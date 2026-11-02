//! Regular grids. Row 0 is the SOUTH edge; sample (col,row) sits at
//! (e0 + col·cell, n0 + row·cell).

#[derive(Clone, Debug)]
pub struct Raster {
    pub cols: usize,
    pub rows: usize,
    pub cell: f64,
    pub e0: f64,
    pub n0: f64,
    pub data: Vec<f32>,
}

impl Raster {
    pub fn bilinear(&self, x: f64, y: f64) -> f64 {
        let gx = ((x - self.e0) / self.cell).clamp(0.0, (self.cols - 1) as f64);
        let gy = ((y - self.n0) / self.cell).clamp(0.0, (self.rows - 1) as f64);
        let x0 = gx as usize;
        let y0 = gy as usize;
        let x1 = (x0 + 1).min(self.cols - 1);
        let y1 = (y0 + 1).min(self.rows - 1);
        let fx = gx - x0 as f64;
        let fy = gy - y0 as f64;
        let d = &self.data;
        let a = d[y0 * self.cols + x0] as f64;
        let b = d[y0 * self.cols + x1] as f64;
        let c = d[y1 * self.cols + x0] as f64;
        let e = d[y1 * self.cols + x1] as f64;
        a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy
    }

    pub fn nearest(&self, x: f64, y: f64) -> f64 {
        let c = ((x - self.e0) / self.cell).round();
        let r = ((y - self.n0) / self.cell).round();
        if c < 0.0 || r < 0.0 || c >= self.cols as f64 || r >= self.rows as f64 {
            return 0.0;
        }
        self.data[r as usize * self.cols + c as usize] as f64
    }

    pub fn filled(cols: usize, rows: usize, cell: f64, e0: f64, n0: f64, v: f32) -> Raster {
        Raster { cols, rows, cell, e0, n0, data: vec![v; cols * rows] }
    }

    pub fn set(&mut self, col: usize, row: usize, v: f32) {
        if col < self.cols && row < self.rows {
            self.data[row * self.cols + col] = v;
        }
    }
}
