// The project document. Plain JSON: saved to IndexedDB automatically and
// exported / imported as a .noise.json file.
//
// Everything is in EPSG:25832 (UTM 32N) metres, the CRS of the South Tyrol
// geoservices. Terrain grids are not stored — they are refetched (and cached).

import type { Category } from '../acoustics/emission'

export type XY = [number, number]

export interface Area {
  e0: number
  n0: number
  e1: number
  n1: number
}

/** Road classes from the provincial road graph. */
export type RoadClass = 'SS' | 'LS' | 'G' | 'PS' | 'user'

/** Assessment periods of D.Lgs. 194/2005 (Italy): day 06–20, evening 20–22, night 22–06. */
export type Period = 'day' | 'evening' | 'night'
export const PERIODS: readonly Period[] = ['day', 'evening', 'night']
export const PERIOD_HOURS: Record<Period, number> = { day: 14, evening: 2, night: 8 }

export interface Traffic {
  /** Average annual daily traffic, both directions together (vehicles / 24 h). */
  aadt: number
  /** Share of AADT per vehicle category in percent; light = the remainder. */
  share: { medium: number; heavy: number; moped: number; moto: number }
  /** Share of the daily traffic travelling in each period, percent (sum 100). */
  periodShare: Record<Period, number>
  /** Heavy vehicle share at night, percent; undefined = same as the day. */
  heavyNight?: number
  /** Speeds in km/h. */
  speed: Record<Category, number>
  /** Road surface correction on rolling noise, dB. */
  surface: number
  /** Extra dB for motorcycles (sport bikes, open exhausts). */
  motoExtra: number
}

export interface Road {
  id: string
  name: string
  cls: RoadClass
  enabled: boolean
  /** One road may be many links in the graph; each is a polyline. */
  lines: XY[][]
  traffic: Traffic
}

export interface Building {
  id: string
  ring: XY[]
  /** Height above ground, metres. */
  height: number
  heightSource: 'dsm' | 'default' | 'user'
  use?: string
}

export type Absorption = 'reflective' | 'absorptive' | 'highlyAbsorptive'

/** dB lost on reflection. EN 1793-1 categories A1 / A3 / A4, roughly. */
export const REFLECTION_LOSS: Record<Absorption, number> = {
  reflective: 1,
  absorptive: 6,
  highlyAbsorptive: 11,
}

export interface Barrier {
  id: string
  name: string
  kind: 'wall' | 'berm'
  points: XY[]
  /** Height above the ground along the line, metres. */
  height: number
  absorption: Absorption
  /** Berms only: width of the flat crest, metres. */
  crestWidth: number
  enabled: boolean
}

/** What a scenario changes on one road. Absent fields keep the road's value. */
export interface RoadMeasure {
  /** Overrides for all categories, km/h. */
  speedLimit?: number
  surface?: number
  /** Percentage change of the whole AADT (e.g. −20). */
  trafficChange?: number
  /** No heavy vehicles at night. */
  nightHeavyBan?: boolean
  /** Motorcycle extra dB override (e.g. 0 after enforcement). */
  motoExtra?: number
  closed?: boolean
}

export interface Scenario {
  id: string
  name: string
  notes?: string
  barriers: Barrier[]
  measures: Record<string, RoadMeasure>
}

export interface Receiver {
  id: string
  name: string
  x: number
  y: number
  /** Height above ground, metres. */
  height: number
  /** Measured L_Aeq for comparison / calibration, dB(A). */
  measuredDay?: number
  measuredNight?: number
}

export type Metric = 'lden' | 'lday' | 'levening' | 'lnight' | 'ldiurno'
export const METRICS: readonly Metric[] = ['lden', 'ldiurno', 'lday', 'levening', 'lnight']

export interface Settings {
  /** Receiver grid spacing, metres. */
  gridSpacing: number
  /** Receiver grid height above ground, metres (4 m = END mapping height). */
  receiverHeight: number
  /** Ground factor outside roads: 0 hard … 1 porous (meadow, orchard). */
  groundG: number
  /** Sources beyond this distance are ignored, metres. */
  maxDistance: number
  /** Evaluate building façades floor by floor. */
  facades: boolean
  /** Reflections on noise walls. */
  reflections: boolean
  /** Thresholds, dB(A). */
  limitDay: number
  limitNight: number
  limitLden: number
}

export interface Project {
  format: 'traffic-noise'
  version: 1
  name: string
  area?: Area
  demId: '2.5' | '0.5'
  roads: Road[]
  buildings: Building[]
  receivers: Receiver[]
  scenarios: Scenario[]
  activeScenarioId: string
  compareScenarioId?: string
  settings: Settings
}
