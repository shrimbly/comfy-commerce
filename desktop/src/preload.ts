import { contextBridge, ipcRenderer } from 'electron'

// The SPA talks to the broker over HTTP and needs nothing from Node, so the
// bridge is intentionally tiny — just enough to let the renderer know it's
// running inside the desktop shell.
contextBridge.exposeInMainWorld('comfyDesktop', {
  isDesktop: true,
  electronVersion: process.versions.electron,
  // 'darwin' | 'win32' | 'linux' — the renderer reserves space for the inlaid
  // macOS traffic-light buttons (the frameless title bar) only on darwin.
  platform: process.platform,
  // The embedded broker's bearer token, fetched synchronously so it exists
  // before the SPA's first request. Sync IPC keeps it off the renderer's
  // command line (additionalArguments would leak it to `ps`).
  apiToken: ipcRenderer.sendSync('comfy:get-api-token') as string | null,
  // Boot signal, sent by the web entry just before React mounts, so the shell
  // can show the window at the earliest moment that can't be a blank document.
  signalReady: () => ipcRenderer.send('comfy:renderer-ready'),
})
