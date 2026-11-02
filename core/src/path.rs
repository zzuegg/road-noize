//! One source → receiver path through the vertical cut of terrain, buildings
//! and barriers, under one propagation condition.
//!
//! Model (per sub-frequency, then averaged over the octave band):
//!
//! * Refraction: curved rays of radius R are handled with the curved-ground
//!   analogy — the profile is lowered by x(d−x)/2R and rays are straight
//!   (R > 0 downward refraction, R < 0 upward → shadow zones appear by
//!   themselves as diffraction over the "raised" ground).
//! * Unscreened: direct + ground-reflected wave, spherical-wave reflection
//!   coefficient Q (with ground wave) on the least-squares mean ground plane,
//!   impedance from the ground type at the reflection point, summed with the
//!   turbulence coherence factor.
//! * Screened (or nearly): four paths S→E→R, S'→E→R, S→E→R', S'→E→R' over the
//!   diffracting edge(s), each with the complex Fresnel knife-edge coefficient
//!   of its own path difference along the convex hull of the obstacles, the
//!   ground reflection on each side with its own mean plane, summed with
//!   coherence factors; plus energy scattered into the shadow by turbulence.

use crate::bands::{BANDS, NB};
use crate::barrier::crossings;
use crate::ground::{delany_bazley, spherical_q};
use crate::scene::{MetClass, Scene};
use crate::special::knife_edge;
use crate::turbulence::C0;
use num_complex::Complex64 as C;
use std::f64::consts::PI;

const TERRAIN_TOL: f64 = 0.3;
const NEAR_SOURCE: f64 = 4.0;
const NEAR_RECEIVER: f64 = 1.5;
const NEAR_RECEIVER_BLDG: f64 = 0.8;
/// Fresnel parameter below which an obstacle is ignored (ITU-R P.526).
const V_IGNORE: f64 = -0.78;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Terrain,
    Building,
    Barrier(usize),
}

#[derive(Default)]
pub struct Profile {
    pub d: f64,
    pub sx: f64,
    pub sy: f64,
    pub zs: f64,
    pub rx: f64,
    pub ry: f64,
    pub zr: f64,
    /// distance from S
    pub x: Vec<f64>,
    /// terrain height
    pub g: Vec<f64>,
    /// obstacle top (terrain − tolerance, roof, barrier vertex)
    pub o: Vec<f64>,
    pub kind: Vec<Kind>,
    pub obstacle: Vec<bool>,
    /// impedance-table index of the ground under each sample
    pub sig_idx: Vec<usize>,
    pub barriers_crossed: Vec<usize>,
    // per-class scratch
    tg: Vec<f64>,
    to: Vec<f64>,
    /// radius the scratch was last transformed for (NaN = stale)
    last_rc: f64,
}

impl Profile {
    pub fn new() -> Profile {
        Profile::default()
    }

    /// Samples the cut between two points. `skip_barrier` excludes one barrier
    /// (the one a reflected path bounces off).
    #[allow(clippy::too_many_arguments)]
    pub fn build(&mut self, sc: &Scene, tab: &ImpedanceTable, s: (f64, f64, f64), r: (f64, f64, f64), skip_barrier: Option<usize>) {
        self.last_rc = f64::NAN;
        self.x.clear();
        self.g.clear();
        self.o.clear();
        self.kind.clear();
        self.obstacle.clear();
        self.sig_idx.clear();
        self.barriers_crossed.clear();
        let (dx, dy) = (r.0 - s.0, r.1 - s.1);
        let d = (dx * dx + dy * dy).sqrt().max(0.1);
        self.d = d;
        (self.sx, self.sy, self.zs) = s;
        (self.rx, self.ry, self.zr) = r;
        let step = (d / 300.0).max(1.0);
        let n = (d / step).ceil().max(1.0) as usize;
        for i in 1..n {
            let t = i as f64 / n as f64;
            let dist = t * d;
            let (px, py) = (s.0 + dx * t, s.1 + dy * t);
            let gz = sc.ground.bilinear(px, py);
            self.sig_idx.push(tab.index(sc.sigma.nearest(px, py).max(1.0)));
            let to_r = d - dist;
            let h = sc.bldg.nearest(px, py);
            if h > 0.0 && to_r > NEAR_RECEIVER_BLDG {
                self.push(dist, gz, gz + h, Kind::Building, true);
            } else {
                let obst = dist > NEAR_SOURCE && to_r > NEAR_RECEIVER;
                self.push(dist, gz, gz - TERRAIN_TOL, Kind::Terrain, obst);
            }
        }
        let mut cr = Vec::new();
        for (bi, b) in sc.barriers.iter().enumerate() {
            if Some(bi) == skip_barrier {
                continue;
            }
            cr.clear();
            if crossings(b, (s.0, s.1), (r.0, r.1), &sc.ground, &mut cr) {
                self.barriers_crossed.push(bi);
                for c in &cr {
                    let (px, py) = (s.0 + dx * c.dist / d, s.1 + dy * c.dist / d);
                    let gz = sc.ground.bilinear(px, py);
                    self.sig_idx.push(tab.index(sc.sigma.nearest(px, py).max(1.0)));
                    self.push(c.dist, gz, c.z, Kind::Barrier(bi), c.z > gz + 0.01);
                }
            }
        }
        if !self.barriers_crossed.is_empty() {
            // keep the profile ordered by distance
            let mut idx: Vec<usize> = (0..self.x.len()).collect();
            idx.sort_by(|a, b| self.x[*a].partial_cmp(&self.x[*b]).unwrap());
            self.x = idx.iter().map(|&i| self.x[i]).collect();
            self.g = idx.iter().map(|&i| self.g[i]).collect();
            self.o = idx.iter().map(|&i| self.o[i]).collect();
            self.kind = idx.iter().map(|&i| self.kind[i]).collect();
            self.obstacle = idx.iter().map(|&i| self.obstacle[i]).collect();
            self.sig_idx = idx.iter().map(|&i| self.sig_idx[i]).collect();
        }
    }

    fn push(&mut self, x: f64, g: f64, o: f64, k: Kind, obst: bool) {
        self.x.push(x);
        self.g.push(g);
        self.o.push(o);
        self.kind.push(k);
        self.obstacle.push(obst);
    }

    /// Applies the curved-ray transform for radius `rc` (0 = straight).
    fn transform(&mut self, rc: f64) {
        if self.last_rc == rc && self.tg.len() == self.x.len() {
            return;
        }
        self.last_rc = rc;
        self.tg.clear();
        self.to.clear();
        let d = self.d;
        for i in 0..self.x.len() {
            let off = if rc != 0.0 { self.x[i] * (d - self.x[i]) / (2.0 * rc) } else { 0.0 };
            self.tg.push(self.g[i] - off);
            self.to.push(self.o[i] - off);
        }
    }
}

/// Least-squares line z = a + b x over samples [i0, i1) of `z`, with the end
/// heights `za` at `xa` and `zb` at `xb` added so a short side still has a plane.
fn fit_plane(x: &[f64], z: &[f64], i0: usize, i1: usize, ends: [(f64, f64); 2]) -> (f64, f64) {
    let (mut n, mut sx, mut sz, mut sxx, mut sxz) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut add = |xi: f64, zi: f64| {
        n += 1.0;
        sx += xi;
        sz += zi;
        sxx += xi * xi;
        sxz += xi * zi;
    };
    for i in i0..i1 {
        add(x[i], z[i]);
    }
    for (xe, ze) in ends {
        add(xe, ze);
    }
    let den = n * sxx - sx * sx;
    if den.abs() < 1e-9 {
        return (sz / n, 0.0);
    }
    let b = (n * sxz - sx * sz) / den;
    ((sz - b * sx) / n, b)
}

/// A point expressed in the frame of a ground plane z = a + b x:
/// (coordinate along the plane, height above it).
fn in_plane(a: f64, b: f64, x: f64, z: f64) -> (f64, f64) {
    let n = (1.0 + b * b).sqrt();
    let h = (z - (a + b * x)) / n;
    let along = (x + b * (z - a)) / n;
    (along, h)
}

/// Ground under a reflection, weighted over its Fresnel zone.
///
/// For each profile sample in [i0, i1) the excess length of the path via that
/// point over the reflected ray is computed once; per frequency, the samples
/// within λ/4 form the zone and their admittances are averaged. A source just
/// above the asphalt therefore still "sees" the meadow beside the road, which
/// a single reflection point never would.
struct Zone {
    /// excess path lengths, ascending
    excess: Vec<f64>,
    /// prefix[i][k] = number of samples of kind k among the first i (sorted)
    prefix: Vec<[u16; 4]>,
    /// impedance-table index of each kind
    kinds: Vec<usize>,
    fallback: usize,
}

/// Samples used for the zone at most; the zone is a smooth average.
const ZONE_SAMPLES: usize = 48;

impl Zone {
    #[allow(clippy::too_many_arguments)]
    fn new(p: &Profile, tab: &ImpedanceTable, i0: usize, i1: usize, a: f64, b: f64, s: (f64, f64), r: (f64, f64), fallback: f64) -> Zone {
        let (us, hs) = in_plane(a, b, s.0, s.1);
        let (ur, hr) = in_plane(a, b, r.0, r.1);
        let (hs, hr) = (hs.max(0.01), hr.max(0.01));
        let r2 = ((ur - us).powi(2) + (hs + hr).powi(2)).sqrt();
        let i1 = i1.min(p.x.len());
        let stride = ((i1.saturating_sub(i0)) / ZONE_SAMPLES).max(1);
        let mut kinds: Vec<usize> = Vec::new();
        let mut items: Vec<(f64, usize)> = Vec::with_capacity(ZONE_SAMPLES + 1);
        let mut i = i0;
        while i < i1 {
            let (u, _) = in_plane(a, b, p.x[i], p.g[i]);
            let e = ((u - us).powi(2) + hs * hs).sqrt() + ((ur - u).powi(2) + hr * hr).sqrt() - r2;
            let ti = p.sig_idx[i];
            let k = match kinds.iter().position(|v| *v == ti) {
                Some(k) => k,
                None if kinds.len() < 4 => {
                    kinds.push(ti);
                    kinds.len() - 1
                }
                None => 0,
            };
            items.push((e, k));
            i += stride;
        }
        items.sort_unstable_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut prefix = Vec::with_capacity(items.len() + 1);
        let mut acc = [0u16; 4];
        prefix.push(acc);
        for (_, k) in &items {
            acc[*k] = acc[*k].saturating_add(1);
            prefix.push(acc);
        }
        Zone { excess: items.iter().map(|x| x.0).collect(), prefix, kinds, fallback: tab.index(fallback) }
    }

    fn impedance(&self, tab: &ImpedanceTable, fi: usize, lambda: f64) -> C {
        let n = self.excess.partition_point(|e| *e <= lambda / 4.0);
        if n == 0 {
            return tab.z[self.fallback][fi];
        }
        let counts = self.prefix[n];
        let mut beta = C::new(0.0, 0.0);
        for (k, ti) in self.kinds.iter().enumerate() {
            if counts[k] > 0 {
                beta += counts[k] as f64 / tab.z[*ti][fi];
            }
        }
        1.0 / (beta / n as f64)
    }
}

/// Normalised ground impedance per frequency for every flow resistivity that
/// occurs in the scene (a handful), so the Delany–Bazley powers are taken once.
pub struct ImpedanceTable {
    pub sigmas: Vec<f64>,
    /// [sigma index][frequency index]
    pub z: Vec<Vec<C>>,
}

impl ImpedanceTable {
    pub fn new(sigmas: Vec<f64>, freqs: &[Freq]) -> ImpedanceTable {
        let z = sigmas.iter().map(|s| freqs.iter().map(|f| delany_bazley(f.f, *s)).collect()).collect();
        ImpedanceTable { sigmas, z }
    }

    pub fn index(&self, sigma: f64) -> usize {
        let mut best = 0;
        let mut d = f64::MAX;
        for (i, s) in self.sigmas.iter().enumerate() {
            let e = (s.ln() - sigma.ln()).abs();
            if e < d {
                d = e;
                best = i;
            }
        }
        best
    }
}

pub struct Freq {
    pub band: usize,
    pub f: f64,
    pub k: f64,
    pub lambda: f64,
    pub weight: f64,
}

pub fn frequencies(sub: usize) -> Vec<Freq> {
    let sub = sub.max(1);
    let mut out = Vec::new();
    for b in 0..NB {
        for f in crate::bands::sub_frequencies(b, sub) {
            out.push(Freq { band: b, f, k: 2.0 * PI * f / C0, lambda: C0 / f, weight: 1.0 / sub as f64 });
        }
    }
    out
}

struct Edge {
    /// hull vertex indices into the profile (first … last)
    first: usize,
    last: usize,
    /// summed length of the hull between first and last
    chain: f64,
    blocked: bool,
}

/// Upper convex hull from S to R over obstacle points (transformed heights).
fn hull_edge(p: &Profile) -> Option<Edge> {
    let n = p.x.len();
    let d = p.d;
    let (zs, zr) = (p.zs, p.zr);
    let line = |x: f64| zs + (zr - zs) * x / d;
    // candidates above the line → blocked
    let mut hull: Vec<(f64, f64, usize)> = vec![(0.0, zs, usize::MAX)];
    let mut blocked = false;
    for i in 0..n {
        if !p.obstacle[i] {
            continue;
        }
        let (x, z) = (p.x[i], p.to[i]);
        if z > line(x) {
            blocked = true;
        }
        while hull.len() >= 2 {
            let (ox, oz, _) = hull[hull.len() - 2];
            let (ax, az, _) = hull[hull.len() - 1];
            if (ax - ox) * (z - oz) - (az - oz) * (x - ox) >= 0.0 {
                hull.pop();
            } else {
                break;
            }
        }
        hull.push((x, z, i));
    }
    while hull.len() >= 2 {
        let (ox, oz, _) = hull[hull.len() - 2];
        let (ax, az, _) = hull[hull.len() - 1];
        if (ax - ox) * (zr - oz) - (az - oz) * (d - ox) >= 0.0 {
            hull.pop();
        } else {
            break;
        }
    }
    if blocked && hull.len() >= 2 {
        let first = hull[1].2;
        let last = hull[hull.len() - 1].2;
        let mut chain = 0.0;
        for w in hull[1..].windows(2) {
            chain += ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt();
        }
        return Some(Edge { first, last, chain, blocked: true });
    }
    // not blocked: the obstacle point closest (in Fresnel terms) to the ray
    let mut best = f64::NEG_INFINITY;
    let mut bi = usize::MAX;
    for i in 0..n {
        // Terrain only diffracts when it blocks; below the ray its shape is the
        // ground plane's business (reflection), not an edge.
        if !p.obstacle[i] || p.kind[i] == Kind::Terrain {
            continue;
        }
        let (x, z) = (p.x[i], p.to[i]);
        let h = z - line(x);
        let v = h * (1.0 / x.max(0.1) + 1.0 / (d - x).max(0.1)).sqrt();
        if v > best {
            best = v;
            bi = i;
        }
    }
    if bi == usize::MAX {
        return None;
    }
    // ignore if well clear even at the lowest band
    let lmax = C0 / BANDS[0];
    if best * (2.0 / lmax).sqrt() < V_IGNORE {
        return None;
    }
    Some(Edge { first: bi, last: bi, chain: 0.0, blocked: false })
}

fn dist2(a: (f64, f64), b: (f64, f64)) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Mirror point (x,z) across the line z = a + b x.
fn mirror(a: f64, b: f64, x: f64, z: f64) -> (f64, f64) {
    let d = (z - a - b * x) / (1.0 + b * b);
    (x + 2.0 * d * b, z - 2.0 * d)
}

/// Energy transfer per band (|p|² relative to a 1 W-equivalent: Lp = Lw + 10 lg E)
/// for one propagation condition.
pub fn evaluate(sc: &Scene, tab: &ImpedanceTable, p: &mut Profile, met: &MetClass, freqs: &[Freq], out: &mut [f64; NB]) {
    *out = [0.0; NB];
    let d = p.d;
    let rc = if met.radius == 0.0 {
        0.0
    } else if met.distance_scaled && met.radius > 0.0 {
        met.radius.max(8.0 * d)
    } else {
        met.radius
    };
    p.transform(rc);
    let turb = &sc.settings.turbulence;
    let s = (0.0, p.zs);
    let r = (d, p.zr);
    let d3 = dist2(s, r).max(0.5);
    let n = p.x.len();

    let sigma_at = |xd: f64| -> f64 {
        let t = (xd / d).clamp(0.0, 1.0);
        sc.sigma.nearest(p.sx + (p.rx - p.sx) * t, p.sy + (p.ry - p.sy) * t).max(1.0)
    };

    match hull_edge(p) {
        None => {
            // ---- unscreened: direct + ground reflection on the mean plane of the
            // real terrain. Refraction raises (or lowers) the equivalent source
            // and receiver heights as in CNOSSOS-EU favourable conditions:
            // δz_s = (z_s/(z_s+z_r))² d²/2R, likewise for the receiver.
            let gs = sc.ground.bilinear(p.sx, p.sy);
            let gr = sc.ground.bilinear(p.rx, p.ry);
            let (a, b) = fit_plane(&p.x, &p.g, 0, n, [(0.0, gs), (d, gr)]);
            let (us, hs0) = in_plane(a, b, s.0, s.1);
            let (ur, hr0) = in_plane(a, b, r.0, r.1);
            let (hs0, hr0) = (hs0.max(0.01), hr0.max(0.01));
            let (mut hs, mut hr) = (hs0, hr0);
            if rc != 0.0 {
                let sum = hs0 + hr0;
                hs += (hs0 / sum).powi(2) * d * d / (2.0 * rc);
                hr += (hr0 / sum).powi(2) * d * d / (2.0 * rc);
            }
            let (hs, hr) = (hs.max(0.01), hr.max(0.01));
            let du = (ur - us).abs().max(0.1);
            let r1 = (du * du + (hr - hs).powi(2)).sqrt();
            let r2 = (du * du + (hr + hs).powi(2)).sqrt();
            let psi = ((hs + hr) / du).atan();
            let xref = du * hs / (hs + hr);
            let zone = Zone::new(p, tab, 0, n, a, b, s, r, sigma_at(xref));
            let hsep = 2.0 * hs * hr / (hs + hr);
            for (fi, fq) in freqs.iter().enumerate() {
                let z = zone.impedance(tab, fi, fq.lambda);
                let q = spherical_q(psi, r2, fq.k, z);
                let f = turb.coherence(fq.k, r1, hsep);
                let ph = C::new(0.0, fq.k * (r2 - r1)).exp();
                let e = 1.0 / (r1 * r1) + q.norm_sqr() / (r2 * r2) + 2.0 * f * (q * ph).re / (r1 * r2);
                out[fq.band] += fq.weight * e.max(0.0) / (4.0 * PI);
            }
        }
        Some(edge) => {
            // ---- diffraction with ground on both sides
            let e1 = (p.x[edge.first], p.to[edge.first]);
            let en = (p.x[edge.last], p.to[edge.last]);
            let i_first = edge.first;
            let i_last = edge.last;
            let gs = sc.ground.bilinear(p.sx, p.sy);
            let gr = sc.ground.bilinear(p.rx, p.ry);
            let ge1 = p.tg[i_first];
            let gen = p.tg[i_last];
            let (sa, sb) = fit_plane(&p.x, &p.tg, 0, i_first, [(0.0, gs), (e1.0, ge1)]);
            let (ra, rb) = fit_plane(&p.x, &p.tg, i_last + 1, n, [(en.0, gen), (d, gr)]);
            let s_img = mirror(sa, sb, s.0, s.1);
            let r_img = mirror(ra, rb, r.0, r.1);
            let (_, hs) = in_plane(sa, sb, s.0, s.1);
            let (_, he1) = in_plane(sa, sb, e1.0, e1.1);
            let (_, hr) = in_plane(ra, rb, r.0, r.1);
            let (_, hen) = in_plane(ra, rb, en.0, en.1);
            let (hs, hr, he1, hen) = (hs.max(0.01), hr.max(0.01), he1.max(0.01), hen.max(0.01));
            let ds = dist2(s, e1).max(0.1);
            let dr = dist2(en, r).max(0.1);
            let psi_s = ((hs + he1) / dist2(s_img, e1).max(0.1)).asin().abs();
            let psi_r = ((hr + hen) / dist2(r_img, en).max(0.1)).asin().abs();
            let zone_s = Zone::new(p, tab, 0, i_first, sa, sb, s, e1, sigma_at(e1.0 * hs / (hs + he1)));
            let zone_r = Zone::new(p, tab, i_last + 1, n, ra, rb, en, r, sigma_at(en.0 + (d - en.0) * hen / (hr + hen)));
            let hsep_s = 2.0 * hs * he1 / (hs + he1);
            let hsep_r = 2.0 * hr * hen / (hr + hen);

            // the four paths: (source image?, receiver image?)
            let combos = [(false, false), (true, false), (false, true), (true, true)];
            let mut len = [0.0; 4];
            let mut direct = [0.0; 4];
            let mut sign = [1.0; 4];
            for (i, &(si, ri)) in combos.iter().enumerate() {
                let a = if si { s_img } else { s };
                let b = if ri { r_img } else { r };
                let l = dist2(a, e1) + edge.chain + dist2(en, b);
                let dd = dist2(a, b);
                len[i] = l;
                direct[i] = dd;
                // edge above or below the line a→b (at e1)
                let zl = a.1 + (b.1 - a.1) * (e1.0 - a.0) / (b.0 - a.0).max(1e-6);
                sign[i] = if edge.blocked || e1.1 > zl { 1.0 } else { -1.0 };
            }
            let free_e = 1.0 / (d3 * d3) / (4.0 * PI);
            for (fi, fq) in freqs.iter().enumerate() {
                let qs = spherical_q(psi_s, dist2(s_img, e1), fq.k, zone_s.impedance(tab, fi, fq.lambda));
                let qr = spherical_q(psi_r, dist2(r_img, en), fq.k, zone_r.impedance(tab, fi, fq.lambda));
                let mut amp = [C::new(0.0, 0.0); 4];
                for (i, &(si, ri)) in combos.iter().enumerate() {
                    let delta = (len[i] - direct[i]).max(0.0);
                    let v = sign[i] * 2.0 * (delta / fq.lambda).sqrt();
                    let mut a = knife_edge(v) * C::new(0.0, fq.k * direct[i]).exp() / direct[i];
                    if si {
                        a *= qs;
                    }
                    if ri {
                        a *= qr;
                    }
                    amp[i] = a;
                }
                let cs = turb.coherence(fq.k, ds, hsep_s);
                let cr = turb.coherence(fq.k, dr, hsep_r);
                let mut e = 0.0;
                for i in 0..4 {
                    for j in 0..4 {
                        let (si, ri) = combos[i];
                        let (sj, rj) = combos[j];
                        let mut f = 1.0;
                        if si != sj {
                            f *= cs;
                        }
                        if ri != rj {
                            f *= cr;
                        }
                        e += f * (amp[i] * amp[j].conj()).re;
                    }
                }
                let mut e = e.max(0.0) / (4.0 * PI);
                if edge.blocked {
                    // turbulent scattering into the shadow (over hard + reflecting ground ≈ 2×)
                    e += 2.0 * free_e * turb.scatter_floor(fq.f, d3);
                }
                out[fq.band] += fq.weight * e;
            }
        }
    }
    for b in 0..NB {
        out[b] *= 10f64.powf(-sc.alpha[b] * d3 / 10.0);
    }
}

/// Screening factor (energy) of a straight leg, knife-edge over the hull,
/// neutral atmosphere; used for reflected and lateral paths.
pub fn leg_screening(p: &mut Profile, freqs: &[Freq], out: &mut [f64; NB]) {
    p.transform(0.0);
    *out = [0.0; NB];
    match hull_edge(p) {
        None => {
            for fq in freqs {
                out[fq.band] += fq.weight;
            }
        }
        Some(edge) => {
            let s = (0.0, p.zs);
            let r = (p.d, p.zr);
            let e1 = (p.x[edge.first], p.to[edge.first]);
            let en = (p.x[edge.last], p.to[edge.last]);
            let l = dist2(s, e1) + edge.chain + dist2(en, r);
            let delta = (l - dist2(s, r)).max(0.0);
            let sign = if edge.blocked { 1.0 } else { -1.0 };
            for fq in freqs {
                let v = sign * 2.0 * (delta / fq.lambda).sqrt();
                out[fq.band] += fq.weight * knife_edge(v).norm_sqr();
            }
        }
    }
}
