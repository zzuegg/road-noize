//! A reflection off a wall across the road must still reach the houses behind
//! a wall on this side, diffracted over its top (it used to be dropped).
use sansim::barrier::{preset, Barrier, PresetParams};
use sansim::engine::{Engine, Options, Scratch};
use sansim::scene::*;

fn wall(y: f64, north: bool, mat: &str) -> Barrier {
    let p = PresetParams { kind: "vertical".into(), height: 4.0, thickness: 0.2, angle: 0.0, top_length: 1.5, crest: 1.5, front_slope: 34.0, back_slope: 34.0, wall_height: 0.0, crest_back: 0.0, front: mat.into(), back: mat.into() };
    let pts = if north { vec![[400.0, y], [0.0, y]] } else { vec![[0.0, y], [400.0, y]] };
    Barrier { id: format!("w{y}"), name: "w".into(), points: pts, profile: preset(&p), enabled: true }
}

fn level(method: &str, walls: Vec<Barrier>) -> f64 {
    let cols = 161;
    let input = SceneInput {
        ground: RasterMeta { cols, rows: 81, cell: 2.5, e0: 0.0, n0: 0.0 },
        roads: vec![Road {
            id: "r".into(),
            cls: "SS".into(),
            enabled: true,
            lines: vec![vec![[0.0, 100.0], [400.0, 100.0]]],
            traffic: Traffic {
                aadt: 12000.0,
                share: Shares { medium: 5.0, heavy: 7.0, moped: 0.5, moto: 4.0 },
                period_share: PeriodShare { day: 82.0, evening: 8.0, night: 10.0 },
                heavy_night: None,
                speed: Speeds { light: 70.0, medium: 70.0, heavy: 60.0, moped: 45.0, moto: 75.0 },
                surface: 0.0,
                moto_extra: 0.0,
            },
        }],
        measures: Default::default(),
        buildings: vec![],
        barriers: walls,
        settings: Settings { method: method.into(), ground_class: "orchard".into(), max_distance: 1000.0, ..Settings::default() },
    };
    let e = Engine::new(Scene::build(input, vec![500.0; cols * 81]));
    e.compute(200.0, 130.0, 5.0, Options::default(), &mut Scratch::default()).levels()[0]
}

#[test]
fn opposite_wall_reflects_over_near_wall() {
    for method in ["cnossos", "physics", "iso9613"] {
        let one = level(method, vec![wall(106.5, true, "reflective")]);
        let two = level(method, vec![wall(106.5, true, "reflective"), wall(93.5, false, "reflective")]);
        let two_abs = level(method, vec![wall(106.5, true, "reflective"), wall(93.5, false, "highlyAbsorptive")]);
        assert!(two - one > 1.5, "{method}: reflective wall across the road adds only {:.2} dB", two - one);
        assert!(two_abs - one < two - one, "{method}: absorption must reduce the reflection");
    }
}
