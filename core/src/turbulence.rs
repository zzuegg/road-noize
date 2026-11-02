//! Atmospheric turbulence.
//!
//! Two effects matter for traffic noise:
//!
//! 1. Loss of coherence between paths (direct vs ground-reflected, over vs
//!    around a barrier): fills the interference dips. Daigle (1979) with a
//!    Gaussian spectrum: F = exp(−σ²(1−ρ)),  σ² = √π ⟨μ²⟩ k² R L,
//!    ρ = (√π/2)(L/h) erf(h/L), h = transverse separation of the paths.
//!
//! 2. Scattering into a barrier's shadow, which caps the screening. Kolmogorov
//!    scaling as in Nord2000: ΔL = 25 + 10 lg γ_T + 3 lg(f/1 kHz) + 10 lg(R/100 m)
//!    relative to free field, γ_T = C_T²/T² + (22/3) C_v²/c². The angular
//!    dependence is neglected, which makes the cap conservative (a barrier is
//!    never credited with more than turbulence allows).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Turbulence {
    /// Temperature structure parameter C_T², K² m^-2/3.
    pub ct2: f64,
    /// Wind velocity structure parameter C_v², m^4/3 s^-2.
    pub cv2: f64,
    /// Outer scale for the Gaussian coherence model, m.
    pub outer_scale: f64,
}

impl Default for Turbulence {
    fn default() -> Self {
        // Moderate turbulence (Nord2000 default class).
        Turbulence { ct2: 0.008, cv2: 0.12, outer_scale: 1.1 }
    }
}

pub const C0: f64 = 340.0;
pub const T0: f64 = 288.15;

impl Turbulence {
    pub fn gamma_t(&self) -> f64 {
        self.ct2 / (T0 * T0) + (22.0 / 3.0) * self.cv2 / (C0 * C0)
    }

    /// Variance of the refractive index for the Gaussian model, derived from
    /// the structure parameters at the outer scale.
    pub fn mu2(&self) -> f64 {
        // C_n² ≈ γ_T / 4 (n = c0/c; δn ≈ −δT/2T − δv/c), ⟨μ²⟩ ≈ C_n² L^{2/3}
        (self.gamma_t() / 4.0) * self.outer_scale.powf(2.0 / 3.0)
    }

    /// Coherence factor between two paths of length `r` separated by `h`.
    pub fn coherence(&self, k: f64, r: f64, h: f64) -> f64 {
        let l = self.outer_scale;
        let sigma2 = self.phase_const() * k * k * r;
        let rho = if h < 1e-6 {
            1.0
        } else {
            (std::f64::consts::PI.sqrt() / 2.0) * (l / h) * erf(h / l)
        };
        (-sigma2 * (1.0 - rho)).exp()
    }

    /// √π ⟨μ²⟩ L, the frequency- and range-independent part of σ².
    #[inline]
    pub fn phase_const(&self) -> f64 {
        std::f64::consts::PI.sqrt() * self.mu2() * self.outer_scale
    }

    /// Scattered energy reaching a shadowed receiver, relative to free field (linear).
    pub fn scatter_floor(&self, f: f64, r: f64) -> f64 {
        let g = self.gamma_t();
        if g <= 0.0 {
            return 0.0;
        }
        let db = 25.0 + 10.0 * g.log10() + 3.0 * (f / 1000.0).log10() + 10.0 * (r.max(1.0) / 100.0).log10();
        10f64.powf(db / 10.0)
    }
}

/// erf, Abramowitz–Stegun 7.1.26 (|ε| < 1.5e-7).
pub fn erf(x: f64) -> f64 {
    let s = x.signum();
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0
        - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
            * t
            * (-x * x).exp();
    s * y
}
