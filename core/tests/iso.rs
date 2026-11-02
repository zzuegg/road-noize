use sansim::barrier::{preset, Barrier, PresetParams};
use sansim::engine::{Engine, Options, Scratch};
use sansim::iso9613::{dz, reflects};
use sansim::scene::*;

fn traffic() -> Traffic {
    Traffic {
        aadt: 24000.0,
        share: Shares { medium: 0.0, heavy: 0.0, moped: 0.0, moto: 0.0 },
        period_share: PeriodShare { day: 14.0 / 24.0 * 100.0, evening: 2.0 / 24.0 * 100.0, night: 8.0 / 24.0 * 100.0 },
        heavy_night: None,
        speed: Speeds { light: 50.0, medium: 50.0, heavy: 50.0, moped: 50.0, moto: 50.0 },
        surface: 0.0,
        moto_extra: 0.0,
    }
}

fn wall(h: f64, front: &str) -> Barrier {
    let p = PresetParams { kind: "vertical".into(), height: h, thickness: 0.2, angle: 0.0, top_length: 1.5, crest: 1.5, front_slope: 34.0, back_slope: 34.0, wall_height: 0.0, front: front.into(), back: front.into() };
    Barrier { id: "w".into(), name: "w".into(), points: vec![[450.0, 105.0], [-50.0, 105.0]], profile: preset(&p), enabled: true }
}

fn engine(barriers: Vec<Barrier>, ground: &str, c0: [f64; 3]) -> Engine {
    let cols = 161;
    let input = SceneInput {
        ground: RasterMeta { cols, rows: cols, cell: 2.5, e0: 0.0, n0: 0.0 },
        roads: vec![Road { id: "r".into(), cls: "SS".into(), enabled: true, lines: vec![vec![[0.0, 100.0], [400.0, 100.0]]], traffic: traffic() }],
        measures: Default::default(),
        buildings: vec![],
        barriers,
        settings: Settings { method: "iso9613".into(), ground_class: ground.into(), max_distance: 2000.0, cmet_c0: c0, ..Settings::default() },
    };
    Engine::new(Scene::build(input, vec![500.0; cols * cols]))
}

fn lev(e: &Engine, x: f64, y: f64, h: f64) -> [f64; 3] {
    e.compute(x, y, h, Options::default(), &mut Scratch::default()).levels()
}

#[test]
fn dz_formula_and_caps() {
    // z = 0 gives 10 lg 3 = 4.8 dB
    let a = dz(0.0, 10.0, 10.0, 20.0, 0.0, false, false);
    assert!((a[4] - 4.77).abs() < 0.01);
    // huge path difference: capped at 20 (single) and 25 (multiple)
    let b = dz(50.0, 10.0, 10.0, 20.0, 0.0, false, false);
    assert!((b[7] - 20.0).abs() < 1e-9);
    let c = dz(50.0, 10.0, 10.0, 20.0, 5.0, true, false);
    assert!((c[7] - 25.0).abs() < 1e-9);
}

#[test]
fn size_criterion() {
    // a 1 m face at 63 Hz (λ 5.4 m) does not reflect, at 4 kHz it does
    // 1 m face, 2 m from source and receiver: 4 kHz reflects, 63 Hz does not
    assert!(!reflects(340.0 / 63.0, 1.0, 1.0, 2.0, 2.0));
    assert!(reflects(340.0 / 4000.0, 1.0, 1.0, 2.0, 2.0));
    // the same face 20 m away is too small even at 4 kHz
    assert!(!reflects(340.0 / 4000.0, 1.0, 1.0, 20.0, 20.0));
}

#[test]
fn iso_line_source_and_ground() {
    let hard = engine(vec![], "asphalt", [0.0; 3]);
    let soft = engine(vec![], "grass", [0.0; 3]);
    let l10 = lev(&hard, 200.0, 110.0, 4.0)[0];
    let l40 = lev(&hard, 200.0, 140.0, 4.0)[0];
    assert!((4.5..8.0).contains(&(l10 - l40)), "two doublings {:.1}", l10 - l40);
    let s = lev(&soft, 200.0, 160.0, 1.5)[0];
    let h = lev(&hard, 200.0, 160.0, 1.5)[0];
    assert!(s < h - 1.0, "soft {s:.1} hard {h:.1}");
}

#[test]
fn iso_wall_insertion_loss_is_bounded() {
    let none = lev(&engine(vec![], "grass", [0.0; 3]), 200.0, 130.0, 1.5)[0];
    let w = lev(&engine(vec![wall(4.0, "absorptive")], "grass", [0.0; 3]), 200.0, 130.0, 1.5)[0];
    println!("ISO IL {:.1}", none - w);
    assert!((5.0..21.0).contains(&(none - w)));
}

#[test]
fn iso_reflective_wall_adds_opposite() {
    let none = lev(&engine(vec![], "grass", [0.0; 3]), 200.0, 70.0, 4.0)[0];
    let refl = lev(&engine(vec![wall(4.0, "reflective")], "grass", [0.0; 3]), 200.0, 70.0, 4.0)[0];
    println!("ISO reflection +{:.1}", refl - none);
    assert!((0.8..3.5).contains(&(refl - none)));
}

#[test]
fn cmet_lowers_long_term_levels_far_away() {
    let dw = lev(&engine(vec![], "grass", [0.0; 3]), 200.0, 350.0, 4.0)[0];
    let lt = lev(&engine(vec![], "grass", [2.0; 3]), 200.0, 350.0, 4.0)[0];
    assert!(dw - lt > 1.0 && dw - lt <= 2.0 + 1e-6, "{dw} {lt}");
}
