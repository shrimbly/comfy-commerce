// Bundles the Electron main + preload (and the broker they import) into CJS.
// Everything is inlined EXCEPT electron and the two native addons, which stay
// external and are resolved from node_modules at runtime.
import { build, context } from 'esbuild'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

// The broker source uses TS-NodeNext '.js' import specifiers that actually point
// at '.ts' files. esbuild won't remap those, so rewrite relative '*.js' → '*.ts'
// when the '.ts' exists (otherwise fall through to default resolution).
const jsToTsPlugin = {
  name: 'js-to-ts',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith('.')) return
      const candidate = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
      return existsSync(candidate) ? { path: candidate } : undefined
    })
  },
}

// Electron + the native addons are resolved at runtime from node_modules.
const shared = {
  outdir: path.join(root, 'out'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22', // Electron 41 ships Node 22
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', 'better-sqlite3', '@resvg/resvg-js'],
  plugins: [jsToTsPlugin],
}

// Main process: the broker uses `import.meta.url` (e.g. routes/web.ts
// resolveWebDist), which is empty under CJS. Map it to a valid file:// URL of the
// bundle so fileURLToPath() doesn't throw. (We also override WEB_DIST, so the
// resolved path is unused anyway.) This banner references __filename — fine in
// the full-Node main process.
const mainOptions = {
  ...shared,
  entryPoints: { main: path.join(root, 'src/main.ts') },
  banner: { js: "const __bundleMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__bundleMetaUrl' },
}

// Preload runs in Electron's SANDBOX, where __filename / the Node module wrapper
// don't exist — so it gets NO banner/define (the main banner's __filename ref is
// what crashed the preload with "ReferenceError: __filename is not defined").
// It only needs contextBridge from electron.
const preloadOptions = {
  ...shared,
  entryPoints: { preload: path.join(root, 'src/preload.ts') },
}

if (watch) {
  const ctxs = await Promise.all([context(mainOptions), context(preloadOptions)])
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('esbuild: watching…')
} else {
  await Promise.all([build(mainOptions), build(preloadOptions)])
  console.log('esbuild: built out/main.cjs + out/preload.cjs')
}
