/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

/** Bridge exposed by the desktop shell's preload (desktop/src/preload.ts); absent in a browser. */
interface Window {
  comfyDesktop?: {
    isDesktop: boolean
    electronVersion: string
    platform: string
    /** Broker bearer token injected over sync IPC — the desktop broker is always token-gated. */
    apiToken: string | null
    /** One-shot boot signal (`ipcRenderer.send('comfy:renderer-ready')`) — the
     *  shell shows the hidden window on it. Optional: older preloads lack it. */
    signalReady?: () => void
  }
}
