import { timingSafeEqual } from 'node:crypto'

import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

import { createConnectorRegistry } from './connectors/index.js'
import type { AppContext } from './context.js'
import { createDb } from './db/client.js'
import { loadEnv, shopifyLiveMode, type Env } from './env.js'
import { createProviderRegistry } from './providers/index.js'
import { registerConnectRoutes } from './routes/connect.js'
import { registerMediaRoutes } from './routes/media.js'
import { registerPipelineRoutes } from './routes/pipeline.js'
import { registerPromptRoutes } from './routes/prompts.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerStoreRoutes } from './routes/stores.js'
import { registerWebRoutes } from './routes/web.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { createAssetStore } from './services/assetStore.js'
import { createAudit } from './services/audit.js'
import { createComfyAuthService } from './services/comfyAuthService.js'
import { createEnrichmentService } from './services/enrichmentService.js'
import { createRunService } from './services/runService.js'
import { createSettingsService } from './services/settingsService.js'
import { createStagingService } from './services/stagingService.js'
import { createStoreService } from './services/storeService.js'
import { seedBuiltinAssets } from './workflows/builtin-assets.js'
import { createWorkflowService } from './workflows/service.js'

export interface BuildAppResult {
  app: FastifyInstance
  ctx: AppContext
}

export async function buildApp(env: Env = loadEnv()): Promise<BuildAppResult> {
  const db = createDb(env.databasePath)
  const audit = createAudit(db)
  const assetStore = createAssetStore(db, env.dataDir)
  // Materialize shipped built-in reference images into a fresh DATA_DIR so
  // built-ins with fixed inputs (e.g. the T-Shirt shoot) can run on install.
  await seedBuiltinAssets(assetStore, env, (m) => console.log(m))
  const connectors = createConnectorRegistry(db, env)
  const settingsService = createSettingsService(db, env)
  const comfyAuth = createComfyAuthService(env, settingsService)
  const providers = createProviderRegistry(env, assetStore, settingsService, comfyAuth)
  const enrichmentService = createEnrichmentService(db)
  const storeService = createStoreService(db, env, connectors, audit, enrichmentService)
  const stagingService = createStagingService(db, env, connectors, storeService, audit, assetStore)
  const workflowService = createWorkflowService(db, env, audit, settingsService)
  // Prime engine node-catalog caches so the first Workflows load doesn't hit a
  // cold compatibility probe — deferred off the boot path: the patient probes
  // JSON.parse multi-MB object_info catalogs on this event loop, which (in the
  // desktop shell) must stay clear while it streams the SPA's first load. 5s
  // is past the first-open window, and the landing route is /connectors, so
  // the Workflows page still finds a warm cache in practice.
  setTimeout(() => workflowService.warmCompat(), 5_000).unref()
  const runService = createRunService(
    db,
    env,
    providers,
    connectors,
    storeService,
    workflowService,
    stagingService,
    audit,
    assetStore,
    enrichmentService,
  )
  // Late binding: disconnect must cancel a store's runs before purging its rows.
  storeService.bindRunService(runService)

  const ctx: AppContext = {
    env,
    db,
    audit,
    assetStore,
    connectors,
    providers,
    enrichmentService,
    settingsService,
    comfyAuth,
    storeService,
    stagingService,
    workflowService,
    runService,
  }

  // Quiet by default: a clean startup banner (see index.ts) plus warnings and
  // errors. Per-request access logs are noise for a local single-operator app —
  // keep them only when explicitly debugging via LOG_LEVEL=debug|trace.
  const logLevel = process.env.LOG_LEVEL ?? 'warn'
  const app = Fastify({
    logger: { level: logLevel },
    disableRequestLogging: !['trace', 'debug'].includes(logLevel),
  })

  // JSON parser that also retains raw bytes — webhook HMACs are computed
  // over the exact payload Shopify sent.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    ;(req as unknown as { rawBody: Buffer }).rawBody = body as Buffer
    const text = (body as Buffer).toString('utf8')
    if (text.length === 0) return done(null, undefined)
    try {
      done(null, JSON.parse(text))
    } catch {
      done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }), undefined)
    }
  })

  await app.register(cors, {
    origin: [env.webOrigin],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  // Reject requests addressed to a foreign Host — the DNS-rebinding guard. A
  // rebound attacker page reaches this port with Host: attacker.example:4000,
  // so anything that is neither loopback nor the configured APP_URL/WEB_ORIGIN
  // host gets a 403 before routing. Reverse-proxied deployments must set
  // APP_URL/WEB_ORIGIN to the public origin (documented in .env.example).
  const allowedHosts = new Set<string>()
  for (const configured of [env.appUrl, env.webOrigin]) {
    try {
      allowedHosts.add(new URL(configured).host)
    } catch {
      /* malformed origin — nothing to allow */
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    let host: URL
    try {
      host = new URL(`http://${request.headers.host ?? ''}`)
    } catch {
      return reply.status(403).send({ error: 'Forbidden host' })
    }
    const loopback =
      host.hostname === 'localhost' || host.hostname === '127.0.0.1' || host.hostname === '[::1]'
    if (loopback || allowedHosts.has(host.host)) return
    return reply.status(403).send({ error: 'Forbidden host' })
  })

  // Optional bearer-token gate for /api/* — off unless BROKER_API_TOKEN is set.
  // The web UI sends the token from its unlock screen (or the desktop shell
  // injects one over IPC); only liveness (/api/health), the HMAC-authed Shopify
  // routes, and read-only asset GETs (headerless <img>/<video> sources) stay
  // exempt. /mock-cdn and static assets are not under /api/ and are never gated.
  if (env.apiToken) {
    const expected = Buffer.from(env.apiToken)
    app.addHook('onRequest', async (request, reply) => {
      const url = (request.raw.url ?? '').split('?')[0] ?? ''
      if (!url.startsWith('/api/')) return
      const read = request.method === 'GET' || request.method === 'HEAD'
      const exempt =
        url === '/api/health' ||
        url === '/api/connect/shopify/callback' ||
        url === '/api/webhooks/shopify' ||
        (read && url.startsWith('/api/assets/'))
      if (exempt) return
      const header = request.headers['authorization']
      const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
      const provided = Buffer.from(token)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return reply.status(401).send({ error: 'Unauthorized' })
      }
    })
  }

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'Invalid request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const { statusCode = 500, message } = err as { statusCode?: number; message?: string }
    if (statusCode >= 500) app.log.error(err)
    return reply.status(statusCode).send({ error: message ?? 'Internal error' })
  })

  // Cheap liveness probe — never hits the network (keep it fast for monitors).
  // authRequired lets the studio detect a token-gated broker and show its
  // unlock screen before the first 401.
  app.get('/api/health', async () => ({
    ok: true,
    name: 'comfy-commerce-broker',
    authRequired: Boolean(env.apiToken),
  }))

  // Richer readiness/diagnostics: pings engines, so treat it as on-demand, not
  // a high-frequency probe. Gated by BROKER_API_TOKEN when one is configured.
  app.get('/api/status', async () => {
    let dbOk = true
    try {
      db.$client.prepare('SELECT 1').get()
    } catch {
      dbOk = false
    }
    return {
      ok: dbOk,
      version: env.version,
      shopifyMode: shopifyLiveMode(env) ? 'live' : 'mock',
      db: { ok: dbOk },
      stores: storeService.list().length,
      providers: await providers.listInfo(),
    }
  })

  registerConnectRoutes(app, ctx)
  registerStoreRoutes(app, ctx)
  registerSettingsRoutes(app, ctx)
  registerPipelineRoutes(app, ctx)
  registerMediaRoutes(app, ctx)
  registerPromptRoutes(app, ctx)
  registerWebhookRoutes(app, ctx)

  // Static web UI + SPA fallback must register LAST so they never shadow an
  // API or media route. Only active in production (env.serveWeb).
  if (env.serveWeb) await registerWebRoutes(app, ctx)

  return { app, ctx }
}
