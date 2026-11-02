import type { MetClass, PresetParams, Project, RoadClass, Scenario, Settings, Traffic, Turbulence } from './types'

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

/**
 * Propagation conditions for an Alpine valley floor. Radii after NMPB-2008
 * (favourable: max(1000 m, 8 d)); inversion and upward classes are typical
 * values. Occurrences are ESTIMATES — replace with local wind/temperature
 * statistics (e.g. the provincial weather service) where available.
 */
export const DEFAULT_MET: MetClass[] = [
  { name: 'homogen', radius: 0, distanceScaled: false, weights: [40, 50, 30] },
  { name: 'günstig (Mitwind)', radius: 1000, distanceScaled: true, weights: [35, 40, 40] },
  { name: 'Inversion', radius: 600, distanceScaled: false, weights: [0, 10, 30] },
  { name: 'aufwärts (Sonne, Gegenwind)', radius: -2500, distanceScaled: false, weights: [25, 0, 0] },
]

export const TURBULENCE_PRESETS: Record<'weak' | 'moderate' | 'strong', Turbulence> = {
  weak: { ct2: 0.002, cv2: 0.03, outerScale: 1.1 },
  moderate: { ct2: 0.008, cv2: 0.12, outerScale: 1.1 },
  strong: { ct2: 0.03, cv2: 0.5, outerScale: 1.1 },
}

export const DEFAULT_SETTINGS: Settings = {
  method: 'physics',
  cmetC0: [0, 0, 0],
  isoSourceHeight: 0.05,
  gridSpacing: 10,
  receiverHeight: 4,
  groundClass: 'orchard',
  maxDistance: 800,
  reflectionOrder: 2,
  reflectionRadius: 150,
  subFrequencies: 3,
  lateral: true,
  turbulence: TURBULENCE_PRESETS.moderate,
  met: DEFAULT_MET,
  temperature: 10,
  humidity: 70,
  facades: true,
  // DPR 142/2004, existing extra-urban road, band A (100 m) — residential.
  limitDay: 70,
  limitNight: 60,
  // WHO Environmental Noise Guidelines 2018, road traffic.
  limitLden: 53,
}

export function defaultPreset(kind: PresetParams['kind'] = 'vertical'): PresetParams {
  const base: PresetParams = {
    kind,
    height: 3,
    thickness: 0.2,
    angle: 0,
    topLength: 1.5,
    crest: 1.5,
    frontSlope: 34,
    backSlope: 34,
    wallHeight: 0,
    front: 'absorptive',
    back: 'reflective',
  }
  switch (kind) {
    case 'tilted':
      return { ...base, angle: 10 }
    case 'bentTop':
      return { ...base, angle: 45 }
    case 'curvedTop':
      return { ...base, angle: 60, topLength: 2 }
    case 'tTop':
      return { ...base, topLength: 1.2 }
    case 'yTop':
      return { ...base, angle: 35, topLength: 1 }
    case 'berm':
      return { ...base, height: 3, front: 'grass', back: 'grass' }
    case 'bermWall':
      return { ...base, height: 2, wallHeight: 2, crest: 1.5 }
    case 'gabion':
      return { ...base, height: 3, crest: 1, frontSlope: 80, backSlope: 80, front: 'gabion', back: 'gabion' }
    default:
      return base
  }
}

export function createScenario(name: string): Scenario {
  return { id: uid('sc'), name, barriers: [], measures: {} }
}

/** Tschars / Ciardes (Kastelbell-Tschars), the village and the SS 38 below it. */
export const TSCHARS_AREA = { e0: 647600, n0: 5165500, e1: 649900, n1: 5167500 }

export function createProject(name: string, baselineName: string): Project {
  const baseline = createScenario(baselineName)
  return {
    format: 'traffic-sansim',
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
