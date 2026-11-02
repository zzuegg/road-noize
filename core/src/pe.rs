//! Crank–Nicolson parabolic equation (wide-angle Padé (1,1)) in a vertical
//! section — a wave solution of sound propagation over terrain with
//! refraction and turbulence, used as the reference "physics view" of a
//! cross-section.
//!
//!   p(r,z) = ψ(r,z) e^{ik₀r} / √r
//!   [1 + (¼ − ik₀Δr/4) Q] ψⁿ⁺¹ = [1 + (¼ + ik₀Δr/4) Q] ψⁿ
//!   Q = k₀⁻² ∂²/∂z² + n²(z) − 1
//!
//! Ground: locally reacting impedance, ∂p/∂z = −ik β p (e^{−iωt}).
//! Terrain, buildings and barriers: staircase ground (the field below the
//! surface is zero and the impedance condition applies on top), barrier and
//! roof tops rigid.
//! Atmosphere: c(z) = c₀ + b ln(1 + z/z₀) above the local ground (b > 0
//! downward refraction, e.g. downwind or a night inversion).
//! Turbulence: random phase screens with a Gaussian spectrum every few metres;
//! |p|² is averaged over realisations.
//! Top: absorbing layer.
//!
//! Limits: one-way (no back-scatter: reflections towards the source, e.g. off
//! a wall on the far side of the road, are not in the PE — the ray engine has
//! them); the ground is single-valued, so an overhanging barrier top is filled
//! in underneath.

use crate::ground::delany_bazley;
use crate::turbulence::{Turbulence, C0};
use num_complex::Complex64 as C;
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeInput {
    /// section samples: distance from the source (m), ground height, surface
    /// height (ground + building/barrier), flow resistivity of the surface
    pub dist: Vec<f64>,
    pub ground: Vec<f64>,
    pub surface: Vec<f64>,
    pub sigma: Vec<f64>,
    /// source height above the ground at distance 0
    pub source_height: f64,
    /// field computed up to this height above the highest surface, m
    pub top: f64,
    pub freqs: Vec<f64>,
    /// log-profile coefficient b (m/s) and roughness z0 (m)
    pub b: f64,
    #[serde(default = "z0")]
    pub z0: f64,
    pub turbulence: Option<Turbulence>,
    #[serde(default = "realisations")]
    pub realisations: usize,
    /// output grid spacing
    pub out_dr: f64,
    pub out_dz: f64,
}

fn z0() -> f64 {
    0.1
}
fn realisations() -> usize {
    6
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeOutput {
    pub cols: usize,
    pub rows: usize,
    pub out_dr: f64,
    pub out_dz: f64,
    /// absolute height of row 0
    pub z_bottom: f64,
    /// per frequency: excess attenuation re free field (dB), rows × cols,
    /// row 0 at the bottom; NaN below the surface
    pub delta_l: Vec<Vec<f32>>,
}

fn interp(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    if x <= xs[0] {
        return ys[0];
    }
    if x >= xs[xs.len() - 1] {
        return ys[ys.len() - 1];
    }
    let i = xs.partition_point(|v| *v < x).max(1);
    let t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]).max(1e-9);
    ys[i - 1] + (ys[i] - ys[i - 1]) * t
}

fn nearest(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    let i = xs.partition_point(|v| *v < x).min(xs.len() - 1);
    if i > 0 && (x - xs[i - 1]).abs() < (xs[i] - x).abs() { ys[i - 1] } else { ys[i] }
}

/// Thomas algorithm for a tridiagonal system (a sub, b diag, c super), in place in d.
fn thomas(a: &[C], b: &[C], c: &[C], d: &mut [C], cp: &mut [C]) {
    let n = d.len();
    if n == 0 {
        return;
    }
    cp[0] = c[0] / b[0];
    d[0] /= b[0];
    for i in 1..n {
        let m = b[i] - a[i] * cp[i - 1];
        cp[i] = c[i] / m;
        d[i] = (d[i] - a[i] * d[i - 1]) / m;
    }
    for i in (0..n - 1).rev() {
        let next = d[i + 1];
        d[i] -= cp[i] * next;
    }
}

/// One realisation of a Gaussian-spectrum refractive-index profile μ(z),
/// variance mu2, correlation length l, as a sum of random Fourier modes.
fn phase_screen(rng: &mut SmallRng, dz: f64, mu2: f64, l: f64, out: &mut [f64]) {
    out.iter_mut().for_each(|v| *v = 0.0);
    let modes = 48;
    let amp = (2.0 * mu2 / modes as f64).sqrt();
    for _ in 0..modes {
        // κ drawn from the Gaussian spectrum of the correlation exp(−z²/l²)
        let u: f64 = rng.gen::<f64>().max(1e-12);
        let kappa = (-u.ln()).sqrt() * 2.0 / l;
        let phi = rng.gen::<f64>() * 2.0 * PI;
        for (j, v) in out.iter_mut().enumerate() {
            *v += amp * (kappa * j as f64 * dz + phi).cos();
        }
    }
}

pub fn solve(input: &PeInput) -> PeOutput {
    let range = *input.dist.last().unwrap_or(&100.0);
    let zmin = input.ground.iter().cloned().fold(f64::MAX, f64::min) - 0.5;
    let zmax = input.surface.iter().cloned().fold(f64::MIN, f64::max) + input.top;
    let out_cols = (range / input.out_dr).floor() as usize + 1;
    let out_rows = ((zmax - zmin) / input.out_dz).ceil() as usize + 1;
    let mut delta_l = Vec::new();
    let turb = input.turbulence;
    let reals = if turb.is_some() { input.realisations.max(1) } else { 1 };
    let g0 = interp(&input.dist, &input.ground, 0.0);
    let zs_abs = g0 + input.source_height;

    for &f in &input.freqs {
        let k = 2.0 * PI * f / C0;
        let lambda = C0 / f;
        let dz = lambda / 10.0;
        let dr = lambda / 2.0;
        let layer = (40.0 * lambda).max(10.0);
        let ztop = zmax + layer;
        let nz = ((ztop - zmin) / dz).ceil() as usize + 1;
        let mut acc = vec![0.0f64; out_cols * out_rows];
        let mut screen = vec![0.0; nz];

        // range-dependent quantities, shared by every realisation
        let steps = (range / dr).ceil() as usize;

        for real in 0..reals {
            let mut rng = SmallRng::seed_from_u64(1234 + real as u64 * 7919 + f as u64);
            // Gaussian starter (wide-angle, Salomons) with its ground image
            let mut psi = vec![C::new(0.0, 0.0); nz];
            let beta0 = 1.0 / delany_bazley(f, nearest(&input.dist, &input.sigma, 0.0));
            let rimg = (C::new(1.0, 0.0) - beta0) / (C::new(1.0, 0.0) + beta0);
            let sqik = C::new(0.0, k).sqrt();
            for (j, v) in psi.iter_mut().enumerate() {
                let z = zmin + j as f64 * dz;
                if z < g0 {
                    continue;
                }
                let u = k * (z - zs_abs);
                let w = k * (z - (2.0 * g0 - zs_abs));
                let s1 = (1.3717 - 0.3701 * u * u) * (-u * u / 3.0).exp();
                let s2 = (1.3717 - 0.3701 * w * w) * (-w * w / 3.0).exp();
                *v = sqik * (C::new(s1, 0.0) + rimg * s2);
            }
            let mut a = vec![C::new(0.0, 0.0); nz];
            let mut b = vec![C::new(0.0, 0.0); nz];
            let mut c = vec![C::new(0.0, 0.0); nz];
            let mut rhs = vec![C::new(0.0, 0.0); nz];
            let mut cp = vec![C::new(0.0, 0.0); nz];
            let mut nsq = vec![C::new(0.0, 0.0); nz];
            let alpha_l = C::new(0.25, -k * dr / 4.0);
            let alpha_r = C::new(0.25, k * dr / 4.0);
            let inv_k2dz2 = 1.0 / (k * k * dz * dz);
            let screen_every = turb.map(|t| (t.outer_scale * 4.0).max(4.0)).unwrap_or(f64::MAX);
            let mut next_screen = screen_every;
            let mut next_out = 1usize;
            let mut last_gz = f64::NAN;

            for step in 1..=steps {
                let r = step as f64 * dr;
                let gz = interp(&input.dist, &input.ground, r);
                let sz = nearest(&input.dist, &input.surface, r).max(gz);
                let jg = (((sz - zmin) / dz).round().max(0.0) as usize).min(nz - 3);
                let hard = sz > gz + 0.05;
                let sigma = if hard { 2.0e5 } else { nearest(&input.dist, &input.sigma, r) };
                let beta = 1.0 / delany_bazley(f, sigma);
                // refractive index squared above the local ground + absorbing layer
                if gz != last_gz {
                    for (j, n2) in nsq.iter_mut().enumerate() {
                        let z = zmin + j as f64 * dz;
                        let hag = (z - gz).max(0.0);
                        let cz = C0 + input.b * (1.0 + hag / input.z0).ln();
                        let mut v = C::new((C0 / cz).powi(2), 0.0);
                        if z > zmax {
                            let t = (z - zmax) / layer;
                            v += C::new(0.0, 0.5 * t * t);
                        }
                        *n2 = v;
                    }
                    last_gz = gz;
                }
                for v in psi.iter_mut().take(jg) {
                    *v = C::new(0.0, 0.0);
                }
                // unknowns j = jg .. nz-2 (the top value stays 0)
                let m = nz - 1 - jg;
                for i in 0..m {
                    let j = jg + i;
                    let qo = C::new(inv_k2dz2, 0.0);
                    let mut qdiag = C::new(-2.0 * inv_k2dz2, 0.0) + nsq[j] - 1.0;
                    let (mut ql, mut qu) = (qo, qo);
                    if i == 0 {
                        // ghost point from ∂ψ/∂z = −ikβψ
                        ql = C::new(0.0, 0.0);
                        qu = qo * 2.0;
                        qdiag += C::new(0.0, 2.0 * k * dz) * beta * inv_k2dz2;
                    }
                    a[i] = alpha_l * ql;
                    b[i] = C::new(1.0, 0.0) + alpha_l * qdiag;
                    c[i] = alpha_l * qu;
                    let left = if i == 0 { C::new(0.0, 0.0) } else { psi[j - 1] };
                    let right = psi[j + 1];
                    rhs[i] = psi[j] + alpha_r * (ql * left + qdiag * psi[j] + qu * right);
                }
                thomas(&a[..m], &b[..m], &c[..m], &mut rhs[..m], &mut cp[..m]);
                psi[jg..jg + m].copy_from_slice(&rhs[..m]);
                psi[nz - 1] = C::new(0.0, 0.0);

                if let Some(t) = turb {
                    if r >= next_screen {
                        phase_screen(&mut rng, dz, t.mu2(), t.outer_scale, &mut screen);
                        for j in jg..nz {
                            psi[j] *= C::new(0.0, k * screen_every * screen[j]).exp();
                        }
                        next_screen += screen_every;
                    }
                }

                while next_out < out_cols && (next_out as f64) * input.out_dr <= r {
                    let col = next_out;
                    let rr = col as f64 * input.out_dr;
                    for row in 0..out_rows {
                        let z = zmin + row as f64 * input.out_dz;
                        if z < sz {
                            continue;
                        }
                        let jf = (z - zmin) / dz;
                        let j0 = (jf.floor() as usize).min(nz - 2);
                        let t = jf - j0 as f64;
                        let v = psi[j0] * (1.0 - t) + psi[j0 + 1] * t;
                        // excess attenuation re free field: |ψ|²/r · R²
                        let rdist2 = rr * rr + (z - zs_abs).powi(2);
                        acc[row * out_cols + col] += v.norm_sqr() / rr * rdist2 / reals as f64;
                    }
                    next_out += 1;
                }
            }
        }
        let mut out = vec![f32::NAN; out_cols * out_rows];
        for col in 1..out_cols {
            let rr = col as f64 * input.out_dr;
            let sz = nearest(&input.dist, &input.surface, rr).max(interp(&input.dist, &input.ground, rr));
            for row in 0..out_rows {
                let z = zmin + row as f64 * input.out_dz;
                let v = acc[row * out_cols + col];
                if z >= sz && v > 0.0 {
                    out[row * out_cols + col] = (10.0 * v.log10()) as f32;
                }
            }
        }
        delta_l.push(out);
    }
    PeOutput { cols: out_cols, rows: out_rows, out_dr: input.out_dr, out_dz: input.out_dz, z_bottom: zmin, delta_l }
}
