import { describe, expect, it } from 'vitest'
import { aWeighted, vehiclePower, gradientCorrection } from './emission'
import { computePoint, periodLevels } from './engine'
import { buildScene, buildWalls, rasterizeBuildings } from './build'
import type { Raster } from './scene'
import { createProject, defaultTraffic, uid } from '../model/defaults'
import type { Barrier, Building, Project, Road } from '../model/types'
import { lden } from './metrics'
import { NB } from './bands'

const AREA = { e0: 0, n0: 0, e1: 400, n1: 400 }

function flat(z = 500): Raster {
  const cols = 161
  return { cols, rows: cols, cell: 2.5, e0: 0, n0: 0, data: new Float32Array(cols * cols).fill(z) }
}

function project(roads: Road[], buildings: Building[] = []): Project {
  const p = createProject('t', 'base')
  p.area = AREA
  p.roads = roads
  p.buildings = buildings
  p.settings.groundG = 0
  p.settings.maxDistance = 2000
  return p
}

function straightRoad(aadt = 24000): Road {
  const traffic = defaultTraffic('SS')
  traffic.aadt = aadt
  traffic.share = { medium: 0, heavy: 0, moped: 0, moto: 0 }
  traffic.speed = { light: 50, medium: 50, heavy: 50, moped: 50, moto: 50 }
  traffic.periodShare = { day: 14 / 24 * 100, evening: 2 / 24 * 100, night: 8 / 24 * 100 }
  return { id: uid('r'), name: 'r', cls: 'SS', enabled: true, lines: [[[0, 100], [400, 100]]], traffic }
}

function levelAt(p: Project, x: number, y: number, h: number, barriers: Barrier[] = []) {
  const g = flat()
  const b = rasterizeBuildings(p.buildings, AREA)
  const sc = { ...p.scenarios[0], barriers }
  const scene = buildScene(p, sc, g, b)
  const out = new Float64Array(3 * NB)
  computePoint(scene, x, y, h, out)
  return periodLevels(out)[0]
}

describe('emission (CNOSSOS-EU)', () => {
  it('a passenger car at 50 km/h is around 92–96 dB(A) sound power', () => {
    const lw = aWeighted(vehiclePower('light', 50))
    expect(lw).toBeGreaterThan(92)
    expect(lw).toBeLessThan(97)
  })
  it('a heavy truck is about 8–12 dB louder than a car at 50 km/h', () => {
    const d = aWeighted(vehiclePower('heavy', 50)) - aWeighted(vehiclePower('light', 50))
    expect(d).toBeGreaterThan(6)
    expect(d).toBeLessThan(13)
  })
  it('noise grows with speed', () => {
    expect(aWeighted(vehiclePower('light', 90))).toBeGreaterThan(aWeighted(vehiclePower('light', 50)) + 4)
  })
  it('uphill makes trucks louder, mild slopes do not affect cars', () => {
    expect(gradientCorrection('heavy', 6, 50)).toBeGreaterThan(3)
    expect(gradientCorrection('light', 1, 50)).toBe(0)
  })
})

describe('propagation', () => {
  it('long straight road: about 3 dB per doubling of distance over hard ground', () => {
    const p = project([straightRoad()])
    const l10 = levelAt(p, 200, 110, 1.5)
    const l20 = levelAt(p, 200, 120, 1.5)
    const l40 = levelAt(p, 200, 140, 1.5)
    expect(l10 - l20).toBeGreaterThan(2.3)
    expect(l10 - l20).toBeLessThan(4.2)
    expect(l20 - l40).toBeGreaterThan(2.3)
    expect(l20 - l40).toBeLessThan(4.5)
  })

  it('plausible absolute level: 1000 cars/h at 50 km/h, 25 m, roughly 60–68 dB(A)', () => {
    // 24000/day at uniform periods = 1000/h
    const p = project([straightRoad(24000)])
    const l = levelAt(p, 200, 125, 4)
    expect(l).toBeGreaterThan(58)
    expect(l).toBeLessThan(69)
  })

  it('soft ground attenuates more than hard ground', () => {
    const hard = project([straightRoad()])
    const soft = project([straightRoad()])
    soft.settings.groundG = 1
    expect(levelAt(soft, 200, 160, 1.5)).toBeLessThan(levelAt(hard, 200, 160, 1.5) - 1)
  })

  it('a 3 m wall next to the road shields a ground-floor receiver by several dB', () => {
    const p = project([straightRoad()])
    const wall: Barrier = {
      id: 'w', name: 'w', kind: 'wall', points: [[-50, 105], [450, 105]], height: 3,
      absorption: 'absorptive', crestWidth: 0, enabled: true,
    }
    const without = levelAt(p, 200, 130, 1.5)
    const withWall = levelAt(p, 200, 130, 1.5, [wall])
    expect(without - withWall).toBeGreaterThan(7)
    expect(without - withWall).toBeLessThan(20)
    // ... and much less on a high floor
    const hiWithout = levelAt(p, 200, 130, 14)
    const hiWith = levelAt(p, 200, 130, 14, [wall])
    expect(hiWithout - hiWith).toBeLessThan(without - withWall)
  })

  it('a reflective wall raises the level on the opposite side of the road', () => {
    const p = project([straightRoad()])
    const mk = (absorption: Barrier['absorption']): Barrier => ({
      id: 'w', name: 'w', kind: 'wall', points: [[-50, 105], [450, 105]], height: 4,
      absorption, crestWidth: 0, enabled: true,
    })
    const none = levelAt(p, 200, 70, 4)
    const refl = levelAt(p, 200, 70, 4, [mk('reflective')])
    const abs = levelAt(p, 200, 70, 4, [mk('highlyAbsorptive')])
    expect(refl - none).toBeGreaterThan(1)
    expect(refl - none).toBeLessThan(3.5)
    expect(abs - none).toBeLessThan(refl - none)
  })

  it('a building between road and receiver shields it', () => {
    const bld: Building = {
      id: 'b', height: 10, heightSource: 'user',
      ring: [[60, 115], [340, 115], [340, 130], [60, 130]],
    }
    const open = levelAt(project([straightRoad()]), 200, 140, 2)
    const shielded = levelAt(project([straightRoad()], [bld]), 200, 140, 2)
    expect(open - shielded).toBeGreaterThan(10)
  })

  it('berms are walls with a crest and do not reflect', () => {
    const w = buildWalls([{ id: 'b', name: 'b', kind: 'berm', points: [[0, 0], [10, 0]], height: 3, absorption: 'reflective', crestWidth: 2, enabled: true }])
    expect(w.n).toBe(2)
    expect(Number.isNaN(w.refl[0])).toBe(true)
  })
})

describe('indicators', () => {
  it('Lden of a constant level carries the evening and night penalties', () => {
    expect(lden(60, 60, 60)).toBeCloseTo(66.4, 0)
  })
})
