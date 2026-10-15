import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Settings } from './Settings'
import './island.css'

function Root() {
  const [settings, setSettings] = useState(window.location.hash.startsWith('#settings'))
  useEffect(() => {
    const sync = (): void => setSettings(window.location.hash.startsWith('#settings'))
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  document.body.dataset.surface = settings ? 'settings' : window.island ? 'island' : 'web'
  return settings ? <Settings /> : <App />
}

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root')

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
