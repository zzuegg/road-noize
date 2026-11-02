//! Octave bands 63 Hz – 8 kHz and the sub-frequencies used to average
//! coherent (phase-dependent) effects over a band.

pub const NB: usize = 8;
pub const BANDS: [f64; NB] = [63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0];
pub const A_WEIGHT: [f64; NB] = [-26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

/// Frequencies spread log-uniformly across one octave (centre ± half an octave).
/// Interference patterns (ground dip, multiple paths) are averaged over these,
/// which is what a measured octave band does physically.
pub fn sub_frequencies(band: usize, n: usize) -> Vec<f64> {
    let fc = BANDS[band];
    (0..n)
        .map(|i| {
            let t = (i as f64 + 0.5) / n as f64 - 0.5; // −0.5 … 0.5 octave
            fc * 2f64.powf(t)
        })
        .collect()
}

pub fn energy_to_db(e: f64) -> f64 {
    if e > 0.0 { 10.0 * e.log10() } else { f64::NEG_INFINITY }
}

pub fn db_to_energy(l: f64) -> f64 {
    10f64.powf(l / 10.0)
}

/// A-weighted total of per-band energies.
pub fn a_weighted(e: &[f64; NB]) -> f64 {
    let mut s = 0.0;
    for b in 0..NB {
        s += e[b] * db_to_energy(A_WEIGHT[b]);
    }
    energy_to_db(s)
}
