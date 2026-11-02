import type { Project, RoadClass, Scenario, Settings, Traffic } from './types'

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Starting values per road class. These are PLACEHOLDERS: replace them with
 * counted values (ASTAT traffic counters, municipal counts) before drawing
 * conclusions. The SS 38 default is in the range of the Vinschgau counters.
 */
export function defaultTraffic(cls: RoadClass): Traffic {
  const base: Traffic = {
    aadt: 500,
    share: { medium: 3, heavy: 1, moped: 1, moto: 2 },
    periodShare: { day: 82, evening: 8, night: 10 },
    speed: { light: 50, medium: 50, heavy: 50, moped: 40, moto: 50 },
    surface: 0,
    motoExtra: 0,
  }
  switch (cls) {
    case 'SS':
      return {
        ...base,
        aadt: 12000,
        share: { medium: 5, heavy: 7, moped: 0.5, moto: 4 },
        speed: { light: 70, medium: 70, heavy: 60, moped: 45, moto: 75 },
      }
    case 'LS':
      return {
        ...base,
        aadt: 2500,
        share: { medium: 4, heavy: 3, moped: 1, moto: 4 },
        speed: { light: 50, medium: 50, heavy: 45, moped: 40, moto: 55 },
      }
    case 'G':
      return { ...base, aadt: 400, speed: { light: 30, medium: 30, heavy: 30, moped: 30, moto: 30 } }
    default:
      return base
  }
}

export const DEFAULT_SETTINGS: Settings = {
  gridSpacing: 10,
  receiverHeight: 4,
  groundG: 0.7,
  maxDistance: 800,
  facades: true,
  reflections: true,
  // DPR 142/2004, existing extra-urban road, band A (100 m) — residential.
  limitDay: 70,
  limitNight: 60,
  // WHO Environmental Noise Guidelines 2018, road traffic.
  limitLden: 53,
}

export function createScenario(name: string): Scenario {
  return { id: uid('sc'), name, barriers: [], measures: {} }
}

/** Tschars / Ciardes (Kastelbell-Tschars), the village and the SS 38 below it. */
export const TSCHARS_AREA = { e0: 647600, n0: 5165500, e1: 649900, n1: 5167500 }

export function createProject(name: string, baselineName: string): Project {
  const baseline = createScenario(baselineName)
  return {
    format: 'traffic-noise',
    version: 1,
    name,
    demId: '2.5',
    roads: [],
    buildings: [],
    receivers: [],
    scenarios: [baseline],
    activeScenarioId: baseline.id,
    settings: { ...DEFAULT_SETTINGS },
  }
}
