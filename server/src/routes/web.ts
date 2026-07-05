import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

import type { AppContext } from '../context.js'

/**
 * Serve the built web UI (web/dist) same-origin in production, with an SPA
 * deep-link fallback. Only registered when env.serveWeb is true; in dev the
 * Vite dev server serves the UI and proxies /api to the broker instead.
 */
export async function registerWebRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const dist = resolveWebDist(ctx.env.webDist)
  if (!dist) {
    throw new Error(
      'SERVE_WEB is on but the built web UI was not found. Run `pnpm build` first, or point WEB_DIST at web/dist.',
    )
  }

  await app.register(fastifyStatic, {
    root: dist,
    index: false, // index.html is served via the SPA fallback below
    wildcard: false, // do NOT install a GET /* catch-all — it would shadow /api/*
    cacheControl: false, // caching is set per-asset in setHeaders
    setHeaders(res, filePath) {
      // Hashed bundles (/assets/*) never change; index.html must always re-validate.
      res.setHeader(
        'Cache-Control',
        filePath.endsWith(`${path.sep}index.html`)
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      )
    },
  })

  // SPA fallback: client-routed paths (/activity, /review, page refreshes) resolve to
  // index.html. /api/* and /mock-cdn/* are real registered routes and never reach
  // here; the prefix guard keeps a mistyped API path a JSON 404 rather than HTML.
  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? ''
    const readMethod = request.method === 'GET' || request.method === 'HEAD'
    if (!readMethod || url.startsWith('/api/') || url.startsWith('/mock-cdn/')) {
      return reply.status(404).send({ error: 'Not found' })
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html')
  })
}

/**
 * Locate web/dist. Works whether the broker is run via tsx (from server/src) or
 * from any cwd; an explicit WEB_DIST override wins. Returns null if not found so
 * the caller can fail fast with a clear message.
 */
function resolveWebDist(override: string | null): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    override,
    path.resolve(here, '../../../web/dist'), // server/src/routes → repo/web/dist
    path.resolve(process.cwd(), 'web/dist'), // started from the repo root
    path.resolve(process.cwd(), '../web/dist'), // started from server/
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => existsSync(path.join(candidate, 'index.html'))) ?? null
}
