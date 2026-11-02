use num_complex::Complex64 as C;
use sansim::bands::NB;
use sansim::barrier::{preset, Barrier, PresetParams};
use sansim::engine::{Engine, Options, Scratch};
use sansim::ground::{delany_bazley, sigma_of, spherical_q};
use sansim::scene::{default_met, MetClass, PeriodShare, RasterMeta, Road, Scene, SceneInput, Settings, Shares, Speeds, Traffic};
use sansim::special::{faddeeva, fresnel, knife_edge};
use std::f64::consts::PI;

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn faddeeva_reference_values() {
    let w0 = faddeeva(C::new(0.0, 0.0));
    assert!(close(w0.re, 1.0, 1e-4) && close(w0.im, 0.0, 1e-4), "{w0}");
    let wi = faddeeva(C::new(0.0, 1.0));
    assert!(close(wi.re, 0.4275836, 2e-4), "{wi}");
    let w1 = faddeeva(C::new(1.0, 0.0));
    assert!(close(w1.re, 0.3678794, 2e-4) && close(w1.im, 0.6071577, 2e-4), "{w1}");
    let w = faddeeva(C::new(2.0, 1.0));
    assert!(close(w.re, 0.1402396, 3e-4) && close(w.im, 0.2222134, 3e-4), "{w}");
}

#[test]
fn fresnel_reference_values() {
    let (c, s) = fresnel(1.0);
    assert!(close(c, 0.7798934, 1e-6) && close(s, 0.4382591, 1e-6), "{c} {s}");
    let (c, s) = fresnel(2.5);
    assert!(close(c, 0.4574130, 1e-5) && close(s, 0.6191818, 1e-5), "{c} {s}");
    let (c, s) = fresnel(5.0);
    assert!(close(c, 0.5636312, 1e-5) && close(s, 0.4991914, 1e-5), "{c} {s}");
}

#[test]
fn knife_edge_matches_itu() {
    // grazing: −6 dB
    assert!(close(20.0 * knife_edge(0.0).norm().log10(), -6.02, 0.05));
    // deep shadow vs ITU-R P.526 J(v)
    for v in [1.0f64, 2.0, 3.0, 5.0] {
        let j = 6.9 + 20.0 * (((v - 0.1).powi(2) + 1.0).sqrt() + v - 0.1).log10();
        let ours = -20.0 * knife_edge(v).norm().log10();
        assert!(close(ours, j, 1.0), "v={v} ours={ours} itu={j}");
    }
    // well lit: free field
    assert!(close(knife_edge(-5.0).norm(), 1.0, 0.1));
}

#[test]
fn hard_ground_reflects_fully() {
    let q = spherical_q(0.05, 50.0, 2.0 * PI * 500.0 / 340.0, delany_bazley(500.0, sigma_of("concrete")));
    assert!(close(q.norm(), 1.0, 0.05), "{q}");
}

#[test]
fn grass_has_a_ground_dip() {
    // classic geometry: hs 0.5, hr 1.5, d 50 over grass
    let (hs, hr, d) = (0.5f64, 1.5f64, 50.0f64);
    let r1 = (d * d + (hr - hs).powi(2)).sqrt();
    let r2 = (d * d + (hr + hs).powi(2)).sqrt();
    let psi = ((hs + hr) / d).atan();
    let mut min = f64::MAX;
    let mut fmin = 0.0;
    let mut f = 50.0;
    while f < 4000.0 {
        let k = 2.0 * PI * f / 340.0;
        let q = spherical_q(psi, r2, k, delany_bazley(f, 200.0));
        let p = C::new(1.0 / r1, 0.0) + q * C::new(0.0, k * (r2 - r1)).exp() / r2;
        let ea = 20.0 * (p.norm() * r1).log10();
        if ea < min {
            min = ea;
            fmin = f;
        }
        f *= 1.05;
    }
    assert!(fmin > 200.0 && fmin < 1000.0, "dip at {fmin} Hz");
    assert!(min < -10.0, "dip only {min} dB");
}

// ---------------------------------------------------------------- scenes

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

fn settings(ground: &str, met: Vec<MetClass>) -> Settings {
    Settings { ground_class: ground.into(), met, max_distance: 2000.0, ..Settings::default() }
}

fn homogeneous() -> Vec<MetClass> {
    vec![MetClass { name: "h".into(), radius: 0.0, distance_scaled: false, weights: [100.0; 3] }]
}

fn wall(kind: &str, height: f64, angle: f64, front: &str, y: f64) -> Barrier {
    let p = PresetParams {
        kind: kind.into(),
        height,
        thickness: 0.2,
        angle,
        top_length: 1.5,
        crest: 1.5,
        front_slope: 34.0,
        back_slope: 34.0,
        wall_height: 0.0,
        front: front.into(),
        back: front.into(),
    };
    // drawn west → east; the road (y = 100) is to the right (south) of the
    // drawing direction when y > 100, so draw east → west for a wall north of the road
    let pts = if y > 100.0 { vec![[450.0, y], [-50.0, y]] } else { vec![[-50.0, y], [450.0, y]] };
    Barrier { id: "w".into(), name: kind.into(), points: pts, profile: preset(&p), enabled: true }
}

fn scene(barriers: Vec<Barrier>, ground: &str, met: Vec<MetClass>) -> Engine {
    let cols = 161;
    let input = SceneInput {
        ground: RasterMeta { cols, rows: cols, cell: 2.5, e0: 0.0, n0: 0.0 },
        roads: vec![Road { id: "r".into(), cls: "SS".into(), enabled: true, lines: vec![vec![[0.0, 100.0], [400.0, 100.0]]], traffic: traffic() }],
        measures: Default::default(),
        buildings: vec![],
        barriers,
        settings: settings(ground, met),
    };
    Engine::new(Scene::build(input, vec![500.0; cols * cols]))
}

fn level(e: &Engine, x: f64, y: f64, h: f64) -> f64 {
    let mut s = Scratch::default();
    e.compute(x, y, h, Options::default(), &mut s).levels()[0]
}

#[test]
fn line_source_decays_about_3_db_per_doubling_on_hard_ground() {
    let e = scene(vec![], "asphalt", homogeneous());
    let l10 = level(&e, 200.0, 110.0, 1.5);
    let l20 = level(&e, 200.0, 120.0, 1.5);
    let l40 = level(&e, 200.0, 140.0, 1.5);
    assert!((2.3..4.5).contains(&(l10 - l20)), "{l10} {l20}");
    assert!((2.3..4.5).contains(&(l20 - l40)), "{l20} {l40}");
}

#[test]
fn absolute_level_is_plausible() {
    // 1000 cars/h at 50 km/h, 25 m, 4 m high, grass: about 60–67 dB(A)
    let e = scene(vec![], "grass", homogeneous());
    let l = level(&e, 200.0, 125.0, 4.0);
    assert!((58.0..68.0).contains(&l), "{l}");
}

#[test]
fn soft_ground_is_quieter_than_hard_ground_at_low_receivers() {
    let hard = level(&scene(vec![], "asphalt", homogeneous()), 200.0, 160.0, 1.5);
    let soft = level(&scene(vec![], "grass", homogeneous()), 200.0, 160.0, 1.5);
    assert!(soft < hard - 2.0, "soft {soft} hard {hard}");
}

#[test]
fn vertical_wall_shields_ground_floor_more_than_upper_floor() {
    let none = scene(vec![], "grass", homogeneous());
    let w = scene(vec![wall("vertical", 3.0, 0.0, "absorptive", 105.0)], "grass", homogeneous());
    let low = level(&none, 200.0, 130.0, 1.5) - level(&w, 200.0, 130.0, 1.5);
    // 25 m up the line of sight clears the wall top
    let high = level(&none, 200.0, 130.0, 25.0) - level(&w, 200.0, 130.0, 25.0);
    // over meadow part of the benefit is lost: the ground effect it replaces was already there
    assert!((5.0..22.0).contains(&low), "low {low}");
    assert!(high < low - 3.0, "high {high} low {low}");
}

#[test]
fn reflective_wall_raises_the_opposite_side_tilted_wall_does_not() {
    let none = level(&scene(vec![], "grass", homogeneous()), 200.0, 70.0, 4.0);
    let vert = level(&scene(vec![wall("vertical", 4.0, 0.0, "reflective", 105.0)], "grass", homogeneous()), 200.0, 70.0, 4.0);
    let tilt = level(&scene(vec![wall("tilted", 4.0, 15.0, "reflective", 105.0)], "grass", homogeneous()), 200.0, 70.0, 4.0);
    let absorb = level(&scene(vec![wall("vertical", 4.0, 0.0, "highlyAbsorptive", 105.0)], "grass", homogeneous()), 200.0, 70.0, 4.0);
    println!("none {none:.1} vertical {vert:.1} tilted15 {tilt:.1} absorptive {absorb:.1}");
    assert!(vert - none > 1.0, "vertical reflective adds {:.1}", vert - none);
    assert!(tilt < vert - 0.7, "tilting should send the reflection over: {tilt} vs {vert}");
    assert!(absorb < vert - 0.7);
}

#[test]
fn bent_top_towards_the_road_screens_more_than_a_plain_wall() {
    let plain = scene(vec![wall("vertical", 3.0, 0.0, "absorptive", 105.0)], "grass", homogeneous());
    let bent = scene(vec![wall("bentTop", 3.0, 45.0, "absorptive", 105.0)], "grass", homogeneous());
    let a = level(&plain, 200.0, 140.0, 4.0);
    let b = level(&bent, 200.0, 140.0, 4.0);
    println!("plain {a:.1} bent {b:.1}");
    assert!(b < a - 0.5);
}

#[test]
fn every_preset_builds_and_screens() {
    let none = level(&scene(vec![], "grass", homogeneous()), 200.0, 130.0, 2.0);
    for kind in ["vertical", "tilted", "bentTop", "curvedTop", "tTop", "yTop", "berm", "bermWall", "gabion"] {
        let e = scene(vec![wall(kind, 3.0, 20.0, "absorptive", 108.0)], "grass", homogeneous());
        let l = level(&e, 200.0, 130.0, 2.0);
        println!("{kind:10} IL {:.1} dB", none - l);
        assert!(none - l > 5.0, "{kind} only {:.1}", none - l);
    }
}

#[test]
fn downward_refraction_reduces_the_barrier_effect_at_distance() {
    let fav = vec![MetClass { name: "inv".into(), radius: 300.0, distance_scaled: false, weights: [100.0; 3] }];
    let w = wall("vertical", 4.0, 0.0, "absorptive", 105.0);
    // hard ground, so refraction is the only thing that differs
    let il_h = level(&scene(vec![], "asphalt", homogeneous()), 200.0, 300.0, 4.0)
        - level(&scene(vec![w.clone()], "asphalt", homogeneous()), 200.0, 300.0, 4.0);
    let il_f = level(&scene(vec![], "asphalt", fav.clone()), 200.0, 300.0, 4.0)
        - level(&scene(vec![w], "asphalt", fav), 200.0, 300.0, 4.0);
    println!("insertion loss homogeneous {il_h:.1}, inversion {il_f:.1}");
    assert!(il_f < il_h - 1.0);
}

#[test]
fn default_met_classes_are_normalised() {
    let m = default_met();
    for p in 0..3 {
        let s: f64 = m.iter().map(|c| c.weights[p]).sum();
        assert!((s - 100.0).abs() < 1e-9);
    }
    let _ = NB;
}
