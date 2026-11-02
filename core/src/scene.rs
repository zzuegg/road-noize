//! Scene input (JSON from the UI) and the prepared scene the engine runs on.

use crate::bands::NB;
use crate::barrier::{facets, profile_top, reflection, Barrier};
use crate::emission::{gradient_correction, height_split, vehicle_parts, vehicle_power, Category, CATEGORIES, MIN_SPEED};
use crate::geometry::{Facet, Owner, V3};
use crate::ground::sigma_of;
use crate::raster::Raster;
use crate::turbulence::Turbulence;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const NP: usize = 3; // day, evening, night
/// source heights (see emission::SOURCE_HEIGHTS)
pub const NH: usize = 3;
pub const PERIOD_HOURS: [f64; NP] = [14.0, 2.0, 8.0];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shares {
    pub medium: f64,
    pub heavy: f64,
    pub moped: f64,
    pub moto: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PeriodShare {
    pub day: f64,
    pub evening: f64,
    pub night: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Speeds {
    pub light: f64,
    pub medium: f64,
    pub heavy: f64,
    pub moped: f64,
    pub moto: f64,
}

impl Speeds {
    pub fn of(&self, c: Category) -> f64 {
        match c {
            Category::Light => self.light,
            Category::Medium => self.medium,
            Category::Heavy => self.heavy,
            Category::Moped => self.moped,
            Category::Moto => self.moto,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Traffic {
    pub aadt: f64,
    pub share: Shares,
    pub period_share: PeriodShare,
    #[serde(default)]
    pub heavy_night: Option<f64>,
    pub speed: Speeds,
    #[serde(default)]
    pub surface: f64,
    #[serde(default)]
    pub moto_extra: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measure {
    pub speed_limit: Option<f64>,
    pub surface: Option<f64>,
    pub traffic_change: Option<f64>,
    #[serde(default)]
    pub night_heavy_ban: bool,
    pub moto_extra: Option<f64>,
    #[serde(default)]
    pub closed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Road {
    pub id: String,
    #[serde(default)]
    pub cls: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub lines: Vec<Vec<[f64; 2]>>,
    pub traffic: Traffic,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Building {
    pub id: String,
    pub ring: Vec<[f64; 2]>,
    pub height: f64,
}

/// A propagation condition: effective sound-speed gradient expressed as the
/// radius of the curved rays (m; > 0 downward refraction, < 0 upward, 0 or
/// absent = straight rays), weighted by how often it occurs in each period.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MetClass {
    pub name: String,
    /// curvature radius, m; 0 = homogeneous
    pub radius: f64,
    /// when true, radius = max(radius, 8 d) as in NMPB-2008 favourable conditions
    #[serde(default)]
    pub distance_scaled: bool,
    /// occurrence, percent, per period (day, evening, night)
    pub weights: [f64; NP],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub max_distance: f64,
    /// ground class for unsealed terrain (see ground::sigma_of)
    pub ground_class: String,
    pub reflection_order: usize,
    pub reflection_radius: f64,
    pub sub_frequencies: usize,
    pub lateral: bool,
    pub turbulence: Turbulence,
    pub met: Vec<MetClass>,
    /// "physics" (detailed) or "iso9613" (ISO 9613-2:1996, standards mode)
    #[serde(default = "physics")]
    pub method: String,
    /// ISO 9613-2 C0 per period (day, evening, night), dB; 0 = downwind
    #[serde(default)]
    pub cmet_c0: [f64; NP],
    /// CNOSSOS-EU: probability of favourable conditions per period
    #[serde(default = "pfav")]
    pub favourable_p: [f64; NP],
    /// source height above the road in ISO mode, m
    #[serde(default = "iso_hs")]
    pub iso_source_height: f64,
    #[serde(default = "temp")]
    pub temperature: f64,
    #[serde(default = "hum")]
    pub humidity: f64,
}

fn temp() -> f64 { 10.0 }
fn physics() -> String { "physics".into() }
fn iso_hs() -> f64 { 0.05 }
fn pfav() -> [f64; NP] { [0.5, 0.75, 1.0] }
fn hum() -> f64 { 70.0 }

impl Default for Settings {
    fn default() -> Self {
        Settings {
            max_distance: 800.0,
            ground_class: "orchard".into(),
            reflection_order: 2,
            reflection_radius: 150.0,
            sub_frequencies: 3,
            lateral: true,
            turbulence: Turbulence::default(),
            met: default_met(),
            method: physics(),
            cmet_c0: [0.0; NP],
            iso_source_height: iso_hs(),
            favourable_p: pfav(),
            temperature: 10.0,
            humidity: 70.0,
        }
    }
}

/// Default propagation conditions for an Alpine valley floor.
pub fn default_met() -> Vec<MetClass> {
    vec![
        MetClass { name: "homogeneous".into(), radius: 0.0, distance_scaled: false, weights: [40.0, 50.0, 30.0] },
        MetClass { name: "favourable".into(), radius: 1000.0, distance_scaled: true, weights: [35.0, 40.0, 40.0] },
        MetClass { name: "inversion".into(), radius: 600.0, distance_scaled: false, weights: [0.0, 10.0, 30.0] },
        MetClass { name: "upward".into(), radius: -2500.0, distance_scaled: false, weights: [25.0, 0.0, 0.0] },
    ]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RasterMeta {
    pub cols: usize,
    pub rows: usize,
    pub cell: f64,
    pub e0: f64,
    pub n0: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SceneInput {
    pub ground: RasterMeta,
    pub roads: Vec<Road>,
    #[serde(default)]
    pub measures: HashMap<String, Measure>,
    #[serde(default)]
    pub buildings: Vec<Building>,
    #[serde(default)]
    pub barriers: Vec<Barrier>,
    pub settings: Settings,
}

// ---------------------------------------------------------------- prepared

pub struct SourceTree {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
    pub r: Vec<f64>,
    pub left: Vec<i32>,
    pub right: Vec<i32>,
    /// NH × NP × NB per node, linear power
    pub pow: Vec<f64>,
    pub road: Vec<u32>,
    pub roots: Vec<u32>,
}

pub struct Scene {
    pub ground: Raster,
    /// building height above ground (1 m), 0 = none
    pub bldg: Raster,
    /// flow resistivity, kPa s m^-2 (2 m)
    pub sigma: Raster,
    pub barriers: Vec<Barrier>,
    pub barrier_top: Vec<f64>,
    pub facets: Vec<Facet>,
    /// facet indices that belong to barriers (for occlusion)
    pub barrier_facets: Vec<usize>,
    pub src: SourceTree,
    /// per road, per category: vehicle power dB per band
    pub vehicle: Vec<[f64; NB]>,
    /// per road, per category, per height: share of the vehicle's power per band
    pub vehicle_split: Vec<[[f64; NB]; NH]>,
    pub settings: Settings,
    /// atmospheric absorption dB/m per band
    pub alpha: [f64; NB],
}

const PIECE: f64 = 4.0;

fn effective(t: &Traffic, m: Option<&Measure>) -> Traffic {
    let mut t = t.clone();
    if let Some(m) = m {
        let f = 1.0 + m.traffic_change.unwrap_or(0.0) / 100.0;
        t.aadt = if m.closed { 0.0 } else { (t.aadt * f).max(0.0) };
        if let Some(v) = m.speed_limit {
            t.speed.light = t.speed.light.min(v);
            t.speed.medium = t.speed.medium.min(v);
            t.speed.heavy = t.speed.heavy.min(v);
            t.speed.moped = t.speed.moped.min(v);
            t.speed.moto = t.speed.moto.min(v);
        }
        if let Some(s) = m.surface {
            t.surface = s;
        }
        if let Some(e) = m.moto_extra {
            t.moto_extra = e;
        }
        if m.night_heavy_ban {
            t.heavy_night = Some(0.0);
        }
    }
    t
}

/// veh/h per category in each period
pub fn hourly_flows(t: &Traffic) -> [[f64; 5]; NP] {
    let shares = [t.period_share.day, t.period_share.evening, t.period_share.night];
    let mut out = [[0.0; 5]; NP];
    for p in 0..NP {
        let per_hour = t.aadt * shares[p] / 100.0 / PERIOD_HOURS[p];
        let heavy = if p == 2 { t.heavy_night.unwrap_or(t.share.heavy) } else { t.share.heavy };
        let light = (100.0 - t.share.medium - heavy - t.share.moped - t.share.moto).max(0.0);
        out[p] = [
            per_hour * light / 100.0,
            per_hour * t.share.medium / 100.0,
            per_hour * heavy / 100.0,
            per_hour * t.share.moped / 100.0,
            per_hour * t.share.moto / 100.0,
        ];
    }
    out
}

/// ISO 9613-1 atmospheric absorption at band centres, dB/m.
pub fn atmospheric_alpha(temp_c: f64, rh: f64) -> [f64; NB] {
    let t = temp_c + 273.15;
    let t0 = 293.15;
    let t01 = 273.16;
    let pa = 1.0; // relative to 101.325 kPa
    let psat = 10f64.powf(-6.8346 * (t01 / t).powf(1.261) + 4.6151);
    let h = rh * psat / pa;
    let fro = pa * (24.0 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
    let frn = pa * (t / t0).powf(-0.5) * (9.0 + 280.0 * h * (-4.170 * ((t / t0).powf(-1.0 / 3.0) - 1.0)).exp());
    let mut out = [0.0; NB];
    for (b, f) in crate::bands::BANDS.iter().enumerate() {
        let f2 = f * f;
        let a = 8.686
            * f2
            * (1.84e-11 / pa * (t / t0).sqrt()
                + (t / t0).powf(-2.5)
                    * (0.01275 * (-2239.1 / t).exp() / (fro + f2 / fro) + 0.1068 * (-3352.0 / t).exp() / (frn + f2 / frn)));
        out[b] = a;
    }
    out
}

pub fn point_in_ring(ring: &[[f64; 2]], x: f64, y: f64) -> bool {
    let mut c = false;
    let n = ring.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (ring[i][0], ring[i][1]);
        let (xj, yj) = (ring[j][0], ring[j][1]);
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            c = !c;
        }
        j = i;
    }
    c
}

fn rasterize_rings(r: &mut Raster, rings: &[(Vec<[f64; 2]>, f32)]) {
    for (ring, v) in rings {
        if ring.len() < 3 {
            continue;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for p in ring {
            x0 = x0.min(p[0]);
            x1 = x1.max(p[0]);
            y0 = y0.min(p[1]);
            y1 = y1.max(p[1]);
        }
        let c0 = (((x0 - r.e0) / r.cell).ceil().max(0.0)) as usize;
        let c1 = (((x1 - r.e0) / r.cell).floor()).min(r.cols as f64 - 1.0);
        let r0 = (((y0 - r.n0) / r.cell).ceil().max(0.0)) as usize;
        let r1 = (((y1 - r.n0) / r.cell).floor()).min(r.rows as f64 - 1.0);
        if c1 < 0.0 || r1 < 0.0 {
            continue;
        }
        for row in r0..=(r1 as usize) {
            for col in c0..=(c1 as usize) {
                let x = r.e0 + col as f64 * r.cell;
                let y = r.n0 + row as f64 * r.cell;
                if point_in_ring(ring, x, y) {
                    let i = row * r.cols + col;
                    if *v > r.data[i] || r.data[i] == 0.0 {
                        r.data[i] = *v;
                    }
                }
            }
        }
    }
}

/// Road widths per class (m), for the hard-ground mask.
fn road_width(cls: &str) -> f64 {
    match cls {
        "SS" => 8.0,
        "LS" => 6.5,
        "G" => 5.0,
        _ => 5.0,
    }
}

impl Scene {
    pub fn build(input: SceneInput, ground_data: Vec<f32>) -> Scene {
        let g = &input.ground;
        let ground = Raster { cols: g.cols, rows: g.rows, cell: g.cell, e0: g.e0, n0: g.n0, data: ground_data };
        let w = (g.cols - 1) as f64 * g.cell;
        let h = (g.rows - 1) as f64 * g.cell;

        // buildings → height raster
        let bc = 1.0;
        let mut bldg = Raster::filled((w / bc) as usize + 1, (h / bc) as usize + 1, bc, g.e0, g.n0, 0.0);
        let rings: Vec<_> = input.buildings.iter().map(|b| (b.ring.clone(), b.height as f32)).collect();
        rasterize_rings(&mut bldg, &rings);

        // ground type: terrain class, roads and buildings hard
        let sc = 2.0;
        let terrain_sigma = sigma_of(&input.settings.ground_class) as f32;
        let mut sigma = Raster::filled((w / sc) as usize + 1, (h / sc) as usize + 1, sc, g.e0, g.n0, terrain_sigma);
        let hard = sigma_of("asphalt") as f32;
        for road in &input.roads {
            let half = road_width(&road.cls) / 2.0;
            for line in &road.lines {
                for s in line.windows(2) {
                    let (ax, ay, bx, by) = (s[0][0], s[0][1], s[1][0], s[1][1]);
                    let l = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
                    let n = (l / sc).ceil().max(1.0) as usize;
                    for k in 0..=n {
                        let t = k as f64 / n as f64;
                        let (x, y) = (ax + (bx - ax) * t, ay + (by - ay) * t);
                        let rad = (half / sc).ceil() as i64;
                        let cc = ((x - sigma.e0) / sc).round() as i64;
                        let rr = ((y - sigma.n0) / sc).round() as i64;
                        for dr in -rad..=rad {
                            for dc in -rad..=rad {
                                let (c2, r2) = (cc + dc, rr + dr);
                                if c2 < 0 || r2 < 0 {
                                    continue;
                                }
                                let px = sigma.e0 + c2 as f64 * sc;
                                let py = sigma.n0 + r2 as f64 * sc;
                                if ((px - x).powi(2) + (py - y).powi(2)).sqrt() <= half {
                                    sigma.set(c2 as usize, r2 as usize, hard);
                                }
                            }
                        }
                    }
                }
            }
        }
        let brings: Vec<_> = input.buildings.iter().map(|b| (b.ring.clone(), hard)).collect();
        rasterize_rings(&mut sigma, &brings);

        // facets: barriers, then building façades
        let mut fac = Vec::new();
        let mut barrier_facets = Vec::new();
        for (i, b) in input.barriers.iter().enumerate() {
            for f in facets(b, i, &ground) {
                barrier_facets.push(fac.len());
                fac.push(f);
            }
        }
        let facade = reflection("facade");
        for (bi, b) in input.buildings.iter().enumerate() {
            let ring = &b.ring;
            if ring.len() < 3 || b.height <= 0.0 {
                continue;
            }
            let mut area = 0.0;
            for i in 0..ring.len() {
                let j = (i + 1) % ring.len();
                area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
            }
            let ccw = area > 0.0;
            for i in 0..ring.len() {
                let p = ring[i];
                let q = ring[(i + 1) % ring.len()];
                let l = ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
                if l < 2.0 {
                    continue;
                }
                let (mut nx, mut ny) = ((q[1] - p[1]) / l, -(q[0] - p[0]) / l);
                if !ccw {
                    nx = -nx;
                    ny = -ny;
                }
                let zp = ground.bilinear(p[0], p[1]);
                let zq = ground.bilinear(q[0], q[1]);
                let base = zp.min(zq);
                let top = zp.max(zq) + b.height;
                let verts = vec![
                    V3::new(p[0], p[1], base),
                    V3::new(q[0], q[1], base),
                    V3::new(q[0], q[1], top),
                    V3::new(p[0], p[1], top),
                ];
                if let Some(f) = Facet::new(verts, V3::new(nx, ny, 0.0), facade, Owner::Building(bi)) {
                    fac.push(f);
                }
            }
        }

        let (src, vehicle, vehicle_split) = build_sources(&input.roads, &input.measures, &ground);
        let barrier_top = input.barriers.iter().map(|b| profile_top(&b.profile)).collect();
        let alpha = atmospheric_alpha(input.settings.temperature, input.settings.humidity);
        Scene {
            ground,
            bldg,
            sigma,
            barrier_top,
            barriers: input.barriers,
            facets: fac,
            barrier_facets,
            src,
            vehicle,
            vehicle_split,
            settings: input.settings,
            alpha,
        }
    }
}

struct Leaf {
    x: f64,
    y: f64,
    z: f64,
    len: f64,
    pow: [f64; NH * NP * NB],
    road: u32,
}

const K: usize = NH * NP * NB;

#[allow(clippy::type_complexity)]
fn build_sources(roads: &[Road], measures: &HashMap<String, Measure>, ground: &Raster) -> (SourceTree, Vec<[f64; NB]>, Vec<[[f64; NB]; NH]>) {
    let mut vehicle = vec![[f64::NEG_INFINITY; NB]; roads.len() * 5];
    let mut vehicle_split = vec![[[0.0; NB]; NH]; roads.len() * 5];
    let mut groups: Vec<Vec<Leaf>> = Vec::new();
    for (ri, road) in roads.iter().enumerate() {
        if !road.enabled {
            continue;
        }
        let t = effective(&road.traffic, measures.get(&road.id));
        if t.aadt <= 0.0 {
            continue;
        }
        let flows = hourly_flows(&t);
        // gradient-free parts once per road and category; the gradient only
        // scales propulsion (CNOSSOS 2.2.4)
        let mut parts0 = [([0.0; NB], [0.0; NB]); 5];
        for (ci, c) in CATEGORIES.iter().enumerate() {
            let extra = if *c == Category::Moto { t.moto_extra } else { 0.0 };
            parts0[ci] = vehicle_parts(*c, t.speed.of(*c).max(MIN_SPEED), 0.0, t.surface, extra);
        }
        for (ci, c) in CATEGORIES.iter().enumerate() {
            let extra = if *c == Category::Moto { t.moto_extra } else { 0.0 };
            vehicle[ri * 5 + ci] = vehicle_power(*c, t.speed.of(*c), 0.0, t.surface, extra);
            let (rr, pp) = vehicle_parts(*c, t.speed.of(*c), 0.0, t.surface, extra);
            let split = height_split(*c);
            for h in 0..NH {
                for b in 0..NB {
                    let tot = rr[b] + pp[b];
                    vehicle_split[ri * 5 + ci][h][b] = if tot > 0.0 { (split[h].0 * rr[b] + split[h].1 * pp[b]) / tot } else { 0.0 };
                }
            }
        }
        for line in &road.lines {
            let mut leaves = Vec::new();
            for s in line.windows(2) {
                let (x0, y0, x1, y1) = (s[0][0], s[0][1], s[1][0], s[1][1]);
                let l = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
                if l < 0.01 {
                    continue;
                }
                let n = (l / PIECE).ceil().max(1.0) as usize;
                let (ux, uy) = ((x1 - x0) / l, (y1 - y0) / l);
                for k in 0..n {
                    let tm = (k as f64 + 0.5) / n as f64;
                    let (xm, ym) = (x0 + (x1 - x0) * tm, y0 + (y1 - y0) * tm);
                    let len = l / n as f64;
                    let za = ground.bilinear(xm - ux * 10.0, ym - uy * 10.0);
                    let zb = ground.bilinear(xm + ux * 10.0, ym + uy * 10.0);
                    let grad = (zb - za) / 20.0 * 100.0;
                    let mut pow = [0.0; K];
                    for p in 0..NP {
                        for (ci, c) in CATEGORIES.iter().enumerate() {
                            let q = flows[p][ci] / 2.0;
                            if q <= 0.0 {
                                continue;
                            }
                            let v = t.speed.of(*c).max(MIN_SPEED);
                            let k = q / (1000.0 * v) * len;
                            let split = height_split(*c);
                            let (rr, pp0) = &parts0[ci];
                            for sign in [1.0, -1.0] {
                                let g = 10f64.powf(gradient_correction(*c, sign * grad, v) / 10.0);
                                let mut pp = *pp0;
                                pp.iter_mut().for_each(|x| *x *= g);
                                for h in 0..NH {
                                    for b in 0..NB {
                                        pow[(h * NP + p) * NB + b] += k * (split[h].0 * rr[b] + split[h].1 * pp[b]);
                                    }
                                }
                            }
                        }
                    }
                    leaves.push(Leaf { x: xm, y: ym, z: ground.bilinear(xm, ym), len, pow, road: ri as u32 });
                }
            }
            if !leaves.is_empty() {
                groups.push(leaves);
            }
        }
    }

    let total: usize = groups.iter().map(|g| 2 * g.len() - 1).sum();
    let mut t = SourceTree {
        x: vec![0.0; total],
        y: vec![0.0; total],
        z: vec![0.0; total],
        r: vec![0.0; total],
        left: vec![-1; total],
        right: vec![-1; total],
        pow: vec![0.0; total * K],
        road: vec![0; total],
        roots: Vec::new(),
    };
    let mut next = 0usize;
    fn build(t: &mut SourceTree, next: &mut usize, leaves: &[Leaf]) -> usize {
        let id = *next;
        *next += 1;
        if leaves.len() == 1 {
            let l = &leaves[0];
            t.x[id] = l.x;
            t.y[id] = l.y;
            t.z[id] = l.z;
            t.r[id] = l.len / 2.0;
            t.pow[id * K..(id + 1) * K].copy_from_slice(&l.pow);
            t.road[id] = l.road;
            return id;
        }
        let mid = leaves.len() / 2;
        let a = build(t, next, &leaves[..mid]);
        let b = build(t, next, &leaves[mid..]);
        t.left[id] = a as i32;
        t.right[id] = b as i32;
        for q in 0..K {
            t.pow[id * K + q] = t.pow[a * K + q] + t.pow[b * K + q];
        }
        let wa: f64 = t.pow[a * K..a * K + NB].iter().sum::<f64>().max(1e-30);
        let wb: f64 = t.pow[b * K..b * K + NB].iter().sum::<f64>().max(1e-30);
        let x = (t.x[a] * wa + t.x[b] * wb) / (wa + wb);
        let y = (t.y[a] * wa + t.y[b] * wb) / (wa + wb);
        t.x[id] = x;
        t.y[id] = y;
        t.z[id] = (t.z[a] * wa + t.z[b] * wb) / (wa + wb);
        let ra = ((t.x[a] - x).powi(2) + (t.y[a] - y).powi(2)).sqrt() + t.r[a];
        let rb = ((t.x[b] - x).powi(2) + (t.y[b] - y).powi(2)).sqrt() + t.r[b];
        t.r[id] = ra.max(rb);
        t.road[id] = t.road[a];
        id
    }
    for g in &groups {
        let root = build(&mut t, &mut next, g);
        t.roots.push(root as u32);
    }
    (t, vehicle, vehicle_split)
}
