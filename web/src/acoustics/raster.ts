/** A regular grid; row 0 = south, sample (c, r) at (e0 + c·cell, n0 + r·cell). */
export interface Raster {
  cols: number
  rows: number
  cell: number
  e0: number
  n0: number
  data: Float32Array
}

export function sampleBilinear(r: Raster, x: number, y: number): number {
  let gx = (x - r.e0) / r.cell
  let gy = (y - r.n0) / r.cell
  gx = Math.max(0, Math.min(r.cols - 1, gx))
  gy = Math.max(0, Math.min(r.rows - 1, gy))
  const x0 = gx | 0
  const y0 = gy | 0
  const x1 = Math.min(x0 + 1, r.cols - 1)
  const y1 = Math.min(y0 + 1, r.rows - 1)
  const fx = gx - x0
  const fy = gy - y0
  const d = r.data
  const a = d[y0 * r.cols + x0]
  const b = d[y0 * r.cols + x1]
  const c = d[y1 * r.cols + x0]
  const e = d[y1 * r.cols + x1]
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy
}

export function sampleNearest(r: Raster, x: number, y: number): number {
  const c = Math.round((x - r.e0) / r.cell)
  const k = Math.round((y - r.n0) / r.cell)
  if (c < 0 || k < 0 || c >= r.cols || k >= r.rows) return 0
  return r.data[k * r.cols + c]
}
