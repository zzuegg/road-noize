// The open geodata services of the Autonomous Province of Bolzano – South
// Tyrol (CC0). All requests in EPSG:25832.
//
//   Terrain (DTM) and surface model (DSM)   WCS  geoservices9
//   Road graph (LinksSequences)             WFS  geoservices1
//   Traffic counters                        WFS  geoservices1
//   Buildings (INSPIRE BU.Building)         WFS  geoservices8

import type { Area, Building, RoadClass, XY } from '../model/types'
import type { Raster } from '../acoustics/scene'

const WCS = 'https://geoservices9.civis.bz.it/geoserver/ows'
const WFS_ROADS = 'https://geoservices1.civis.bz.it/geoserver/ows'
const WFS_INSPIRE = 'https://geoservices8.civis.bz.it/geoserver/ows'

export const DEM_COVERAGES = {
  '2.5': {
    dtm: 'p_bz-Elevation__DigitalTerrainModel-2.5m',
    dsm: 'p_bz-Elevation__DigitalElevationModel-2.5m',
    cell: 2.5,
    maxSide: 4000,
  },
  '0.5': {
    dtm: 'p_bz-Elevation__DigitalTerrainModel-0.5m',
    dsm: 'p_bz-Elevation__DigitalElevationModel-0.5m',
    cell: 0.5,
    maxSide: 800,
  },
} as const

export class ServiceError extends Error {}

async function fetchWithTimeout(url: string, ms = 120_000): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    if (!r.ok) throw new ServiceError(`HTTP ${r.status}: ${url.split('?')[0]}`)
    return r
  } catch (e) {
    if (e instanceof ServiceError) throw e
    throw new ServiceError(`Service not reachable: ${url.split('?')[0]}`)
  } finally {
    clearTimeout(t)
  }
}

/** Snaps outward to whole cells. */
export function snap(area: Area, cell: number): Area {
  return {
    e0: Math.floor(area.e0 / cell) * cell,
    n0: Math.floor(area.n0 / cell) * cell,
    e1: Math.ceil(area.e1 / cell) * cell,
    n1: Math.ceil(area.n1 / cell) * cell,
  }
}

/** A coverage as a Raster (row 0 = south). Gaps are filled with the minimum. */
export async function fetchCoverage(coverage: string, area: Area, cell: number): Promise<Raster> {
  const b = snap(area, cell)
  const url =
    `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${encodeURIComponent(coverage)}` +
    `&subset=E(${b.e0},${b.e1})&subset=N(${b.n0},${b.n1})&format=image/tiff`
  const buf = await (await fetchWithTimeout(url)).arrayBuffer()
  const head = new TextDecoder().decode(buf.slice(0, 200))
  if (head.startsWith('<?xml') || head.includes('Exception')) {
    throw new ServiceError('The elevation service reported an error for this area.')
  }
  const { fromArrayBuffer } = await import('geotiff')
  const tiff = await fromArrayBuffer(buf)
  const img = await tiff.getImage()
  const cols = img.getWidth()
  const rows = img.getHeight()
  let e0 = b.e0 + cell / 2
  let n0 = b.n0 + cell / 2
  let c = cell
  try {
    const [minX, minY, maxX] = img.getBoundingBox()
    const cx = (maxX - minX) / cols
    if (cx > 0 && Number.isFinite(cx)) {
      c = cx
      e0 = minX + cx / 2
      n0 = minY + cx / 2
    }
  } catch {
    /* keep requested georeference */
  }
  const raw = (await img.readRasters({ interleave: true })) as unknown as ArrayLike<number>
  const data = new Float32Array(cols * rows)
  let min = Infinity
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const v = raw[r * cols + k]
      const ok = Number.isFinite(v) && v > -1000
      // flip: GeoTIFF row 0 is north
      data[(rows - 1 - r) * cols + k] = ok ? v : NaN
      if (ok && v < min) min = v
    }
  }
  if (!Number.isFinite(min)) throw new ServiceError('No elevation data in this area.')
  for (let i = 0; i < data.length; i++) if (Number.isNaN(data[i])) data[i] = min
  return { cols, rows, cell: c, e0, n0, data }
}

interface GeoJsonFeature {
  id?: string
  geometry: { type: string; coordinates: unknown } | null
  properties: Record<string, unknown>
}

async function wfs(base: string, typeName: string, area: Area, extra = ''): Promise<GeoJsonFeature[]> {
  const url =
    `${base}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(typeName)}` +
    `&outputFormat=application/json&srsName=EPSG:25832` +
    `&bbox=${area.e0},${area.n0},${area.e1},${area.n1},EPSG:25832${extra}`
  const json = (await (await fetchWithTimeout(url)).json()) as { features?: GeoJsonFeature[] }
  return json.features ?? []
}

function lines(geom: GeoJsonFeature['geometry']): XY[][] {
  if (!geom) return []
  if (geom.type === 'LineString') return [geom.coordinates as XY[]]
  if (geom.type === 'MultiLineString') return geom.coordinates as XY[][]
  return []
}

function outerRings(geom: GeoJsonFeature['geometry']): XY[][] {
  if (!geom) return []
  if (geom.type === 'Polygon') return [(geom.coordinates as XY[][])[0]]
  if (geom.type === 'MultiPolygon') return (geom.coordinates as XY[][][]).map((p) => p[0])
  return []
}

export interface ImportedRoad {
  name: string
  cls: RoadClass
  lines: XY[][]
}

/** Highest-ranking class among the sequences a link belongs to. */
export function classify(category: string): RoadClass | null {
  const tokens = category.split(',').map((s) => s.trim())
  if (tokens.includes('SS')) return 'SS'
  if (tokens.includes('LS')) return 'LS'
  if (tokens.includes('G')) return 'G'
  if (tokens.includes('PS')) return 'PS'
  return null
}

/** Clips a polyline to the area (Liang–Barsky per segment), splitting where it leaves. */
export function clipPolyline(line: readonly XY[], a: Area): XY[][] {
  const out: XY[][] = []
  let cur: XY[] = []
  const flush = () => {
    if (cur.length >= 2) out.push(cur)
    cur = []
  }
  for (let i = 0; i < line.length - 1; i++) {
    const [x0, y0] = line[i]
    const [x1, y1] = line[i + 1]
    const dx = x1 - x0
    const dy = y1 - y0
    let t0 = 0
    let t1 = 1
    const edges: [number, number][] = [
      [-dx, x0 - a.e0],
      [dx, a.e1 - x0],
      [-dy, y0 - a.n0],
      [dy, a.n1 - y0],
    ]
    let visible = true
    for (const [pp, q] of edges) {
      if (pp === 0) {
        if (q < 0) visible = false
      } else {
        const r = q / pp
        if (pp < 0) t0 = Math.max(t0, r)
        else t1 = Math.min(t1, r)
      }
    }
    if (!visible || t0 > t1) {
      flush()
      continue
    }
    const pa: XY = [x0 + dx * t0, y0 + dy * t0]
    const pb: XY = [x0 + dx * t1, y0 + dy * t1]
    if (cur.length === 0) cur.push(pa)
    else if (t0 > 0) {
      flush()
      cur.push(pa)
    }
    cur.push(pb)
    if (t1 < 1) flush()
  }
  flush()
  return out
}

const DEDUPE_CELL = 3

/**
 * Removes stretches already covered by an earlier group. The road graph holds
 * the same carriageway under several names (the SS 38 route and the address
 * "Staatsstraße" on top of it); keeping both would count its traffic twice.
 */
function dedupe(groups: ImportedRoad[]): ImportedRoad[] {
  const taken = new Set<string>()
  const key = (x: number, y: number) =>
    `${Math.round(x / DEDUPE_CELL)},${Math.round(y / DEDUPE_CELL)}`
  const near = (x: number, y: number) => {
    const cx = Math.round(x / DEDUPE_CELL)
    const cy = Math.round(y / DEDUPE_CELL)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (taken.has(`${cx + i},${cy + j}`)) return true
    return false
  }
  const out: ImportedRoad[] = []
  for (const g of groups) {
    const kept: XY[][] = []
    const mark: string[] = []
    for (const line of g.lines) {
      let cur: XY[] = []
      for (let i = 0; i < line.length - 1; i++) {
        const [x0, y0] = line[i]
        const [x1, y1] = line[i + 1]
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2))
        for (let k = 0; k < n; k++) {
          const xa = x0 + ((x1 - x0) * k) / n
          const ya = y0 + ((y1 - y0) * k) / n
          const xb = x0 + ((x1 - x0) * (k + 1)) / n
          const yb = y0 + ((y1 - y0) * (k + 1)) / n
          if (near((xa + xb) / 2, (ya + yb) / 2)) {
            if (cur.length >= 2) kept.push(cur)
            cur = []
            continue
          }
          if (cur.length === 0) cur.push([xa, ya])
          cur.push([xb, yb])
          mark.push(key((xa + xb) / 2, (ya + yb) / 2))
        }
      }
      if (cur.length >= 2) kept.push(cur)
    }
    for (const m of mark) taken.add(m)
    const lines = kept
      .map(simplify)
      .filter((l) => polyLength(l) >= 8)
    if (lines.length) out.push({ ...g, lines })
  }
  return out
}

function polyLength(l: readonly XY[]): number {
  let s = 0
  for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1])
  return s
}

/** Drops nearly collinear vertices (from the 2 m dedupe subdivision). */
function simplify(l: XY[]): XY[] {
  if (l.length <= 2) return l
  const out: XY[] = [l[0]]
  for (let i = 1; i < l.length - 1; i++) {
    const [ax, ay] = out[out.length - 1]
    const [bx, by] = l[i]
    const [cx, cy] = l[i + 1]
    const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
    const len = Math.hypot(cx - ax, cy - ay) || 1
    if (cross / len > 0.2) out.push(l[i])
  }
  out.push(l[l.length - 1])
  return out
}

/**
 * Roads from the provincial road graph, clipped to the area, grouped by name
 * and class so traffic is entered once per road rather than once per link.
 * Footpaths, cycle paths, farm and forest tracks and railways are dropped.
 * Named routes (state / provincial roads) win over address names lying on the
 * same carriageway.
 */
export async function fetchRoads(area: Area, includePrivate = false): Promise<ImportedRoad[]> {
  const feats = await wfs(WFS_ROADS, 'p_bz-TransportNetwork:LinksSequences-Queryable', area)
  const groups = new Map<string, ImportedRoad & { route: boolean }>()
  for (const f of feats) {
    const p = f.properties
    if (p.NETWORK_TYPE !== 'RoadNetwork') continue
    let cls = classify(String(p.CATEGORY ?? ''))
    if (!cls || (cls === 'PS' && !includePrivate)) continue
    const nameCat = String(p.NAME_CATEGORY ?? '')
    const route = nameCat === 'SS' || nameCat === 'LS'
    // An address street that shares links with a state road is not the state
    // road: what remains of it after de-duplication is local street.
    if (!route && (cls === 'SS' || cls === 'LS')) cls = 'G'
    const name = String(p.NAME_D ?? p.NAME ?? '').trim() || '—'
    const key = `${cls}|${name}`
    const g = groups.get(key) ?? { name, cls, lines: [], route }
    for (const l of lines(f.geometry)) g.lines.push(...clipPolyline(l, area))
    groups.set(key, g)
  }
  const rank: Record<RoadClass, number> = { SS: 0, LS: 1, G: 2, PS: 3, user: 4 }
  const sorted = [...groups.values()]
    .filter((g) => g.lines.length > 0)
    .sort(
      (a, b) =>
        Number(b.route) - Number(a.route) || rank[a.cls] - rank[b.cls] || a.name.localeCompare(b.name),
    )
    .map(({ route: _r, ...g }) => g)
  return dedupe(sorted)
}

export interface TrafficCounter {
  code: string
  place: string
  road: string
  km?: number
  x: number
  y: number
  link?: string
}

/** Permanent traffic counters near the area (AADT published by ASTAT). */
export async function fetchCounters(area: Area, margin = 15000): Promise<TrafficCounter[]> {
  const big = { e0: area.e0 - margin, n0: area.n0 - margin, e1: area.e1 + margin, n1: area.n1 + margin }
  const feats = await wfs(WFS_ROADS, 'p_bz-TransportNetwork:Infrastructures-TrafficCounters', big)
  return feats
    .filter((f) => f.geometry?.type === 'Point')
    .map((f) => {
      const p = f.properties
      const [x, y] = f.geometry!.coordinates as XY
      return {
        code: String(p.CODE_DE ?? ''),
        place: String(p.PLACE_DE ?? ''),
        road: String(p.NAME ?? ''),
        km: typeof p.KM_POST === 'number' ? p.KM_POST : undefined,
        x,
        y,
        link: typeof p.QLICK_DE === 'string' ? p.QLICK_DE : undefined,
      }
    })
}

export interface ImportedBuilding {
  id: string
  ring: XY[]
  use?: string
}

export async function fetchBuildings(area: Area): Promise<ImportedBuilding[]> {
  const feats = await wfs(WFS_INSPIRE, 'p_bz-Inspire:BU.Building', area)
  const out: ImportedBuilding[] = []
  for (const f of feats) {
    const use = typeof f.properties.CURRENT_USE === 'string' ? f.properties.CURRENT_USE : undefined
    outerRings(f.geometry).forEach((ring, k) => {
      if (ring.length >= 4) out.push({ id: `${f.id ?? out.length}-${k}`, ring: ring.slice(0, -1), use })
    })
  }
  return out
}

/** Default height where the surface model gives nothing usable. */
export const DEFAULT_BUILDING_HEIGHT = 7

/**
 * Building heights from the surface model: the 90th percentile of
 * DSM − DTM over the cells inside the footprint (the roof, not the eaves of a
 * neighbour or a tree over the edge, mostly).
 */
export function heightsFromDsm(buildings: ImportedBuilding[], dtm: Raster, dsm: Raster): Building[] {
  return buildings.map((b) => {
    const vals: number[] = []
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of b.ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const c = dsm.cell
    for (let y = Math.ceil((minY - dsm.n0) / c) * c + dsm.n0; y <= maxY; y += c) {
      for (let x = Math.ceil((minX - dsm.e0) / c) * c + dsm.e0; x <= maxX; x += c) {
        if (!inside(b.ring, x, y)) continue
        const d = sample(dsm, x, y) - sample(dtm, x, y)
        if (Number.isFinite(d)) vals.push(d)
      }
    }
    vals.sort((a, z) => a - z)
    const p90 = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))] : NaN
    const ok = vals.length >= 2 && p90 >= 2 && p90 <= 80
    return {
      id: b.id,
      ring: b.ring,
      use: b.use,
      height: ok ? Math.round(p90 * 10) / 10 : DEFAULT_BUILDING_HEIGHT,
      heightSource: ok ? 'dsm' : 'default',
    }
  })
}

function sample(r: Raster, x: number, y: number): number {
  const col = Math.round((x - r.e0) / r.cell)
  const row = Math.round((y - r.n0) / r.cell)
  if (col < 0 || row < 0 || col >= r.cols || row >= r.rows) return NaN
  return r.data[row * r.cols + col]
}

export function inside(ring: readonly XY[], x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** WMTS basemaps (EPSG:25832 tile matrix set of the province). */
export const WMTS_URL = 'https://geoservices.buergernetz.bz.it/mapproxy/service'
export const BASEMAPS = {
  ortho: 'p_bz-Orthoimagery:Aerial-2023-RGB',
  topo: 'p_bz-BasemapImagery:TopographicMap-2007-10k',
  osm: 'oown-OpenStreetMap:CartoPositron',
} as const
