//! Does the wall send more noise to the houses across the road?
//! Flat ground (orchard meadow), straight road along y = 100, wall on the
//! north side at y = 109, receivers on the south side 30 m from the wall.
use sansim::barrier::{preset, Barrier, PresetParams};
use sansim::engine::{Engine, Options, Scratch};
use sansim::scene::*;

fn traffic() -> Traffic {
    Traffic {
        aadt: 12000.0,
        share: Shares { medium: 5.0, heavy: 7.0, moped: 0.5, moto: 4.0 },
        period_share: PeriodShare { day: 82.0, evening: 8.0, night: 10.0 },
        heavy_night: None,
        speed: Speeds { light: 70.0, medium: 70.0, heavy: 60.0, moped: 45.0, moto: 75.0 },
        surface: 0.0,
        moto_extra: 0.0,
    }
}

fn wall(kind: &str, h: f64, angle: f64, mat: &str) -> Barrier {
    let p = PresetParams { kind: kind.into(), height: h, thickness: 0.2, angle, top_length: 1.5, crest: 1.5, front_slope: 34.0, back_slope: 34.0, wall_height: 0.0, front: mat.into(), back: mat.into() };
    // drawn east → west so the road (south) is on the left = road side
    Barrier { id: "w".into(), name: kind.into(), points: vec![[700.0, 109.0], [-300.0, 109.0]], profile: preset(&p), enabled: true }
}

fn main() {
    let variants: Vec<(&str, Option<Barrier>)> = vec![
        ("no wall", None),
        ("vertical 4.1 m, reflective", Some(wall("vertical", 4.1, 0.0, "reflective"))),
        ("vertical 4.1 m, absorptive", Some(wall("vertical", 4.1, 0.0, "absorptive"))),
        ("bent top 3+1.5@45, reflective", Some(wall("bentTop", 3.0, 45.0, "reflective"))),
        ("bent top 3+1.5@45, absorptive", Some(wall("bentTop", 3.0, 45.0, "absorptive"))),
        ("tilted back 15°, reflective", Some(wall("tilted", 4.1, 15.0, "reflective"))),
    ];
    let heights = [2.0, 5.0, 8.0, 12.0];
    for method in ["physics", "cnossos", "iso9613"] {
        println!("\n{method}: L_day at the houses across the road (30 m from the wall), change vs no wall");
        println!("{:<32} {:>8} {:>8} {:>8} {:>8}", "", "2 m", "5 m", "8 m", "12 m");
        let mut base = [0.0; 4];
        for (vi, (name, w)) in variants.iter().enumerate() {
            let cols = 241;
            let input = SceneInput {
                ground: RasterMeta { cols, rows: 161, cell: 2.5, e0: -100.0, n0: 0.0 },
                roads: vec![Road { id: "r".into(), cls: "SS".into(), enabled: true, lines: vec![vec![[-300.0, 100.0], [700.0, 100.0]]], traffic: traffic() }],
                measures: Default::default(),
                buildings: vec![],
                barriers: w.clone().into_iter().collect(),
                settings: Settings { method: method.into(), ground_class: "orchard".into(), max_distance: 1500.0, ..Settings::default() },
            };
            let e = Engine::new(Scene::build(input, vec![550.0; cols * 161]));
            let mut row = String::new();
            for (hi, h) in heights.iter().enumerate() {
                let l = e.compute(200.0, 79.0, *h, Options { incident: true, ..Default::default() }, &mut Scratch::default()).levels()[0];
                if vi == 0 {
                    base[hi] = l;
                    row += &format!(" {:>8.1}", l);
                } else {
                    row += &format!(" {:>+8.1}", l - base[hi]);
                }
            }
            println!("{:<32}{row}", name);
        }
    }
}
