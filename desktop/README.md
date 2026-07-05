# @comfy-commerce/desktop

The Comfy Commerce desktop app — an Electron shell that runs the existing Fastify
broker **in its main process** and points a native window at it. No changes to
`server/` or `web/`: the broker serves the API + built SPA over loopback exactly
like `pnpm start`, and Electron loads that URL.

## How it works

- **Main process** (`src/main.ts`) boots the broker with `buildApp(loadEnv({…}))`,
  binding it to `127.0.0.1` on an OS-assigned port, with `DATA_DIR` pointed at the
  per-user app-data dir. It opens a `BrowserWindow` at the broker URL
  (`contextIsolation`, `sandbox`, no `nodeIntegration`).
- **Bundle** (`esbuild.mjs`) inlines the main, preload, and the whole broker
  (fastify, drizzle, `@comfy-commerce/shared`, …) into `out/*.cjs`. Only `electron`
  and the two native addons stay external. A small plugin remaps the broker's
  TS-NodeNext `.js` import specifiers to `.ts` so esbuild can resolve them.
- **Native modules** — `better-sqlite3` (NAN, ABI-specific) and `@resvg/resvg-js`
  (N-API). We do **not** rebuild in place (`npmRebuild: false`) — that would compile
  better-sqlite3 against the Electron ABI inside the shared pnpm store and break the
  Node-ABI copy `pnpm test` uses. Instead `scripts/after-pack.cjs` downloads the
  matching **prebuilt** better-sqlite3 `.node` for the target platform/arch and swaps
  it into the packaged app. Electron is pinned to **41.x** because that's the latest
  line with a published better-sqlite3 prebuild (ABI 145) — so no Xcode CLT / compiler
  is needed on any build host.

## Build & run

```bash
# from the repo root
pnpm install

# build a macOS app (.dmg + .zip in desktop/dist)
pnpm --filter @comfy-commerce/desktop dist:mac

# unpacked .app only (faster, for testing)
pnpm --filter @comfy-commerce/desktop exec electron-builder --mac --dir
open "desktop/dist/mac-arm64/Comfy Commerce.app"
```

`dist:mac` runs: build the web UI → esbuild the broker bundle → electron-builder
(packages, swaps the native binary, signs with a local Developer ID if present).

Data (SQLite DB, `secret.key`, generated assets) lives in the OS app-data dir,
e.g. `~/Library/Application Support/Comfy Commerce` on macOS — it persists across
app updates.

## Status / TODO

- ✅ macOS: builds, runs, better-sqlite3 + the broker work end-to-end.
- ⏳ Windows: config is in place (`win: nsis`); the afterPack swap downloads the
  win prebuild, so it can be built from CI (`windows-latest`) — the resvg win binary
  still needs declaring for that target.
- ⏳ Signing/notarization + auto-update: out of scope for this first pass.
