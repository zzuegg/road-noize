// Values derived from results for display: metric per grid cell, per
// building, per receiver; differences; statistics.

import { metricOf, limitFor } from '../acoustics/metrics'
import type { Metric, Project } from '../model/types'
import type { ScenarioResult } from '../model/store'

export function metricArray(data: Float32Array, stride: number, m: Metric): Float32Array {
  const n = data.length / stride
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const ld = data[i * stride]
    out[i] = Number.isFinite(ld)
      ? metricOf(m, ld, data[i * stride + 1], data[i * stride + 2])
      : NaN
  }
  return out
}

export interface BuildingLevels {
  /** max over the façade per building */
  max: Map<string, number>
  /** max per building and floor */
  floors: Map<string, number[]>
}

export function buildingLevels(r: ScenarioResult, m: Metric): BuildingLevels {
  const max = new Map<string, number>()
  const floors = new Map<string, number[]>()
  const f = r.facade
  if (!f) return { max, floors }
  const vals = metricArray(f.data, 3, m)
  f.meta.forEach((pt, i) => {
    const id = f.buildingIds[pt.building]
    const v = vals[i]
    if (!Number.isFinite(v)) return
    if (!(v <= (max.get(id) ?? -Infinity))) max.set(id, v)
    const fl = floors.get(id) ?? []
    if (!(v <= (fl[pt.floor] ?? -Infinity))) fl[pt.floor] = v
    floors.set(id, fl)
  })
  return { max, floors }
}

export interface Stats {
  buildingsOver: number
  buildingsTotal: number
  floorsOver: number
  areaOver: number
  facadeMax: number
}

export function stats(p: Project, r: ScenarioResult, m: Metric): Stats {
  const limit = limitFor(m, p.settings)
  const bl = buildingLevels(r, m)
  let buildingsOver = 0
  let floorsOver = 0
  let facadeMax = -Infinity
  for (const [id, v] of bl.max) {
    if (v > facadeMax) facadeMax = v
    if (v > limit) buildingsOver++
    for (const f of bl.floors.get(id) ?? []) if (f > limit) floorsOver++
  }
  const g = metricArray(r.grid.data, 3, m)
  let cells = 0
  for (const v of g) if (v > limit) cells++
  return {
    buildingsOver,
    buildingsTotal: bl.max.size,
    floorsOver,
    areaOver: cells * r.grid.spec.step * r.grid.spec.step,
    facadeMax,
  }
}
