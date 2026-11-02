import { useStore } from '../model/store'
import { METRICS } from '../model/types'
import { DIFF_CLASSES, LEVEL_CLASSES } from './palette'
import { t } from '../i18n'

export function Toolbar() {
  const tool = useStore((s) => s.tool)
  const metric = useStore((s) => s.metric)
  const view = useStore((s) => s.view)
  const basemap = useStore((s) => s.basemap)
  const opacity = useStore((s) => s.opacity)
  const colourBuildings = useStore((s) => s.colourBuildings)
  const hasCompare = useStore((s) => !!s.project.compareScenarioId)
  const st = useStore.getState
  const hint =
    tool === 'area' ? t('tool.hint.area')
    : tool === 'wall' || tool === 'berm' || tool === 'road' ? t('tool.hint.line')
    : tool === 'receiver' ? t('tool.hint.point')
    : tool === 'section' ? t('tool.hint.section')
    : ''
  return (
    <div className="toolbar">
      <button className={tool === 'select' ? 'active' : ''} onClick={() => st().setTool('select')}>{t('tool.select')}</button>
      <button className={tool === 'receiver' ? 'active' : ''} onClick={() => st().setTool('receiver')}>{t('receivers.add')}</button>
      <button className={tool === 'section' ? 'active' : ''} onClick={() => st().setTool('section')}>{t('tool.section')}</button>
      <span className="sep" />
      <select value={metric} onChange={(e) => st().setUi({ metric: e.target.value as never })}>
        {METRICS.map((m) => <option key={m} value={m}>{t(`metric.${m}` as never)}</option>)}
      </select>
      <select value={view} onChange={(e) => st().setUi({ view: e.target.value as never })}>
        <option value="level">{t('view.level')}</option>
        <option value="diff" disabled={!hasCompare}>{t('view.diff')}</option>
      </select>
      <select value={basemap} onChange={(e) => st().setUi({ basemap: e.target.value as never })} title={t('view.basemap')}>
        <option value="ortho">{t('view.ortho')}</option>
        <option value="topo">{t('view.topo')}</option>
        <option value="osm">{t('view.osm')}</option>
      </select>
      <label className="check" title={t('view.opacity')}>
        <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => st().setUi({ opacity: Number(e.target.value) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={colourBuildings} onChange={(e) => st().setUi({ colourBuildings: e.target.checked })} />
        {t('view.facades')}
      </label>
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

export function Legend() {
  const view = useStore((s) => s.view)
  const metric = useStore((s) => s.metric)
  if (view === 'diff') {
    return (
      <div className="legend">
        <strong>Δ {t(`metric.${metric}` as never)} dB</strong>
        {DIFF_CLASSES.map(([from, c], i) => {
          const to = DIFF_CLASSES[i + 1]?.[0]
          const label = from === -Infinity ? `< ${to}` : to === undefined ? `≥ +${from}` : `${from > 0 ? '+' : ''}${from} … ${to > 0 ? '+' : ''}${to}`
          return <div key={i}><i style={{ background: c }} />{label}</div>
        })}
      </div>
    )
  }
  return (
    <div className="legend">
      <strong>{t(`metric.${metric}` as never)} dB(A)</strong>
      {LEVEL_CLASSES.map(([from, c], i) => {
        const to = LEVEL_CLASSES[i + 1]?.[0]
        return <div key={from}><i style={{ background: c }} />{to ? `${from} – ${to}` : `≥ ${from}`}</div>
      })}
    </div>
  )
}
