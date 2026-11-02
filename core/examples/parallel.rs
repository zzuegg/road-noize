//! Two parallel walls along a straight road: how much do reflections between
//! them cost the houses behind the north wall?
//! Road along y = 100, walls at y = 106.5 (north) and 93.5 (south), 4 m high.
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

fn wall(y: f64, north: bool, mat: &str) -> Barrier {
    let p = PresetParams { kind: "vertical".into(), height: 4.0, thickness: 0.2, angle: 0.0, top_length: 1.5, crest: 1.5, front_slope: 34.0, back_slope: 34.0, wall_height: 0.0, front: mat.into(), back: mat.into() };
    // road on the left of the drawing direction = road side (+o)
    let pts = if north { vec![[700.0, y], [-300.0, y]] } else { vec![[-300.0, y], [700.0, y]] };
    Barrier { id: format!("w{y}"), name: "w".into(), points: pts, profile: preset(&p), enabled: true }
}

fn main() {
    let recs = [(125.0, 2.0), (125.0, 5.0), (160.0, 2.0), (160.0, 5.0), (250.0, 5.0)];
    for method in ["cnossos", "physics"] {
        for order in [1usize, 2] {
            println!("\n{method}, reflection order {order}: L_day behind the north wall, change vs north wall alone");
            let mut base = vec![0.0; recs.len()];
            for (vi, (name, walls)) in [
                ("north wall alone (absorptive)", vec![wall(106.5, true, "absorptive")]),
                ("+ south wall absorptive", vec![wall(106.5, true, "absorptive"), wall(93.5, false, "absorptive")]),
                ("+ south wall highly absorptive", vec![wall(106.5, true, "highlyAbsorptive"), wall(93.5, false, "highlyAbsorptive")]),
                ("north reflective alone", vec![wall(106.5, true, "reflective")]),
                ("+ south wall reflective", vec![wall(106.5, true, "reflective"), wall(93.5, false, "reflective")]),
            ]
            .into_iter()
            .enumerate()
            {
                let cols = 241;
                let input = SceneInput {
                    ground: RasterMeta { cols, rows: 161, cell: 2.5, e0: -100.0, n0: 0.0 },
                    roads: vec![Road { id: "r".into(), cls: "SS".into(), enabled: true, lines: vec![vec![[-300.0, 100.0], [700.0, 100.0]]], traffic: traffic() }],
                    measures: Default::default(),
                    buildings: vec![],
                    barriers: walls,
                    settings: Settings { method: method.into(), ground_class: "orchard".into(), max_distance: 1500.0, reflection_order: order, ..Settings::default() },
                };
                let e = Engine::new(Scene::build(input, vec![550.0; cols * 161]));
                let mut row = String::new();
                for (ri, (y, h)) in recs.iter().enumerate() {
                    let l = e.compute(200.0, *y, *h, Options::default(), &mut Scratch::default()).levels()[0];
                    if vi == 0 || vi == 3 { base[ri] = l; row += &format!(" {:>7.1}", l) } else { row += &format!(" {:>+7.1}", l - base[ri]) }
                }
                println!("{:<34}{row}", name);
            }
        }
    }
    println!("\ncolumns: receiver 25 m/2 m, 25 m/5 m, 60 m/2 m, 60 m/5 m, 150 m/5 m north of the road");
}
