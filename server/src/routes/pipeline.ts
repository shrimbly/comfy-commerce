import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { AppContext } from '../context.js'

const idsBody = z.object({ ids: z.array(z.string()).min(1) })

const workflowParamSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['text', 'select', 'number']),
  nodeId: z.string().optional(),
  inputKey: z.string().optional(),
  defaultValue: z.string().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
})

const fixedInputSchema = z.object({
  nodeId: z.string(),
  assetId: z.string().min(1),
  label: z.string().optional(),
})

const saveWorkflowBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  graph: z.unknown(),
  inputNodeId: z.string().optional(),
  outputNodeId: z.string().optional(),
  params: z.array(workflowParamSchema).optional(),
  fixedInputs: z.array(fixedInputSchema).optional(),
})

const runTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('selection'),
    inputs: z.array(z.object({ productId: z.string(), mediaId: z.string() })).min(1),
  }),
  z.object({ kind: z.literal('products'), productIds: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('catalog') }),
])

const createRunBody = z.object({
  storeId: z.string(),
  workflowId: z.string(),
  providerId: z.enum(['mock', 'comfy-local', 'comfy-remote', 'comfy-cloud']),
  params: z.record(z.string(), z.string()).default({}),
  target: runTargetSchema,
  stageAction: z.enum(['add-featured', 'replace-position', 'add-new']).default('add-new'),
  sampleSize: z.number().int().min(1).max(50).optional(),
})

const stageBody = z.object({
  storeId: z.string(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        mediaId: z.string(),
        afterUrl: z.string(),
        action: z.enum(['add-featured', 'replace-position', 'add-new']),
        mediaType: z.enum(['image', 'video', 'model3d']).optional(),
        variantTitle: z.string().nullable().optional(),
        recipeId: z.string().nullable().optional(),
      }),
    )
    .min(1),
})

const arrangementBody = z.object({
  storeId: z.string(),
  productId: z.string(),
  order: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('media'), mediaId: z.string() }),
      z.object({ kind: z.literal('staged'), itemId: z.string() }),
    ]),
  ),
})

const galleryRefBody = z.object({ storeId: z.string(), productId: z.string() })

/** Is this call coming from the web UI or a headless/API client? */
function callSource(request: { headers: Record<string, unknown> }): 'ui' | 'api' {
  return request.headers['x-comfy-commerce-client'] === 'web' ? 'ui' : 'api'
}

/**
 * Workflows + runs + staging — these ARE the headless API: the web UI calls
 * exactly the same operations. Staged items always enter `pending`; runs
 * never publish anything.
 */
export function registerPipelineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { env, workflowService, runService, providers, stagingService, audit } = ctx

  // ComfyUI graphs (especially flattened subgraphs) can exceed Fastify's 1 MB
  // default; both routes that accept a raw graph share a larger ceiling.
  const graphRoute = { bodyLimit: env.workflowBodyLimit }

  /* ── workflows ─────────────────────────────────────────────── */

  app.get('/api/workflows', async () => ({ workflows: await workflowService.list() }))

  app.get('/api/workflows/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { filename, json } = await workflowService.downloadGraph(id)
    return reply
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .type('application/json')
      .send(json)
  })

  app.post('/api/workflows/inspect', graphRoute, async (request) => {
    const { graph } = z.object({ graph: z.unknown() }).parse(request.body)
    return workflowService.inspect(graph)
  })

  app.post('/api/workflows', graphRoute, async (request, reply) => {
    const body = saveWorkflowBody.parse(request.body)
    const workflow = await workflowService.save(body)
    return reply.status(201).send({ workflow })
  })

  app.patch('/api/workflows/:id', async (request) => {
    const { id } = request.params as { id: string }
    const patch = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        imageAssetId: z.string().nullable().optional(),
        compareImageAssetId: z.string().nullable().optional(),
        fixedInputs: z.array(fixedInputSchema).optional(),
      })
      .parse(request.body)
    return { workflow: await workflowService.update(id, patch) }
  })

  app.delete('/api/workflows/:id', async (request) => {
    const { id } = request.params as { id: string }
    workflowService.delete(id)
    return { ok: true }
  })

  /* ── providers ─────────────────────────────────────────────── */

  app.get('/api/providers', async () => ({ providers: await providers.listInfo() }))

  /* ── runs ──────────────────────────────────────────────────── */

  app.post('/api/runs/estimate', async (request) => {
    const { storeId, target } = z
      .object({ storeId: z.string(), target: runTargetSchema })
      .parse(request.body)
    return runService.estimate(storeId, target)
  })

  app.post('/api/runs', async (request, reply) => {
    const body = createRunBody.parse(request.body)
    const run = await runService.create({ ...body, source: callSource(request) })
    return reply.status(202).send({ run })
  })

  app.get('/api/runs', async (request) => {
    const { storeId } = request.query as { storeId?: string }
    return { runs: runService.list(storeId) }
  })

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const run = runService.get(id)
    if (!run) return reply.status(404).send({ error: 'Run not found' })
    return { run }
  })

  app.post('/api/runs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string }
    return { run: runService.cancel(id) }
  })

  app.post('/api/runs/:id/skip-current', async (request) => {
    const { id } = request.params as { id: string }
    return { run: runService.skipCurrent(id) }
  })

  app.post('/api/runs/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string }
    const run = runService.retry(id)
    return reply.status(202).send({ run })
  })

  app.post('/api/runs/:id/promote', async (request, reply) => {
    const { id } = request.params as { id: string }
    const run = await runService.promote(id)
    return reply.status(202).send({ run })
  })

  app.delete('/api/runs/:id', async (request) => {
    const { id } = request.params as { id: string }
    runService.remove(id)
    return { ok: true }
  })

  /* ── staging (the gate) ────────────────────────────────────── */

  app.get('/api/staging', async (request) => {
    const { storeId } = request.query as { storeId?: string }
    return stagingService.list(storeId)
  })

  app.post('/api/staging', async (request, reply) => {
    const body = stageBody.parse(request.body)
    const items = await stagingService.stage(
      body.items.map((item) => ({ ...item, storeId: body.storeId, source: callSource(request) })),
    )
    return reply.status(201).send({ items })
  })

  app.post('/api/staging/approve', async (request) => {
    const { ids } = idsBody.parse(request.body)
    return { results: stagingService.approve(ids) }
  })

  app.post('/api/staging/reject', async (request) => {
    const { ids } = idsBody.parse(request.body)
    return { results: stagingService.reject(ids) }
  })

  app.post('/api/staging/publish', async (request) => {
    const { ids } = idsBody.parse(request.body)
    return { results: await stagingService.publish(ids) }
  })

  app.post('/api/staging/revert', async (request) => {
    const { ids } = idsBody.parse(request.body)
    return { results: await stagingService.revert(ids) }
  })

  app.get('/api/staging/gallery', async (request) => {
    const { storeId, productId } = request.query as { storeId?: string; productId?: string }
    if (!storeId || !productId) {
      throw Object.assign(new Error('storeId and productId are required'), { statusCode: 400 })
    }
    return stagingService.galleryEditor(storeId, productId)
  })

  app.post('/api/staging/arrangement', async (request) => {
    const body = arrangementBody.parse(request.body)
    return { arrangement: stagingService.saveArrangement(body) }
  })

  app.post('/api/staging/publish-gallery', async (request) => {
    const { storeId, productId } = galleryRefBody.parse(request.body)
    return stagingService.publishGallery(storeId, productId)
  })

  app.get('/api/audit', async (request) => {
    const { storeId } = request.query as { storeId?: string }
    return { entries: audit.list(storeId) }
  })
}
