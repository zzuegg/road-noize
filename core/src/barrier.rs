//! Noise barriers of any cross-section.
//!
//! A barrier is a plan polyline (its axis) and a cross-section made of one or
//! more polygons in the local (o, h) plane: o is the offset perpendicular to
//! the axis, positive towards the ROAD side (left of the drawing direction),
//! h the height above the ground at the axis. Every polygon edge carries a
//! material. Extruded along the axis this gives the faces that reflect sound —
//! a face tilted by θ sends the reflection 2θ up or down, exactly as built.
//!
//! The presets cover the usual families: vertical, tilted (leaning back or
//! towards the road), bent or curved tops towards the road ("cantilever",
//! facing down onto the traffic) or away from it (facing up), T- and Y-tops,
//! earth berms with any slope angles, berm with wall on top, gabion walls.
//! Anything else can be entered as custom polygons.

use crate::bands::NB;
use crate::geometry::{Facet, Owner, V3};
use crate::raster::Raster;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PV {
    pub o: f64,
    pub h: f64,
    /// material of the edge from this vertex to the next
    pub m: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Part {
    pub verts: Vec<PV>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Barrier {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub points: Vec<[f64; 2]>,
    pub profile: Vec<Part>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// Energy absorption coefficient per octave band (63 Hz … 8 kHz).
pub fn absorption(material: &str) -> [f64; NB] {
    match material {
        "reflective" | "concrete" | "glass" => [0.01, 0.01, 0.02, 0.02, 0.03, 0.04, 0.05, 0.05],
        // DLα ≈ 8 dB with the EN 1793-3 traffic spectrum: EN 1793-1 category A3, lower edge
        "absorptive" => [0.15, 0.30, 0.60, 0.85, 0.90, 0.85, 0.80, 0.75],
        // DLα ≈ 11 dB: EN 1793-1 category A3, upper edge
        "highlyAbsorptive" => [0.20, 0.45, 0.80, 0.95, 0.97, 0.95, 0.90, 0.85],
        "grass" | "earth" => [0.10, 0.20, 0.40, 0.60, 0.70, 0.75, 0.80, 0.80],
        "gabion" | "stone" => [0.10, 0.20, 0.40, 0.60, 0.70, 0.70, 0.70, 0.70],
        "wood" => [0.10, 0.15, 0.20, 0.25, 0.30, 0.30, 0.30, 0.30],
        "facade" => [0.02, 0.03, 0.04, 0.05, 0.07, 0.09, 0.10, 0.10],
        _ => [0.02; NB],
    }
}

pub fn reflection(material: &str) -> [f64; NB] {
    let a = absorption(material);
    let mut r = [0.0; NB];
    for b in 0..NB {
        r[b] = (1.0 - a[b]).max(0.0);
    }
    r
}

// ------------------------------------------------------------------ presets

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetParams {
    pub kind: String,
    #[serde(default = "d_h")]
    pub height: f64,
    #[serde(default = "d_t")]
    pub thickness: f64,
    /// degrees; meaning depends on kind (tilt, bend, slope)
    #[serde(default)]
    pub angle: f64,
    /// top element length (bent / curved / T / Y), m
    #[serde(default = "d_top")]
    pub top_length: f64,
    /// berms
    #[serde(default = "d_crest")]
    pub crest: f64,
    #[serde(default = "d_slope")]
    pub front_slope: f64,
    #[serde(default = "d_slope")]
    pub back_slope: f64,
    /// berms: extra level top behind the crest (towards −o), m. A plateau
    /// that runs back into rising terrain keeps the reference line at the
    /// road-side edge, so the height is measured from the ground there.
    #[serde(default)]
    pub crest_back: f64,
    /// wall on a berm
    #[serde(default)]
    pub wall_height: f64,
    #[serde(default = "d_front")]
    pub front: String,
    #[serde(default = "d_back")]
    pub back: String,
}

fn d_h() -> f64 { 4.0 }
fn d_t() -> f64 { 0.2 }
fn d_top() -> f64 { 1.5 }
fn d_crest() -> f64 { 1.5 }
fn d_slope() -> f64 { 34.0 }
fn d_front() -> String { "absorptive".into() }
fn d_back() -> String { "reflective".into() }

/// A polyline thickened symmetrically into a polygon. The +o side ("front",
/// towards the road for a stem going up) gets `front`, the other `back`.
pub fn thick_polyline(center: &[(f64, f64)], t: f64, front: &str, back: &str) -> Part {
    let n = center.len();
    let mut left: Vec<(f64, f64)> = Vec::with_capacity(n); // +normal side
    let mut right: Vec<(f64, f64)> = Vec::with_capacity(n);
    for i in 0..n {
        // averaged direction → miter normal
        let (ax, ay) = center[if i == 0 { 0 } else { i - 1 }];
        let (bx, by) = center[if i + 1 < n { i + 1 } else { n - 1 }];
        let (dx, dy) = (bx - ax, by - ay);
        let l = (dx * dx + dy * dy).sqrt().max(1e-9);
        // normal to the right of the direction (in o,h with h up): (dy, −dx)
        let (nx, ny) = (dy / l, -dx / l);
        let (cx, cy) = center[i];
        left.push((cx + nx * t / 2.0, cy + ny * t / 2.0));
        right.push((cx - nx * t / 2.0, cy - ny * t / 2.0));
    }
    // for a stem going straight up, (dy,−dx) = (+1, 0): `left` is the +o side
    let mut verts = Vec::new();
    // up the back side, across the top, down the front side, across the base
    for p in right.iter() {
        verts.push(PV { o: p.0, h: p.1.max(0.0), m: back.to_string() });
    }
    // top cap edge from right[n-1] to left[n-1] uses front material
    if let Some(last) = verts.last_mut() {
        last.m = front.to_string();
    }
    for p in left.iter().rev() {
        verts.push(PV { o: p.0, h: p.1.max(0.0), m: front.to_string() });
    }
    // base edge (left[0] → right[0]) is on the ground; material irrelevant
    if let Some(last) = verts.last_mut() {
        last.m = "base".into();
    }
    Part { verts }
}

pub fn preset(p: &PresetParams) -> Vec<Part> {
    let h = p.height.max(0.1);
    let t = p.thickness.max(0.05);
    let a = p.angle.to_radians();
    let f = p.front.as_str();
    let b = p.back.as_str();
    match p.kind.as_str() {
        // leaning: angle > 0 leans away from the road (top towards −o)
        "tilted" => vec![thick_polyline(&[(0.0, 0.0), (-h * a.tan(), h)], t, f, b)],
        // vertical stem, then a straight arm; angle from vertical, > 0 towards
        // the road (arm "facing down" onto the traffic), < 0 away from it
        "bentTop" => {
            let l = p.top_length;
            vec![thick_polyline(&[(0.0, 0.0), (0.0, h), (l * a.sin(), h + l * a.cos())], t, f, b)]
        }
        // vertical stem with a circular arc of length top_length bending by `angle`
        "curvedTop" => {
            let mut c = vec![(0.0, 0.0), (0.0, h)];
            let steps = 8;
            let total = a;
            let seg = p.top_length / steps as f64;
            let (mut o, mut z, mut dir) = (0.0f64, h, 0.0f64);
            for _ in 0..steps {
                dir += total / steps as f64;
                o += seg * dir.sin();
                z += seg * dir.cos();
                c.push((o, z));
            }
            vec![thick_polyline(&c, t, f, b)]
        }
        "tTop" => {
            let w = p.top_length;
            vec![
                thick_polyline(&[(0.0, 0.0), (0.0, h)], t, f, b),
                thick_polyline(&[(w / 2.0, h + t / 2.0), (-w / 2.0, h + t / 2.0)], t, f, b),
            ]
        }
        "yTop" => {
            let l = p.top_length;
            vec![
                thick_polyline(&[(0.0, 0.0), (0.0, h)], t, f, b),
                thick_polyline(&[(0.0, h), (l * a.sin(), h + l * a.cos())], t, f, f),
                thick_polyline(&[(0.0, h), (-l * a.sin(), h + l * a.cos())], t, b, b),
            ]
        }
        "berm" | "bermWall" | "gabion" => {
            let (fs, bs) = if p.kind == "gabion" {
                (p.front_slope.max(60.0), p.back_slope.max(60.0))
            } else {
                (p.front_slope.clamp(5.0, 89.0), p.back_slope.clamp(5.0, 89.0))
            };
            let mat = if p.kind == "gabion" { "gabion" } else { "grass" };
            let cw = p.crest.max(0.0);
            let cb = p.crest_back.max(0.0);
            let fw = h / fs.to_radians().tan();
            let bw = h / bs.to_radians().tan();
            // road side is +o
            let verts = vec![
                PV { o: cw / 2.0 + fw, h: 0.0, m: mat.into() },
                PV { o: cw / 2.0, h, m: mat.into() },
                PV { o: -cw / 2.0 - cb, h, m: mat.into() },
                PV { o: -cw / 2.0 - cb - bw, h: 0.0, m: "base".into() },
            ];
            let mut parts = vec![Part { verts }];
            if p.kind == "bermWall" && p.wall_height > 0.0 {
                let mut stem = thick_polyline(&[(0.0, h - 0.2), (0.0, h + p.wall_height)], t, f, b);
                for v in stem.verts.iter_mut() {
                    v.h = v.h.max(h - 0.2);
                }
                parts.push(stem);
            }
            parts
        }
        _ => vec![thick_polyline(&[(0.0, 0.0), (0.0, h)], t, f, b)], // vertical
    }
}

/// Highest point of the cross-section.
pub fn profile_top(parts: &[Part]) -> f64 {
    parts.iter().flat_map(|p| p.verts.iter()).map(|v| v.h).fold(0.0, f64::max)
}

// ------------------------------------------------------------------ extrusion

fn signed_area(v: &[PV]) -> f64 {
    let mut a = 0.0;
    for i in 0..v.len() {
        let j = (i + 1) % v.len();
        a += v[i].o * v[j].h - v[j].o * v[i].h;
    }
    a / 2.0
}

/// Faces of the barrier for image sources and occlusion.
pub fn facets(bar: &Barrier, index: usize, ground: &Raster) -> Vec<Facet> {
    let mut out = Vec::new();
    if !bar.enabled {
        return out;
    }
    for w in bar.points.windows(2) {
        let (ax, ay, bx, by) = (w[0][0], w[0][1], w[1][0], w[1][1]);
        let (dx, dy) = (bx - ax, by - ay);
        let l = (dx * dx + dy * dy).sqrt();
        if l < 0.05 {
            continue;
        }
        let (nx, ny) = (-dy / l, dx / l); // left normal = +o (road side)
        let za = ground.bilinear(ax, ay);
        let zb = ground.bilinear(bx, by);
        for part in &bar.profile {
            let v = &part.verts;
            if v.len() < 3 {
                continue;
            }
            let ccw = signed_area(v) > 0.0;
            for i in 0..v.len() {
                let p = &v[i];
                let q = &v[(i + 1) % v.len()];
                if p.m == "base" || (p.h < 0.01 && q.h < 0.01) {
                    continue;
                }
                let (eo, eh) = (q.o - p.o, q.h - p.h);
                // outward normal in the (o,h) plane
                let (mo, mh) = if ccw { (eh, -eo) } else { (-eh, eo) };
                let outward = V3::new(nx * mo, ny * mo, mh);
                let pt = |x0: f64, y0: f64, z0: f64, pv: &PV| V3::new(x0 + nx * pv.o, y0 + ny * pv.o, z0 + pv.h);
                let verts = vec![pt(ax, ay, za, p), pt(bx, by, zb, p), pt(bx, by, zb, q), pt(ax, ay, za, q)];
                if let Some(f) = Facet::new(verts, outward, reflection(&p.m), Owner::Barrier(index)) {
                    out.push(f);
                }
            }
        }
    }
    out
}

/// A point of the vertical cut through a barrier along a source→receiver line.
#[derive(Clone, Copy, Debug)]
pub struct Crossing {
    /// distance from the start of the line, m
    pub dist: f64,
    pub z: f64,
}

/// Where the plan line s→r cuts the barrier, as profile points (every vertex
/// of the cross-section, stretched by the crossing angle).
pub fn crossings(bar: &Barrier, s: (f64, f64), r: (f64, f64), ground: &Raster, out: &mut Vec<Crossing>) -> bool {
    if !bar.enabled {
        return false;
    }
    let (dx, dy) = (r.0 - s.0, r.1 - s.1);
    let d = (dx * dx + dy * dy).sqrt();
    if d < 1e-6 {
        return false;
    }
    let mut crossed = false;
    for w in bar.points.windows(2) {
        let (ax, ay) = (w[0][0], w[0][1]);
        let (ux, uy) = (w[1][0] - ax, w[1][1] - ay);
        let l = (ux * ux + uy * uy).sqrt();
        if l < 0.05 {
            continue;
        }
        let (ux, uy) = (ux / l, uy / l);
        let (nx, ny) = (-uy, ux);
        let den = dx * uy - dy * ux; // cross(D, u)
        if den.abs() < 1e-9 {
            continue;
        }
        for part in &bar.profile {
            for v in &part.verts {
                // S + tD = A + n o + u s
                let qx = ax + nx * v.o - s.0;
                let qy = ay + ny * v.o - s.1;
                let t = (qx * uy - qy * ux) / den;
                let sa = (qx * dy - qy * dx) / den;
                if t <= 0.0 || t >= 1.0 || sa < -0.02 * l || sa > 1.02 * l {
                    continue;
                }
                let gz = ground.bilinear(ax + ux * sa, ay + uy * sa);
                out.push(Crossing { dist: t * d, z: gz + v.h });
                crossed = true;
            }
        }
    }
    crossed
}
