use sansim::engine::{Engine, Options, Scratch};
use sansim::scene::*;
fn main() {
    let t = Traffic { aadt: 24000.0, share: Shares { medium: 0.0, heavy: 0.0, moped: 0.0, moto: 0.0 }, period_share: PeriodShare { day: 58.33, evening: 8.33, night: 33.34 }, heavy_night: None, speed: Speeds { light: 50.0, medium: 50.0, heavy: 50.0, moped: 50.0, moto: 50.0 }, surface: 0.0, moto_extra: 0.0 };
    println!("{:>8} {:>10} {:>10} {:>10} {:>10}", "dist", "physics", "ISO DW", "CNOS H", "CNOS F");
    for g in ["grass", "asphalt"] {
        println!("ground {g}");
        let mk = |method: &str, pf: f64| {
            let cols = 241;
            let input = SceneInput { ground: RasterMeta { cols, rows: cols, cell: 2.5, e0: 0.0, n0: 0.0 }, roads: vec![Road { id: "r".into(), cls: "SS".into(), enabled: true, lines: vec![vec![[-200.0, 100.0], [800.0, 100.0]]], traffic: t.clone() }], measures: Default::default(), buildings: vec![], barriers: vec![], settings: Settings { method: method.into(), ground_class: g.into(), max_distance: 3000.0, favourable_p: [pf; 3], ..Settings::default() } };
            Engine::new(Scene::build(input, vec![500.0; cols * cols]))
        };
        let e = [mk("physics", 0.0), mk("iso9613", 0.0), mk("cnossos", 0.0), mk("cnossos", 1.0)];
        for d in [10.0, 25.0, 50.0, 100.0, 200.0, 400.0] {
            let v: Vec<f64> = e.iter().map(|e| e.compute(300.0, 100.0 + d, 4.0, Options::default(), &mut Scratch::default()).levels()[0]).collect();
            println!("{d:>8} {:>10.1} {:>10.1} {:>10.1} {:>10.1}", v[0], v[1], v[2], v[3]);
        }
    }
}
