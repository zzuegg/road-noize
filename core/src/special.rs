//! Special functions: the Faddeeva function w(z) (Humlíček 1982, W4 — relative
//! accuracy ~1e-4, plenty for a reflection coefficient) and the Fresnel
//! integrals for knife-edge diffraction.

use num_complex::Complex64 as C;
use std::f64::consts::PI;

/// w(z) = exp(−z²) erfc(−i z), valid in the whole complex plane.
pub fn faddeeva(z: C) -> C {
    if z.im < 0.0 {
        // w(z) = 2 exp(−z²) − w(−z)
        return 2.0 * (-(z * z)).exp() - faddeeva(-z);
    }
    let x = z.re;
    let y = z.im;
    let t = C::new(y, -x);
    let s = x.abs() + y;
    if s >= 15.0 {
        t * 0.5641896 / (0.5 + t * t)
    } else if s >= 5.5 {
        let u = t * t;
        t * (1.410474 + u * 0.5641896) / (0.75 + u * (3.0 + u))
    } else if y >= 0.195 * x.abs() - 0.176 {
        (16.4955 + t * (20.20933 + t * (11.96482 + t * (3.778987 + t * 0.5642236))))
            / (16.4955 + t * (38.82363 + t * (39.27121 + t * (21.69274 + t * (6.699398 + t)))))
    } else {
        let u = t * t;
        u.exp()
            - t * (36183.31 - u * (3321.9905 - u * (1540.787 - u * (219.0313 - u * (35.76683 - u * (1.320522 - u * 0.56419))))))
                / (32066.6 - u * (24322.84 - u * (9022.228 - u * (2186.181 - u * (364.2191 - u * (61.57037 - u * (1.841439 - u)))))))
    }
}

/// Fresnel integrals C(x), S(x) = ∫₀ˣ cos/sin(π t²/2) dt.
pub fn fresnel(x: f64) -> (f64, f64) {
    let ax = x.abs();
    let (c, s) = if ax < 3.0 {
        // power series
        let mut c = 0.0;
        let mut s = 0.0;
        let t = PI * ax * ax / 2.0;
        let mut n = 0usize;
        let mut term;
        // Series: ∫ exp(iπt²/2) = Σ (iπ/2)^n x^(2n+1) / (n! (2n+1))
        let mut pow = 1.0; // (π/2 x²)^n / n!
        loop {
            let val = ax * pow / (2 * n + 1) as f64;
            match n % 4 {
                0 => c += val,
                1 => s += val,
                2 => c -= val,
                _ => s -= val,
            }
            n += 1;
            pow *= t / n as f64;
            term = val;
            if n > 200 || term.abs() < 1e-16 && n > 4 {
                break;
            }
        }
        let _ = term;
        (c, s)
    } else {
        // asymptotic with auxiliary functions f, g
        let t = PI * ax * ax / 2.0;
        let mut f = 0.0;
        let mut g = 0.0;
        // f ~ 1/(πx) (1 − 3/(πx²)² + …), g ~ 1/(π²x³)(1 − 15/(πx²)² + …)
        let u = 1.0 / (PI * ax * ax);
        let u2 = u * u;
        f += (1.0 - 3.0 * u2 + 105.0 * u2 * u2) / (PI * ax);
        g += (1.0 - 15.0 * u2 + 945.0 * u2 * u2) * u / (PI * ax);
        (0.5 + f * t.sin() - g * t.cos(), 0.5 - f * t.cos() - g * t.sin())
    };
    if x < 0.0 { (-c, -s) } else { (c, s) }
}

/// Complex field behind a knife edge relative to free field, for the Fresnel
/// parameter v (v > 0 in the shadow, v < 0 in the lit zone).
/// F(v) = (1+i)/2 · [ (½ − C(v)) − i (½ − S(v)) ]; |F(0)| = ½ (−6 dB).
pub fn knife_edge(v: f64) -> C {
    let (c, s) = fresnel(v);
    C::new(0.5, 0.5) * C::new(0.5 - c, -(0.5 - s))
}
