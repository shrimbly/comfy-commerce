import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Env } from '../env.js'
import type { AssetStore } from '../services/assetStore.js'
import { BUILTIN_WORKFLOWS } from './builtins.js'

/**
 * Built-in workflows can reference fixed images (e.g. the T-Shirt shoot's model
 * + scene). Their bytes ship in web/public/builtins/assets/<assetId>.<ext> (built
 * into web/dist and bundled with the desktop app), keyed by the SAME asset id the
 * baked graph's fixedInputs point at. A fresh DATA_DIR has neither the row nor the
 * file, so without seeding `assetStore.read` returns null and the run fails with
 * "Fixed reference image … is missing". This seeds them once, on boot.
 */

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** Locate the shipped built-in assets dir across dev / prod / packaged layouts. */
function resolveAssetsDir(env: Env): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    env.webDist ? path.join(env.webDist, 'builtins', 'assets') : null, // desktop: WEB_DIST resource
    path.resolve(here, '../../../web/dist/builtins/assets'), //  built from source
    path.resolve(here, '../../../web/public/builtins/assets'), // dev source of truth
    path.resolve(process.cwd(), 'web/dist/builtins/assets'),
    path.resolve(process.cwd(), 'web/public/builtins/assets'),
    path.resolve(process.cwd(), '../web/dist/builtins/assets'),
    path.resolve(process.cwd(), '../web/public/builtins/assets'),
  ].filter((c): c is string => Boolean(c))
  return candidates.find((c) => existsSync(c)) ?? null
}

/** Seed any missing built-in fixed-reference images into the asset store. */
export async function seedBuiltinAssets(
  assetStore: AssetStore,
  env: Env,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const ids = new Set<string>()
  for (const wf of BUILTIN_WORKFLOWS) {
    for (const fixed of wf.fixedInputs ?? []) ids.add(fixed.assetId)
  }
  const missing = [...ids].filter((id) => !assetStore.get(id))
  if (missing.length === 0) return

  const dir = resolveAssetsDir(env)
  if (!dir) {
    log(`[builtin-assets] ${missing.length} reference image(s) missing but no assets dir was found`)
    return
  }
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  for (const id of missing) {
    const file = entries.find((f) => f.startsWith(`${id}.`))
    if (!file) {
      log(`[builtin-assets] no shipped file for ${id} in ${dir}`)
      continue
    }
    const ext = path.extname(file).slice(1).toLowerCase()
    const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream'
    const bytes = await fs.readFile(path.join(dir, file))
    await assetStore.seed(id, bytes, contentType)
    log(`[builtin-assets] seeded ${file} (${bytes.length} bytes)`)
  }
}
