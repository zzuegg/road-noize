import { useEffect } from 'react'
import { MapView } from './ui/MapView'
import { DataPanel, MeasuresPanel, ProjectPanel, ReceiversPanel, ResultsPanel, RoadsPanel, ScenariosPanel, SettingsPanel } from './ui/Panels'
import { Legend, Toolbar } from './ui/Toolbar'
import { SectionView } from './ui/SectionView'
import { restore, useStore } from './model/store'
import { t } from './i18n'

export function App() {
  const error = useStore((s) => s.error)
  useEffect(() => void restore(), [])
  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>{t('app.title')}</h1>
          <p className="muted small">{t('app.subtitle')}</p>
        </header>
        {error && (
          <div className="error" onClick={() => useStore.getState().dismissError()}>
            {error} ✕
          </div>
        )}
        <ProjectPanel />
        <DataPanel />
        <ScenariosPanel />
        <MeasuresPanel />
        <ResultsPanel />
        <ReceiversPanel />
        <RoadsPanel />
        <SettingsPanel />
      </aside>
      <main className="main">
        <Toolbar />
        <div className="map-area">
          <MapView />
          <Legend />
        </div>
        <SectionView />
      </main>
    </div>
  )
}
