import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.js'
import './styles/index.css'

// Desktop shell: the window is held hidden until the renderer signals it's
// ready — sent before createRoot so frame one of the entrance is already on
// screen when the window shows (sent after mount it would clip the opening
// animation frames). No-op in a browser.
window.comfyDesktop?.signalReady?.()

// Boot lands on '/', whose only job is to redirect to /connectors. Rewriting
// the URL before React mounts makes the very first render already be
// /connectors, so AnimatePresence's initial={false} applies as authored — no
// accidental boot blur transition and no 1024→768 maxWidth settle. The
// `<Route path="/">` Navigate in App.tsx stays as a fallback.
if (location.pathname === '/') history.replaceState(null, '', '/connectors')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
