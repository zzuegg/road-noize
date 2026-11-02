// The project document. Plain JSON: saved to IndexedDB automatically and
// exported / imported as a .noise.json file.
//
// Everything is in EPSG:25832 (UTM 32N) metres, the CRS of the South Tyrol
// geoservices. Terrain grids are not stored — they are refetched (and cached).

export type Category = 'light' | 'medium' | 'heavy' | 'moped' | 'moto'

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

/** Surface materials (absorption spectra live in the Rust core). */
export type Material =
  | 'reflective'
  | 'absorptive'
  | 'highlyAbsorptive'
  | 'grass'
  | 'gabion'
  | 'wood'

export const MATERIALS: readonly Material[] = [
  'reflective',
  'absorptive',
  'highlyAbsorptive',
  'grass',
  'gabion',
  'wood',
]

/** Cross-section families, see core/src/barrier.rs. */
export type BarrierKind =
  | 'vertical'
  | 'tilted'
  | 'bentTop'
  | 'curvedTop'
  | 'tTop'
  | 'yTop'
  | 'berm'
  | 'bermWall'
  | 'gabion'
  | 'custom'

export const BARRIER_KINDS: readonly BarrierKind[] = [
  'vertical',
  'tilted',
  'bentTop',
  'curvedTop',
  'tTop',
  'yTop',
  'berm',
  'bermWall',
  'gabion',
  'custom',
]

export interface PresetParams {
  kind: BarrierKind
  height: number
  thickness: number
  /** degrees: tilt (tilted), bend from vertical (bent/curved/Y tops) */
  angle: number
  topLength: number
  crest: number
  frontSlope: number
  backSlope: number
  wallHeight: number
  /** road side */
  front: Material
  back: Material
}

/** Cross-section vertex: offset o (+ towards the road), height h, material of the edge to the next vertex. */
export interface PV {
  o: number
  h: number
  m: string
}

export interface Part {
  verts: PV[]
}

export interface Barrier {
  id: string
  name: string
  points: XY[]
  preset: PresetParams
  /** generated from `preset` unless kind = custom */
  profile: Part[]
  /** the road is on the other side of the drawing direction */
  flip: boolean
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

/** A propagation condition: curved rays of radius R (m; > 0 downward
 *  refraction, < 0 upward, 0 straight), weighted by occurrence per period. */
export interface MetClass {
  name: string
  radius: number
  distanceScaled: boolean
  /** percent: day, evening, night */
  weights: [number, number, number]
}

export interface Turbulence {
  ct2: number
  cv2: number
  outerScale: number
}

export type GroundClass =
  | 'snow'
  | 'forest'
  | 'pasture'
  | 'orchard'
  | 'grass'
  | 'gravel'
  | 'compacted'
  | 'asphalt'

export const GROUND_CLASSES: readonly GroundClass[] = [
  'snow',
  'forest',
  'pasture',
  'orchard',
  'grass',
  'gravel',
  'compacted',
  'asphalt',
]

export type Method = 'physics' | 'cnossos' | 'iso9613'

/** Which roads emit in a calculation. */
export type SourceSelection = 'all' | 'main' | 'selected'

export interface Settings {
  /** physics: detailed model; cnossos: CNOSSOS-EU; iso9613: ISO 9613-2:1996 */
  method: Method
  /** CNOSSOS-EU probability of favourable conditions (day, evening, night) */
  favourableP: [number, number, number]
  /** roads that emit: all, main roads only (state + provincial), or a selection */
  sources: SourceSelection
  /** road ids for sources = 'selected' */
  selectedRoads: string[]
  /** ISO 9613-2 C0 per period (day, evening, night), dB; 0 = downwind */
  cmetC0: [number, number, number]
  /** source height above the road in ISO mode, m */
  isoSourceHeight: number
  /** Receiver grid spacing, metres. */
  gridSpacing: number
  /** Receiver grid height above ground, metres (4 m = END mapping height). */
  receiverHeight: number
  /** Unsealed ground outside roads and buildings. */
  groundClass: GroundClass
  maxDistance: number
  reflectionOrder: number
  reflectionRadius: number
  /** frequencies per octave band for coherent averaging */
  subFrequencies: number
  lateral: boolean
  turbulence: Turbulence
  met: MetClass[]
  temperature: number
  humidity: number
  /** Evaluate building façades floor by floor. */
  facades: boolean
  limitDay: number
  limitNight: number
  limitLden: number
}

export interface Project {
  format: 'traffic-sansim'
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
