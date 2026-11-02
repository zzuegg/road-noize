// Vertical slice along a line. Two views of the same section:
//  - rays: the full engine (all paths, reflections, weather mix) on a grid
//  - wave (PE): the parabolic-equation solution for one weather condition,
//    shown as the pass-by level of one vehicle crossing the section start.

import { useEffect, useRef, useState } from 'react'
import { activeScenario, buildingRaster, PE_FREQS, PE_WEATHER, useStore, type PeWeather } from '../model/store'
import { metricOf } from '../acoustics/metrics'
import { sampleBilinear, sampleNearest } from '../acoustics/raster'
import { vehiclePower } from '../acoustics/emission'
import { A_WEIGHT, BANDS } from '../acoustics/bands'
import { presetProfile } from '../acoustics/core'
import { diffColour, levelColour } from './palette'
import { fmt, t } from '../i18n'
import type { Category } from '../model/types'

type Mode = 'rays' | 'pe'

export function SectionView() {
  const section = useStore((s) => s.section)
  const busy = useStore((s) => s.sectionBusy)
  const project = useStore((s) => s.project)
  const terrain = useStore((s) => s.terrain)
  const metric = useStore((s) => s.metric)
  const view = useStore((s) => s.view)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<Mode>('rays')
  const [vehicle, setVehicle] = useState<Category>('heavy')
  const [speed, setSpeed] = useState(50)

  useEffect(() => {
    const c = canvas.current
    if (!c || !section || !terrain) return
    const dpr = devicePixelRatio
    const W = (c.width = c.clientWidth * dpr)
    const H = (c.height = c.clientHeight * dpr)
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, W, H)
    const pad = { l: 46 * dpr, b: 22 * dpr, r: 8, t: 8 }
    const pw = W - pad.l - pad.r
    const ph = H - pad.t - pad.b
    const { a, b, cols, rows, z0, z1 } = section
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const X = (d: number) => pad.l + (d / len) * pw
    const Y = (z: number) => pad.t + ph - ((z - z0) / (z1 - z0)) * ph
    const sc = activeScenario(project)
    const otherId = project.compareScenarioId
    const diff = view === 'diff' && !!otherId

    if (mode === 'rays') {
      const cur = section.data[sc.id]
      const other = otherId ? section.data[otherId] : undefined
      if (cur) {
        const cw = pw / cols
        const rh = ph / rows
        for (let r = 0; r < rows; r++) {
          for (let k = 0; k < cols; k++) {
            const i = r * cols + k
            if (!Number.isFinite(cur[i * 3])) continue
            let v = metricOf(metric, cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2])
            let col: string | undefined
            if (diff && other) {
              v -= metricOf(metric, other[i * 3], other[i * 3 + 1], other[i * 3 + 2])
              col = diffColour(v)
            } else col = levelColour(v)
            if (!col) continue
            ctx.fillStyle = col
            ctx.fillRect(pad.l + k * cw - cw / 2, pad.t + ph - (r + 1) * rh, cw + 1, rh + 1)
          }
        }
      }
    } else {
      const lw = vehiclePower(vehicle, speed)
      const zsAbs = sampleBilinear(terrain.dtm, a[0], a[1]) + 0.3
      const levels = (id: string) => {
        const pe = section.pe[id]
        if (!pe) return undefined
        const out = new Float32Array(pe.cols * pe.rows).fill(NaN)
        for (let row = 0; row < pe.rows; row++) {
          const z = pe.zBottom + row * pe.outDz
          for (let col = 1; col < pe.cols; col++) {
            const r = col * pe.outDr
            const R = Math.hypot(r, z - zsAbs)
            let e = 0
            let ok = false
            PE_FREQS.forEach((f, fi) => {
              const dl = pe.deltaL[fi][row * pe.cols + col]
              if (dl === null || !Number.isFinite(dl)) return
              ok = true
              const b = BANDS.indexOf(f as (typeof BANDS)[number])
              e += 10 ** ((lw[b] + A_WEIGHT[b] + dl - 20 * Math.log10(R) - 11) / 10)
            })
            if (ok) out[row * pe.cols + col] = 10 * Math.log10(e)
          }
        }
        return { pe, out }
      }
      const cur = levels(sc.id)
      const other = otherId ? levels(otherId) : undefined
      if (cur) {
        const { pe, out } = cur
        const cw = (pe.outDr / len) * pw
        const rh = (pe.outDz / (z1 - z0)) * ph
        for (let row = 0; row < pe.rows; row++) {
          const z = pe.zBottom + row * pe.outDz
          if (z < z0 || z > z1) continue
          for (let col = 1; col < pe.cols; col++) {
            let v = out[row * pe.cols + col]
            if (!Number.isFinite(v)) continue
            let colr: string | undefined
            if (diff && other && other.pe.cols === pe.cols) {
              v -= other.out[row * pe.cols + col]
              colr = diffColour(v)
            } else colr = levelColour(v)
            if (!colr) continue
            ctx.fillStyle = colr
            ctx.fillRect(X(col * pe.outDr) - cw / 2, Y(z) - rh / 2, cw + 1, rh + 1)
          }
        }
      }
    }

    // terrain, buildings, barriers, roads
    const bl = buildingRaster(project)
    const n = 500
    ctx.beginPath()
    ctx.moveTo(X(0), Y(z0))
    for (let i = 0; i <= n; i++) {
      const f = i / n
      ctx.lineTo(X(f * len), Y(sampleBilinear(terrain.dtm, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)))
    }
    ctx.lineTo(X(len), Y(z0))
    ctx.closePath()
    ctx.fillStyle = '#5b4a3a'
    ctx.fill()
    if (bl) {
      ctx.fillStyle = '#9aa0a6'
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n
        const x = a[0] + (b[0] - a[0]) * f
        const y = a[1] + (b[1] - a[1]) * f
        const h = sampleNearest(bl, x, y)
        if (h > 0) {
          const g = sampleBilinear(terrain.dtm, x, y)
          ctx.fillRect(X((i / n) * len), Y(g + h), pw / n + 1, Y(g) - Y(g + h))
        }
      }
    }
    // barriers: the actual cross-section, stretched by the crossing angle
    for (const bar of sc.barriers) {
      if (!bar.enabled) continue
      const pts = bar.flip ? [...bar.points].reverse() : bar.points
      const prof = bar.preset.kind === 'custom' ? bar.profile : presetProfile(bar.preset)
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i]
        const [bx, by] = pts[i + 1]
        const L = Math.hypot(bx - ax, by - ay)
        if (L < 0.05) continue
        const ux = (bx - ax) / L
        const uy = (by - ay) / L
        const den = dx * uy - dy * ux
        if (Math.abs(den) < 1e-9) continue
        // where the section crosses the axis
        const qx = ax - a[0]
        const qy = ay - a[1]
        const tt = (qx * uy - qy * ux) / den
        const sa = (qx * dy - qy * dx) / den
        if (tt < 0 || tt > 1 || sa < 0 || sa > L) continue
        const g = sampleBilinear(terrain.dtm, ax + ux * sa, ay + uy * sa)
        // offset o maps to section distance: d = tt·len + o / (n·dir) where n is the road-side normal
        const nd = (-uy * dx + ux * dy) / len // n · unit section direction
        if (Math.abs(nd) < 1e-6) continue
        for (const part of prof) {
          ctx.beginPath()
          part.verts.forEach((v, k) => {
            const d = tt * len + v.o / nd
            if (k === 0) ctx.moveTo(X(d), Y(g + v.h))
            else ctx.lineTo(X(d), Y(g + v.h))
          })
          ctx.closePath()
          ctx.fillStyle = bar.preset.front === 'reflective' ? '#7dd3fc' : ['berm', 'bermWall', 'gabion'].includes(bar.preset.kind) ? '#7a5230' : '#1d4ed8'
          ctx.fill()
        }
      }
    }
    ctx.fillStyle = '#000'
    for (const road of project.roads) {
      if (!road.enabled) continue
      for (const l of road.lines) {
        for (let i = 0; i < l.length - 1; i++) {
          const [x0, y0] = l[i]
          const [x1, y1] = l[i + 1]
          const dx = b[0] - a[0], dy = b[1] - a[1], ex = x1 - x0, ey = y1 - y0
          const den = dx * ey - dy * ex
          if (Math.abs(den) < 1e-9) continue
          const tt = ((x0 - a[0]) * ey - (y0 - a[1]) * ex) / den
          const u = ((x0 - a[0]) * dy - (y0 - a[1]) * dx) / den
          if (tt < 0 || tt > 1 || u < 0 || u > 1) continue
          const g = sampleBilinear(terrain.dtm, a[0] + dx * tt, a[1] + dy * tt)
          ctx.beginPath()
          ctx.arc(X(tt * len), Y(g), 5 * dpr, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    ctx.fillStyle = '#ddd'
    ctx.font = `${11 * dpr}px sans-serif`
    for (let z = Math.ceil(z0 / 5) * 5; z <= z1; z += 5) {
      ctx.fillText(`${z}`, 4, Y(z) + 4)
      ctx.fillRect(pad.l - 4, Y(z), 4, 1)
    }
    const stepD = len > 400 ? 100 : len > 150 ? 50 : 20
    for (let d = 0; d <= len; d += stepD) ctx.fillText(`${d} m`, X(d) - 10, H - 6)
  }, [section, terrain, project, metric, view, mode, vehicle, speed])

  if (!section) return null
  const st = useStore.getState
  return (
    <div className="section-view">
      <div className="row wrap">
        <strong>{t('section.title')}</strong>
        <span className="muted small">{fmt(Math.hypot(section.b[0] - section.a[0], section.b[1] - section.a[1]), 0)} m</span>
        <button className={mode === 'rays' ? 'active' : ''} onClick={() => setMode('rays')}>{t('section.rays')}</button>
        <button className={mode === 'pe' ? 'active' : ''} onClick={() => setMode('pe')}>{t('section.pe')}</button>
        {mode === 'rays' && <span className="muted small">{t(`metric.${metric}` as never)}</span>}
        {mode === 'pe' && (
          <>
            <select value={section.peWeather} onChange={(e) => void st().computePe(e.target.value as PeWeather)}>
              {(Object.keys(PE_WEATHER) as PeWeather[]).map((w) => <option key={w} value={w}>{t(`weather.${w}` as never)}</option>)}
            </select>
            <button disabled={section.peBusy} onClick={() => void st().computePe(section.peWeather)}>{t('section.peRun')}</button>
            <select value={vehicle} onChange={(e) => setVehicle(e.target.value as Category)}>
              {(['light', 'medium', 'heavy', 'moto'] as Category[]).map((c) => <option key={c} value={c}>{t(`cat.${c}` as never)}</option>)}
            </select>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {[30, 50, 70, 90].map((v) => <option key={v} value={v}>{v} km/h</option>)}
            </select>
            <span className="muted small">{t('section.peHint')}</span>
          </>
        )}
        {(busy || section.peBusy) && <span className="muted">{t('section.computing')}</span>}
        <span className="spacer" />
        <button onClick={() => st().closeSection()}>{t('section.close')}</button>
      </div>
      <canvas ref={canvas} />
    </div>
  )
}
