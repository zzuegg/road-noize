import { useEffect, useMemo, useRef, useState } from 'react'
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import ImageLayer from 'ol/layer/Image'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import WMTS from 'ol/source/WMTS'
import WMTSTileGrid from 'ol/tilegrid/WMTS'
import Static from 'ol/source/ImageStatic'
import Feature from 'ol/Feature'
import { LineString, Point, Polygon } from 'ol/geom'
import { fromExtent } from 'ol/geom/Polygon'
import { Draw, Modify } from 'ol/interaction'
import { createBox } from 'ol/interaction/Draw'
import { Fill, Stroke, Style, Circle as CircleStyle, Text } from 'ol/style'
import type { FeatureLike } from 'ol/Feature'
import 'ol/ol.css'
import { UTM32N } from '../geo/crs'
import { BASEMAPS, WMTS_URL } from '../geo/services'
import { activeScenario, useStore } from '../model/store'
import { buildingLevels, metricArray } from './derived'
import { diffColour, levelColour, rgb } from './palette'
import { fmt, t } from '../i18n'
import type { XY } from '../model/types'

const LEVELS = 18
const top = 5_851_428.571428571 * 0.00028
const RES = Array.from({ length: LEVELS }, (_, i) => top / 2 ** i)
const GRID = new WMTSTileGrid({
  origin: [449_092.4, 5_424_522.8],
  resolutions: RES,
  matrixIds: RES.map((_, i) => String(i).padStart(2, '0')),
  tileSize: 256,
  extent: [580_000, 5_100_000, 780_000, 5_240_000],
})

function wmts(layer: string) {
  return new WMTS({
    url: WMTS_URL,
    layer,
    matrixSet: 'EPSG_25832',
    format: 'image/png',
    projection: UTM32N,
    tileGrid: GRID,
    style: 'default',
    attributions: 'Autonome Provinz Bozen – Südtirol (CC0)',
    crossOrigin: 'anonymous',
  })
}

const ROAD_WIDTH: Record<string, number> = { SS: 6, LS: 4.5, G: 3, PS: 2, user: 4.5 }

function drawCanvas(
  values: Float32Array,
  cols: number,
  rows: number,
  colour: (v: number) => string | undefined,
): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = cols
  c.height = rows
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(cols, rows)
  const cache = new Map<string, [number, number, number]>()
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const v = values[r * cols + k]
      const col = colour(v)
      if (!col) continue
      let px = cache.get(col)
      if (!px) {
        px = rgb(col)
        cache.set(col, px)
      }
      const o = ((rows - 1 - r) * cols + k) * 4
      img.data[o] = px[0]
      img.data[o + 1] = px[1]
      img.data[o + 2] = px[2]
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

export function MapView() {
  const el = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const mapRef = useRef<OlMap | undefined>(undefined)
  const base = useRef<TileLayer<WMTS> | undefined>(undefined)
  const noise = useRef<ImageLayer<Static> | undefined>(undefined)
  const vec = useRef<Record<string, VectorSource>>({})
  const [ready, setReady] = useState(false)

  const project = useStore((s) => s.project)
  const results = useStore((s) => s.results)
  const tool = useStore((s) => s.tool)
  const selection = useStore((s) => s.selection)
  const metric = useStore((s) => s.metric)
  const view = useStore((s) => s.view)
  const basemap = useStore((s) => s.basemap)
  const opacity = useStore((s) => s.opacity)
  const colourBuildings = useStore((s) => s.colourBuildings)
  const counters = useStore((s) => s.counters)
  const section = useStore((s) => s.section)
  const scenario = activeScenario(project)
  const result = results[scenario.id]
  const compare = project.compareScenarioId ? results[project.compareScenarioId] : undefined

  // ---------------------------------------------------------------- map
  useEffect(() => {
    const layers: Record<string, VectorSource> = {}
    for (const k of ['area', 'buildings', 'roads', 'barriers', 'receivers', 'counters', 'section']) {
      layers[k] = new VectorSource()
    }
    vec.current = layers
    base.current = new TileLayer({ source: wmts(BASEMAPS.ortho) })
    noise.current = new ImageLayer({ opacity: 0.65 })
    const a = useStore.getState().project.area
    const map = new OlMap({
      target: el.current!,
      layers: [
        base.current,
        noise.current,
        new VectorLayer({ source: layers.area, style: areaStyle }),
        new VectorLayer({ source: layers.buildings }),
        new VectorLayer({ source: layers.roads }),
        new VectorLayer({ source: layers.barriers }),
        new VectorLayer({ source: layers.counters, style: counterStyle }),
        new VectorLayer({ source: layers.section, style: sectionStyle }),
        new VectorLayer({ source: layers.receivers }),
      ],
      view: new View({
        projection: UTM32N,
        center: a ? [(a.e0 + a.e1) / 2, (a.n0 + a.n1) / 2] : [660_000, 5_170_000],
        resolution: a ? Math.max(a.e1 - a.e0, a.n1 - a.n0) / 900 : 50,
      }),
    })
    mapRef.current = map
    ;(window as unknown as { olMap: OlMap }).olMap = map
    setReady(true)
    return () => map.setTarget(undefined)
  }, [])

  // fit when the area changes
  const areaKey = project.area ? Object.values(project.area).join(',') : ''
  useEffect(() => {
    const a = project.area
    if (!a || !mapRef.current) return
    mapRef.current.getView().fit([a.e0, a.n0, a.e1, a.n1], { padding: [40, 40, 40, 40], duration: 300 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKey, ready])

  useEffect(() => {
    base.current?.setSource(wmts(BASEMAPS[basemap]))
  }, [basemap])

  // ---------------------------------------------------------- noise raster
  const raster = useMemo(() => {
    if (!result) return undefined
    const { spec } = result.grid
    const cur = metricArray(result.grid.data, 3, metric)
    let values = cur
    let colour: (v: number) => string | undefined = levelColour
    if (view === 'diff' && compare && compare.grid.spec.cols === spec.cols && compare.grid.spec.rows === spec.rows) {
      const other = metricArray(compare.grid.data, 3, metric)
      values = new Float32Array(cur.length)
      for (let i = 0; i < cur.length; i++) values[i] = cur[i] - other[i]
      colour = diffColour
    }
    return { spec, values, canvas: drawCanvas(values, spec.cols, spec.rows, colour) }
  }, [result, compare, metric, view])

  useEffect(() => {
    if (!noise.current) return
    if (!raster) {
      noise.current.setSource(null)
      return
    }
    const { spec, canvas } = raster
    const h = spec.step / 2
    noise.current.setSource(
      new Static({
        url: canvas.toDataURL(),
        imageExtent: [
          spec.e0 - h,
          spec.n0 - h,
          spec.e0 + (spec.cols - 1) * spec.step + h,
          spec.n0 + (spec.rows - 1) * spec.step + h,
        ],
        projection: UTM32N,
        interpolate: true,
      }),
    )
  }, [raster])

  useEffect(() => noise.current?.setOpacity(opacity), [opacity])

  // ------------------------------------------------------------- vectors
  useEffect(() => {
    const s = vec.current.area
    if (!s) return
    s.clear()
    const a = project.area
    if (a) s.addFeature(new Feature(fromExtent([a.e0, a.n0, a.e1, a.n1])))
  }, [project.area, ready])

  const bLevels = useMemo(() => {
    if (!result) return undefined
    const cur = buildingLevels(result, metric)
    if (view === 'diff' && compare) {
      const other = buildingLevels(compare, metric)
      const d = new Map<string, number>()
      for (const [id, v] of cur.max) d.set(id, v - (other.max.get(id) ?? NaN))
      return { values: d, diff: true, abs: cur.max }
    }
    return { values: cur.max, diff: false, abs: cur.max }
  }, [result, compare, metric, view])

  useEffect(() => {
    const s = vec.current.buildings
    if (!s) return
    s.clear()
    s.addFeatures(
      project.buildings.map((b) => {
        const f = new Feature(new Polygon([[...b.ring, b.ring[0]]]))
        f.setId(b.id)
        f.set('kind', 'building')
        const v = bLevels?.values.get(b.id)
        const col =
          colourBuildings && v !== undefined
            ? bLevels!.diff
              ? diffColour(v)
              : levelColour(v)
            : undefined
        const selected = selection?.kind === 'building' && selection.id === b.id
        f.setStyle(
          new Style({
            fill: new Fill({ color: col ?? 'rgba(240,240,240,0.55)' }),
            stroke: new Stroke({ color: selected ? '#00e5ff' : '#222', width: selected ? 3 : 1 }),
          }),
        )
        return f
      }),
    )
  }, [project.buildings, bLevels, colourBuildings, selection, ready])

  useEffect(() => {
    const s = vec.current.roads
    if (!s) return
    s.clear()
    for (const r of project.roads) {
      const m = scenario.measures[r.id]
      const selected = selection?.kind === 'road' && selection.id === r.id
      const style = new Style({
        stroke: new Stroke({
          color: !r.enabled || m?.closed ? 'rgba(120,120,120,0.6)' : selected ? '#00e5ff' : m ? '#ff9f1c' : 'rgba(30,30,30,0.85)',
          width: ROAD_WIDTH[r.cls] ?? 3,
          lineDash: r.enabled ? undefined : [6, 6],
        }),
      })
      r.lines.forEach((l, i) => {
        const f = new Feature(new LineString(l))
        f.setId(`${r.id}#${i}`)
        f.set('kind', 'road')
        f.set('ref', r.id)
        f.setStyle(style)
        s.addFeature(f)
      })
    }
  }, [project.roads, scenario.measures, selection, ready])

  useEffect(() => {
    const s = vec.current.barriers
    if (!s) return
    s.clear()
    for (const b of scenario.barriers) {
      const selected = selection?.kind === 'barrier' && selection.id === b.id
      const f = new Feature(new LineString(b.points))
      f.setId(b.id)
      f.set('kind', 'barrier')
      f.setStyle([
        new Style({
          stroke: new Stroke({
            color: selected ? '#00e5ff' : b.kind === 'berm' ? '#7a5230' : b.absorption === 'reflective' ? '#7dd3fc' : '#1d4ed8',
            width: b.kind === 'berm' ? 9 : 6,
            lineDash: b.enabled ? undefined : [8, 8],
          }),
          text: new Text({
            text: `${fmt(b.height, 1)} m`,
            placement: 'line',
            fill: new Fill({ color: '#fff' }),
            stroke: new Stroke({ color: '#000', width: 3 }),
            font: 'bold 12px sans-serif',
          }),
        }),
      ])
      s.addFeature(f)
    }
  }, [scenario.barriers, selection, ready])

  const recValues = useMemo(() => {
    if (!result) return undefined
    const vals = metricArray(result.receivers.data, 8, metric)
    const out = new Map<string, number>()
    result.receivers.ids.forEach((id, i) => out.set(id, vals[i]))
    return out
  }, [result, metric])

  useEffect(() => {
    const s = vec.current.receivers
    if (!s) return
    s.clear()
    for (const r of project.receivers) {
      const v = recValues?.get(r.id)
      const selected = selection?.kind === 'receiver' && selection.id === r.id
      const f = new Feature(new Point([r.x, r.y]))
      f.setId(r.id)
      f.set('kind', 'receiver')
      f.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 7,
            fill: new Fill({ color: (v !== undefined && levelColour(v)) || '#fff' }),
            stroke: new Stroke({ color: selected ? '#00e5ff' : '#000', width: selected ? 3 : 2 }),
          }),
          text: new Text({
            text: v !== undefined && Number.isFinite(v) ? `${r.name}  ${fmt(v, 1)}` : r.name,
            offsetY: -16,
            fill: new Fill({ color: '#fff' }),
            stroke: new Stroke({ color: '#000', width: 3 }),
            font: 'bold 12px sans-serif',
          }),
        }),
      )
      s.addFeature(f)
    }
  }, [project.receivers, recValues, selection, ready])

  useEffect(() => {
    const s = vec.current.counters
    if (!s) return
    s.clear()
    for (const c of counters) {
      const f = new Feature(new Point([c.x, c.y]))
      f.set('label', `${c.code} ${c.place}`)
      s.addFeature(f)
    }
  }, [counters, ready])

  useEffect(() => {
    const s = vec.current.section
    if (!s) return
    s.clear()
    if (section) s.addFeature(new Feature(new LineString([section.a, section.b])))
  }, [section, ready])

  // -------------------------------------------------------- interactions
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const st = useStore.getState
    const added: (Draw | Modify)[] = []
    if (tool === 'area') {
      const d = new Draw({ source: new VectorSource(), type: 'Circle', geometryFunction: createBox() })
      d.on('drawend', (e) => {
        const [e0, n0, e1, n1] = e.feature.getGeometry()!.getExtent()
        st().setArea({ e0: Math.round(e0), n0: Math.round(n0), e1: Math.round(e1), n1: Math.round(n1) })
      })
      added.push(d)
    } else if (tool === 'wall' || tool === 'berm' || tool === 'road') {
      const d = new Draw({ source: new VectorSource(), type: 'LineString' })
      d.on('drawend', (e) => {
        const pts = (e.feature.getGeometry() as LineString).getCoordinates() as XY[]
        if (pts.length < 2) return
        if (tool === 'road') st().addRoad(pts)
        else st().addBarrier(tool, pts)
        st().setTool('select')
      })
      added.push(d)
    } else if (tool === 'section') {
      const d = new Draw({ source: new VectorSource(), type: 'LineString', maxPoints: 2 })
      d.on('drawend', (e) => {
        const pts = (e.feature.getGeometry() as LineString).getCoordinates() as XY[]
        st().setTool('select')
        void st().computeSection(pts[0], pts[pts.length - 1])
      })
      added.push(d)
    } else if (tool === 'select') {
      // editable: barriers of the scenario, receivers, drawn roads
      const m = new Modify({ source: vec.current.barriers })
      m.on('modifyend', (e) => {
        e.features.forEach((f) => {
          st().updateBarrier(String(f.getId()), {
            points: (f.getGeometry() as LineString).getCoordinates() as XY[],
          })
        })
      })
      const mr = new Modify({ source: vec.current.receivers })
      mr.on('modifyend', (e) => {
        e.features.forEach((f) => {
          const [x, y] = (f.getGeometry() as Point).getCoordinates()
          st().updateReceiver(String(f.getId()), { x, y })
        })
      })
      added.push(m, mr)
    }
    added.forEach((i) => map.addInteraction(i))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') st().setTool('select')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      added.forEach((i) => map.removeInteraction(i))
      window.removeEventListener('keydown', onKey)
    }
  }, [tool, ready])

  // click: select or place receiver
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const key = map.on('singleclick', (e) => {
      const st = useStore.getState()
      if (st.tool === 'receiver') {
        st.addReceiver(e.coordinate[0], e.coordinate[1])
        st.setTool('select')
        return
      }
      if (st.tool !== 'select') return
      let picked: FeatureLike | undefined
      map.forEachFeatureAtPixel(
        e.pixel,
        (f) => {
          if (!picked && f.get('kind')) picked = f
        },
        { hitTolerance: 5 },
      )
      if (!picked) return st.select(undefined)
      const kind = picked.get('kind')
      const id = kind === 'road' ? picked.get('ref') : String(picked.getId())
      st.select({ kind, id })
    })
    return () => map.un('singleclick', key.listener)
  }, [ready])

  // hover readout
  const hoverData = useRef({ raster, bLevels })
  hoverData.current = { raster, bLevels }
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const key = map.on('pointermove', (e) => {
      const box = tip.current
      if (!box) return
      if (e.dragging) return (box.style.display = 'none') as unknown as void
      const { raster: r, bLevels: bl } = hoverData.current
      let text = ''
      let bfound = false
      map.forEachFeatureAtPixel(e.pixel, (f) => {
        if (bfound || f.get('kind') !== 'building') return
        const b = useStore.getState().project.buildings.find((x) => x.id === f.getId())
        if (!b) return
        bfound = true
        const v = bl?.abs.get(b.id)
        text = t('hover.building', {
          h: fmt(b.height, 1),
          src: t(`src.${b.heightSource}` as never),
          v: v !== undefined ? fmt(v, 1) : '–',
        })
        if (bl?.diff) text += ` · Δ ${fmt(bl.values.get(b.id) ?? NaN, 1)}`
      })
      if (!bfound && r) {
        const { spec, values } = r
        const c = Math.round((e.coordinate[0] - spec.e0) / spec.step)
        const k = Math.round((e.coordinate[1] - spec.n0) / spec.step)
        if (c >= 0 && k >= 0 && c < spec.cols && k < spec.rows) {
          const v = values[k * spec.cols + c]
          if (Number.isFinite(v)) text = useStore.getState().view === 'diff' ? `Δ ${fmt(v, 1)} dB` : t('hover.level', { v: fmt(v, 1) })
        }
      }
      if (!text) {
        box.style.display = 'none'
        return
      }
      box.textContent = text
      box.style.display = 'block'
      box.style.left = `${e.pixel[0] + 14}px`
      box.style.top = `${e.pixel[1] + 14}px`
    })
    return () => map.un('pointermove', key.listener)
  }, [ready])

  return (
    <div className="map-wrap">
      <div ref={el} className="map" />
      <div ref={tip} className="tooltip" />
    </div>
  )
}

function areaStyle() {
  return new Style({ stroke: new Stroke({ color: '#ffffff', width: 2, lineDash: [10, 6] }) })
}

function sectionStyle() {
  return new Style({ stroke: new Stroke({ color: '#ff00d4', width: 3 }) })
}

function counterStyle(f: FeatureLike) {
  return new Style({
    image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#ffb703' }), stroke: new Stroke({ color: '#000', width: 2 }) }),
    text: new Text({
      text: String(f.get('label') ?? ''),
      offsetY: 14,
      fill: new Fill({ color: '#000' }),
      stroke: new Stroke({ color: '#ffb703', width: 3 }),
      font: '11px sans-serif',
    }),
  })
}
