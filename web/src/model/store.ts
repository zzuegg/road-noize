import { create } from 'zustand'
import { createStore, get as idbGet, set as idbSet } from 'idb-keyval'
import {
  createProject,
  createScenario,
  defaultPreset,
  defaultTraffic,
  DEFAULT_SETTINGS,
  TSCHARS_AREA,
  uid,
} from './defaults'
import type {
  Area,
  Barrier,
  Building,
  Metric,
  Project,
  Receiver,
  Road,
  RoadMeasure,
  Scenario,
  Settings,
  XY,
} from './types'
import {
  DEM_COVERAGES,
  fetchBuildings,
  fetchCounters,
  fetchCoverage,
  fetchRoads,
  heightsFromDsm,
  type TrafficCounter,
} from '../geo/services'
import type { Raster } from '../acoustics/raster'
import {
  facadeReceivers,
  gridReceivers,
  rasterizeBuildings,
  sectionReceivers,
  type FacadePoint,
  type GridSpec,
  type ReceiverSet,
} from '../acoustics/build'
import { Cancelled, cancelAll, runParts, runPe, type PeOutput, type RunPart } from '../acoustics/runner'
import { sampleBilinear, sampleNearest } from '../acoustics/raster'
import { presetProfile, sceneJson } from '../acoustics/core'
import { t } from '../i18n'

const db = createStore('traffic-sansim', 'kv')

export type Tool =
  | 'select'
  | 'area'
  | 'wall'
  | 'berm'
  | 'road'
  | 'receiver'
  | 'section'

export type Selection =
  | { kind: 'road'; id: string }
  | { kind: 'barrier'; id: string }
  | { kind: 'receiver'; id: string }
  | { kind: 'building'; id: string }
  | undefined

export interface ScenarioResult {
  hash: string
  grid: { spec: GridSpec; data: Float32Array }
  facade?: { meta: FacadePoint[]; data: Float32Array; buildingIds: string[] }
  receivers: { ids: string[]; data: Float32Array }
  seconds: number
}

export interface SectionResult {
  a: XY
  b: XY
  cols: number
  rows: number
  z0: number
  z1: number
  /** per scenario id: 3 values per cell */
  data: Record<string, Float32Array>
  /** parabolic-equation result per scenario id */
  pe: Record<string, PeOutput>
  peBusy: boolean
  peWeather: PeWeather
}

/** Log-profile coefficient b (m/s) of c(z) = c0 + b ln(1 + z/z0). */
export const PE_WEATHER = { neutral: 0, downwind: 1.5, inversion: 3, upwind: -1.5 } as const
export type PeWeather = keyof typeof PE_WEATHER

export const PE_FREQS = [63, 125, 250, 500, 1000, 2000]

export interface Terrain {
  key: string
  dtm: Raster
  dsm?: Raster
}

interface State {
  project: Project
  terrain?: Terrain
  counters: TrafficCounter[]
  busy?: string
  error?: string
  progress?: number
  results: Record<string, ScenarioResult>
  section?: SectionResult
  sectionBusy: boolean

  tool: Tool
  selection: Selection
  metric: Metric
  view: 'level' | 'diff'
  basemap: 'ortho' | 'topo' | 'osm'
  opacity: number
  colourBuildings: boolean

  setTool: (t: Tool) => void
  select: (s: Selection) => void
  setUi: (patch: Partial<Pick<State, 'metric' | 'view' | 'basemap' | 'opacity' | 'colourBuildings'>>) => void
  dismissError: () => void

  update: (fn: (p: Project) => Project) => void
  newProject: () => void
  exampleTschars: () => Promise<void>
  loadProject: (p: Project) => void
  setArea: (a: Area) => void
  setSettings: (patch: Partial<Settings>) => void

  importAll: () => Promise<void>
  loadTerrain: () => Promise<void>

  addRoad: (points: XY[]) => void
  updateRoad: (id: string, patch: Partial<Road>) => void
  removeRoad: (id: string) => void

  updateBuilding: (id: string, patch: Partial<Building>) => void

  addScenario: (copyOf?: string) => void
  updateScenario: (id: string, patch: Partial<Scenario>) => void
  removeScenario: (id: string) => void
  setActiveScenario: (id: string) => void
  setCompare: (id?: string) => void

  addBarrier: (kind: 'wall' | 'berm', points: XY[]) => void
  updateBarrier: (id: string, patch: Partial<Barrier>) => void
  removeBarrier: (id: string) => void
  setMeasure: (roadId: string, m: RoadMeasure | undefined) => void

  addReceiver: (x: number, y: number) => void
  updateReceiver: (id: string, patch: Partial<Receiver>) => void
  removeReceiver: (id: string) => void

  compute: (all?: boolean) => Promise<void>
  cancel: () => void
  computeSection: (a: XY, b: XY) => Promise<void>
  computePe: (weather: PeWeather) => Promise<void>
  closeSection: () => void
}

export function activeScenario(p: Project): Scenario {
  return p.scenarios.find((s) => s.id === p.activeScenarioId) ?? p.scenarios[0]
}

/** Everything a result depends on, as a string. */
export function inputHash(p: Project, s: Scenario): string {
  let bh = 0
  for (const b of p.buildings) bh += b.height * (b.ring.length + 1)
  const json = JSON.stringify({
    a: p.area,
    r: p.roads,
    s: { b: s.barriers, m: s.measures },
    set: p.settings,
    b: [p.buildings.length, Math.round(bh * 10)],
    rec: p.receivers.map((r) => [r.x, r.y, r.height]),
  })
  let h = 2166136261
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36) + json.length
}

let bldgCache: { buildings: Building[]; area?: Area; raster: Raster } | undefined

export function buildingRaster(p: Project): Raster | undefined {
  if (!p.area) return undefined
  if (bldgCache && bldgCache.buildings === p.buildings && bldgCache.area === p.area) {
    return bldgCache.raster
  }
  const raster = rasterizeBuildings(p.buildings, p.area)
  bldgCache = { buildings: p.buildings, area: p.area, raster }
  return raster
}

function terrainKey(p: Project): string {
  const a = p.area!
  return `dem|${p.demId}|${a.e0},${a.n0},${a.e1},${a.n1}`
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function persist(p: Project) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void idbSet('project', p, db).catch(() => {}), 600)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useStore = create<State>((set, get) => {
  const update = (fn: (p: Project) => Project) => {
    const next = fn(get().project)
    if (next === get().project) return
    set({ project: next })
    persist(next)
  }
  const updateScenario = (id: string, fn: (s: Scenario) => Scenario) =>
    update((p) => ({ ...p, scenarios: p.scenarios.map((s) => (s.id === id ? fn(s) : s)) }))
  const updateActive = (fn: (s: Scenario) => Scenario) =>
    updateScenario(activeScenario(get().project).id, fn)

  return {
    project: createProject('Tschars', t('scenarios.baseline')),
    counters: [],
    results: {},
    sectionBusy: false,
    tool: 'select',
    selection: undefined,
    metric: 'lden',
    view: 'level',
    basemap: 'ortho',
    opacity: 0.65,
    colourBuildings: true,

    setTool: (tool) => set({ tool }),
    select: (selection) => set({ selection }),
    setUi: (patch) => set(patch),
    dismissError: () => set({ error: undefined }),

    update,

    newProject: () => {
      cancelAll()
      const p = createProject('Projekt', t('scenarios.baseline'))
      set({ project: p, terrain: undefined, results: {}, section: undefined, counters: [], tool: 'area' })
      persist(p)
    },

    exampleTschars: async () => {
      cancelAll()
      const p = createProject('Tschars / Ciardes', t('scenarios.baseline'))
      p.area = { ...TSCHARS_AREA }
      set({ project: p, terrain: undefined, results: {}, section: undefined, counters: [] })
      persist(p)
      await get().importAll()
    },

    loadProject: (p) => {
      cancelAll()
      set({ project: p, terrain: undefined, results: {}, section: undefined, counters: [] })
      persist(p)
      if (p.area) void get().loadTerrain()
    },

    setArea: (area) => {
      update((p) => ({ ...p, area }))
      set({ terrain: undefined, results: {}, section: undefined, tool: 'select' })
    },

    setSettings: (patch) => update((p) => ({ ...p, settings: { ...p.settings, ...patch } })),

    loadTerrain: async () => {
      const p = get().project
      if (!p.area) return
      const key = terrainKey(p)
      if (get().terrain?.key === key) return
      set({ busy: t('data.loading'), error: undefined })
      try {
        let cached: Terrain | undefined
        try {
          cached = await idbGet<Terrain>(key, db)
        } catch {
          cached = undefined
        }
        if (cached?.dtm?.data instanceof Float32Array) {
          set({ terrain: cached })
          return
        }
        const c = DEM_COVERAGES[p.demId]
        const [dtm, dsm] = await Promise.all([
          fetchCoverage(c.dtm, p.area, c.cell),
          fetchCoverage(c.dsm, p.area, c.cell).catch(() => undefined),
        ])
        const terrain = { key, dtm, dsm }
        set({ terrain })
        void idbSet(key, terrain, db).catch(() => {})
      } catch (e) {
        set({ error: errText(e) })
      } finally {
        set({ busy: undefined })
      }
    },

    importAll: async () => {
      const p0 = get().project
      if (!p0.area) return
      set({ busy: t('data.loading'), error: undefined })
      try {
        await get().loadTerrain()
        const terrain = get().terrain
        if (!terrain) return
        set({ busy: t('data.loading') })
        const area = p0.area
        const [roads, buildings, counters] = await Promise.all([
          fetchRoads(area),
          fetchBuildings(area),
          fetchCounters(area).catch(() => [] as TrafficCounter[]),
        ])
        const withHeights = terrain.dsm
          ? heightsFromDsm(buildings, terrain.dtm, terrain.dsm)
          : buildings.map((b) => ({ ...b, height: 7, heightSource: 'default' as const }))
        update((p) => ({
          ...p,
          roads: [
            ...roads.map(
              (r): Road => ({
                id: uid('road'),
                name: r.name,
                cls: r.cls,
                enabled: true,
                lines: r.lines,
                traffic: defaultTraffic(r.cls),
              }),
            ),
            ...p.roads.filter((r) => r.cls === 'user'),
          ],
          buildings: withHeights,
        }))
        set({ counters, results: {} })
      } catch (e) {
        set({ error: errText(e) })
      } finally {
        set({ busy: undefined })
      }
    },

    addRoad: (points) =>
      update((p) => ({
        ...p,
        roads: [
          ...p.roads,
          {
            id: uid('road'),
            name: `${t('class.user')} ${p.roads.filter((r) => r.cls === 'user').length + 1}`,
            cls: 'user',
            enabled: true,
            lines: [points],
            traffic: defaultTraffic('LS'),
          },
        ],
      })),
    updateRoad: (id, patch) =>
      update((p) => ({ ...p, roads: p.roads.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
    removeRoad: (id) => update((p) => ({ ...p, roads: p.roads.filter((r) => r.id !== id) })),

    updateBuilding: (id, patch) =>
      update((p) => ({
        ...p,
        buildings: p.buildings.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      })),

    addScenario: (copyOf) =>
      update((p) => {
        const src = p.scenarios.find((s) => s.id === copyOf)
        const base = createScenario(
          src ? `${src.name} (2)` : `Variante ${p.scenarios.length}`,
        )
        const sc: Scenario = src
          ? {
              ...structuredClone(src),
              id: base.id,
              name: base.name,
              barriers: src.barriers.map((b) => ({ ...structuredClone(b), id: uid('bar') })),
            }
          : base
        return {
          ...p,
          scenarios: [...p.scenarios, sc],
          compareScenarioId: p.compareScenarioId ?? p.activeScenarioId,
          activeScenarioId: sc.id,
        }
      }),
    updateScenario: (id, patch) => updateScenario(id, (s) => ({ ...s, ...patch })),
    removeScenario: (id) =>
      update((p) => {
        if (p.scenarios.length <= 1) return p
        const scenarios = p.scenarios.filter((s) => s.id !== id)
        return {
          ...p,
          scenarios,
          activeScenarioId: p.activeScenarioId === id ? scenarios[0].id : p.activeScenarioId,
          compareScenarioId: p.compareScenarioId === id ? undefined : p.compareScenarioId,
        }
      }),
    setActiveScenario: (id) =>
      update((p) => ({
        ...p,
        activeScenarioId: id,
        compareScenarioId: p.compareScenarioId === id ? undefined : p.compareScenarioId,
      })),
    setCompare: (id) => update((p) => ({ ...p, compareScenarioId: id })),

    addBarrier: (kind: 'wall' | 'berm', points) => {
      const id = uid('bar')
      updateActive((s) => ({
        ...s,
        barriers: [
          ...s.barriers,
          (() => {
            const preset = defaultPreset(kind === 'wall' ? 'vertical' : 'berm')
            return {
              id,
              name: `${kind === 'wall' ? 'LSW' : 'Wall'} ${s.barriers.length + 1}`,
              points,
              preset,
              profile: presetProfile(preset),
              flip: false,
              enabled: true,
            }
          })(),
        ],
      }))
      set({ selection: { kind: 'barrier', id } })
    },
    updateBarrier: (id, patch) =>
      updateActive((s) => ({
        ...s,
        barriers: s.barriers.map((b) => {
          if (b.id !== id) return b
          const next = { ...b, ...patch }
          if (patch.preset && next.preset.kind !== 'custom') next.profile = presetProfile(next.preset)
          return next
        }),
      })),
    removeBarrier: (id) =>
      updateActive((s) => ({ ...s, barriers: s.barriers.filter((b) => b.id !== id) })),
    setMeasure: (roadId, m) =>
      updateActive((s) => {
        const measures = { ...s.measures }
        if (m) measures[roadId] = m
        else delete measures[roadId]
        return { ...s, measures }
      }),

    addReceiver: (x, y) => {
      const id = uid('rec')
      update((p) => ({
        ...p,
        receivers: [
          ...p.receivers,
          { id, name: `P${p.receivers.length + 1}`, x, y, height: 4 },
        ],
      }))
      set({ selection: { kind: 'receiver', id } })
    },
    updateReceiver: (id, patch) =>
      update((p) => ({
        ...p,
        receivers: p.receivers.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      })),
    removeReceiver: (id) =>
      update((p) => ({ ...p, receivers: p.receivers.filter((r) => r.id !== id) })),

    cancel: () => {
      cancelAll()
      set({ progress: undefined, sectionBusy: false })
    },

    compute: async (all = false) => {
      const p = get().project
      const terrain = get().terrain
      if (!p.area || !terrain) return set({ error: t('run.needTerrain') })
      if (!p.roads.some((r) => r.enabled && r.traffic.aadt > 0)) {
        return set({ error: t('run.needRoads') })
      }
      const bldg = buildingRaster(p)!
      const ids = all
        ? p.scenarios.map((s) => s.id)
        : [p.activeScenarioId, ...(p.compareScenarioId ? [p.compareScenarioId] : [])]
      const todo = p.scenarios.filter(
        (s) => ids.includes(s.id) && get().results[s.id]?.hash !== inputHash(p, s),
      )
      if (todo.length === 0) return
      set({ progress: 0, error: undefined })

      const grid = gridReceivers(p.area, p.settings.gridSpacing, p.settings.receiverHeight, bldg)
      const fac = p.settings.facades ? facadeReceivers(p.buildings, p.area) : undefined
      const rec: ReceiverSet = {
        x: Float64Array.from(p.receivers.map((r) => r.x)),
        y: Float64Array.from(p.receivers.map((r) => r.y)),
        h: Float64Array.from(p.receivers.map((r) => r.height)),
        skip: new Uint8Array(p.receivers.length),
      }
      const parts: RunPart[] = []
      todo.forEach((s) => {
        const json = sceneJson(p, s, terrain.dtm)
        const key = inputHash(p, s)
        const base = { key, json, ground: terrain.dtm.data }
        parts.push({ ...base, set: rec, lmax: true })
        if (fac) parts.push({ ...base, set: fac.set, incident: true })
        parts.push({ ...base, set: grid.set })
      })
      const t0 = performance.now()
      try {
        const out = await runParts(parts, (f) => set({ progress: f }))
        const per = fac ? 3 : 2
        const seconds = (performance.now() - t0) / 1000 / todo.length
        const results = { ...get().results }
        todo.forEach((s, i) => {
          const o = out.slice(i * per, (i + 1) * per)
          results[s.id] = {
            hash: inputHash(p, s),
            receivers: { ids: p.receivers.map((r) => r.id), data: o[0] },
            facade: fac
              ? { meta: fac.meta, data: o[1], buildingIds: p.buildings.map((b) => b.id) }
              : undefined,
            grid: { spec: grid.spec, data: o[per - 1] },
            seconds,
          }
        })
        set({ results })
      } catch (e) {
        if (!(e instanceof Cancelled)) set({ error: errText(e) })
      } finally {
        set({ progress: undefined })
      }
    },

    computeSection: async (a, b) => {
      const p = get().project
      const terrain = get().terrain
      if (!p.area || !terrain) return
      const bldg = buildingRaster(p)!
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const cols = Math.max(20, Math.min(200, Math.round(len / 1.5)))
      const rows = 40
      const { set: rs, z0, z1 } = sectionReceivers(a, b, cols, rows, 25, bldg, (x, y) =>
        sampleBilinear(terrain.dtm, x, y),
      )
      const ids = [p.activeScenarioId, ...(p.compareScenarioId ? [p.compareScenarioId] : [])]
      const scs = ids.map((id) => p.scenarios.find((s) => s.id === id)!).filter(Boolean)
      set({ sectionBusy: true, section: { a, b, cols, rows, z0, z1, data: {}, pe: {}, peBusy: false, peWeather: 'neutral' } })
      try {
        const out = await runParts(
          scs.map((s) => ({ key: inputHash(p, s), json: sceneJson(p, s, terrain.dtm), ground: terrain.dtm.data, set: rs })),
          (f) => set({ progress: f }),
        )
        const data: Record<string, Float32Array> = {}
        scs.forEach((s, i) => (data[s.id] = out[i]))
        const cur = get().section
        if (cur) set({ section: { ...cur, data } })
      } catch (e) {
        if (!(e instanceof Cancelled)) set({ error: errText(e) })
      } finally {
        set({ sectionBusy: false, progress: undefined })
      }
    },

    computePe: async (weather) => {
      const p = get().project
      const terrain = get().terrain
      const sec = get().section
      if (!p.area || !terrain || !sec) return
      const bldg = buildingRaster(p)!
      const ids = [p.activeScenarioId, ...(p.compareScenarioId ? [p.compareScenarioId] : [])]
      set({ section: { ...sec, peBusy: true, peWeather: weather, pe: {} } })
      try {
        const pe: Record<string, PeOutput> = {}
        for (const id of ids) {
          const sc = p.scenarios.find((s) => s.id === id)
          if (!sc) continue
          const input = peInput(p, sc, terrain.dtm, bldg, sec.a, sec.b, weather)
          // eslint-disable-next-line no-await-in-loop
          pe[id] = await runPe(JSON.stringify(input))
        }
        const cur = get().section
        if (cur) set({ section: { ...cur, pe, peBusy: false } })
      } catch (e) {
        set({ error: errText(e) })
        const cur = get().section
        if (cur) set({ section: { ...cur, peBusy: false } })
      }
    },
    closeSection: () => set({ section: undefined }),
  }
})

/** Restores the last session's project. */
export async function restore(): Promise<void> {
  try {
    const p = await idbGet<Project>('project', db)
    if (p && p.format === 'traffic-sansim') {
      p.settings = { ...DEFAULT_SETTINGS, ...p.settings }
      useStore.setState({ project: p })
      if (p.area) void useStore.getState().loadTerrain()
    }
  } catch {
    /* first start */
  }
}

if (import.meta.env.DEV) (window as unknown as { store: unknown }).store = useStore

const SIGMA: Record<string, number> = {
  snow: 12.5, forest: 31.5, pasture: 80, orchard: 125, grass: 200, gravel: 500, compacted: 2000, asphalt: 20000,
}

/** Upper envelope of a cross-section at offset o. */
function envelope(parts: Barrier['profile'], o: number): number {
  let top = -Infinity
  for (const part of parts) {
    const v = part.verts
    for (let i = 0; i < v.length; i++) {
      const a = v[i]
      const b = v[(i + 1) % v.length]
      const lo = Math.min(a.o, b.o)
      const hi = Math.max(a.o, b.o)
      if (o < lo || o > hi) continue
      const h = hi - lo < 1e-9 ? Math.max(a.h, b.h) : a.h + ((b.h - a.h) * (o - a.o)) / (b.o - a.o)
      if (h > top) top = h
    }
  }
  return top
}

/** The PE input for a section from a (on the road) to b. */
function peInput(p: Project, sc: Scenario, dtm: Raster, bldg: Raster, a: XY, b: XY, weather: PeWeather) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const step = 0.5
  const n = Math.max(2, Math.ceil(len / step) + 1)
  const dist: number[] = []
  const ground: number[] = []
  const surface: number[] = []
  const sigma: number[] = []
  const roadSig = SIGMA.asphalt
  const terrSig = SIGMA[p.settings.groundClass] ?? 125
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, (i * step) / len)
    const x = a[0] + (b[0] - a[0]) * t
    const y = a[1] + (b[1] - a[1]) * t
    const g = sampleBilinear(dtm, x, y)
    let top = g + sampleNearest(bldg, x, y)
    for (const bar of sc.barriers) {
      if (!bar.enabled) continue
      const pts = bar.flip ? [...bar.points].reverse() : bar.points
      const prof = bar.preset.kind === 'custom' ? bar.profile : bar.profile.length ? bar.profile : presetProfile(bar.preset)
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, ay] = pts[k]
        const [bx, by] = pts[k + 1]
        const L = Math.hypot(bx - ax, by - ay)
        if (L < 0.05) continue
        const ux = (bx - ax) / L
        const uy = (by - ay) / L
        const along = (x - ax) * ux + (y - ay) * uy
        if (along < 0 || along > L) continue
        const o = (x - ax) * -uy + (y - ay) * ux // left of the axis = road side
        const h = envelope(prof, o)
        if (Number.isFinite(h) && h > 0) {
          const gz = sampleBilinear(dtm, ax + ux * along, ay + uy * along)
          top = Math.max(top, gz + h)
        }
      }
    }
    let sg = terrSig
    if (top > g + 0.05) sg = 2e5
    else {
      for (const r of p.roads) {
        const half = r.cls === 'SS' ? 4 : r.cls === 'LS' ? 3.25 : 2.5
        if (r.lines.some((l) => l.some((_, j) => j > 0 && segDist(l[j - 1], l[j], x, y) <= half))) {
          sg = roadSig
          break
        }
      }
    }
    dist.push(t * len)
    ground.push(g)
    surface.push(top)
    sigma.push(sg)
  }
  const tb = p.settings.turbulence
  return {
    dist,
    ground,
    surface,
    sigma,
    sourceHeight: 0.3,
    top: 25,
    freqs: PE_FREQS,
    b: PE_WEATHER[weather],
    z0: 0.1,
    turbulence: { ct2: tb.ct2, cv2: tb.cv2, outer_scale: tb.outerScale },
    realisations: 4,
    outDr: Math.max(0.5, len / 300),
    outDz: 0.25,
  }
}

function segDist(a: XY, b: XY, x: number, y: number): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2))
  return Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y)
}
