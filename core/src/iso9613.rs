//! ISO 9613-2:1996 "Attenuation of sound during propagation outdoors —
//! General method of calculation", octave-band method, downwind conditions,
//! applied to the same vertical profile the physical model uses.
//!
//!   L_fT(DW) = L_W + D_c − A,   A = A_div + A_atm + A_gr + A_bar (+ A_misc = 0)
//!   L_AT(LT) = L_AT(DW) − C_met
//!
//! * A_div = 20 lg(d/1 m) + 11                                  (7.1)
//! * A_atm = α d, α from ISO 9613-1 at the set T / RH            (7.2)
//! * A_gr  general method, source / middle / receiver regions,   (7.3.1)
//!         G of each region = share of porous ground in it,
//!         heights above the mean ground plane
//! * A_bar top edge:  D_z − A_gr ≥ 0;  lateral: D_z               (7.4)
//!         D_z = 10 lg(3 + (C2/λ) C3 z K_met), C2 = 20,
//!         C3 = 1 (single) or (1 + (5λ/e)²)/(1/3 + (5λ/e)²) (multiple),
//!         K_met = exp(−(1/2000)√(d_ss d_sr d / 2z)), cap 20 / 25 dB
//!         screening only where the line of sight is blocked
//! * reflections: image sources, ρ = 1 − α of the surface,      (7.5)
//!         only where the surface is large enough for the band
//! * C_met = C0 (1 − 10 (h_s + h_r)/d_p) for d_p > 10 (h_s + h_r)  (8)

use crate::bands::{BANDS, NB};
use crate::path::{Kind, Profile};
use crate::scene::Scene;
use crate::turbulence::C0;

/// ISO 9613-2 Table 3, one region, into `out` per band.
fn region(out: &mut [f64; NB], h: f64, g: f64, dp: f64) {
    let e50 = 1.0 - (-dp / 50.0).exp();
    let a = 1.5 + 3.0 * (-0.12 * (h - 5.0).powi(2)).exp() * e50 + 5.7 * (-0.09 * h * h).exp() * (1.0 - (-2.8e-6 * dp * dp).exp());
    let b = 1.5 + 8.6 * (-0.09 * h * h).exp() * e50;
    let c = 1.5 + 14.0 * (-0.46 * h * h).exp() * e50;
    let d = 1.5 + 5.0 * (-0.9 * h * h).exp() * e50;
    out[0] += -1.5;
    out[1] += -1.5 + g * a;
    out[2] += -1.5 + g * b;
    out[3] += -1.5 + g * c;
    out[4] += -1.5 + g * d;
    out[5] += -1.5 * (1.0 - g);
    out[6] += -1.5 * (1.0 - g);
    out[7] += -1.5 * (1.0 - g);
}

/// Porous (G = 1) where the flow resistivity is that of unsealed ground.
pub fn g_of_sigma(sigma: f64) -> f64 {
    if sigma < 1000.0 { 1.0 } else { 0.0 }
}

/// Share of porous ground over [x0, x1] of the profile.
fn g_share(p: &Profile, sc: &Scene, x0: f64, x1: f64) -> f64 {
    let (mut n, mut s) = (0.0, 0.0);
    let d = p.d;
    for i in 0..p.x.len() {
        if p.x[i] >= x0 && p.x[i] <= x1 && p.kind[i] != Kind::Barrier(usize::MAX) {
            let t = p.x[i] / d;
            let sig = sc.sigma.nearest(p.sx + (p.rx - p.sx) * t, p.sy + (p.ry - p.sy) * t);
            s += g_of_sigma(sig);
            n += 1.0;
        }
    }
    if n == 0.0 {
        // short region: the ground under its middle
        let t = ((x0 + x1) / 2.0 / d).clamp(0.0, 1.0);
        return g_of_sigma(sc.sigma.nearest(p.sx + (p.rx - p.sx) * t, p.sy + (p.ry - p.sy) * t));
    }
    s / n
}

/// Least-squares mean ground plane over the terrain samples and both ends.
fn mean_plane(p: &Profile, sc: &Scene) -> (f64, f64) {
    let gs = sc.ground.bilinear(p.sx, p.sy);
    let gr = sc.ground.bilinear(p.rx, p.ry);
    let (mut n, mut sx, mut sz, mut sxx, mut sxz) = (2.0, p.d, gs + gr, p.d * p.d, p.d * gr);
    for i in 0..p.x.len() {
        n += 1.0;
        sx += p.x[i];
        sz += p.g[i];
        sxx += p.x[i] * p.x[i];
        sxz += p.x[i] * p.g[i];
    }
    let den = n * sxx - sx * sx;
    if den.abs() < 1e-9 {
        return (sz / n, 0.0);
    }
    let b = (n * sxz - sx * sz) / den;
    ((sz - b * sx) / n, b)
}

pub struct IsoPath {
    /// attenuation A per band, dB (without C_met)
    pub a: [f64; NB],
    /// A_gr alone, and A_div + A_atm
    pub agr: [f64; NB],
    pub spread: [f64; NB],
    /// heights above the mean plane and projected distance, for C_met
    pub hs: f64,
    pub hr: f64,
    pub dp: f64,
    pub blocked: bool,
}

/// Top-edge path difference over the convex hull of obstacles (terrain,
/// buildings, barrier sections) when the line of sight is blocked.
/// Returns (z, d_ss, d_sr, e, multiple).
pub fn hull_path(p: &Profile) -> Option<(f64, f64, f64, f64, bool)> {
    let d = p.d;
    let (zs, zr) = (p.zs, p.zr);
    let line = |x: f64| zs + (zr - zs) * x / d;
    let mut hull: Vec<(f64, f64)> = vec![(0.0, zs)];
    let mut blocked = false;
    for i in 0..p.x.len() {
        if !p.obstacle[i] {
            continue;
        }
        // ISO: terrain screens too, but only where it actually blocks
        let (x, z) = (p.x[i], p.o[i]);
        if z > line(x) {
            blocked = true;
        }
        while hull.len() >= 2 {
            let (ox, oz) = hull[hull.len() - 2];
            let (ax, az) = hull[hull.len() - 1];
            if (ax - ox) * (z - oz) - (az - oz) * (x - ox) >= 0.0 {
                hull.pop();
            } else {
                break;
            }
        }
        hull.push((x, z));
    }
    while hull.len() >= 2 {
        let (ox, oz) = hull[hull.len() - 2];
        let (ax, az) = hull[hull.len() - 1];
        if (ax - ox) * (zr - oz) - (az - oz) * (d - ox) >= 0.0 {
            hull.pop();
        } else {
            break;
        }
    }
    hull.push((d, zr));
    if !blocked || hull.len() < 3 {
        return None;
    }
    let seg = |a: (f64, f64), b: (f64, f64)| ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
    let mut len = 0.0;
    for w in hull.windows(2) {
        len += seg(w[0], w[1]);
    }
    let dss = seg(hull[0], hull[1]);
    let dsr = seg(hull[hull.len() - 2], hull[hull.len() - 1]);
    let e = (len - dss - dsr).max(0.0);
    let direct = seg((0.0, zs), (d, zr));
    Some(((len - direct).max(0.0), dss, dsr, e, hull.len() > 3 && e > 0.01))
}

/// D_z per band (ISO 9613-2 eq. 14), with the 20 / 25 dB cap.
pub fn dz(z: f64, dss: f64, dsr: f64, d: f64, e: f64, multiple: bool, kmet_on: bool) -> [f64; NB] {
    let mut out = [0.0; NB];
    let kmet = if kmet_on && z > 0.0 { (-(1.0 / 2000.0) * (dss * dsr * d / (2.0 * z)).sqrt()).exp() } else { 1.0 };
    for (b, f) in BANDS.iter().enumerate() {
        let lam = C0 / f;
        let c3 = if multiple && e > 0.0 {
            let t = (5.0 * lam / e).powi(2);
            (1.0 + t) / (1.0 / 3.0 + t)
        } else {
            1.0
        };
        let v = 10.0 * (3.0 + (20.0 / lam) * c3 * z * kmet).log10();
        out[b] = v.min(if multiple { 25.0 } else { 20.0 });
    }
    out
}

/// Attenuation of one direct path.
pub fn attenuation(sc: &Scene, p: &Profile) -> IsoPath {
    let d = p.d;
    let d3 = (d * d + (p.zr - p.zs).powi(2)).sqrt().max(1.0);
    let (a0, b0) = mean_plane(p, sc);
    let n = (1.0 + b0 * b0).sqrt();
    let hs = ((p.zs - a0) / n).max(0.0);
    let hr = ((p.zr - (a0 + b0 * d)) / n).max(0.0);
    let dp = d;

    // A_gr, general method
    let mut agr = [0.0; NB];
    let ls = (30.0 * hs).min(dp);
    let lr = (30.0 * hr).min(dp - ls);
    let gs = g_share(p, sc, 0.0, ls.max(0.5));
    let gr = g_share(p, sc, (dp - lr).min(dp - 0.5), dp);
    region(&mut agr, hs, gs, dp);
    region(&mut agr, hr, gr, dp);
    let lim = 30.0 * (hs + hr);
    let q = if dp <= lim { 0.0 } else { 1.0 - lim / dp };
    if q > 0.0 {
        let gm = g_share(p, sc, ls, dp - lr);
        agr[0] += -3.0 * q;
        for v in agr.iter_mut().skip(1) {
            *v += -3.0 * q * (1.0 - gm);
        }
    }

    let mut a = [0.0; NB];
    let adiv = 20.0 * d3.log10() + 11.0;
    let mut spread = [0.0; NB];
    for b in 0..NB {
        spread[b] = adiv + sc.alpha[b] * d3;
    }
    let blocked;
    match hull_path(p) {
        Some((z, dss, dsr, e, multiple)) => {
            blocked = true;
            let dzv = dz(z, dss, dsr, d3, e, multiple, true);
            for b in 0..NB {
                // A_bar = D_z − A_gr ≥ 0, so A_gr + A_bar = max(D_z, A_gr)
                let abar = (dzv[b] - agr[b]).max(0.0);
                a[b] = adiv + sc.alpha[b] * d3 + agr[b] + abar;
            }
        }
        None => {
            blocked = false;
            for b in 0..NB {
                a[b] = adiv + sc.alpha[b] * d3 + agr[b];
            }
        }
    }
    IsoPath { a, agr, spread, hs, hr, dp, blocked }
}

/// C_met for a path and C0 (eq. 21, 22).
pub fn cmet(c0: f64, hs: f64, hr: f64, dp: f64) -> f64 {
    let lim = 10.0 * (hs + hr);
    if dp <= lim { 0.0 } else { c0 * (1.0 - lim / dp) }
}

/// ISO 7.5 size criterion: a surface reflects band λ only if
/// 1/λ > [2 / (l_min cos β)²] · [d_so d_or / (d_so + d_or)].
pub fn reflects(lambda: f64, lmin: f64, cos_beta: f64, dso: f64, dor: f64) -> bool {
    let lc = (lmin * cos_beta.abs()).max(1e-6);
    1.0 / lambda > (2.0 / (lc * lc)) * (dso * dor / (dso + dor).max(1e-6))
}
