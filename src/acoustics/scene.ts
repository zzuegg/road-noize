// What the propagation engine works on: flat typed arrays only, so a scene can
// be posted to web workers cheaply and the inner loops stay monomorphic.

import { NB } from './bands'

/** Number of assessment periods carried through the engine (day, evening, night). */
export const NP = 3

/**
 * A regular grid of values. Row 0 is the SOUTH edge; sample (col,row) sits at
 * (e0 + col·cell, n0 + row·cell).
 */
export interface Raster {
  cols: number
  rows: number
  cell: number
  e0: number
  n0: number
  data: Float32Array
}

/**
 * Road sources as a binary tree over consecutive pieces of each road, so a
 * receiver far away sees a few aggregated point sources and a receiver close by
 * sees the individual pieces. Leaves have left = right = −1.
 */
export interface SourceTree {
  n: number
  x: Float64Array
  y: Float64Array
  z: Float64Array
  /** Radius enclosing everything under the node, metres. */
  r: Float64Array
  left: Int32Array
  right: Int32Array
  /** Sound power, linear (10^(Lw/10)), NP × NB per node: [period][band]. */
  pow: Float64Array
  /** Road index per node (leaves only meaningful), for maximum levels. */
  road: Int32Array
  roots: Int32Array
}

/** Barrier segments. Berms appear as two parallel non-reflecting crest lines. */
export interface WallSet {
  n: number
  x0: Float64Array
  y0: Float64Array
  x1: Float64Array
  y1: Float64Array
  /** Height above ground. */
  h: Float64Array
  /** Reflection loss in dB, or NaN where the segment does not reflect. */
  refl: Float64Array
}

export interface ComputeScene {
  ground: Raster
  /** Building height above ground, 0 where there is none. Sampled nearest. */
  bldg: Raster
  src: SourceTree
  walls: WallSet
  /** Per road, per category (5), per band: single-vehicle power in dB (day speeds). */
  vehicle: Float64Array
  groundG: number
  maxDistance: number
  reflections: boolean
}

export function emptyWalls(): WallSet {
  return {
    n: 0,
    x0: new Float64Array(0),
    y0: new Float64Array(0),
    x1: new Float64Array(0),
    y1: new Float64Array(0),
    h: new Float64Array(0),
    refl: new Float64Array(0),
  }
}

export function sampleBilinear(r: Raster, x: number, y: number): number {
  let gx = (x - r.e0) / r.cell
  let gy = (y - r.n0) / r.cell
  if (gx < 0) gx = 0
  else if (gx > r.cols - 1) gx = r.cols - 1
  if (gy < 0) gy = 0
  else if (gy > r.rows - 1) gy = r.rows - 1
  const x0 = gx | 0
  const y0 = gy | 0
  const x1 = x0 + 1 < r.cols ? x0 + 1 : x0
  const y1 = y0 + 1 < r.rows ? y0 + 1 : y0
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
  const col = Math.round((x - r.e0) / r.cell)
  const row = Math.round((y - r.n0) / r.cell)
  if (col < 0 || row < 0 || col >= r.cols || row >= r.rows) return 0
  return r.data[row * r.cols + col]
}

export const SCENE_BANDS = NB
