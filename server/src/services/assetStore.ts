import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { assets } from '../db/schema.js'

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'model/gltf-binary': 'glb',
  'model/vnd.usdz+zip': 'usdz',
}

/**
 * Local custody for edited-image bytes (provider outputs). Files live under
 * DATA_DIR/assets and are served at /api/assets/:id.
 */
export function createAssetStore(db: Db, dataDir: string) {
  const assetsDir = path.join(dataDir, 'assets')
  const findRow = (id: string) => db.select().from(assets).where(eq(assets.id, id)).get()

  return {
    async save(bytes: Buffer, contentType: string): Promise<{ id: string; url: string }> {
      const id = randomUUID()
      const ext = EXT_BY_TYPE[contentType] ?? 'bin'
      const filename = `${id}.${ext}`
      await fs.mkdir(assetsDir, { recursive: true })
      await fs.writeFile(path.join(assetsDir, filename), bytes)
      db.insert(assets)
        .values({ id, contentType, filename, createdAt: new Date().toISOString() })
        .run()
      return { id, url: `/api/assets/${id}` }
    },

    /**
     * Register a KNOWN asset id with its bytes if it isn't stored yet — used to
     * seed shipped built-in reference images into a fresh DATA_DIR. Idempotent:
     * a no-op once the asset exists, so it's safe to run on every boot.
     */
    async seed(id: string, bytes: Buffer, contentType: string): Promise<void> {
      if (findRow(id)) return
      const ext = EXT_BY_TYPE[contentType] ?? 'bin'
      const filename = `${id}.${ext}`
      await fs.mkdir(assetsDir, { recursive: true })
      await fs.writeFile(path.join(assetsDir, filename), bytes)
      db.insert(assets)
        .values({ id, contentType, filename, createdAt: new Date().toISOString() })
        .run()
    },

    get(id: string): { filename: string; contentType: string; path: string } | null {
      const row = findRow(id)
      if (!row) return null
      return {
        filename: row.filename,
        contentType: row.contentType,
        path: path.join(assetsDir, row.filename),
      }
    },

    /** Load an asset's bytes — used to feed fixed reference images to engines. */
    async read(
      id: string,
    ): Promise<{ bytes: Buffer; contentType: string; filename: string } | null> {
      const row = findRow(id)
      if (!row) return null
      const bytes = await fs.readFile(path.join(assetsDir, row.filename))
      return { bytes, contentType: row.contentType, filename: row.filename }
    },
  }
}

export type AssetStore = ReturnType<typeof createAssetStore>
