import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildApp, type BuildAppResult } from '../src/app.js'
import { mockCatalogs } from '../src/db/schema.js'
import { loadEnv } from '../src/env.js'
import type { EditRequest } from '../src/providers/types.js'

const json = (res: { payload: string }) => JSON.parse(res.payload)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let open: (BuildAppResult & { tmpDir: string }) | null = null

afterEach(async () => {
  if (open) {
    await open.app.close()
    rmSync(open.tmpDir, { recursive: true, force: true })
    open = null
  }
})

describe('disconnect while a run is mid-flight (finding #7)', { timeout: 30_000 }, () => {
  it('cancels the executor before purging — no stray edits, no catalog resurrection', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'comfy-commerce-disc-'))
    process.env.LOG_LEVEL = 'silent'
    const env = loadEnv({
      DATA_DIR: tmpDir,
      PORT: '0',
      RUN_CONCURRENCY: '1',
      SHOPIFY_API_KEY: undefined as unknown as string,
      COMFY_LOCAL_URL: 'http://127.0.0.1:1',
      COMFY_CLOUD_API_KEY: undefined as unknown as string,
    })
    const { app, ctx } = await buildApp(env)
    await app.ready()
    open = { app, ctx, tmpDir }

    const connect = json(
      await app.inject({ method: 'POST', url: '/api/connect/shopify', payload: { shop: 'disc-demo' } }),
    )
    const storeId = connect.store.id as string
    // Materialize the catalog so the run has plenty of items to chew through.
    await app.inject({ method: 'GET', url: `/api/stores/${storeId}/catalog` })

    // Count provider edits — the executor calls this once per item.
    const provider = ctx.providers.get('mock')
    const realEdit = provider.edit.bind(provider)
    let edits = 0
    provider.edit = async (req: EditRequest) => {
      edits += 1
      return realEdit(req)
    }

    const { run } = json(
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          storeId,
          workflowId: 'builtin:fit-to-768px',
          providerId: 'mock',
          params: {},
          target: { kind: 'catalog' },
        },
      }),
    )
    // Let it get genuinely mid-flight (mock edits take 250–750ms each).
    for (let i = 0; i < 100 && edits === 0; i++) await sleep(50)
    expect(ctx.runService.get(run.id)?.state).toBe('running')
    expect(edits).toBeGreaterThan(0)

    const del = await app.inject({ method: 'DELETE', url: `/api/stores/${storeId}` })
    expect(del.statusCode).toBe(200)
    const editsAtDelete = edits

    // The old behavior kept editing every remaining catalog item after the
    // purge; now at most the single in-flight item can straggle through.
    await sleep(1500)
    expect(edits - editsAtDelete).toBeLessThanOrEqual(1)

    // Everything scoped to the store is gone — and STAYS gone: the executor's
    // missing-row stop signal means no late loop iteration touches the DB.
    const runsAfter = json(await app.inject({ method: 'GET', url: `/api/runs?storeId=${storeId}` }))
    expect(runsAfter.runs).toHaveLength(0)
    const stagingAfter = json(
      await app.inject({ method: 'GET', url: `/api/staging?storeId=${storeId}` }),
    )
    expect(stagingAfter.items).toHaveLength(0)

    // The resurrection guard: MockConnector.load lazily re-INSERTs the demo
    // catalog on any read — a post-purge executor used to bring it back.
    const catalogRows = ctx.db.select().from(mockCatalogs).all()
    expect(catalogRows.some((r) => r.storeId === storeId)).toBe(false)
  })
})
