// electron-builder afterPack hook: swap better-sqlite3's native binary for the
// Electron-ABI prebuild.
//
// We keep `npmRebuild: false` so the repo's pnpm store copy (Node ABI, used by
// `pnpm test`) is NEVER rebuilt/corrupted. electron-builder copies that Node-ABI
// binary into the app; here we overwrite it with the matching Electron prebuild
// from better-sqlite3's GitHub releases.
//
// The prebuild is downloaded per target platform/arch, so this also lets us build
// the Windows app from macOS — no compiler / Xcode CLT needed on any host.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')

const BSQLITE_VERSION = '12.10.0'
const ELECTRON_ABI = 145 // electron 41.x → NODE_MODULE_VERSION 145 (has prebuilds)

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (current, redirects) => {
      https
        .get(current, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects > 5) return reject(new Error('too many redirects'))
            res.resume()
            return go(res.headers.location, redirects + 1)
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${current}`))
          const out = fs.createWriteStream(dest)
          res.pipe(out)
          out.on('finish', () => out.close(() => resolve()))
          out.on('error', reject)
        })
        .on('error', reject)
    }
    go(url, 0)
  })
}

exports.default = async function afterPack(context) {
  const { Arch } = require('electron-builder')
  const platform = context.electronPlatformName // 'darwin' | 'win32' | 'linux'
  const arch = Arch[context.arch] // 'x64' | 'arm64' | 'ia32'

  const asset = `better-sqlite3-v${BSQLITE_VERSION}-electron-v${ELECTRON_ABI}-${platform}-${arch}.tar.gz`
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BSQLITE_VERSION}/${asset}`

  const resourcesDir =
    platform === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
  const dest = path.join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  )

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsq-'))
  const tarball = path.join(tmpDir, asset)
  console.log(`[afterPack] downloading ${asset}`)
  await download(url, tarball)
  execFileSync('tar', ['-xzf', tarball, '-C', tmpDir])

  const built = [
    path.join(tmpDir, 'build', 'Release', 'better_sqlite3.node'),
    path.join(tmpDir, 'Release', 'better_sqlite3.node'),
  ].find((candidate) => fs.existsSync(candidate))
  if (!built) throw new Error(`better_sqlite3.node not found inside ${asset}`)

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(built, dest)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log(`[afterPack] swapped better-sqlite3 → electron-v${ELECTRON_ABI} ${platform}-${arch}`)
}
