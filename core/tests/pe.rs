use num_complex::Complex64 as C;
use sansim::ground::{delany_bazley, spherical_q};
use sansim::pe::{solve, PeInput};
use std::f64::consts::PI;

fn flat(range: f64, sigma: f64, freqs: Vec<f64>, b: f64) -> PeInput {
    let n = (range as usize) + 1;
    PeInput {
        dist: (0..n).map(|i| i as f64).collect(),
        ground: vec![0.0; n],
        surface: vec![0.0; n],
        sigma: vec![sigma; n],
        source_height: 0.5,
        top: 20.0,
        freqs,
        b,
        z0: 0.1,
        turbulence: None,
        realisations: 1,
        out_dr: 1.0,
        out_dz: 0.25,
    }
}

fn analytic(f: f64, hs: f64, hr: f64, d: f64, sigma: f64) -> f64 {
    let k = 2.0 * PI * f / 340.0;
    let r1 = (d * d + (hr - hs).powi(2)).sqrt();
    let r2 = (d * d + (hr + hs).powi(2)).sqrt();
    let q = spherical_q(((hs + hr) / d).atan(), r2, k, delany_bazley(f, sigma));
    let p = C::new(1.0 / r1, 0.0) + q * C::new(0.0, k * (r2 - r1)).exp() / r2;
    20.0 * (p.norm() * r1).log10()
}

fn at(out: &sansim::pe::PeOutput, fi: usize, r: f64, z: f64) -> f64 {
    let col = (r / out.out_dr).round() as usize;
    let row = ((z - out.z_bottom) / out.out_dz).round() as usize;
    out.delta_l[fi][row * out.cols + col] as f64
}

#[test]
fn pe_matches_two_ray_over_grass() {
    let freqs = vec![125.0, 250.0, 500.0, 1000.0];
    let out = solve(&flat(100.0, 200.0, freqs.clone(), 0.0));
    for (i, f) in freqs.iter().enumerate() {
        let pe = at(&out, i, 100.0, 1.5);
        let an = analytic(*f, 0.5, 1.5, 100.0, 200.0);
        println!("{f} Hz: PE {pe:.1} analytic {an:.1}");
        assert!((pe - an).abs() < 1.5, "{f} Hz: PE {pe:.1} vs analytic {an:.1}");
    }
}

#[test]
fn pe_barrier_shadow() {
    let mut inp = flat(80.0, 200.0, vec![500.0], 0.0);
    for i in 0..inp.dist.len() {
        if (20.0..=20.5).contains(&inp.dist[i]) {
            inp.surface[i] = 4.0;
        }
    }
    let out = solve(&inp);
    let shadow = at(&out, 0, 60.0, 1.5);
    let open = at(&solve(&flat(80.0, 200.0, vec![500.0], 0.0)), 0, 60.0, 1.5);
    println!("open {open:.1} shadow {shadow:.1}");
    assert!(open - shadow > 8.0);
}

#[test]
fn pe_downward_refraction_raises_far_levels() {
    let still = solve(&flat(300.0, 200.0, vec![500.0], 0.0));
    let down = solve(&flat(300.0, 200.0, vec![500.0], 1.5));
    let a = at(&still, 0, 300.0, 2.0);
    let b = at(&down, 0, 300.0, 2.0);
    println!("still {a:.1} downward {b:.1}");
    assert!(b > a + 3.0);
}
