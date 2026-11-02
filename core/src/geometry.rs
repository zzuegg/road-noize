//! 3D geometry: planar facets (barrier faces, building façades) for image
//! sources and occlusion tests.

use crate::bands::NB;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct V3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl V3 {
    pub const fn new(x: f64, y: f64, z: f64) -> V3 {
        V3 { x, y, z }
    }
    pub fn sub(self, o: V3) -> V3 {
        V3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    pub fn add(self, o: V3) -> V3 {
        V3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    pub fn mul(self, k: f64) -> V3 {
        V3::new(self.x * k, self.y * k, self.z * k)
    }
    pub fn dot(self, o: V3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: V3) -> V3 {
        V3::new(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x)
    }
    pub fn len(self) -> f64 {
        self.dot(self).sqrt()
    }
    pub fn norm(self) -> V3 {
        let l = self.len();
        if l > 0.0 { self.mul(1.0 / l) } else { self }
    }
    pub fn dist(self, o: V3) -> f64 {
        self.sub(o).len()
    }
}

/// What a facet belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Barrier(usize),
    Building(usize),
}

/// A planar convex polygon with an outward normal and an energy reflection
/// factor per band (1 − α).
#[derive(Clone, Debug)]
pub struct Facet {
    pub verts: Vec<V3>,
    pub normal: V3,
    /// plane: n·p = d
    pub d: f64,
    pub refl: [f64; NB],
    pub owner: Owner,
    pub centre: V3,
    pub radius: f64,
    /// smallest dimension of the face (ISO 9613-2 7.5 size criterion)
    pub lmin: f64,
    // in-plane basis for the inside test
    u: V3,
    v: V3,
    poly2: Vec<(f64, f64)>,
}

impl Facet {
    /// `verts` in order; `outward` is a point-free hint: the normal is flipped
    /// to agree with it.
    pub fn new(verts: Vec<V3>, outward: V3, refl: [f64; NB], owner: Owner) -> Option<Facet> {
        if verts.len() < 3 {
            return None;
        }
        // Newell normal
        let mut n = V3::new(0.0, 0.0, 0.0);
        for i in 0..verts.len() {
            let a = verts[i];
            let b = verts[(i + 1) % verts.len()];
            n.x += (a.y - b.y) * (a.z + b.z);
            n.y += (a.z - b.z) * (a.x + b.x);
            n.z += (a.x - b.x) * (a.y + b.y);
        }
        if n.len() < 1e-9 {
            return None;
        }
        let mut n = n.norm();
        if n.dot(outward) < 0.0 {
            n = n.mul(-1.0);
        }
        let mut c = V3::new(0.0, 0.0, 0.0);
        for p in &verts {
            c = c.add(*p);
        }
        c = c.mul(1.0 / verts.len() as f64);
        let radius = verts.iter().map(|p| p.dist(c)).fold(0.0, f64::max);
        let u = verts[1].sub(verts[0]).norm();
        let v = n.cross(u).norm();
        let poly2 = verts.iter().map(|p| (p.sub(c).dot(u), p.sub(c).dot(v))).collect();
        let e0 = verts[1].dist(verts[0]);
        let e1 = verts[2].dist(verts[1]);
        let lmin = e0.min(e1);
        Some(Facet { d: n.dot(verts[0]), normal: n, refl, owner, centre: c, radius, lmin, u, v, poly2, verts })
    }

    pub fn signed_distance(&self, p: V3) -> f64 {
        self.normal.dot(p) - self.d
    }

    pub fn mirror(&self, p: V3) -> V3 {
        p.sub(self.normal.mul(2.0 * self.signed_distance(p)))
    }

    /// Point (assumed on the plane) inside the polygon?
    pub fn contains(&self, p: V3) -> bool {
        let q = p.sub(self.centre);
        let (x, y) = (q.dot(self.u), q.dot(self.v));
        let poly = &self.poly2;
        let mut inside = false;
        let mut j = poly.len() - 1;
        for i in 0..poly.len() {
            let (xi, yi) = poly[i];
            let (xj, yj) = poly[j];
            if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
                inside = !inside;
            }
            j = i;
        }
        inside
    }

    /// Intersection parameter t ∈ (0,1) of segment a→b with the facet, if any.
    pub fn intersect(&self, a: V3, b: V3) -> Option<f64> {
        let da = self.signed_distance(a);
        let db = self.signed_distance(b);
        if (da > 0.0) == (db > 0.0) {
            return None;
        }
        let t = da / (da - db);
        if t <= 1e-4 || t >= 1.0 - 1e-4 {
            return None;
        }
        let p = a.add(b.sub(a).mul(t));
        if self.contains(p) { Some(t) } else { None }
    }
}
