import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Website } from './Website'
import '../renderer/src/island.css'
import './site.css'

createRoot(document.getElementById('root')!).render(<StrictMode><Website /></StrictMode>)
