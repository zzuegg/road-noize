import { useEffect, useRef, useState, type ReactNode } from 'react'
import { activeScenario, inputHash, useStore } from '../model/store'
import { DEM_COVERAGES } from '../geo/services'
import { fmt, getLang, setLang, t } from '../i18n'
import { buildingLevels, metricArray, stats } from './derived'
import { floorHeights } from '../acoustics/build'
import { GROUND_CLASSES, type GroundClass, type Project, type Road, type RoadMeasure, type Traffic } from '../model/types'
import { BarrierEditor } from './BarrierEditor'
import { isMainRoad } from '../acoustics/core'
import type { SourceSelection } from '../model/types'
import { DEFAULT_MET, TURBULENCE_PRESETS } from '../model/defaults'

function Section({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  const [o, setO] = useState(open)
  return (
    <section className={`panel-section${o ? '' : ' closed'}`}>
      <h3 onClick={() => setO(!o)}>
        <span>{o ? '▾' : '▸'}</span> {title}
      </h3>
      {o && <div className="panel-body">{children}</div>}
    </section>
  )
}

export function Num({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  placeholder,
  title,
}: {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  step?: number
  min?: number
  max?: number
  placeholder?: string
  title?: string
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => setText(value === undefined ? '' : String(value)), [value])
  const commit = () => {
    const s = text.trim().replace(',', '.').replace('−', '-')
    if (s === '') return onChange(undefined)
    const v = Number(s)
    if (!Number.isFinite(v)) return setText(value === undefined ? '' : String(value))
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
    if (c !== value) onChange(c)
    else setText(String(c))
  }
  return (
    <label className="num" title={title}>
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={text}
        step={step}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </label>
  )
}

function lineLength(lines: [number, number][][]): number {
  let s = 0
  for (const l of lines) for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1])
  return s
}

// ------------------------------------------------------------------ project

export function ProjectPanel() {
  const project = useStore((s) => s.project)
  const update = useStore((s) => s.update)
  const file = useRef<HTMLInputElement>(null)
  const [, force] = useState(0)

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${project.name.replace(/[\\/:*?"<>|]/g, '-') || 'noise'}.noise.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const importJson = async (f: File) => {
    try {
      const p = JSON.parse(await f.text()) as Project
      if (p.format !== 'traffic-sansim' || !Array.isArray(p.scenarios)) throw new Error('format')
      useStore.getState().loadProject(p)
    } catch {
      useStore.setState({ error: 'Datei ist kein Projekt / not a project file' })
    }
  }

  return (
    <Section title={t('section.project')}>
      <label className="field">
        <span>{t('project.name')}</span>
        <input value={project.name} onChange={(e) => update((p) => ({ ...p, name: e.target.value }))} />
      </label>
      <div className="row wrap">
        <button onClick={() => useStore.getState().newProject()}>{t('project.new')}</button>
        <button onClick={() => void useStore.getState().exampleTschars()}>{t('project.tschars')}</button>
        <button onClick={exportJson}>{t('project.export')}</button>
        <button onClick={() => file.current?.click()}>{t('project.import')}</button>
        <input
          ref={file}
          type="file"
          accept=".json"
          hidden
          onChange={(e) => e.target.files?.[0] && void importJson(e.target.files[0])}
        />
        <button
          className="lang"
          onClick={() => {
            setLang(getLang() === 'de' ? 'en' : 'de')
            force((n) => n + 1)
            useStore.setState({})
          }}
        >
          {getLang() === 'de' ? 'EN' : 'DE'}
        </button>
      </div>
    </Section>
  )
}

// --------------------------------------------------------------------- data

export function DataPanel() {
  const project = useStore((s) => s.project)
  const terrain = useStore((s) => s.terrain)
  const counters = useStore((s) => s.counters)
  const busy = useStore((s) => s.busy)
  const tool = useStore((s) => s.tool)
  const a = project.area
  const w = a ? a.e1 - a.e0 : 0
  const h = a ? a.n1 - a.n0 : 0
  const maxSide = DEM_COVERAGES[project.demId].maxSide
  const tooBig = Math.max(w, h) > maxSide
  const dsmCount = project.buildings.filter((b) => b.heightSource === 'dsm').length

  return (
    <Section title={t('section.data')}>
      <div className="row">
        <button
          className={tool === 'area' ? 'active' : ''}
          onClick={() => useStore.getState().setTool(tool === 'area' ? 'select' : 'area')}
        >
          {t('area.draw')}
        </button>
        <span className="muted">{a ? t('area.size', { w: Math.round(w), h: Math.round(h) }) : t('area.none')}</span>
      </div>
      <label className="field">
        <span>{t('data.dem')}</span>
        <select
          value={project.demId}
          onChange={(e) => {
            useStore.getState().update((p) => ({ ...p, demId: e.target.value as Project['demId'] }))
            useStore.setState({ terrain: undefined, results: {} })
          }}
        >
          <option value="2.5">{t('data.dem25')}</option>
          <option value="0.5">{t('data.dem05')}</option>
        </select>
      </label>
      {tooBig && <p className="warn">{t('area.tooBig', { max: maxSide })}</p>}
      <div className="row wrap">
        <button
          className="primary"
          disabled={!a || tooBig || !!busy}
          onClick={() => {
            if (
              (project.roads.some((r) => r.cls !== 'user') || project.buildings.length) &&
              !confirm(t('data.replaceWarn'))
            )
              return
            void useStore.getState().importAll()
          }}
        >
          {busy ?? t('data.import')}
        </button>
        {a && !terrain && !busy && (
          <button disabled={tooBig} onClick={() => void useStore.getState().loadTerrain()}>
            {t('data.importTerrain')}
          </button>
        )}
      </div>
      <p className="muted small">
        {terrain
          ? t('data.terrain', {
              cols: terrain.dtm.cols,
              rows: terrain.dtm.rows,
              min: Math.round(terrain.dtm.data.reduce((x, y) => Math.min(x, y), Infinity)),
              max: Math.round(terrain.dtm.data.reduce((x, y) => Math.max(x, y), -Infinity)),
            })
          : t('data.noTerrain')}
        <br />
        {t('data.buildings', { n: project.buildings.length, dsm: dsmCount })} ·{' '}
        {t('data.roads', { n: project.roads.length })}
      </p>
      {counters.length > 0 && (
        <div className="small">
          <p className="muted">{t('data.counters')}</p>
          <ul className="plain">
            {counters.slice(0, 8).map((c) => (
              <li key={c.code + c.place}>
                {c.link ? (
                  <a href={c.link} target="_blank" rel="noreferrer">
                    {c.code} {c.place}
                  </a>
                ) : (
                  `${c.code} ${c.place}`
                )}
                {c.km !== undefined && <span className="muted"> km {c.km}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

// -------------------------------------------------------------------- roads

function TrafficEditor({ road }: { road: Road }) {
  const updateRoad = useStore((s) => s.updateRoad)
  const tr = road.traffic
  const set = (patch: Partial<Traffic>) => updateRoad(road.id, { traffic: { ...tr, ...patch } })
  const share = (k: keyof Traffic['share'], v?: number) => set({ share: { ...tr.share, [k]: v ?? 0 } })
  const ps = (k: keyof Traffic['periodShare'], v?: number) => set({ periodShare: { ...tr.periodShare, [k]: v ?? 0 } })
  const sp = (k: keyof Traffic['speed'], v?: number) => set({ speed: { ...tr.speed, [k]: v ?? 50 } })
  const sum = tr.periodShare.day + tr.periodShare.evening + tr.periodShare.night
  return (
    <div className="editor">
      <label className="field">
        <span>{t('common.name')}</span>
        <input value={road.name} onChange={(e) => updateRoad(road.id, { name: e.target.value })} />
      </label>
      <p className="warn small">{t('roads.placeholder')}</p>
      <div className="grid2">
        <Num label={t('roads.aadt')} value={tr.aadt} min={0} onChange={(v) => set({ aadt: v ?? 0 })} />
        <Num label={t('roads.heavy')} value={tr.share.heavy} min={0} max={100} onChange={(v) => share('heavy', v)} />
        <Num label={t('roads.medium')} value={tr.share.medium} min={0} max={100} onChange={(v) => share('medium', v)} />
        <Num label={t('roads.moto')} value={tr.share.moto} min={0} max={100} onChange={(v) => share('moto', v)} />
        <Num label={t('roads.moped')} value={tr.share.moped} min={0} max={100} onChange={(v) => share('moped', v)} />
        <Num
          label={t('roads.heavyNight')}
          value={tr.heavyNight}
          placeholder={String(tr.share.heavy)}
          min={0}
          max={100}
          onChange={(v) => set({ heavyNight: v })}
        />
        <Num label={t('roads.day')} value={tr.periodShare.day} min={0} max={100} onChange={(v) => ps('day', v)} />
        <Num label={t('roads.evening')} value={tr.periodShare.evening} min={0} max={100} onChange={(v) => ps('evening', v)} />
        <Num label={t('roads.night')} value={tr.periodShare.night} min={0} max={100} onChange={(v) => ps('night', v)} />
      </div>
      {Math.abs(sum - 100) > 0.5 && <p className="warn small">Σ = {fmt(sum, 1)} % ≠ 100 %</p>}
      <div className="grid2">
        <Num label={`${t('roads.vLight')} km/h`} value={tr.speed.light} min={20} onChange={(v) => sp('light', v)} />
        <Num label={`${t('roads.vMedium')} km/h`} value={tr.speed.medium} min={20} onChange={(v) => sp('medium', v)} />
        <Num label={`${t('roads.vHeavy')} km/h`} value={tr.speed.heavy} min={20} onChange={(v) => sp('heavy', v)} />
        <Num label={`${t('roads.vMoto')} km/h`} value={tr.speed.moto} min={20} onChange={(v) => sp('moto', v)} />
        <Num label={`${t('roads.vMoped')} km/h`} value={tr.speed.moped} min={20} onChange={(v) => sp('moped', v)} />
        <Num label={t('roads.surface')} value={tr.surface} step={0.5} onChange={(v) => set({ surface: v ?? 0 })} />
        <Num
          label={t('roads.motoExtra')}
          title={t('roads.motoExtraHint')}
          value={tr.motoExtra}
          step={1}
          min={0}
          max={20}
          onChange={(v) => set({ motoExtra: v ?? 0 })}
        />
      </div>
      <p className="muted small">{t('roads.motoExtraHint')}</p>
      <button className="danger" onClick={() => useStore.getState().removeRoad(road.id)}>
        {t('roads.remove')}
      </button>
    </div>
  )
}

export function RoadsPanel() {
  const roads = useStore((s) => s.project.roads)
  const selection = useStore((s) => s.selection)
  const tool = useStore((s) => s.tool)
  const select = useStore((s) => s.select)
  const updateRoad = useStore((s) => s.updateRoad)
  const sel = selection?.kind === 'road' ? roads.find((r) => r.id === selection.id) : undefined
  return (
    <Section title={t('section.roads')}>
      <button
        className={tool === 'road' ? 'active' : ''}
        onClick={() => useStore.getState().setTool(tool === 'road' ? 'select' : 'road')}
      >
        {t('roads.add')}
      </button>
      <ul className="list">
        {roads.map((r) => (
          <li key={r.id} className={sel?.id === r.id ? 'selected' : ''}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => updateRoad(r.id, { enabled: e.target.checked })} />
            <button className="link" onClick={() => select({ kind: 'road', id: r.id })}>
              {r.name}
            </button>
            <span className="muted small">
              {t(`class.${r.cls}` as never)} · {Math.round(lineLength(r.lines))} m · {r.traffic.aadt}/d
            </span>
          </li>
        ))}
      </ul>
      {sel && <TrafficEditor road={sel} />}
    </Section>
  )
}

// ---------------------------------------------------------------- scenarios

export function ScenariosPanel() {
  const project = useStore((s) => s.project)
  const results = useStore((s) => s.results)
  const st = useStore.getState
  return (
    <Section title={t('section.scenarios')}>
      <ul className="list">
        {project.scenarios.map((s) => {
          const r = results[s.id]
          const fresh = r && r.hash === inputHash(project, s)
          return (
            <li key={s.id} className={s.id === project.activeScenarioId ? 'selected' : ''}>
              <input
                type="radio"
                name="active"
                title={t('scenarios.active')}
                checked={s.id === project.activeScenarioId}
                onChange={() => st().setActiveScenario(s.id)}
              />
              <input
                className="inline"
                value={s.name}
                onChange={(e) => st().updateScenario(s.id, { name: e.target.value })}
              />
              <span className={`dot ${fresh ? 'ok' : r ? 'stale' : ''}`} title={fresh ? '✓' : r ? t('run.stale') : t('results.none')} />
              <button title={t('scenarios.copy')} onClick={() => st().addScenario(s.id)}>
                ⧉
              </button>
              <button
                title={t('scenarios.remove')}
                disabled={project.scenarios.length <= 1}
                onClick={() => confirm(`${t('scenarios.remove')}: ${s.name}?`) && st().removeScenario(s.id)}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
      <div className="row">
        <button onClick={() => st().addScenario()}>{t('scenarios.add')}</button>
      </div>
      <label className="field">
        <span>{t('scenarios.compare')}</span>
        <select
          value={project.compareScenarioId ?? ''}
          onChange={(e) => st().setCompare(e.target.value || undefined)}
        >
          <option value="">{t('scenarios.none')}</option>
          {project.scenarios
            .filter((s) => s.id !== project.activeScenarioId)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </label>
    </Section>
  )
}

// ----------------------------------------------------------------- measures

function MeasureEditor({ road, m }: { road: Road; m: RoadMeasure }) {
  const setMeasure = useStore((s) => s.setMeasure)
  const set = (patch: Partial<RoadMeasure>) => setMeasure(road.id, { ...m, ...patch })
  return (
    <div className="editor">
      <div className="row">
        <strong>{road.name}</strong>
        <span className="spacer" />
        <button onClick={() => setMeasure(road.id, undefined)}>×</button>
      </div>
      <div className="grid2">
        <Num label={t('measures.speedLimit')} value={m.speedLimit} min={20} placeholder={String(road.traffic.speed.light)} onChange={(v) => set({ speedLimit: v })} />
        <Num label={t('measures.surface')} value={m.surface} step={0.5} placeholder={String(road.traffic.surface)} onChange={(v) => set({ surface: v })} />
        <Num label={t('measures.trafficChange')} value={m.trafficChange} placeholder="0" onChange={(v) => set({ trafficChange: v })} />
        <Num label={t('measures.motoExtra')} value={m.motoExtra} min={0} placeholder={String(road.traffic.motoExtra)} onChange={(v) => set({ motoExtra: v })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={!!m.nightHeavyBan} onChange={(e) => set({ nightHeavyBan: e.target.checked })} />
        {t('measures.nightHeavyBan')}
      </label>
      <label className="check">
        <input type="checkbox" checked={!!m.closed} onChange={(e) => set({ closed: e.target.checked })} />
        {t('measures.closed')}
      </label>
    </div>
  )
}

export function MeasuresPanel() {
  const project = useStore((s) => s.project)
  const selection = useStore((s) => s.selection)
  const tool = useStore((s) => s.tool)
  const st = useStore.getState
  const sc = activeScenario(project)
  const roadsWithout = project.roads.filter((r) => !sc.measures[r.id])
  return (
    <Section title={`${t('section.measures')}: ${sc.name}`}>
      <div className="row wrap">
        <button className={tool === 'wall' ? 'active' : ''} onClick={() => st().setTool(tool === 'wall' ? 'select' : 'wall')}>
          {t('measures.wall')}
        </button>
        <button className={tool === 'berm' ? 'active' : ''} onClick={() => st().setTool(tool === 'berm' ? 'select' : 'berm')}>
          {t('measures.berm')}
        </button>
      </div>
      {sc.barriers.length === 0 && <p className="muted small">{t('measures.empty')}</p>}
      <ul className="list">
        {sc.barriers.map((b) => {
          const selected = selection?.kind === 'barrier' && selection.id === b.id
          const len = lineLength([b.points])
          return (
            <li key={b.id} className={`block${selected ? ' selected' : ''}`}>
              <div className="row">
                <input type="checkbox" checked={b.enabled} onChange={(e) => st().updateBarrier(b.id, { enabled: e.target.checked })} />
                <input className="inline" value={b.name} onFocus={() => st().select({ kind: 'barrier', id: b.id })} onChange={(e) => st().updateBarrier(b.id, { name: e.target.value })} />
                <span className="muted small">{t('measures.length', { m: Math.round(len) })}</span>
                <button onClick={() => st().removeBarrier(b.id)}>×</button>
              </div>
              {selected && <BarrierEditor b={b} />}
              {!selected && <span className="muted small">{t(`kind.${b.preset.kind}` as never)} · {fmt(Math.max(0, ...b.profile.flatMap((pp) => pp.verts.map((v) => v.h))), 1)} m</span>}
            </li>
          )
        })}
      </ul>
      <h4>{t('measures.traffic')}</h4>
      {Object.entries(sc.measures).map(([rid, m]) => {
        const road = project.roads.find((r) => r.id === rid)
        return road ? <MeasureEditor key={rid} road={road} m={m} /> : null
      })}
      {roadsWithout.length > 0 && (
        <select value="" onChange={(e) => e.target.value && st().setMeasure(e.target.value, {})}>
          <option value="">{t('measures.addRoad')}</option>
          {roadsWithout.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({t(`class.${r.cls}` as never)})
            </option>
          ))}
        </select>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------- receivers

export function ReceiversPanel() {
  const receivers = useStore((s) => s.project.receivers)
  const selection = useStore((s) => s.selection)
  const tool = useStore((s) => s.tool)
  const st = useStore.getState
  return (
    <Section title={t('section.receivers')}>
      <button className={tool === 'receiver' ? 'active' : ''} onClick={() => st().setTool(tool === 'receiver' ? 'select' : 'receiver')}>
        {t('receivers.add')}
      </button>
      {receivers.length === 0 && <p className="muted small">{t('receivers.empty')}</p>}
      <ul className="list">
        {receivers.map((r) => (
          <li key={r.id} className={`block${selection?.kind === 'receiver' && selection.id === r.id ? ' selected' : ''}`}>
            <div className="row">
              <input className="inline" value={r.name} onFocus={() => st().select({ kind: 'receiver', id: r.id })} onChange={(e) => st().updateReceiver(r.id, { name: e.target.value })} />
              <button onClick={() => st().removeReceiver(r.id)}>×</button>
            </div>
            <div className="grid3">
              <Num label={t('receivers.height')} value={r.height} step={0.5} min={0.5} max={60} onChange={(v) => st().updateReceiver(r.id, { height: v ?? 4 })} />
              <Num label={t('receivers.measuredDay')} value={r.measuredDay} onChange={(v) => st().updateReceiver(r.id, { measuredDay: v })} />
              <Num label={t('receivers.measuredNight')} value={r.measuredNight} onChange={(v) => st().updateReceiver(r.id, { measuredNight: v })} />
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}

// ----------------------------------------------------------------- settings

export function SettingsPanel() {
  const s = useStore((st) => st.project.settings)
  const set = useStore((st) => st.setSettings)
  const turbKey = (Object.keys(TURBULENCE_PRESETS) as (keyof typeof TURBULENCE_PRESETS)[]).find(
    (k) => TURBULENCE_PRESETS[k].cv2 === s.turbulence.cv2 && TURBULENCE_PRESETS[k].ct2 === s.turbulence.ct2,
  )
  const setMet = (i: number, patch: Partial<(typeof s.met)[number]>) =>
    set({ met: s.met.map((m, j) => (j === i ? { ...m, ...patch } : m)) })
  const sums = [0, 1, 2].map((k) => s.met.reduce((a, m) => a + m.weights[k], 0))
  const iso = s.method === 'iso9613' || s.method === 'cnossos'
  return (
    <Section title={t('section.settings')} open={false}>
      <label className="num">
        <span>{t('settings.method')}</span>
        <select value={s.method} onChange={(e) => set({ method: e.target.value as typeof s.method })}>
          <option value="physics">{t('method.physics')}</option>
          <option value="cnossos">{t('method.cnossos')}</option>
          <option value="iso9613">{t('method.iso9613')}</option>
        </select>
      </label>
      <p className="muted small">{t(iso ? 'method.isoHint' : s.method === 'cnossos' ? 'method.cnossosHint' : 'method.physicsHint')}</p>
      {s.method === 'cnossos' && (
        <div className="grid3">
          {[0, 1, 2].map((k) => (
            <Num key={k} label={`p ${t(k === 0 ? 'period.day' : k === 1 ? 'period.evening' : 'period.night')}`} title={t('settings.pFavHint')} value={s.favourableP[k]} step={0.05} min={0} max={1}
              onChange={(v) => set({ favourableP: s.favourableP.map((c, j) => (j === k ? v ?? 0.5 : c)) as [number, number, number] })} />
          ))}
        </div>
      )}
      {iso && (
        <div className="grid3">
          {[0, 1, 2].map((k) => (
            <Num key={k} label={`C0 ${t(k === 0 ? 'period.day' : k === 1 ? 'period.evening' : 'period.night')} dB`} value={s.cmetC0[k]} step={0.5} min={0} max={5}
              onChange={(v) => set({ cmetC0: s.cmetC0.map((c, j) => (j === k ? v ?? 0 : c)) as [number, number, number] })} />
          ))}
          <Num label={t('settings.isoHs')} value={s.isoSourceHeight} step={0.05} min={0.01} max={1} onChange={(v) => set({ isoSourceHeight: v ?? 0.05 })} />
        </div>
      )}
      <div className="grid2">
        <Num label={t('settings.grid')} value={s.gridSpacing} min={1} max={50} onChange={(v) => set({ gridSpacing: v ?? 10 })} />
        <Num label={t('settings.height')} value={s.receiverHeight} step={0.5} min={0.5} max={50} onChange={(v) => set({ receiverHeight: v ?? 4 })} />
        <label className="num">
          <span>{t('settings.ground')}</span>
          <select value={s.groundClass} onChange={(e) => set({ groundClass: e.target.value as GroundClass })}>
            {GROUND_CLASSES.map((g) => <option key={g} value={g}>{t(`ground.${g}` as never)}</option>)}
          </select>
        </label>
        <Num label={t('settings.maxDist')} value={s.maxDistance} min={100} max={5000} onChange={(v) => set({ maxDistance: v ?? 800 })} />
        <Num label={t('settings.reflOrder')} value={s.reflectionOrder} min={0} max={2} onChange={(v) => set({ reflectionOrder: v ?? 2 })} />
        <Num label={t('settings.reflRadius')} value={s.reflectionRadius} min={0} max={500} onChange={(v) => set({ reflectionRadius: v ?? 150 })} />
        {!iso && <Num label={t('settings.subFreq')} title={t('settings.subFreqHint')} value={s.subFrequencies} min={1} max={9} onChange={(v) => set({ subFrequencies: v ?? 3 })} />}
        {!iso && <label className="num">
          <span>{t('settings.turbulence')}</span>
          <select value={turbKey ?? ''} onChange={(e) => set({ turbulence: TURBULENCE_PRESETS[e.target.value as keyof typeof TURBULENCE_PRESETS] })}>
            {!turbKey && <option value="">—</option>}
            <option value="weak">{t('turb.weak')}</option>
            <option value="moderate">{t('turb.moderate')}</option>
            <option value="strong">{t('turb.strong')}</option>
          </select>
        </label>}
        <Num label={t('settings.temperature')} value={s.temperature} min={-20} max={40} onChange={(v) => set({ temperature: v ?? 10 })} />
        <Num label={t('settings.humidity')} value={s.humidity} min={5} max={100} onChange={(v) => set({ humidity: v ?? 70 })} />
        <Num label={t('settings.limitDay')} value={s.limitDay} onChange={(v) => set({ limitDay: v ?? 70 })} />
        <Num label={t('settings.limitNight')} value={s.limitNight} onChange={(v) => set({ limitNight: v ?? 60 })} />
        <Num label={t('settings.limitLden')} value={s.limitLden} onChange={(v) => set({ limitLden: v ?? 53 })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={s.lateral} onChange={(e) => set({ lateral: e.target.checked })} />
        {t('settings.lateral')}
      </label>
      <label className="check">
        <input type="checkbox" checked={s.facades} onChange={(e) => set({ facades: e.target.checked })} />
        {t('settings.facades')}
      </label>
      {!iso && <>
      <h4>{t('settings.met')}</h4>
      <p className="muted small">{t('settings.metHint')}</p>
      <table className="stats met">
        <thead>
          <tr><th>{t('common.name')}</th><th title={t('settings.radiusHint')}>R m</th><th>{t('period.day')} %</th><th>{t('period.evening')} %</th><th>{t('period.night')} %</th><th /></tr>
        </thead>
        <tbody>
          {s.met.map((m, i) => (
            <tr key={i}>
              <td><input className="inline" value={m.name} onChange={(e) => setMet(i, { name: e.target.value })} /></td>
              <td><Num label="" value={m.radius} step={100} onChange={(v) => setMet(i, { radius: v ?? 0 })} /></td>
              {[0, 1, 2].map((k) => (
                <td key={k}>
                  <Num label="" value={m.weights[k]} min={0} max={100} onChange={(v) => setMet(i, { weights: m.weights.map((w, j) => (j === k ? v ?? 0 : w)) as [number, number, number] })} />
                </td>
              ))}
              <td><button onClick={() => set({ met: s.met.filter((_, j) => j !== i) })} disabled={s.met.length <= 1}>×</button></td>
            </tr>
          ))}
          <tr className="muted">
            <td>Σ</td><td />
            {sums.map((v, k) => <td key={k} className={Math.abs(v - 100) > 0.5 ? 'bad' : ''}>{fmt(v, 0)}</td>)}
            <td />
          </tr>
        </tbody>
      </table>
      <div className="row">
        <button onClick={() => set({ met: [...s.met, { name: 'neu', radius: 1000, distanceScaled: false, weights: [0, 0, 0] }] })}>+</button>
        <button onClick={() => set({ met: DEFAULT_MET })}>{t('settings.metReset')}</button>
      </div>
      </>}
      <p className="muted small">
        <strong>{t('common.method')}:</strong> {t('about.method')}
      </p>
    </Section>
  )
}

// ------------------------------------------------------------------ results

function delta(a: number, b: number | undefined) {
  if (b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null
  const d = a - b
  return <span className={d < -0.05 ? 'good' : d > 0.05 ? 'bad' : ''}>{d > 0 ? '+' : ''}{fmt(d, 1)}</span>
}

export function ResultsPanel() {
  const project = useStore((s) => s.project)
  const results = useStore((s) => s.results)
  const metric = useStore((s) => s.metric)
  const progress = useStore((s) => s.progress)
  const terrain = useStore((s) => s.terrain)
  const selection = useStore((s) => s.selection)
  const st = useStore.getState
  const sc = activeScenario(project)
  const cmp = project.scenarios.find((s) => s.id === project.compareScenarioId)
  const r = results[sc.id]
  const rc = cmp ? results[cmp.id] : undefined
  const stale = (r && r.hash !== inputHash(project, sc)) || (rc && cmp && rc.hash !== inputHash(project, cmp))
  const s1 = r ? stats(project, r, metric) : undefined
  const s2 = rc ? stats(project, rc, metric) : undefined

  const recRows = project.receivers.map((rec) => {
    const i = r?.receivers.ids.indexOf(rec.id) ?? -1
    const j = rc?.receivers.ids.indexOf(rec.id) ?? -1
    const v = i >= 0 ? metricArray(r!.receivers.data, 8, metric)[i] : NaN
    const w = j >= 0 ? metricArray(rc!.receivers.data, 8, metric)[j] : undefined
    const lmaxMoto = i >= 0 ? r!.receivers.data[i * 8 + 3 + 4] : NaN
    const lmaxTruck = i >= 0 ? r!.receivers.data[i * 8 + 3 + 2] : NaN
    const ld = i >= 0 ? r!.receivers.data[i * 8] : NaN
    const ln = i >= 0 ? r!.receivers.data[i * 8 + 2] : NaN
    return { rec, v, w, lmaxMoto, lmaxTruck, ld, ln }
  })

  const csv = () => {
    const head = [`method ${project.settings.method === 'iso9613' ? 'ISO 9613-2:1996 (CNOSSOS-EU emission)' : project.settings.method === 'cnossos' ? 'CNOSSOS-EU' : 'sansim physics'}; sources: ${sourcesLabel(project)}`, 'x', 'y', 'height', `${metric} ${sc.name}`, cmp ? `${metric} ${cmp.name}` : '', 'Lday', 'Lnight', 'Lmax truck', 'Lmax motorcycle', 'measured day', 'measured night']
    const lines = recRows.map((x) =>
      [x.rec.name, x.rec.x.toFixed(1), x.rec.y.toFixed(1), x.rec.height, x.v.toFixed(1), x.w?.toFixed(1) ?? '', x.ld.toFixed(1), x.ln.toFixed(1), x.lmaxTruck.toFixed(1), x.lmaxMoto.toFixed(1), x.rec.measuredDay ?? '', x.rec.measuredNight ?? ''].join(';'),
    )
    const blob = new Blob([[head.join(';'), ...lines].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${project.name}-${sc.name}.csv`
    a.click()
  }

  const selBuilding = selection?.kind === 'building' ? project.buildings.find((b) => b.id === selection.id) : undefined

  return (
    <Section title={t('section.results')}>
      <SourcePicker />
      <div className="row wrap">
        {progress === undefined ? (
          <>
            <button className="primary" disabled={!terrain} onClick={() => void st().compute()}>
              {t('run.compute')}
            </button>
            {project.scenarios.length > 2 && (
              <button disabled={!terrain} onClick={() => void st().compute(true)}>
                {t('run.computeAll')}
              </button>
            )}
          </>
        ) : (
          <>
            <progress value={progress} max={1} />
            <span>{t('run.progress', { pct: Math.round(progress * 100) })}</span>
            <button onClick={() => st().cancel()}>{t('run.cancel')}</button>
          </>
        )}
      </div>
      {!terrain && <p className="muted small">{t('run.needTerrain')}</p>}
      {stale && <p className="warn small">{t('run.stale')}</p>}
      {!r && <p className="muted small">{t('results.none')}</p>}
      {r && s1 && (
        <>
          <p className="muted small">{t(`metric.${metric}` as never)} · <strong>{t(`method.${project.settings.method}` as never)}</strong> · {sourcesLabel(project)} · {t('run.time', { s: fmt(r.seconds, 1) })}</p>
          <table className="stats">
            <thead>
              <tr>
                <th />
                <th>{sc.name}</th>
                {s2 && <th>{cmp!.name}</th>}
                {s2 && <th>{t('results.delta')}</th>}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('results.buildings')}</td>
                <td>{s1.buildingsOver} / {s1.buildingsTotal}</td>
                {s2 && <td>{s2.buildingsOver}</td>}
                {s2 && <td>{delta(s1.buildingsOver, s2.buildingsOver)}</td>}
              </tr>
              <tr>
                <td>{t('results.floors')}</td>
                <td>{s1.floorsOver}</td>
                {s2 && <td>{s2.floorsOver}</td>}
                {s2 && <td>{delta(s1.floorsOver, s2.floorsOver)}</td>}
              </tr>
              <tr>
                <td>{t('results.area')}</td>
                <td>{fmt(s1.areaOver / 10000, 2)} ha</td>
                {s2 && <td>{fmt(s2.areaOver / 10000, 2)} ha</td>}
                {s2 && <td>{delta(s1.areaOver / 10000, s2.areaOver / 10000)}</td>}
              </tr>
              <tr>
                <td>{t('results.facadeMax')}</td>
                <td>{fmt(s1.facadeMax, 1)}</td>
                {s2 && <td>{fmt(s2.facadeMax, 1)}</td>}
                {s2 && <td>{delta(s1.facadeMax, s2.facadeMax)}</td>}
              </tr>
            </tbody>
          </table>
        </>
      )}
      {selBuilding && r && <BuildingDetail id={selBuilding.id} />}
      {recRows.length > 0 && r && (
        <>
          <table className="stats">
            <thead>
              <tr>
                <th>{t('results.receiver')}</th>
                <th>{t(`metric.${metric}` as never)}</th>
                {rc && <th>{t('results.delta')}</th>}
                <th title={t('results.lmax')}>Lmax {t('cat.heavy')}</th>
                <th title={t('results.lmax')}>Lmax {t('cat.moto')}</th>
                <th>{t('results.measured')}</th>
              </tr>
            </thead>
            <tbody>
              {recRows.map((x) => (
                <tr key={x.rec.id}>
                  <td>{x.rec.name} <span className="muted">{fmt(x.rec.height, 1)} m</span></td>
                  <td>{fmt(x.v, 1)}</td>
                  {rc && <td>{delta(x.v, x.w)}</td>}
                  <td>{fmt(x.lmaxTruck, 0)}</td>
                  <td>{fmt(x.lmaxMoto, 0)}</td>
                  <td className="small">
                    {x.rec.measuredDay !== undefined && <>T {fmt(x.rec.measuredDay, 1)} ({delta(x.ld, x.rec.measuredDay)}) </>}
                    {x.rec.measuredNight !== undefined && <>N {fmt(x.rec.measuredNight, 1)} ({delta(x.ln, x.rec.measuredNight)})</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={csv}>{t('results.csv')}</button>
        </>
      )}
      {rc && <p className="muted small">{t('results.compareHint')}</p>}
    </Section>
  )
}

/** What emits in the calculation, in words. */
export function sourcesLabel(p: Project): string {
  const s = p.settings
  if (s.sources === 'main') return t('sources.mainShort')
  if (s.sources === 'selected') {
    const names = p.roads.filter((r) => s.selectedRoads.includes(r.id)).map((r) => r.name)
    return names.length ? names.join(', ') : t('sources.none')
  }
  return t('sources.allShort')
}

function SourcePicker() {
  const project = useStore((s) => s.project)
  const set = useStore((s) => s.setSettings)
  const s = project.settings
  const toggle = (id: string, on: boolean) =>
    set({ selectedRoads: on ? [...s.selectedRoads, id] : s.selectedRoads.filter((x) => x !== id) })
  const mainCount = project.roads.filter(isMainRoad).length
  return (
    <div className="editor">
      <label className="num">
        <span>{t('sources.title')}</span>
        <select value={s.sources} onChange={(e) => set({ sources: e.target.value as SourceSelection })}>
          <option value="all">{t('sources.all')}</option>
          <option value="main">{t('sources.main', { n: mainCount })}</option>
          <option value="selected">{t('sources.selected')}</option>
        </select>
      </label>
      {s.sources === 'selected' && (
        <>
          <div className="row wrap small">
            <button onClick={() => set({ selectedRoads: project.roads.map((r) => r.id) })}>{t('sources.selectAll')}</button>
            <button onClick={() => set({ selectedRoads: [] })}>{t('sources.selectNone')}</button>
            <button onClick={() => set({ selectedRoads: project.roads.filter(isMainRoad).map((r) => r.id) })}>{t('sources.selectMain')}</button>
          </div>
          <ul className="list">
            {project.roads.map((r) => (
              <li key={r.id}>
                <label className="check">
                  <input type="checkbox" checked={s.selectedRoads.includes(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
                  {r.name}
                </label>
                <span className="muted small">{t(`class.${r.cls}` as never)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">{t('sources.hint')}</p>
    </div>
  )
}

function BuildingDetail({ id }: { id: string }) {
  const project = useStore((s) => s.project)
  const results = useStore((s) => s.results)
  const metric = useStore((s) => s.metric)
  const b = project.buildings.find((x) => x.id === id)!
  const sc = activeScenario(project)
  const r = results[sc.id]
  const rc = project.compareScenarioId ? results[project.compareScenarioId] : undefined
  const f1 = r ? buildingLevels(r, metric).floors.get(id) ?? [] : []
  const f2 = rc ? buildingLevels(rc, metric).floors.get(id) ?? [] : undefined
  const heights = floorHeights(b.height)
  return (
    <div className="editor">
      <div className="row">
        <strong>{b.use ?? 'Gebäude'}</strong>
        <span className="muted small">{t(`src.${b.heightSource}` as never)}</span>
      </div>
      <Num
        label={`${t('measures.height')}`}
        value={b.height}
        step={0.5}
        min={2}
        max={100}
        onChange={(v) => v && useStore.getState().updateBuilding(id, { height: v, heightSource: 'user' })}
      />
      <table className="stats">
        <tbody>
          {heights.map((h, i) => (
            <tr key={i}>
              <td>{fmt(h, 0)} m</td>
              <td>{fmt(f1[i] ?? NaN, 1)}</td>
              {f2 && <td>{delta(f1[i] ?? NaN, f2[i])}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

