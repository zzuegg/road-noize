// The Rust core on the main thread: barrier presets (cheap, synchronous once
// loaded). Heavy work runs in workers (see runner.ts).

import init, { barrier_preset } from '../wasm/sansim.js'
import type { Barrier, Part, PresetParams, Project, Road, Scenario, Settings } from '../model/types'
import type { Raster } from './raster'

let ready: Promise<unknown> | undefined
let loaded = false

export function loadCore(): Promise<unknown> {
  ready ??= init().then(() => (loaded = true))
  return ready
}

export function coreLoaded(): boolean {
  return loaded
}

export function presetProfile(p: PresetParams): Part[] {
  if (!loaded) return []
  return JSON.parse(barrier_preset(JSON.stringify(p))) as Part[]
}

/** Barrier as the core expects it: road side always to the left of the line. */
function coreBarrier(b: Barrier) {
  const points = b.flip ? [...b.points].reverse() : b.points
  const profile = b.preset.kind === 'custom' ? b.profile : presetProfile(b.preset)
  return { id: b.id, name: b.name, points, profile, enabled: b.enabled }
}

/** Main roads: state and provincial roads (SS, LS). */
export function isMainRoad(r: Road): boolean {
  return r.cls === 'SS' || r.cls === 'LS'
}

/** Does this road emit under the calculation's source selection? */
export function roadEmits(r: Road, set: Settings): boolean {
  if (!r.enabled) return false
  if (set.sources === 'main') return isMainRoad(r)
  if (set.sources === 'selected') return set.selectedRoads.includes(r.id)
  return true
}

/** The SceneInput JSON of core/src/scene.rs. */
export function sceneJson(p: Project, s: Scenario, ground: Raster): string {
  const set = p.settings
  return JSON.stringify({
    ground: { cols: ground.cols, rows: ground.rows, cell: ground.cell, e0: ground.e0, n0: ground.n0 },
    roads: p.roads.map((r) => ({ id: r.id, cls: r.cls, enabled: roadEmits(r, set), lines: r.lines, traffic: r.traffic })),
    measures: s.measures,
    buildings: p.buildings.map((b) => ({ id: b.id, ring: b.ring, height: b.height })),
    barriers: s.barriers.map(coreBarrier),
    settings: {
      maxDistance: set.maxDistance,
      groundClass: set.groundClass,
      reflectionOrder: set.reflectionOrder,
      reflectionRadius: set.reflectionRadius,
      subFrequencies: set.subFrequencies,
      lateral: set.lateral,
      turbulence: { ct2: set.turbulence.ct2, cv2: set.turbulence.cv2, outer_scale: set.turbulence.outerScale },
      met: set.met.map((m) => ({ name: m.name, radius: m.radius, distance_scaled: m.distanceScaled, weights: m.weights })),
      temperature: set.temperature,
      humidity: set.humidity,
      method: set.method,
      cmetC0: set.cmetC0,
      favourableP: set.favourableP,
      isoSourceHeight: set.isoSourceHeight,
    },
  })
}
