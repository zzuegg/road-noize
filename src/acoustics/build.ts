// Project + terrain → ComputeScene, and the receiver sets.

import { buildSources } from './sources'
import type { ComputeScene, Raster, WallSet } from './scene'
import {
  REFLECTION_LOSS,
  type Area,
  type Barrier,
  type Building,
  type Project,
  type Scenario,
  type XY,
} from '../model/types'

/** Resolution of the building raster, metres. */
const BLDG_CELL = 1

/** Building heights burned into a raster (scanline fill at cell centres). */
export function rasterizeBuildings(buildings: readonly Building[], area: Area): Raster {
  const cell = BLDG_CELL
  const cols = Math.ceil((area.e1 - area.e0) / cell) + 1
  const rows = Math.ceil((area.n1 - area.n0) / cell) + 1
  const data = new Float32Array(cols * rows)
  const xs: number[] = []
  for (const b of buildings) {
    const ring = b.ring
    if (ring.length < 3 || !(b.height > 0)) continue
    let minY = Infinity
    let maxY = -Infinity
    for (const [, y] of ring) {
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const r0 = Math.max(0, Math.ceil((minY - area.n0) / cell))
    const r1 = Math.min(rows - 1, Math.floor((maxY - area.n0) / cell))
    for (let row = r0; row <= r1; row++) {
      const y = area.n0 + row * cell
      xs.length = 0
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - area.e0) / cell))
        const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - area.e0) / cell))
        for (let col = c0; col <= c1; col++) {
          const i = row * cols + col
          if (b.height > data[i]) data[i] = b.height
        }
      }
    }
  }
  return { cols, rows, cell, e0: area.e0, n0: area.n0, data }
}

function offsetPolyline(points: readonly XY[], d: number): XY[] {
  return points.map(([x, y], i) => {
    const [ax, ay] = points[Math.max(0, i - 1)]
    const [bx, by] = points[Math.min(points.length - 1, i + 1)]
    const dx = bx - ax
    const dy = by - ay
    const l = Math.hypot(dx, dy) || 1
    return [x - (dy / l) * d, y + (dx / l) * d]
  })
}

export function buildWalls(barriers: readonly Barrier[]): WallSet {
  const segs: [number, number, number, number, number, number][] = []
  for (const b of barriers) {
    if (!b.enabled || b.points.length < 2 || !(b.height > 0)) continue
    const lines =
      b.kind === 'berm'
        ? [offsetPolyline(b.points, -b.crestWidth / 2), offsetPolyline(b.points, b.crestWidth / 2)]
        : [b.points]
    const refl = b.kind === 'wall' ? REFLECTION_LOSS[b.absorption] : NaN
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        segs.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1], b.height, refl])
      }
    }
  }
  const n = segs.length
  const w: WallSet = {
    n,
    x0: new Float64Array(n),
    y0: new Float64Array(n),
    x1: new Float64Array(n),
    y1: new Float64Array(n),
    h: new Float64Array(n),
    refl: new Float64Array(n),
  }
  segs.forEach((s, i) => {
    w.x0[i] = s[0]
    w.y0[i] = s[1]
    w.x1[i] = s[2]
    w.y1[i] = s[3]
    w.h[i] = s[4]
    w.refl[i] = s[5]
  })
  return w
}

export function buildScene(
  project: Project,
  scenario: Scenario,
  ground: Raster,
  bldg: Raster,
): ComputeScene {
  const { tree, vehicle } = buildSources(project.roads, scenario.measures, ground)
  return {
    ground,
    bldg,
    src: tree,
    walls: buildWalls(scenario.barriers),
    vehicle,
    groundG: project.settings.groundG,
    maxDistance: project.settings.maxDistance,
    reflections: project.settings.reflections,
  }
}

// ----------------------------------------------------------------- receivers

export interface ReceiverSet {
  x: Float64Array
  y: Float64Array
  h: Float64Array
  /** 1 = skip (inside a building). */
  skip: Uint8Array
}

export interface GridSpec {
  cols: number
  rows: number
  e0: number
  n0: number
  step: number
}

export function gridReceivers(area: Area, step: number, height: number, bldg: Raster) {
  const cols = Math.floor((area.e1 - area.e0) / step) + 1
  const rows = Math.floor((area.n1 - area.n0) / step) + 1
  const n = cols * rows
  const set: ReceiverSet = {
    x: new Float64Array(n),
    y: new Float64Array(n),
    h: new Float64Array(n).fill(height),
    skip: new Uint8Array(n),
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const x = area.e0 + c * step
      const y = area.n0 + r * step
      set.x[i] = x
      set.y[i] = y
      const col = Math.round((x - bldg.e0) / bldg.cell)
      const row = Math.round((y - bldg.n0) / bldg.cell)
      if (col >= 0 && row >= 0 && col < bldg.cols && row < bldg.rows) {
        if (bldg.data[row * bldg.cols + col] > 0) set.skip[i] = 1
      }
    }
  }
  const spec: GridSpec = { cols, rows, e0: area.e0, n0: area.n0, step }
  return { set, spec }
}

export interface FacadePoint {
  building: number
  floor: number
}

/** Storey heights evaluated on façades: 2 m, then every 3 m below the eaves. */
export function floorHeights(buildingHeight: number): number[] {
  const out = [2]
  for (let h = 5; h <= buildingHeight - 1 && out.length < 8; h += 3) out.push(h)
  return out
}

/** Points 1 m in front of every façade, every ~6 m, on every floor. */
export function facadeReceivers(buildings: readonly Building[], area: Area) {
  const xs: number[] = []
  const ys: number[] = []
  const hs: number[] = []
  const meta: FacadePoint[] = []
  buildings.forEach((b, bi) => {
    const ring = b.ring
    if (ring.length < 3) return
    let a2 = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    }
    const ccw = a2 > 0
    const floors = floorHeights(b.height)
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]
      const [x1, y1] = ring[(i + 1) % ring.length]
      const L = Math.hypot(x1 - x0, y1 - y0)
      if (L < 2) continue
      // outward normal
      let nx = (y1 - y0) / L
      let ny = -(x1 - x0) / L
      if (!ccw) {
        nx = -nx
        ny = -ny
      }
      const k = Math.max(1, Math.round(L / 6))
      for (let s = 0; s < k; s++) {
        const t = (s + 0.5) / k
        const x = x0 + (x1 - x0) * t + nx * 1.0
        const y = y0 + (y1 - y0) * t + ny * 1.0
        if (x < area.e0 || x > area.e1 || y < area.n0 || y > area.n1) continue
        floors.forEach((h, fi) => {
          xs.push(x)
          ys.push(y)
          hs.push(h)
          meta.push({ building: bi, floor: fi })
        })
      }
    }
  })
  const set: ReceiverSet = {
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    h: Float64Array.from(hs),
    skip: new Uint8Array(xs.length),
  }
  return { set, meta }
}

/** A vertical slice along a line: `cols` along, `rows` up from 0.5 m to `top` m. */
export function sectionReceivers(
  a: XY,
  b: XY,
  cols: number,
  rows: number,
  top: number,
  bldg: Raster,
  groundAt: (x: number, y: number) => number,
) {
  const n = cols * rows
  const set: ReceiverSet = {
    x: new Float64Array(n),
    y: new Float64Array(n),
    h: new Float64Array(n),
    skip: new Uint8Array(n),
  }
  // heights are absolute: from the lowest ground on the line upward
  let zmin = Infinity
  let zmax = -Infinity
  for (let c = 0; c < cols; c++) {
    const t = c / (cols - 1)
    const z = groundAt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    zmin = Math.min(zmin, z)
    zmax = Math.max(zmax, z)
  }
  const z0 = zmin
  const z1 = zmax + top
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = c / (cols - 1)
      const x = a[0] + (b[0] - a[0]) * t
      const y = a[1] + (b[1] - a[1]) * t
      const zAbs = z0 + ((z1 - z0) * (r + 0.5)) / rows
      const g = groundAt(x, y)
      const i = r * cols + c
      set.x[i] = x
      set.y[i] = y
      set.h[i] = zAbs - g
      const col = Math.round((x - bldg.e0) / bldg.cell)
      const row = Math.round((y - bldg.n0) / bldg.cell)
      const bh =
        col >= 0 && row >= 0 && col < bldg.cols && row < bldg.rows
          ? bldg.data[row * bldg.cols + col]
          : 0
      if (zAbs < g + 0.3 || zAbs < g + bh) set.skip[i] = 1
    }
  }
  return { set, z0, z1 }
}
