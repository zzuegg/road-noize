import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './geo/crs'
import { App } from './App'
import { loadCore } from './acoustics/core'
import './styles.css'

void loadCore().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})

if (import.meta.env.DEV) {
  void import('./model/store').then((m) => ((window as unknown as { store: unknown }).store = m.useStore))
}
