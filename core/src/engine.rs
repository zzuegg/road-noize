//! Receiver evaluation: direct paths under every propagation condition,
//! lateral paths around barrier ends, and image sources up to second order on
//! every barrier face and building façade.

use crate::bands::{a_weighted, BANDS, NB};
use crate::geometry::{Owner, V3};
use crate::iso9613;
use crate::path::{evaluate, frequencies, leg_screening, Freq, ImpedanceTable, Profile};
use crate::emission::SOURCE_HEIGHTS;
use crate::scene::{Scene, NH, NP};
use crate::special::knife_edge;
use std::f64::consts::PI;

const REFINE: f64 = 0.2;
const REFINE_REFL: f64 = 0.3;
/// Order-2 reflections only between faces this close to each other and the receiver.
const ORDER2_RADIUS: f64 = 60.0;

pub struct Engine {
    pub scene: Scene,
    freqs: Vec<Freq>,
    /// normalised occurrence per period and class
    weights: Vec<[f64; NP]>,
    /// for each facet: the facets that can feed it a first reflection (order 2)
    partners: Vec<Vec<u32>>,
    tab: ImpedanceTable,
    /// standards mode (ISO 9613-2)
    iso: bool,
}

pub struct Scratch {
    p: Profile,
    leg: Profile,
    stack: Vec<u32>,
}

impl Default for Scratch {
    fn default() -> Self {
        Scratch { p: Profile::new(), leg: Profile::new(), stack: Vec::with_capacity(4096) }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    pub lmax: bool,
    /// direct sound only (for diagnostics)
    pub no_reflections: bool,
    /// façade point: the façade it stands in front of does not count
    /// (incident sound, as façade levels are assessed)
    pub incident: bool,
}

pub struct PointResult {
    /// energy per period and band (linear, Lp = 10 lg)
    pub e: [[f64; NB]; NP],
    pub lmax: [f64; 5],
}

impl PointResult {
    pub fn levels(&self) -> [f64; NP] {
        [a_weighted(&self.e[0]), a_weighted(&self.e[1]), a_weighted(&self.e[2])]
    }
}

impl Engine {
    pub fn new(scene: Scene) -> Engine {
        let freqs = frequencies(scene.settings.sub_frequencies);
        let mut weights = vec![[0.0; NP]; scene.settings.met.len()];
        for p in 0..NP {
            let total: f64 = scene.settings.met.iter().map(|m| m.weights[p].max(0.0)).sum();
            for (c, m) in scene.settings.met.iter().enumerate() {
                weights[c][p] = if total > 0.0 { m.weights[p].max(0.0) / total } else if c == 0 { 1.0 } else { 0.0 };
            }
        }
        let partners = if scene.settings.reflection_order >= 2 { order2_partners(&scene) } else { Vec::new() };
        let mut sigmas: Vec<f64> = Vec::new();
        for v in scene.sigma.data.iter() {
            let v = (*v as f64).max(1.0);
            if !sigmas.iter().any(|s| (s - v).abs() < 1e-6) && sigmas.len() < 16 {
                sigmas.push(v);
            }
        }
        if sigmas.is_empty() {
            sigmas.push(200.0);
        }
        let tab = ImpedanceTable::new(sigmas, &freqs);
        let iso = scene.settings.method == "iso9613";
        Engine { scene, freqs, weights, partners, tab, iso }
    }

    pub fn compute(&self, x: f64, y: f64, height: f64, opts: Options, sc: &mut Scratch) -> PointResult {
        let s = &self.scene;
        let tree = &s.src;
        let zr = s.ground.bilinear(x, y) + height;
        let maxd = s.settings.max_distance;
        let mut res = PointResult { e: [[0.0; NB]; NP], lmax: [f64::NEG_INFINITY; 5] };
        let mut t_class = [0.0; NB];
        let mut t_per;
        let mut scr = [0.0; NB];

        // ------------------------------------------------------------ direct
        sc.stack.clear();
        sc.stack.extend_from_slice(&tree.roots);
        while let Some(n) = sc.stack.pop() {
            let n = n as usize;
            let d = ((tree.x[n] - x).powi(2) + (tree.y[n] - y).powi(2)).sqrt();
            if d - tree.r[n] > maxd {
                continue;
            }
            let leaf = tree.left[n] < 0;
            let refine = if opts.lmax { !leaf } else { !leaf && tree.r[n] > REFINE * d };
            if refine {
                sc.stack.push(tree.left[n] as u32);
                sc.stack.push(tree.right[n] as u32);
                continue;
            }
            let base = tree.z[n];
            let o = n * NH * NP * NB;
            let mut neutral = [[0.0; NB]; NH];
            if self.iso {
                let hs = s.settings.iso_source_height;
                sc.p.build(s, &self.tab, (tree.x[n], tree.y[n], base + hs), (x, y, zr), None);
                let ip = iso9613::attenuation(s, &sc.p);
                let mut t = [0.0; NB];
                for b in 0..NB {
                    t[b] = 10f64.powf(-ip.a[b] / 10.0);
                }
                if s.settings.lateral && ip.blocked {
                    let crossed = sc.p.barriers_crossed.clone();
                    for bi in crossed {
                        let lat = self.lateral_iso(bi, (tree.x[n], tree.y[n], base + hs), (x, y, zr), &ip.agr);
                        for b in 0..NB {
                            t[b] += lat[b];
                        }
                    }
                }
                for p in 0..NP {
                    let f = 10f64.powf(-iso9613::cmet(s.settings.cmet_c0[p], ip.hs, ip.hr, ip.dp) / 10.0);
                    for b in 0..NB {
                        let mut pw = 0.0;
                        for hi in 0..NH {
                            pw += tree.pow[o + (hi * NP + p) * NB + b];
                        }
                        res.e[p][b] += pw * t[b] * f;
                    }
                }
                neutral = [t; NH];
            } else {
            sc.p.build(s, &self.tab, (tree.x[n], tree.y[n], base + SOURCE_HEIGHTS[1]), (x, y, zr), None);
            for hi in 0..NH {
                // skip heights that carry no power for this node
                let any = (0..NP * NB).any(|q| tree.pow[o + hi * NP * NB + q] > 0.0);
                if !any {
                    continue;
                }
                sc.p.zs = base + SOURCE_HEIGHTS[hi];
                t_per = [[0.0; NB]; NP];
                for (c, met) in s.settings.met.iter().enumerate() {
                    let w = self.weights[c];
                    if c != 0 && w.iter().all(|v| *v == 0.0) {
                        continue;
                    }
                    evaluate(s, &self.tab, &mut sc.p, met, &self.freqs, &mut t_class);
                    if c == 0 {
                        neutral[hi] = t_class;
                    }
                    for p in 0..NP {
                        for b in 0..NB {
                            t_per[p][b] += w[p] * t_class[b];
                        }
                    }
                }
                for p in 0..NP {
                    for b in 0..NB {
                        res.e[p][b] += tree.pow[o + (hi * NP + p) * NB + b] * t_per[p][b];
                    }
                }
            }
            // lateral diffraction around the ends of crossed barriers (engine height)
            if s.settings.lateral && !sc.p.barriers_crossed.is_empty() {
                let crossed = sc.p.barriers_crossed.clone();
                for bi in crossed {
                    let lat = self.lateral(bi, (tree.x[n], tree.y[n], base + SOURCE_HEIGHTS[1]), (x, y, zr), &mut sc.leg, &mut scr);
                    for p in 0..NP {
                        for b in 0..NB {
                            let mut pw = 0.0;
                            for hi in 0..NH {
                                pw += tree.pow[o + (hi * NP + p) * NB + b];
                            }
                            res.e[p][b] += pw * lat[b];
                        }
                    }
                    for hi in 0..NH {
                        for b in 0..NB {
                            neutral[hi][b] += lat[b];
                        }
                    }
                }
            }
            }
            if opts.lmax {
                let road = tree.road[n] as usize;
                for c in 0..5 {
                    let lw = &s.vehicle[road * 5 + c];
                    let split = &s.vehicle_split[road * 5 + c];
                    let mut e = [0.0; NB];
                    for b in 0..NB {
                        if lw[b].is_finite() {
                            let mut t = 0.0;
                            for hi in 0..NH {
                                t += split[hi][b] * neutral[hi][b];
                            }
                            e[b] = 10f64.powf(lw[b] / 10.0) * t;
                        }
                    }
                    let l = a_weighted(&e);
                    if l > res.lmax[c] {
                        res.lmax[c] = l;
                    }
                }
            }
        }

        if opts.no_reflections || s.settings.reflection_order == 0 {
            return res;
        }

        // ------------------------------------------------------- reflections
        let r3 = V3::new(x, y, zr);
        let rad = s.settings.reflection_radius;
        let cand: Vec<usize> = (0..s.facets.len())
            .filter(|&i| {
                let f = &s.facets[i];
                let sd = f.signed_distance(r3);
                f.centre.dist(r3) - f.radius <= rad && sd > 0.05 && !(opts.incident && sd < 2.0)
            })
            .collect();

        for &fi in &cand {
            self.reflect1(fi, r3, sc, &mut res);
        }
        if s.settings.reflection_order >= 2 {
            for &f2 in &cand {
                let b = &s.facets[f2];
                if b.centre.dist(r3) - b.radius > ORDER2_RADIUS {
                    continue;
                }
                for &f1 in &self.partners[f2] {
                    self.reflect2(f1 as usize, f2, r3, sc, &mut res);
                }
            }
        }
        res
    }

    fn refl_source_height(&self) -> f64 {
        if self.iso { self.scene.settings.iso_source_height } else { SOURCE_HEIGHTS[1] }
    }

    fn occluded(&self, a: V3, b: V3, skip: &[usize]) -> bool {
        for &fi in &self.scene.barrier_facets {
            if skip.contains(&fi) {
                continue;
            }
            if self.scene.facets[fi].intersect(a, b).is_some() {
                return true;
            }
        }
        false
    }

    fn barrier_of(&self, fi: usize) -> Option<usize> {
        match self.scene.facets[fi].owner {
            Owner::Barrier(b) => Some(b),
            Owner::Building(_) => None,
        }
    }

    fn add_reflected(&self, n: usize, pts: &[V3], refl: [f64; NB], skip_barrier: Option<usize>, sc: &mut Scratch, res: &mut PointResult) {
        let s = &self.scene;
        if self.iso {
            return self.add_reflected_iso(n, pts, refl, skip_barrier, sc, res);
        }
        let mut total = [1.0; NB];
        let mut len = 0.0;
        let mut scr = [0.0; NB];
        for w in pts.windows(2) {
            len += w[0].dist(w[1]);
            sc.leg.build(s, &self.tab, (w[0].x, w[0].y, w[0].z), (w[1].x, w[1].y, w[1].z), skip_barrier);
            leg_screening(&mut sc.leg, &self.freqs, &mut scr);
            for b in 0..NB {
                total[b] *= scr[b];
            }
        }
        if len > s.settings.max_distance {
            return;
        }
        let geo = 2.0 / (4.0 * PI * len * len);
        let o = n * NH * NP * NB;
        for b in 0..NB {
            let t = geo * refl[b] * total[b] * 10f64.powf(-s.alpha[b] * len / 10.0);
            for p in 0..NP {
                let mut pw = 0.0;
                for hi in 0..NH {
                    pw += s.src.pow[o + (hi * NP + p) * NB + b];
                }
                res.e[p][b] += pw * t;
            }
        }
    }

    /// ISO 9613-2 7.5: the image source is treated like a source; one ground
    /// effect (on the leg to the receiver), screening of every leg.
    fn add_reflected_iso(&self, n: usize, pts: &[V3], refl: [f64; NB], skip_barrier: Option<usize>, sc: &mut Scratch, res: &mut PointResult) {
        let s = &self.scene;
        let mut len = 0.0;
        let mut extra = [0.0; NB];
        let legs = pts.len() - 1;
        for (li, w) in pts.windows(2).enumerate() {
            len += w[0].dist(w[1]);
            sc.leg.build(s, &self.tab, (w[0].x, w[0].y, w[0].z), (w[1].x, w[1].y, w[1].z), skip_barrier);
            let ip = iso9613::attenuation(s, &sc.leg);
            for b in 0..NB {
                let gb = ip.a[b] - ip.spread[b];
                extra[b] += if li == legs - 1 { gb } else { (gb - ip.agr[b]).max(0.0) };
            }
        }
        if len > s.settings.max_distance {
            return;
        }
        let adiv = 20.0 * len.max(1.0).log10() + 11.0;
        let first = pts[0];
        let last = pts[pts.len() - 1];
        let hs = (first.z - s.ground.bilinear(first.x, first.y)).max(0.0);
        let hr = (last.z - s.ground.bilinear(last.x, last.y)).max(0.0);
        let dp: f64 = pts.windows(2).map(|w| ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt()).sum();
        let o = n * NH * NP * NB;
        for p in 0..NP {
            let f = 10f64.powf(-iso9613::cmet(s.settings.cmet_c0[p], hs, hr, dp) / 10.0);
            for b in 0..NB {
                if refl[b] <= 0.0 {
                    continue;
                }
                let t = refl[b] * 10f64.powf(-(adiv + s.alpha[b] * len + extra[b]) / 10.0) * f;
                let mut pw = 0.0;
                for hi in 0..NH {
                    pw += s.src.pow[o + (hi * NP + p) * NB + b];
                }
                res.e[p][b] += pw * t;
            }
        }
    }

    /// ISO size criterion applied to a face's reflection factors.
    fn iso_refl(&self, fi: usize, src: V3, p: V3, rec: V3, refl: [f64; NB]) -> [f64; NB] {
        if !self.iso {
            return refl;
        }
        let f = &self.scene.facets[fi];
        let dso = src.dist(p).max(0.1);
        let dor = p.dist(rec).max(0.1);
        let cosb = f.normal.dot(src.sub(p)).abs() / dso;
        let mut out = refl;
        for (b, fc) in BANDS.iter().enumerate() {
            if !iso9613::reflects(crate::turbulence::C0 / fc, f.lmin, cosb, dso, dor) {
                out[b] = 0.0;
            }
        }
        out
    }

    /// ISO lateral path around a barrier end: A_div + A_atm + A_gr + D_z (K_met = 1).
    fn lateral_iso(&self, bi: usize, src: (f64, f64, f64), rec: (f64, f64, f64), agr: &[f64; NB]) -> [f64; NB] {
        let s = &self.scene;
        let bar = &s.barriers[bi];
        let mut out = [0.0; NB];
        if bar.points.len() < 2 {
            return out;
        }
        let sv = V3::new(src.0, src.1, src.2);
        let rv = V3::new(rec.0, rec.1, rec.2);
        let direct = sv.dist(rv);
        for e in [bar.points[0], bar.points[bar.points.len() - 1]] {
            let ds = ((e[0] - src.0).powi(2) + (e[1] - src.1).powi(2)).sqrt();
            let dr = ((e[0] - rec.0).powi(2) + (e[1] - rec.1).powi(2)).sqrt();
            let z = src.2 + (rec.2 - src.2) * ds / (ds + dr).max(1e-6);
            let ev = V3::new(e[0], e[1], z);
            let l = sv.dist(ev) + ev.dist(rv);
            let zdiff = (l - direct).max(0.0);
            let dzv = iso9613::dz(zdiff, ds, dr, direct, 0.0, false, false);
            for b in 0..NB {
                let a = 20.0 * l.max(1.0).log10() + 11.0 + s.alpha[b] * l + agr[b] + dzv[b];
                out[b] += 10f64.powf(-a / 10.0);
            }
        }
        out
    }

    fn reflect1(&self, fi: usize, r3: V3, sc: &mut Scratch, res: &mut PointResult) {
        let s = &self.scene;
        let tree = &s.src;
        let f = &s.facets[fi];
        let mut stack: Vec<u32> = tree.roots.clone();
        while let Some(n) = stack.pop() {
            let n = n as usize;
            let src = V3::new(tree.x[n], tree.y[n], tree.z[n] + self.refl_source_height());
            let sd = f.signed_distance(src);
            if sd <= 0.0 && -sd > tree.r[n] {
                continue;
            }
            let img = f.mirror(src);
            let d = img.dist(r3);
            if d - tree.r[n] > s.settings.max_distance {
                continue;
            }
            let leaf = tree.left[n] < 0;
            if !leaf && (tree.r[n] > REFINE_REFL * d || sd.abs() <= tree.r[n]) {
                stack.push(tree.left[n] as u32);
                stack.push(tree.right[n] as u32);
                continue;
            }
            if sd <= 0.0 {
                continue;
            }
            let si = f.signed_distance(img);
            let sr = f.signed_distance(r3);
            let t = si / (si - sr);
            let p = img.add(r3.sub(img).mul(t));
            if !f.contains(p) {
                continue;
            }
            if self.occluded(src, p, &[fi]) || self.occluded(p, r3, &[fi]) {
                continue;
            }
            // leave the face by half a metre so the legs do not start inside it
            let pe = p.add(f.normal.mul(0.5));
            let refl = self.iso_refl(fi, src, p, r3, f.refl);
            self.add_reflected(n, &[src, pe, r3], refl, self.barrier_of(fi), sc, res);
        }
    }

    fn reflect2(&self, f1i: usize, f2i: usize, r3: V3, sc: &mut Scratch, res: &mut PointResult) {
        let s = &self.scene;
        let tree = &s.src;
        let f1 = &s.facets[f1i];
        let f2 = &s.facets[f2i];
        let mut stack: Vec<u32> = tree.roots.clone();
        while let Some(n) = stack.pop() {
            let n = n as usize;
            let src = V3::new(tree.x[n], tree.y[n], tree.z[n] + self.refl_source_height());
            let sd = f1.signed_distance(src);
            if sd <= 0.0 && -sd > tree.r[n] {
                continue;
            }
            let i1 = f1.mirror(src);
            if f2.signed_distance(i1) <= 0.0 {
                continue;
            }
            let i2 = f2.mirror(i1);
            let d = i2.dist(r3);
            if d - tree.r[n] > s.settings.max_distance {
                continue;
            }
            let leaf = tree.left[n] < 0;
            if !leaf && (tree.r[n] > REFINE_REFL * 1.5 * d || sd.abs() <= tree.r[n]) {
                stack.push(tree.left[n] as u32);
                stack.push(tree.right[n] as u32);
                continue;
            }
            if sd <= 0.0 {
                continue;
            }
            let a = f2.signed_distance(i2);
            let b = f2.signed_distance(r3);
            let p2 = i2.add(r3.sub(i2).mul(a / (a - b)));
            if !f2.contains(p2) {
                continue;
            }
            let a1 = f1.signed_distance(i1);
            let b1 = f1.signed_distance(p2);
            if (a1 > 0.0) == (b1 > 0.0) {
                continue;
            }
            let p1 = i1.add(p2.sub(i1).mul(a1 / (a1 - b1)));
            if !f1.contains(p1) {
                continue;
            }
            let skip = [f1i, f2i];
            if self.occluded(src, p1, &skip) || self.occluded(p1, p2, &skip) || self.occluded(p2, r3, &skip) {
                continue;
            }
            let r1 = self.iso_refl(f1i, src, p1, p2, f1.refl);
            let r2 = self.iso_refl(f2i, p1, p2, r3, f2.refl);
            let mut refl = [0.0; NB];
            for k in 0..NB {
                refl[k] = r1[k] * r2[k];
            }
            let pts = [src, p1.add(f1.normal.mul(0.5)), p2.add(f2.normal.mul(0.5)), r3];
            let skip_b = self.barrier_of(f2i).or(self.barrier_of(f1i));
            self.add_reflected(n, &pts, refl, skip_b, sc, res);
        }
    }

    /// Sound passing around the two ends of a barrier (knife-edge on the
    /// vertical end edge), energy transfer per band.
    fn lateral(&self, bi: usize, src: (f64, f64, f64), rec: (f64, f64, f64), leg: &mut Profile, scr: &mut [f64; NB]) -> [f64; NB] {
        let s = &self.scene;
        let bar = &s.barriers[bi];
        let mut out = [0.0; NB];
        if bar.points.len() < 2 {
            return out;
        }
        let ends = [bar.points[0], bar.points[bar.points.len() - 1]];
        let sv = V3::new(src.0, src.1, src.2);
        let rv = V3::new(rec.0, rec.1, rec.2);
        let direct = sv.dist(rv);
        for e in ends {
            // the ray passes the end at the height of the straight line
            let ds = ((e[0] - src.0).powi(2) + (e[1] - src.1).powi(2)).sqrt();
            let dr = ((e[0] - rec.0).powi(2) + (e[1] - rec.1).powi(2)).sqrt();
            let z = src.2 + (rec.2 - src.2) * ds / (ds + dr).max(1e-6);
            let ev = V3::new(e[0], e[1], z);
            let l = sv.dist(ev) + ev.dist(rv);
            if l > s.settings.max_distance {
                continue;
            }
            let delta = (l - direct).max(0.0);
            let mut gain = [1.0; NB];
            for (a, b) in [(sv, ev), (ev, rv)] {
                leg.build(s, &self.tab, (a.x, a.y, a.z), (b.x, b.y, b.z), Some(bi));
                leg_screening(leg, &self.freqs, scr);
                for k in 0..NB {
                    gain[k] *= scr[k];
                }
            }
            let geo = 2.0 / (4.0 * PI * l * l);
            for fq in &self.freqs {
                let v = 2.0 * (delta / fq.lambda).sqrt();
                out[fq.band] += fq.weight * knife_edge(v).norm_sqr() * geo * gain[fq.band]
                    * 10f64.powf(-s.alpha[fq.band] * l / 10.0);
            }
        }
        let _ = BANDS;
        out
    }
}

/// Pairs of faces that look at each other within ORDER2_RADIUS (street
/// canyons, wall facing a façade): the only ones that make second-order paths.
fn order2_partners(s: &Scene) -> Vec<Vec<u32>> {
    let n = s.facets.len();
    let mut out = vec![Vec::new(); n];
    // bucket by plan cell to avoid the full O(n²)
    let cell = ORDER2_RADIUS;
    let mut grid: std::collections::HashMap<(i64, i64), Vec<u32>> = std::collections::HashMap::new();
    for (i, f) in s.facets.iter().enumerate() {
        let key = ((f.centre.x / cell).floor() as i64, (f.centre.y / cell).floor() as i64);
        grid.entry(key).or_default().push(i as u32);
    }
    for (f2, b) in s.facets.iter().enumerate() {
        let (cx, cy) = ((b.centre.x / cell).floor() as i64, (b.centre.y / cell).floor() as i64);
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(list) = grid.get(&(cx + dx, cy + dy)) {
                    for &f1 in list {
                        let f1u = f1 as usize;
                        if f1u == f2 {
                            continue;
                        }
                        let a = &s.facets[f1u];
                        if a.centre.dist(b.centre) - a.radius - b.radius > ORDER2_RADIUS {
                            continue;
                        }
                        if a.normal.dot(b.normal) > -0.2 || b.signed_distance(a.centre) <= 0.0 || a.signed_distance(b.centre) <= 0.0 {
                            continue;
                        }
                        out[f2].push(f1);
                    }
                }
            }
        }
    }
    out
}
