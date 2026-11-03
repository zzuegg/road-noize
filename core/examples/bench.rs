use sansim::barrier::{preset, Barrier, PresetParams};
use sansim::engine::{Engine, Options, Scratch};
use sansim::scene::*;
use std::time::Instant;

fn main() {
    let cols = 921usize;
    let rows = 801usize;
    let mut ground = vec![0f32; cols * rows];
    for r in 0..rows {
        for c in 0..cols {
            let y = r as f64 * 2.5;
            ground[r * cols + c] = (550.0 + (y - 800.0).max(0.0) * 0.25 + (c as f64 * 0.01).sin() * 2.0) as f32;
        }
    }
    let t = Traffic {
        aadt: 12000.0,
        share: Shares { medium: 5.0, heavy: 7.0, moped: 0.5, moto: 4.0 },
        period_share: PeriodShare { day: 82.0, evening: 8.0, night: 10.0 },
        heavy_night: None,
        speed: Speeds { light: 70.0, medium: 70.0, heavy: 60.0, moped: 45.0, moto: 75.0 },
        surface: 0.0,
        moto_extra: 0.0,
    };
    let roads: Vec<Road> = (0..3)
        .map(|k| Road { id: format!("r{k}"), cls: "SS".into(), enabled: true, lines: vec![vec![[0.0, 600.0 + 300.0 * k as f64], [1200.0, 700.0 + 300.0 * k as f64], [2300.0, 750.0 + 300.0 * k as f64]]], traffic: t.clone() })
        .collect();
    let mut buildings = Vec::new();
    let mut seed = 12345u64;
    let mut rnd = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as f64 / (1u64 << 31) as f64
    };
    for i in 0..330 {
        let (x, y) = (300.0 + rnd() * 1700.0, 500.0 + rnd() * 1200.0);
        let (w, h) = (8.0 + rnd() * 10.0, 8.0 + rnd() * 10.0);
        buildings.push(Building { id: format!("b{i}"), ring: vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]], height: 6.0 + rnd() * 6.0 });
    }
    let p = PresetParams { kind: "bentTop".into(), height: 3.0, thickness: 0.2, angle: 45.0, top_length: 1.5, crest: 1.5, front_slope: 34.0, back_slope: 34.0, wall_height: 0.0, crest_back: 0.0, front: "absorptive".into(), back: "absorptive".into() };
    let barriers = vec![Barrier { id: "w".into(), name: "w".into(), points: vec![[1500.0, 1015.0], [900.0, 1007.0]], profile: preset(&p), enabled: true }];
    let input = SceneInput { ground: RasterMeta { cols, rows, cell: 2.5, e0: 0.0, n0: 0.0 }, roads, measures: Default::default(), buildings, barriers, settings: Settings::default() };
    let t0 = Instant::now();
    let e = Engine::new(Scene::build(input, ground));
    println!("scene build {:?}, facets {}", t0.elapsed(), e.scene.facets.len());
    let mut s = Scratch::default();
    for (name, opts) in [("direct only", Options { no_reflections: true, ..Default::default() }), ("full", Options::default())] {
        let t0 = Instant::now();
        let mut n = 0;
        let mut acc = 0.0;
        for i in 0..std::env::var("N").ok().and_then(|v| v.parse().ok()).unwrap_or(40) {
            let x = 200.0 + (i % 8) as f64 * 250.0;
            let y = 550.0 + (i / 8) as f64 * 220.0;
            let r = e.compute(x, y, 4.0, opts, &mut s);
            acc += r.levels()[0];
            n += 1;
        }
        let ms = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
        println!("{name}: {ms:.1} ms per receiver (mean L {:.1})", acc / n as f64);
    }
}
