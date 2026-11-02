//! CNOSSOS-EU sound propagation (Directive (EU) 2015/996, Annex II, 2.5, as
//! amended by Directive (EU) 2021/1226) — the method required for strategic
//! noise maps under the END (in Italy D.Lgs. 194/2005 and 42/2017).
//!
//! Per octave band, along the vertical profile, for homogeneous (H) and
//! favourable (F) conditions:
//!
//!   L_H = L_W − A_div − A_atm − A_boundary,H
//!   L_F = L_W − A_div − A_atm − A_boundary,F
//!   L_LT = 10 lg( p 10^{L_F/10} + (1 − p) 10^{L_H/10} )
//!
//! * A_div = 20 lg d + 11, A_atm = α d (ISO 9613-1)
//! * A_ground (no diffraction), heights above the mean ground plane:
//!     A = max(−10 lg[4k²/d_p² (z_s² − √(2C_f/k) z_s + C_f/k)(z_r² − √(2C_f/k) z_r + C_f/k)], A_min)
//!     C_f = d_p (1 + 3 w d_p e^{−√(w d_p)}) / (1 + w d_p)
//!     w = 0.0185 f^2.5 G_w^2.6 / (f^1.5 G_w^2.6 + 1.3·10³ f^0.75 G_w^1.3 + 1.16·10⁶)
//!   H: G_w = G'_path, A_min = −3(1 − G'_path); G_path = 0 → −3 dB
//!   F: heights + δz_s/δz_r (a0 = 2·10⁻⁴ m⁻¹) + δz_T = 6·10⁻³ d_p/(z_s + z_r),
//!      G_w = G_path, A_min = −3(1 − G'_path)[1 + 2(1 − 30(z_s+z_r)/d_p)] beyond 30(z_s+z_r)
//!   G'_path = G_path d_p/30(z_s+z_r) + G_s (1 − d_p/30(z_s+z_r)) close to the source, G_s = 0 (road)
//! * Diffraction: Δ_dif = 10 lg(3 + 40/λ C'' δ) if 40/λ C'' δ ≥ −2, else 0, ≤ 25 dB,
//!   C'' = 1 or (1 + (5λ/e)²)/(1/3 + (5λ/e)²) for multiple edges;
//!   A_dif = Δ_dif(S,R) + Δ_ground(S,O) + Δ_ground(O,R),
//!   Δ_ground(S,O) = −20 lg(1 + (10^{−A_ground(S,O)/20} − 1) 10^{−(Δ_dif(S',R) − Δ_dif(S,R))/20}).
//!   Under F the path differences are taken along circular arcs of radius
//!   Γ = max(1000 m, 8 d).
//!
//! Reflections: image sources, L_W + 10 lg(1 − α). Lateral diffraction is not
//! part of the method and is not applied in this mode.

use crate::bands::{BANDS, NB};
use crate::iso9613::g_of_sigma;
use crate::path::{Kind, Profile};
use crate::scene::Scene;
use crate::turbulence::C0;
use std::f64::consts::PI;

const A0: f64 = 2.0e-4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cond {
    Homogeneous,
    Favourable,
}

/// Fraction of porous ground between x0 and x1 along the profile.
fn g_path(p: &Profile, sc: &Scene, x0: f64, x1: f64) -> f64 {
    let (mut n, mut s) = (0.0, 0.0);
    for i in 0..p.x.len() {
        if p.x[i] < x0 || p.x[i] > x1 {
            continue;
        }
        let t = p.x[i] / p.d;
        s += g_of_sigma(sc.sigma.nearest(p.sx + (p.rx - p.sx) * t, p.sy + (p.ry - p.sy) * t));
        n += 1.0;
    }
    if n == 0.0 { 0.0 } else { s / n }
}

/// Mean plane z = a + b x over terrain samples in [i0, i1) plus two end points.
fn plane(x: &[f64], z: &[f64], i0: usize, i1: usize, ends: [(f64, f64); 2]) -> (f64, f64) {
    let (mut n, mut sx, mut sz, mut sxx, mut sxz) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut add = |xi: f64, zi: f64| {
        n += 1.0;
        sx += xi;
        sz += zi;
        sxx += xi * xi;
        sxz += xi * zi;
    };
    for i in i0..i1.min(x.len()) {
        add(x[i], z[i]);
    }
    for (a, b) in ends {
        add(a, b);
    }
    let den = n * sxx - sx * sx;
    if den.abs() < 1e-9 {
        return (sz / n, 0.0);
    }
    let b = (n * sxz - sx * sz) / den;
    ((sz - b * sx) / n, b)
}

/// Height of (x, z) above the plane and its projection along it.
fn above(a: f64, b: f64, x: f64, z: f64) -> (f64, f64) {
    let n = (1.0 + b * b).sqrt();
    ((x + b * (z - a)) / n, ((z - (a + b * x)) / n).max(0.0))
}

/// CNOSSOS ground attenuation per band, eq. 2.5.15 / 2.5.16.
fn a_ground(zs: f64, zr: f64, dp: f64, g_path: f64, cond: Cond) -> [f64; NB] {
    let mut out = [0.0; NB];
    let zs = zs.max(0.0);
    let zr = zr.max(0.0);
    let lim = 30.0 * (zs + zr);
    let g_prime = if dp <= lim && lim > 0.0 { g_path * dp / lim } else { g_path }; // G_s = 0 (road)
    let (zs_e, zr_e, gw, amin) = match cond {
        Cond::Homogeneous => (zs, zr, g_prime, -3.0 * (1.0 - g_prime)),
        Cond::Favourable => {
            let sum = (zs + zr).max(1e-3);
            let dzs = A0 * (zs / sum).powi(2) * dp * dp / 2.0;
            let dzr = A0 * (zr / sum).powi(2) * dp * dp / 2.0;
            let dzt = 6.0e-3 * dp / sum;
            let amin = if dp <= lim { -3.0 * (1.0 - g_prime) } else { -3.0 * (1.0 - g_prime) * (1.0 + 2.0 * (1.0 - lim / dp)) };
            (zs + dzs + dzt, zr + dzr + dzt, g_path, amin)
        }
    };
    if g_path <= 0.0 {
        let v = if cond == Cond::Homogeneous { -3.0 } else { amin };
        return [v; NB];
    }
    for (b, f) in BANDS.iter().enumerate() {
        let k = 2.0 * PI * f / C0;
        let w = 0.0185 * f.powf(2.5) * gw.powf(2.6)
            / (f.powf(1.5) * gw.powf(2.6) + 1.3e3 * f.powf(0.75) * gw.powf(1.3) + 1.16e6);
        let cf = dp * (1.0 + 3.0 * w * dp * (-(w * dp).sqrt()).exp()) / (1.0 + w * dp);
        let q = (2.0 * cf / k).sqrt();
        let term = (4.0 * k * k / (dp * dp)) * (zs_e * zs_e - q * zs_e + cf / k) * (zr_e * zr_e - q * zr_e + cf / k);
        let a = if term > 0.0 { -10.0 * term.log10() } else { amin };
        out[b] = a.max(amin);
    }
    out
}

/// Δ_dif for a path difference δ (eq. 2.5.21), per band.
fn delta_dif(delta: f64, e: f64, multiple: bool) -> [f64; NB] {
    let mut out = [0.0; NB];
    for (b, f) in BANDS.iter().enumerate() {
        let lam = C0 / f;
        let c2 = if multiple && e > 0.0 {
            let t = (5.0 * lam / e).powi(2);
            (1.0 + t) / (1.0 / 3.0 + t)
        } else {
            1.0
        };
        let x = 40.0 / lam * c2 * delta;
        out[b] = if x >= -2.0 { (10.0 * (3.0 + x).log10()).min(25.0) } else { 0.0 };
    }
    out
}

/// Length between two points: straight (H) or along an arc of radius Γ (F).
fn len(a: (f64, f64), b: (f64, f64), gamma: f64) -> f64 {
    let c = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
    if gamma.is_finite() {
        2.0 * gamma * (c / (2.0 * gamma)).min(1.0).asin()
    } else {
        c
    }
}

struct Edges {
    /// hull vertices between S and R (profile indices)
    idx: Vec<usize>,
    blocked: bool,
}

/// Diffraction points: convex hull over obstacles (heights lowered by the ray
/// curvature under F); if nothing blocks, the building or barrier point that
/// comes closest to the ray.
fn edges(p: &Profile, gamma: f64) -> Option<Edges> {
    let d = p.d;
    let off = |x: f64| if gamma.is_finite() { x * (d - x) / (2.0 * gamma) } else { 0.0 };
    let line = |x: f64| p.zs + (p.zr - p.zs) * x / d;
    let mut hull: Vec<(f64, f64, usize)> = vec![(0.0, p.zs, usize::MAX)];
    let mut blocked = false;
    for i in 0..p.x.len() {
        if !p.obstacle[i] {
            continue;
        }
        let (x, z) = (p.x[i], p.o[i] - off(p.x[i]));
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
        if (ax - ox) * (p.zr - oz) - (az - oz) * (d - ox) >= 0.0 {
            hull.pop();
        } else {
            break;
        }
    }
    if blocked && hull.len() >= 2 {
        return Some(Edges { idx: hull[1..].iter().map(|h| h.2).collect(), blocked: true });
    }
    let mut best = f64::NEG_INFINITY;
    let mut bi = usize::MAX;
    for i in 0..p.x.len() {
        if !p.obstacle[i] || p.kind[i] == Kind::Terrain {
            continue;
        }
        let x = p.x[i];
        let h = p.o[i] - off(x) - line(x);
        let v = h * (1.0 / x.max(0.1) + 1.0 / (d - x).max(0.1)).sqrt();
        if v > best {
            best = v;
            bi = i;
        }
    }
    if bi == usize::MAX {
        return None;
    }
    Some(Edges { idx: vec![bi], blocked: false })
}

/// A_boundary per band for one condition (ground, or diffraction with ground).
pub fn boundary(sc: &Scene, p: &Profile, cond: Cond) -> [f64; NB] {
    let d = p.d;
    let s = (0.0, p.zs);
    let r = (d, p.zr);
    let gs = sc.ground.bilinear(p.sx, p.sy);
    let gr = sc.ground.bilinear(p.rx, p.ry);
    let n = p.x.len();
    let d3 = ((d * d) + (p.zr - p.zs).powi(2)).sqrt();
    let gamma = if cond == Cond::Favourable { (8.0 * d3).max(1000.0) } else { f64::INFINITY };

    let ground_whole = || {
        let (a, b) = plane(&p.x, &p.g, 0, n, [(0.0, gs), (d, gr)]);
        let (us, zs) = above(a, b, s.0, s.1);
        let (ur, zr) = above(a, b, r.0, r.1);
        a_ground(zs, zr, (ur - us).abs().max(0.5), g_path(p, sc, 0.0, d), cond)
    };

    let Some(ed) = edges(p, gamma) else {
        return ground_whole();
    };
    let o1 = (p.x[ed.idx[0]], p.o[ed.idx[0]]);
    let on = (p.x[*ed.idx.last().unwrap()], p.o[*ed.idx.last().unwrap()]);
    // path difference S → O1 … On → R
    let mut chain = 0.0;
    for w in ed.idx.windows(2) {
        chain += len((p.x[w[0]], p.o[w[0]]), (p.x[w[1]], p.o[w[1]]), gamma);
    }
    let e = chain;
    let multiple = ed.idx.len() > 1 && e > 0.01;
    let path_diff = |a: (f64, f64), b: (f64, f64)| {
        let v = len(a, o1, gamma) + chain + len(on, b, gamma) - len(a, b, gamma);
        if ed.blocked { v } else { -v }
    };
    let dd = delta_dif(path_diff(s, r), e, multiple);
    if !ed.blocked && dd.iter().all(|v| *v == 0.0) {
        return ground_whole();
    }
    // ground on each side, with its own mean plane
    let i1 = ed.idx[0];
    let i2 = *ed.idx.last().unwrap();
    let (sa, sb) = plane(&p.x, &p.g, 0, i1, [(0.0, gs), (o1.0, p.g[i1])]);
    let (ra, rb) = plane(&p.x, &p.g, i2 + 1, n, [(on.0, p.g[i2]), (d, gr)]);
    let (us, zs) = above(sa, sb, s.0, s.1);
    let (uo, zo) = above(sa, sb, o1.0, o1.1);
    let (uo2, zo2) = above(ra, rb, on.0, on.1);
    let (ur, zr) = above(ra, rb, r.0, r.1);
    let ag_so = a_ground(zs, zo, (uo - us).abs().max(0.5), g_path(p, sc, 0.0, o1.0), cond);
    let ag_or = a_ground(zo2, zr, (ur - uo2).abs().max(0.5), g_path(p, sc, on.0, d), cond);
    // image source / receiver in the side planes
    let mirror = |a: f64, b: f64, x: f64, z: f64| {
        let t = (z - a - b * x) / (1.0 + b * b);
        (x + 2.0 * t * b, z - 2.0 * t)
    };
    let s_img = mirror(sa, sb, s.0, s.1);
    let r_img = mirror(ra, rb, r.0, r.1);
    let dd_s = delta_dif(path_diff(s_img, r), e, multiple);
    let dd_r = delta_dif(path_diff(s, r_img), e, multiple);
    let mut out = [0.0; NB];
    for b in 0..NB {
        let g_so = -20.0 * (1.0 + (10f64.powf(-ag_so[b] / 20.0) - 1.0) * 10f64.powf(-(dd_s[b] - dd[b]) / 20.0)).max(1e-6).log10();
        let g_or = -20.0 * (1.0 + (10f64.powf(-ag_or[b] / 20.0) - 1.0) * 10f64.powf(-(dd_r[b] - dd[b]) / 20.0)).max(1e-6).log10();
        out[b] = dd[b] + g_so + g_or;
    }
    out
}

/// Total attenuation for H and F (A_div + A_atm + A_boundary).
pub fn attenuation(sc: &Scene, p: &Profile) -> ([f64; NB], [f64; NB]) {
    let d3 = ((p.d * p.d) + (p.zr - p.zs).powi(2)).sqrt().max(1.0);
    let spread = 20.0 * d3.log10() + 11.0;
    let bh = boundary(sc, p, Cond::Homogeneous);
    let bf = boundary(sc, p, Cond::Favourable);
    let mut h = [0.0; NB];
    let mut f = [0.0; NB];
    for b in 0..NB {
        h[b] = spread + sc.alpha[b] * d3 + bh[b];
        f[b] = spread + sc.alpha[b] * d3 + bf[b];
    }
    (h, f)
}
