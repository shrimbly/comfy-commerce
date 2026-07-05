import { randomBytes } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from 'electron'

const isMac = process.platform === 'darwin'

import { buildApp } from '../../server/src/app'
import { loadEnv } from '../../server/src/env'

// One instance only — two would fight over the SQLite DB and the port.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

type Broker = Awaited<ReturnType<typeof buildApp>>
let broker: Broker['app'] | null = null
let ctx: Broker['ctx'] | null = null
let quitting = false

/** Where the built SPA lives: bundled resource when packaged, repo dir in dev. */
function resolveWebDist(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web', 'dist')
    : path.resolve(app.getAppPath(), '..', 'web', 'dist') // desktop/ → repo/web/dist
}

/**
 * Reserve a free loopback port up front. We need the port BEFORE building the
 * broker so APP_URL can be baked into its env: the in-process Shopify connector
 * captures appUrl at construction and uses it to fetch broker-hosted assets
 * (e.g. a freshly generated image) when publishing. With PORT=0 the env's appUrl
 * fell back to http://localhost:0, so publish failed with "fetch failed".
 */
function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/** Boot the Fastify broker in-process on the pre-reserved loopback port. */
async function startBroker(origin: string, port: number, apiToken: string): Promise<void> {
  const env = loadEnv({
    DATA_DIR: app.getPath('userData'), // per-user, persists across updates
    WEB_DIST: resolveWebDist(),
    SERVE_WEB: '1',
    HOST: '127.0.0.1',
    PORT: String(port),
    // The broker must know its own loopback origin so the connector can fetch
    // broker-hosted assets when publishing. 127.0.0.1 (not localhost) avoids a
    // macOS IPv6 ::1-vs-IPv4 listener mismatch.
    APP_URL: origin,
    BROKER_API_TOKEN: apiToken,
    OPEN_BROWSER: '0', // never spawn an external browser
  })
  const built = await buildApp(env)
  broker = built.app
  ctx = built.ctx
  await broker.listen({ port, host: '127.0.0.1' })
  // Warm the provider-availability cache off the window's critical path — the
  // UI's first /api/providers then answers from cache instead of live probes.
  void built.ctx.providers.listInfo().catch(() => {})
}

/**
 * Native-feeling app chrome:
 *  - macOS: a clean menu without the dev-y Reload / DevTools items, but keeping
 *    the standard Edit (copy/paste/undo) and window roles so shortcuts work.
 *  - Windows/Linux: no application menu at all (drops the File/Edit/View bar).
 */
function installAppMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

/**
 * Show once, idempotently. The window shows on whichever lands first: the
 * renderer's pre-mount ready signal ('comfy:renderer-ready'), Chromium's
 * first paint ('ready-to-show'), or the post-load fallback timer — so a
 * renderer error can never leave the window hidden.
 */
function showWindow(win: BrowserWindow): void {
  if (!win.isDestroyed() && !win.isVisible()) win.show()
}

/** Point a window at the (now listening) broker, arming the show fallback. */
function loadStudio(win: BrowserWindow, origin: string): void {
  void win.loadURL(origin)
  setTimeout(() => showWindow(win), 2_000)
}

function createWindow(origin: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: 'Comfy Commerce',
    // Match the app's canvas (same fallback logic as index.html's theme
    // script), so any compositor gap shows canvas-colored — not a
    // maximum-contrast near-black flash behind a light UI.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171c' : '#f9f8f5',
    show: false,
    autoHideMenuBar: true, // belt-and-suspenders on Windows; no-op on macOS
    // macOS: hide the title bar so a full-width drag strip (rendered by the web
    // app above the sidebar) can host the inlaid traffic lights, for a native,
    // chrome-light feel. Windows keeps its native frame.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => showWindow(win))

  const sameOrigin = (url: string): boolean => {
    try {
      return new URL(url).origin === new URL(origin).origin
    } catch {
      return false
    }
  }
  // Only hand http(s) URLs to the OS — file://, smb://, ms-msdt:// etc. can
  // launch local protocol handlers on attacker-chosen targets. Malformed or
  // non-web URLs are silently dropped.
  const openExternalSafely = (url: string): void => {
    let protocol: string
    try {
      protocol = new URL(url).protocol
    } catch {
      return
    }
    if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
  }
  // Keep in-app navigation inside the broker origin; send the rest to the OS browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url)) {
      event.preventDefault()
      openExternalSafely(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: 'allow' }
    openExternalSafely(url)
    return { action: 'deny' }
  })

  return win
}

app
  .whenReady()
  .then(async () => {
    installAppMenu()

    // The embedded broker is always token-gated: an explicit BROKER_API_TOKEN
    // is honored (intentional headless use), otherwise a fresh random token
    // per launch. The renderer gets it over sync IPC (see preload.ts) —
    // deliberately NOT webPreferences.additionalArguments, which lands on the
    // renderer's OS command line where `ps` would leak it to exactly the local
    // processes the token defends against. Registered before any window exists
    // so the preload's sendSync can never race the handler.
    const apiToken = process.env.BROKER_API_TOKEN?.trim() || randomBytes(32).toString('hex')
    ipcMain.on('comfy:get-api-token', (event) => {
      event.returnValue = apiToken
    })
    // Sent by the web entry just before React mounts (see preload.ts) — the
    // earliest moment showing the window cannot reveal a blank document.
    ipcMain.on('comfy:renderer-ready', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) showWindow(win)
    })

    const port = await reserveLoopbackPort()
    const origin = `http://127.0.0.1:${port}`

    // Create the hidden window BEFORE booting the broker: Chromium's
    // renderer/GPU process spawn (hundreds of ms) then overlaps DB creation,
    // asset seeding, and service construction instead of queueing behind them.
    const win = createWindow(origin)
    await startBroker(origin, port, apiToken)
    loadStudio(win, origin)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) loadStudio(createWindow(origin), origin)
    })
  })
  .catch((err: unknown) => {
    console.error('Failed to start Comfy Commerce:', err)
    app.quit()
  })

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Mirror the broker's clean shutdown (server/src/index.ts): stop accepting
// connections, abort in-flight runs, checkpoint + close the SQLite handle.
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void (async () => {
    try {
      ctx?.runService.shutdown()
      await broker?.close()
      ctx?.db.$client.close()
    } catch (err) {
      console.error('Shutdown error:', err)
    }
    app.exit(0)
  })()
})
