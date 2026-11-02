//! Road traffic sound power after CNOSSOS-EU (Directive (EU) 2015/996, Annex II).
//!   L_WR = A_R + B_R lg(v/70)        rolling
//!   L_WP = A_P + B_P (v−70)/70        propulsion
//!   L_W' = L_W + 10 lg(Q/(1000 v))    per metre of line

use crate::bands::NB;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Light,
    Medium,
    Heavy,
    Moped,
    Moto,
}

pub const CATEGORIES: [Category; 5] =
    [Category::Light, Category::Medium, Category::Heavy, Category::Moped, Category::Moto];

struct Coeffs {
    ar: [f64; NB],
    br: [f64; NB],
    ap: [f64; NB],
    bp: [f64; NB],
}

const Z: [f64; NB] = [0.0; NB];

fn coeffs(c: Category) -> Coeffs {
    match c {
        Category::Light => Coeffs {
            ar: [79.7, 85.7, 84.5, 90.2, 97.3, 93.9, 84.1, 74.3],
            br: [30.0, 41.5, 38.9, 25.7, 32.5, 37.2, 39.0, 40.0],
            ap: [94.5, 89.2, 88.0, 85.9, 84.2, 86.9, 83.3, 76.1],
            bp: [-1.3, 7.2, 7.7, 8.0, 8.0, 8.0, 8.0, 8.0],
        },
        Category::Medium => Coeffs {
            ar: [84.0, 88.7, 91.5, 96.7, 97.4, 90.9, 83.8, 80.5],
            br: [30.0, 35.8, 32.6, 23.8, 30.1, 36.2, 38.3, 40.1],
            ap: [101.0, 96.5, 98.8, 96.8, 98.6, 95.2, 88.8, 82.7],
            bp: [-1.9, 4.7, 6.4, 6.5, 6.5, 6.5, 6.5, 6.5],
        },
        Category::Heavy => Coeffs {
            ar: [87.0, 91.7, 94.1, 100.7, 100.8, 94.3, 87.1, 82.5],
            br: [30.0, 33.5, 31.3, 25.4, 31.8, 37.1, 38.6, 40.6],
            ap: [104.4, 100.6, 101.7, 101.0, 100.1, 95.9, 91.3, 85.3],
            bp: [0.0, 3.0, 4.6, 5.0, 5.0, 5.0, 5.0, 5.0],
        },
        Category::Moped => Coeffs {
            ar: Z,
            br: Z,
            ap: [88.0, 87.5, 89.5, 93.7, 96.6, 98.8, 93.9, 88.7],
            bp: [4.2, 7.4, 9.8, 11.6, 15.7, 18.9, 20.3, 20.6],
        },
        Category::Moto => Coeffs {
            ar: Z,
            br: Z,
            ap: [95.0, 97.2, 92.7, 92.9, 94.7, 93.2, 90.1, 86.5],
            bp: [3.2, 5.9, 11.9, 11.6, 11.5, 12.6, 11.1, 12.0],
        },
    }
}

pub const MIN_SPEED: f64 = 20.0;

/// Gradient correction on propulsion noise (dB); s in %, positive uphill.
pub fn gradient_correction(c: Category, s: f64, v: f64) -> f64 {
    let s = s.clamp(-12.0, 12.0);
    match c {
        Category::Light => {
            if s < -6.0 { -s - 6.0 } else if s > 2.0 { (s - 2.0) / 1.5 } else { 0.0 }
        }
        Category::Medium => {
            if s < -4.0 { ((-s - 4.0) / 0.7) * ((v - 20.0) / 100.0) } else if s > 0.0 { s * v / 100.0 } else { 0.0 }
        }
        Category::Heavy => {
            if s < -4.0 { ((-s - 4.0) / 0.5) * ((v - 10.0) / 100.0) } else if s > 0.0 { (s / 0.8) * v / 100.0 } else { 0.0 }
        }
        _ => 0.0,
    }
}

/// Single-vehicle sound power per band, dB re 1 pW.
pub fn vehicle_power(c: Category, speed: f64, gradient: f64, surface: f64, extra: f64) -> [f64; NB] {
    let v = speed.max(MIN_SPEED);
    let k = coeffs(c);
    let rolling = !matches!(c, Category::Moped | Category::Moto);
    let g = gradient_correction(c, gradient, v);
    let mut out = [0.0; NB];
    for b in 0..NB {
        let lp = k.ap[b] + k.bp[b] * (v - 70.0) / 70.0 + g;
        let mut e = 10f64.powf(lp / 10.0);
        if rolling {
            let lr = k.ar[b] + k.br[b] * (v / 70.0).log10() + surface;
            e += 10f64.powf(lr / 10.0);
        }
        out[b] = 10.0 * e.log10() + extra;
    }
    out
}

/// Linear power per metre (10^(Lw'/10)) of a stream of `flow` veh/h.
pub fn stream_power(c: Category, flow: f64, speed: f64, gradient: f64, surface: f64, extra: f64) -> [f64; NB] {
    let mut out = [0.0; NB];
    if flow <= 0.0 {
        return out;
    }
    let v = speed.max(MIN_SPEED);
    let lw = vehicle_power(c, v, gradient, surface, extra);
    let k = flow / (1000.0 * v);
    for b in 0..NB {
        out[b] = 10f64.powf(lw[b] / 10.0) * k;
    }
    out
}

/// Rolling and propulsion parts of one vehicle, linear power per band.
pub fn vehicle_parts(c: Category, speed: f64, gradient: f64, surface: f64, extra: f64) -> ([f64; NB], [f64; NB]) {
    let v = speed.max(MIN_SPEED);
    let k = coeffs(c);
    let rolling = !matches!(c, Category::Moped | Category::Moto);
    let g = gradient_correction(c, gradient, v);
    let x = 10f64.powf(extra / 10.0);
    let mut r = [0.0; NB];
    let mut p = [0.0; NB];
    for b in 0..NB {
        p[b] = 10f64.powf((k.ap[b] + k.bp[b] * (v - 70.0) / 70.0 + g) / 10.0) * x;
        if rolling {
            r[b] = 10f64.powf((k.ar[b] + k.br[b] * (v / 70.0).log10() + surface) / 10.0) * x;
        }
    }
    (r, p)
}

/// Harmonoise source heights: tyre/road at 0.01 m, engine at 0.30 m (cars,
/// two-wheelers) or 0.75 m (vans, trucks).
pub const SOURCE_HEIGHTS: [f64; 3] = [0.01, 0.30, 0.75];

/// Share of (rolling, propulsion) energy put at each source height.
pub fn height_split(c: Category) -> [(f64, f64); 3] {
    match c {
        Category::Medium | Category::Heavy => [(0.8, 0.2), (0.0, 0.0), (0.2, 0.8)],
        _ => [(0.8, 0.2), (0.2, 0.8), (0.0, 0.0)],
    }
}
