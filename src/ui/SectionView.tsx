// Vertical slice along a line: terrain, buildings, barriers and the sound
// field above them. The picture that shows why a wall protects the ground floor
// and not the second floor.

import { useEffect, useRef } from 'react'
import { activeScenario, buildingRaster, useStore } from '../model/store'
import { metricOf } from '../acoustics/metrics'
import { sampleBilinear, sampleNearest } from '../acoustics/scene'
import { diffColour, levelColour } from './palette'
import { fmt, t } from '../i18n'

export function SectionView() {
  const section = useStore((s) => s.section)
  const busy = useStore((s) => s.sectionBusy)
  const project = useStore((s) => s.project)
  const terrain = useStore((s) => s.terrain)
  const metric = useStore((s) => s.metric)
  const view = useStore((s) => s.view)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    if (!c || !section || !terrain) return
    const W = (c.width = c.clientWidth * devicePixelRatio)
    const H = (c.height = c.clientHeight * devicePixelRatio)
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, W, H)
    const pad = { l: 46 * devicePixelRatio, b: 22 * devicePixelRatio, r: 8, t: 8 }
    const pw = W - pad.l - pad.r
    const ph = H - pad.t - pad.b
    const { a, b, cols, rows, z0, z1 } = section
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    // keep the vertical scale honest-ish: at most 4× exaggeration
    const X = (d: number) => pad.l + (d / len) * pw
    const Y = (z: number) => pad.t + ph - ((z - z0) / (z1 - z0)) * ph

    const sc = activeScenario(project)
    const cur = section.data[sc.id]
    const other = project.compareScenarioId ? section.data[project.compareScenarioId] : undefined
    if (cur) {
      const cw = pw / cols
      const rh = ph / rows
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          const i = r * cols + k
          if (!Number.isFinite(cur[i * 3])) continue
          let v = metricOf(metric, cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2])
          let col: string | undefined
          if (view === 'diff' && other) {
            v -= metricOf(metric, other[i * 3], other[i * 3 + 1], other[i * 3 + 2])
            col = diffColour(v)
          } else col = levelColour(v)
          if (!col) continue
          ctx.fillStyle = col
          ctx.fillRect(pad.l + k * cw - cw / 2, pad.t + ph - (r + 1) * rh, cw + 1, rh + 1)
        }
      }
    }

    // buildings and terrain
    const bl = buildingRaster(project)
    const n = 400
    ctx.beginPath()
    ctx.moveTo(X(0), Y(z0))
    for (let i = 0; i <= n; i++) {
      const f = i / n
      const x = a[0] + (b[0] - a[0]) * f
      const y = a[1] + (b[1] - a[1]) * f
      ctx.lineTo(X(f * len), Y(sampleBilinear(terrain.dtm, x, y)))
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
    // barriers crossing the line
    for (const bar of sc.barriers) {
      if (!bar.enabled) continue
      for (let i = 0; i < bar.points.length - 1; i++) {
        const [x0, y0] = bar.points[i]
        const [x1, y1] = bar.points[i + 1]
        const dx = b[0] - a[0], dy = b[1] - a[1], ex = x1 - x0, ey = y1 - y0
        const den = dx * ey - dy * ex
        if (Math.abs(den) < 1e-9) continue
        const tt = ((x0 - a[0]) * ey - (y0 - a[1]) * ex) / den
        const u = ((x0 - a[0]) * dy - (y0 - a[1]) * dx) / den
        if (tt < 0 || tt > 1 || u < 0 || u > 1) continue
        const g = sampleBilinear(terrain.dtm, a[0] + dx * tt, a[1] + dy * tt)
        const wpx = Math.max(3 * devicePixelRatio, bar.kind === 'berm' ? (bar.crestWidth / len) * pw : 0)
        ctx.fillStyle = bar.kind === 'berm' ? '#7a5230' : '#1d4ed8'
        ctx.fillRect(X(tt * len) - wpx / 2, Y(g + bar.height), wpx, Y(g) - Y(g + bar.height))
      }
    }
    // roads crossing the line
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
          ctx.arc(X(tt * len), Y(g), 5 * devicePixelRatio, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    // axes
    ctx.fillStyle = '#ddd'
    ctx.font = `${11 * devicePixelRatio}px sans-serif`
    for (let z = Math.ceil(z0 / 10) * 10; z <= z1; z += 10) {
      ctx.fillText(`${z}`, 4, Y(z) + 4)
      ctx.fillRect(pad.l - 4, Y(z), 4, 1)
    }
    const stepD = len > 400 ? 100 : 50
    for (let d = 0; d <= len; d += stepD) ctx.fillText(`${d} m`, X(d) - 10, H - 6)
  }, [section, terrain, project, metric, view])

  if (!section) return null
  return (
    <div className="section-view">
      <div className="row">
        <strong>{t('section.title')}</strong>
        <span className="muted small">
          {fmt(Math.hypot(section.b[0] - section.a[0], section.b[1] - section.a[1]), 0)} m · {t(`metric.${metric}` as never)}
        </span>
        {busy && <span className="muted">{t('section.computing')}</span>}
        <span className="spacer" />
        <button onClick={() => useStore.getState().closeSection()}>{t('section.close')}</button>
      </div>
      <canvas ref={canvas} />
    </div>
  )
}
