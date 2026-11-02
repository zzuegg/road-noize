// One barrier: cross-section family, its parameters, materials, and a drawing
// of the section (road on the left) so what gets computed is what you see.

import { useStore } from '../model/store'
import { BARRIER_KINDS, MATERIALS, type Barrier, type Material, type Part, type PresetParams } from '../model/types'
import { defaultPreset } from '../model/defaults'
import { fmt, t } from '../i18n'
import { Num } from './Panels'

const MAT_COLOUR: Record<string, string> = {
  reflective: '#9ecbff',
  absorptive: '#3b6fd8',
  highlyAbsorptive: '#1e3a8a',
  grass: '#4d8b3c',
  gabion: '#9a8a6a',
  wood: '#a0662f',
  base: '#555',
}

export function ProfileSvg({ parts, width = 300, height = 150 }: { parts: Part[]; width?: number; height?: number }) {
  const pts = parts.flatMap((p) => p.verts)
  if (pts.length === 0) return null
  // road side (+o) drawn on the LEFT
  const xs = pts.map((v) => -v.o)
  const minX = Math.min(...xs, -1) - 1.5
  const maxX = Math.max(...xs, 1) + 1.5
  const maxH = Math.max(...pts.map((v) => v.h), 1) + 0.8
  const s = Math.min((width - 20) / (maxX - minX), (height - 20) / maxH)
  const X = (o: number) => 10 + (-o - minX) * s
  const Y = (h: number) => height - 10 - h * s
  return (
    <svg width={width} height={height} className="profile-svg">
      <line x1={0} x2={width} y1={Y(0)} y2={Y(0)} stroke="#6b5a45" strokeWidth={2} />
      <text x={6} y={Y(0) + 9} className="svg-label">{t('barrier.roadSide')}</text>
      {parts.map((p, pi) => (
        <g key={pi}>
          <polygon
            points={p.verts.map((v) => `${X(v.o)},${Y(v.h)}`).join(' ')}
            fill="rgba(160,160,160,0.25)"
            stroke="none"
          />
          {p.verts.map((v, i) => {
            const w = p.verts[(i + 1) % p.verts.length]
            if (v.m === 'base') return null
            return (
              <line
                key={i}
                x1={X(v.o)}
                y1={Y(v.h)}
                x2={X(w.o)}
                y2={Y(w.h)}
                stroke={MAT_COLOUR[v.m] ?? '#ccc'}
                strokeWidth={3}
                strokeLinecap="round"
              />
            )
          })}
        </g>
      ))}
      {[0, 1, 2, 3, 4, 5, 6, 8, 10].filter((h) => h <= maxH).map((h) => (
        <text key={h} x={width - 18} y={Y(h) + 3} className="svg-label">{h}</text>
      ))}
    </svg>
  )
}

export function BarrierEditor({ b }: { b: Barrier }) {
  const update = useStore((s) => s.updateBarrier)
  const p = b.preset
  const set = (patch: Partial<PresetParams>) => update(b.id, { preset: { ...p, ...patch } })
  const kind = p.kind
  const isBerm = kind === 'berm' || kind === 'bermWall' || kind === 'gabion'
  const hasAngle = kind === 'tilted' || kind === 'bentTop' || kind === 'curvedTop' || kind === 'yTop'
  const hasTop = kind === 'bentTop' || kind === 'curvedTop' || kind === 'tTop' || kind === 'yTop'
  const mat = (label: string, value: Material, on: (m: Material) => void) => (
    <label className="num">
      <span>{label}</span>
      <select value={value} onChange={(e) => on(e.target.value as Material)}>
        {MATERIALS.map((m) => (
          <option key={m} value={m}>{t(`mat.${m}` as never)}</option>
        ))}
      </select>
    </label>
  )
  return (
    <div className="editor">
      <label className="num">
        <span>{t('barrier.kind')}</span>
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value as PresetParams['kind']
            if (k === 'custom') update(b.id, { preset: { ...p, kind: k } })
            else update(b.id, { preset: { ...defaultPreset(k), height: isBerm === (k === 'berm' || k === 'gabion' || k === 'bermWall') ? p.height : defaultPreset(k).height } })
          }}
        >
          {BARRIER_KINDS.map((k) => (
            <option key={k} value={k}>{t(`kind.${k}` as never)}</option>
          ))}
        </select>
      </label>
      <ProfileSvg parts={b.profile} />
      <p className="muted small">{t(`kindHint.${kind}` as never)}</p>
      {kind !== 'custom' && (
        <div className="grid2">
          <Num label={t('measures.height')} value={p.height} step={0.25} min={0.3} max={15} onChange={(v) => set({ height: v ?? 3 })} />
          {!isBerm && <Num label={t('barrier.thickness')} value={p.thickness} step={0.05} min={0.05} max={2} onChange={(v) => set({ thickness: v ?? 0.2 })} />}
          {hasAngle && (
            <Num
              label={kind === 'tilted' ? t('barrier.tilt') : t('barrier.bend')}
              title={kind === 'tilted' ? t('barrier.tiltHint') : t('barrier.bendHint')}
              value={p.angle}
              step={5}
              min={-80}
              max={135}
              onChange={(v) => set({ angle: v ?? 0 })}
            />
          )}
          {hasTop && <Num label={t('barrier.topLength')} value={p.topLength} step={0.25} min={0.2} max={6} onChange={(v) => set({ topLength: v ?? 1.5 })} />}
          {isBerm && <Num label={t('measures.crest')} value={p.crest} step={0.25} min={0} max={20} onChange={(v) => set({ crest: v ?? 1 })} />}
          {isBerm && <Num label={t('barrier.frontSlope')} value={p.frontSlope} step={1} min={5} max={89} onChange={(v) => set({ frontSlope: v ?? 34 })} />}
          {isBerm && <Num label={t('barrier.backSlope')} value={p.backSlope} step={1} min={5} max={89} onChange={(v) => set({ backSlope: v ?? 34 })} />}
          {kind === 'bermWall' && <Num label={t('barrier.wallHeight')} value={p.wallHeight} step={0.25} min={0} max={8} onChange={(v) => set({ wallHeight: v ?? 0 })} />}
          {(!isBerm || kind === 'bermWall') && mat(t('barrier.front'), p.front, (m) => set({ front: m }))}
          {(!isBerm || kind === 'bermWall') && mat(t('barrier.back'), p.back, (m) => set({ back: m }))}
        </div>
      )}
      {kind === 'custom' && <CustomProfile b={b} />}
      <label className="check">
        <input type="checkbox" checked={b.flip} onChange={(e) => update(b.id, { flip: e.target.checked })} />
        {t('barrier.flip')}
      </label>
    </div>
  )
}

/** Vertex table for a free cross-section (one polygon). */
function CustomProfile({ b }: { b: Barrier }) {
  const update = useStore((s) => s.updateBarrier)
  const part = b.profile[0] ?? { verts: [] }
  const setVerts = (verts: Part['verts']) => update(b.id, { profile: [{ verts }, ...b.profile.slice(1)] })
  return (
    <div className="small">
      <p className="muted">{t('barrier.customHint')}</p>
      <table className="stats">
        <thead>
          <tr><th>o m</th><th>h m</th><th>{t('barrier.material')}</th><th /></tr>
        </thead>
        <tbody>
          {part.verts.map((v, i) => (
            <tr key={i}>
              <td><Num label="" value={v.o} step={0.1} onChange={(x) => setVerts(part.verts.map((w, j) => (j === i ? { ...w, o: x ?? 0 } : w)))} /></td>
              <td><Num label="" value={v.h} step={0.1} min={0} onChange={(x) => setVerts(part.verts.map((w, j) => (j === i ? { ...w, h: x ?? 0 } : w)))} /></td>
              <td>
                <select value={v.m} onChange={(e) => setVerts(part.verts.map((w, j) => (j === i ? { ...w, m: e.target.value } : w)))}>
                  {[...MATERIALS, 'base'].map((m) => <option key={m} value={m}>{m === 'base' ? '—' : t(`mat.${m}` as never)}</option>)}
                </select>
              </td>
              <td><button onClick={() => setVerts(part.verts.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => setVerts([...part.verts, { o: 0, h: fmtNum(part.verts.at(-1)?.h ?? 0), m: 'absorptive' }])}>+</button>
    </div>
  )
}

function fmtNum(v: number): number {
  return Number(fmt(v, 2).replace(',', '.'))
}
