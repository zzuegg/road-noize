//! Ground reflection for a point source over a locally reacting surface:
//! Delany–Bazley impedance from the flow resistivity, and the spherical-wave
//! reflection coefficient Q = R_p + (1 − R_p) F(w), which contains the ground
//! wave. Convention e^{−iωt}, propagation e^{ikr}.

use crate::special::faddeeva;
use num_complex::Complex64 as C;
use std::f64::consts::PI;

/// Normalised characteristic impedance (Delany & Bazley 1970), σ in kPa·s/m².
pub fn delany_bazley(f: f64, sigma_kpa: f64) -> C {
    let x = f / sigma_kpa; // f/σ with σ in kPa s m^-2 (= 1000 · rayl/m / 1000)
    C::new(1.0 + 9.08 * x.powf(-0.75), 11.9 * x.powf(-0.73))
}

/// Spherical-wave reflection coefficient. `psi` grazing angle (rad), `r2` length
/// of the reflected path (m), `k` wavenumber, `z` normalised impedance.
pub fn spherical_q(psi: f64, r2: f64, k: f64, z: C) -> C {
    if !z.re.is_finite() || z.norm() > 1e6 {
        return C::new(1.0, 0.0);
    }
    let beta = 1.0 / z;
    let s = psi.sin();
    let rp = (s - beta) / (s + beta);
    // numerical distance w = ½(1+i) √(k r2) (sin ψ + β)
    let w = C::new(0.5, 0.5) * (k * r2).sqrt() * (s + beta);
    let fw = C::new(1.0, 0.0) + C::new(0.0, PI.sqrt()) * w * faddeeva(w);
    rp + (C::new(1.0, 0.0) - rp) * fw
}

/// Ground types with typical effective flow resistivities (kPa·s/m²), after
/// Nord2000 / Harmonoise impedance classes.
pub fn sigma_of(class: &str) -> f64 {
    match class {
        "snow" => 12.5,
        "forest" => 31.5,
        "grass" => 200.0,
        "pasture" => 80.0,
        "orchard" => 125.0,
        "gravel" => 500.0,
        "compacted" => 2000.0,
        "asphalt" | "hard" => 20000.0,
        "water" | "concrete" => 200000.0,
        _ => 200.0,
    }
}
