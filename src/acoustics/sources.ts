// Roads → emission tree.
//
// Each road is cut into pieces of at most PIECE metres. A piece carries the
// sound power of both directions of travel for every period, with the
// gradient correction taken from the terrain in each direction. Pieces of one
// road are then grouped pairwise into a binary tree (see SourceTree).

import { NB } from './bands'
import { CATEGORIES, streamPowerPerMetre, vehiclePower, type Category } from './emission'
import { NP, sampleBilinear, type Raster, type SourceTree } from './scene'
import { PERIOD_HOURS, PERIODS, type Road, type RoadMeasure, type Traffic } from '../model/types'

const PIECE = 4
/** Source height above the road surface (CNOSSOS-EU). */
export const SOURCE_HEIGHT = 0.05

/** Traffic with a scenario's measures applied. */
export function effectiveTraffic(t: Traffic, m: RoadMeasure | undefined): Traffic {
  if (!m) return t
  const factor = 1 + (m.trafficChange ?? 0) / 100
  const speed = { ...t.speed }
  if (m.speedLimit !== undefined) {
    for (const c of CATEGORIES) speed[c] = Math.min(speed[c], m.speedLimit)
  }
  return {
    ...t,
    aadt: m.closed ? 0 : Math.max(0, t.aadt * factor),
    speed,
    surface: m.surface ?? t.surface,
    motoExtra: m.motoExtra ?? t.motoExtra,
    heavyNight: m.nightHeavyBan ? 0 : t.heavyNight,
  }
}

/** Vehicles per hour by category in each period. */
export function hourlyFlows(t: Traffic): Record<Category, number>[] {
  return PERIODS.map((p) => {
    const perHour = (t.aadt * (t.periodShare[p] / 100)) / PERIOD_HOURS[p]
    const s = { ...t.share }
    if (p === 'night' && t.heavyNight !== undefined) s.heavy = t.heavyNight
    const light = Math.max(0, 100 - s.medium - s.heavy - s.moped - s.moto)
    return {
      light: (perHour * light) / 100,
      medium: (perHour * s.medium) / 100,
      heavy: (perHour * s.heavy) / 100,
      moped: (perHour * s.moped) / 100,
      moto: (perHour * s.moto) / 100,
    }
  })
}

interface Leaf {
  x: number
  y: number
  z: number
  len: number
  pow: Float64Array
  road: number
}

/** Power per metre for both directions on a gradient s (percent, along +). */
function powerPerMetre(t: Traffic, flows: Record<Category, number>[], s: number): Float64Array {
  const out = new Float64Array(NP * NB)
  for (let p = 0; p < NP; p++) {
    for (const c of CATEGORIES) {
      const q = flows[p][c] / 2
      if (!(q > 0)) continue
      const extra = c === 'moto' ? t.motoExtra : 0
      for (const sign of [1, -1]) {
        const w = streamPowerPerMetre(c, q, t.speed[c], {
          gradient: sign * s,
          surface: t.surface,
          extra,
        })
        for (let b = 0; b < NB; b++) out[p * NB + b] += w[b]
      }
    }
  }
  return out
}

export interface SourceBuild {
  tree: SourceTree
  /** Per road (index in the list given), category, band: vehicle power dB. */
  vehicle: Float64Array
}

export function buildSources(
  roads: readonly Road[],
  measures: Record<string, RoadMeasure>,
  ground: Raster,
): SourceBuild {
  const vehicle = new Float64Array(roads.length * 5 * NB).fill(-Infinity)
  const groups: Leaf[][] = []

  roads.forEach((road, ri) => {
    if (!road.enabled) return
    const t = effectiveTraffic(road.traffic, measures[road.id])
    if (!(t.aadt > 0)) return
    const flows = hourlyFlows(t)
    CATEGORIES.forEach((c, ci) => {
      const lw = vehiclePower(c, t.speed[c], {
        surface: t.surface,
        extra: c === 'moto' ? t.motoExtra : 0,
      })
      for (let b = 0; b < NB; b++) vehicle[(ri * 5 + ci) * NB + b] = lw[b]
    })

    for (const line of road.lines) {
      const leaves: Leaf[] = []
      for (let i = 0; i < line.length - 1; i++) {
        const [x0, y0] = line[i]
        const [x1, y1] = line[i + 1]
        const L = Math.hypot(x1 - x0, y1 - y0)
        if (L < 0.01) continue
        const n = Math.max(1, Math.ceil(L / PIECE))
        for (let k = 0; k < n; k++) {
          const ta = k / n
          const tb = (k + 1) / n
          const xa = x0 + (x1 - x0) * ta
          const ya = y0 + (y1 - y0) * ta
          const xb = x0 + (x1 - x0) * tb
          const yb = y0 + (y1 - y0) * tb
          const len = L / n
          // gradient over a 20 m base, smoother than the DTM cell noise
          const ux = (x1 - x0) / L
          const uy = (y1 - y0) / L
          const xm = (xa + xb) / 2
          const ym = (ya + yb) / 2
          const zA = sampleBilinear(ground, xm - ux * 10, ym - uy * 10)
          const zB = sampleBilinear(ground, xm + ux * 10, ym + uy * 10)
          const s = ((zB - zA) / 20) * 100
          const ppm = powerPerMetre(t, flows, s)
          const pow = new Float64Array(NP * NB)
          for (let q = 0; q < pow.length; q++) pow[q] = ppm[q] * len
          leaves.push({
            x: xm,
            y: ym,
            z: sampleBilinear(ground, xm, ym) + SOURCE_HEIGHT,
            len,
            pow,
            road: ri,
          })
        }
      }
      if (leaves.length) groups.push(leaves)
    }
  })

  // ---- flatten into a tree
  const total = groups.reduce((s, g) => s + 2 * g.length - 1, 0)
  const tree: SourceTree = {
    n: total,
    x: new Float64Array(total),
    y: new Float64Array(total),
    z: new Float64Array(total),
    r: new Float64Array(total),
    left: new Int32Array(total).fill(-1),
    right: new Int32Array(total).fill(-1),
    pow: new Float64Array(total * NP * NB),
    road: new Int32Array(total),
    roots: new Int32Array(groups.length),
  }
  let next = 0

  function weight(pow: Float64Array): number {
    let s = 0
    for (let b = 0; b < NB; b++) s += pow[b] // day, unweighted: good enough for a centroid
    return s
  }

  function build(leaves: Leaf[], lo: number, hi: number): number {
    const id = next++
    if (hi - lo === 1) {
      const l = leaves[lo]
      tree.x[id] = l.x
      tree.y[id] = l.y
      tree.z[id] = l.z
      tree.r[id] = l.len / 2
      tree.pow.set(l.pow, id * NP * NB)
      tree.road[id] = l.road
      return id
    }
    const mid = (lo + hi) >> 1
    const a = build(leaves, lo, mid)
    const b = build(leaves, mid, hi)
    tree.left[id] = a
    tree.right[id] = b
    const o = id * NP * NB
    for (let q = 0; q < NP * NB; q++) {
      tree.pow[o + q] = tree.pow[a * NP * NB + q] + tree.pow[b * NP * NB + q]
    }
    const wa = weight(tree.pow.subarray(a * NP * NB, a * NP * NB + NB)) || 1
    const wb = weight(tree.pow.subarray(b * NP * NB, b * NP * NB + NB)) || 1
    const x = (tree.x[a] * wa + tree.x[b] * wb) / (wa + wb)
    const y = (tree.y[a] * wa + tree.y[b] * wb) / (wa + wb)
    tree.x[id] = x
    tree.y[id] = y
    tree.z[id] = (tree.z[a] * wa + tree.z[b] * wb) / (wa + wb)
    tree.r[id] = Math.max(
      Math.hypot(tree.x[a] - x, tree.y[a] - y) + tree.r[a],
      Math.hypot(tree.x[b] - x, tree.y[b] - y) + tree.r[b],
    )
    tree.road[id] = tree.road[a]
    return id
  }

  groups.forEach((leaves, gi) => {
    tree.roots[gi] = build(leaves, 0, leaves.length)
  })
  return { tree, vehicle }
}
