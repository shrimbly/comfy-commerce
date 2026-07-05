import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Env {
  port: number
  host: string
  dataDir: string
  databasePath: string
  /** Public base URL of this broker (OAuth callback + asset URLs in real mode). */
  appUrl: string
  /** Origin of the web UI, for CORS + post-OAuth redirect. */
  webOrigin: string
  /** When true, the broker serves the built web UI (web/dist) same-origin. */
  serveWeb: boolean
  /** Explicit path to the built web UI; auto-probed when null. */
  webDist: string | null
  /** Broker version, surfaced by GET /api/status. */
  version: string
  /** Optional bearer token gating /api/* for non-web callers (null = open). */
  apiToken: string | null
  /** Max concurrent runs executing at once. */
  runConcurrency: number
  /** Attempts per run item before it's marked failed (1 = no retry). */
  runItemMaxAttempts: number
  /** Base backoff between item retries, in ms (grows exponentially). */
  runItemRetryBaseMs: number
  /** Body-size ceiling for workflow graph uploads, in bytes. */
  workflowBodyLimit: number
  /** Grace period before a shutdown force-exits, in ms. */
  shutdownTimeoutMs: number
  shopify: {
    apiKey: string | null
    apiSecret: string | null
    scopes: string
    apiVersion: string
    /** Ceiling for awaiting image media ingestion readiness, in ms. */
    mediaReadyTimeoutMs: number
    /** Ceiling for awaiting video media ingestion (transcoding is slow), in ms. */
    mediaReadyVideoTimeoutMs: number
  }
  comfyLocalUrl: string
  /**
   * Job-completion ceiling for the local/remote ComfyUI engines, in ms (how
   * long to keep polling /history). On timeout the engine is interrupted so a
   * retry can't stack a duplicate job. Mirrors comfyCloud.jobTimeoutMs.
   */
  comfyJobTimeoutMs: number
  /**
   * Optional seed for the Remote ComfyUI engine's URL. The live value is stored
   * in the DB (editable from the Connectors page); this only provides a default
   * when the DB value is unset — handy for headless / scripted setups.
   */
  comfyRemoteUrl: string | null
  comfyCloud: {
    apiUrl: string
    apiKey: string | null
    /** How long to keep polling a cloud job for completion, in ms. */
    jobTimeoutMs: number
  }
  tokenEncryptionKey: Buffer
}

/**
 * Token-encryption key: from TOKEN_ENCRYPTION_KEY (64 hex chars) if provided,
 * otherwise auto-generated once and persisted to DATA_DIR/secret.key so
 * self-hosted setups work with zero configuration.
 */
function resolveEncryptionKey(dataDir: string): Buffer {
  const fromEnv = process.env.TOKEN_ENCRYPTION_KEY
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'hex')
    if (key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
    }
    return key
  }
  const keyPath = path.join(dataDir, 'secret.key')
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex')
  }
  const key = randomBytes(32)
  writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 })
  return key
}

/** Load `.env` from the server dir or the repo root (real env vars win). */
function loadDotenvFile(): void {
  if (process.env.VITEST) return // tests must never inherit live credentials
  for (const candidate of ['.env', '../.env']) {
    const file = path.resolve(candidate)
    if (!existsSync(file)) continue
    try {
      process.loadEnvFile(file)
    } catch {
      // best effort — a malformed .env should not prevent startup
    }
    return
  }
}

/** Drop a single trailing slash so URL origins concatenate predictably. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}

export function loadEnv(overrides: Partial<Record<string, string>> = {}): Env {
  loadDotenvFile()
  const get = (name: string, fallback?: string) =>
    overrides[name] ?? process.env[name] ?? fallback

  const dataDir = path.resolve(get('DATA_DIR', './data')!)
  mkdirSync(path.join(dataDir, 'assets'), { recursive: true })

  const port = Number(get('PORT', '4000'))
  const selfOrigin = `http://localhost:${port}`
  // Production mode: the broker also serves the built web UI same-origin.
  const serveWeb = get('SERVE_WEB', '0') === '1' || get('NODE_ENV') === 'production'
  // Dev: the web UI is served by Vite on its own port. The root `pnpm dev` pins
  // WEB_PORT so this origin matches the real Vite port — CORS, the post-OAuth
  // redirect, and the startup banner all depend on it being correct.
  const webDevOrigin = `http://localhost:${get('WEB_PORT', '5173')}`
  const comfyRemoteSeed = get('COMFY_REMOTE_URL')?.trim()

  return {
    port,
    host: get('HOST', '127.0.0.1')!,
    dataDir,
    databasePath: get('DATABASE_PATH', path.join(dataDir, 'comfy-commerce.sqlite'))!,
    appUrl: trimTrailingSlash(get('APP_URL', selfOrigin)!),
    // Same-origin in prod (UI served by the broker) → CORS is a no-op and OAuth
    // redirects land back on the SPA. Dev keeps the Vite dev-server origin.
    webOrigin: trimTrailingSlash(get('WEB_ORIGIN', serveWeb ? selfOrigin : webDevOrigin)!),
    serveWeb,
    webDist: get('WEB_DIST') ?? null,
    version: get('npm_package_version', '0.1.0')!,
    apiToken: get('BROKER_API_TOKEN')?.trim() || null,
    runConcurrency: Math.max(1, Number(get('RUN_CONCURRENCY', '2'))),
    runItemMaxAttempts: Math.max(1, Number(get('RUN_ITEM_MAX_ATTEMPTS', '3'))),
    runItemRetryBaseMs: Math.max(0, Number(get('RUN_ITEM_RETRY_BASE_MS', '1500'))),
    workflowBodyLimit: Number(get('WORKFLOW_BODY_LIMIT', String(10 * 1024 * 1024))),
    shutdownTimeoutMs: Number(get('SHUTDOWN_TIMEOUT_MS', '10000')),
    shopify: {
      apiKey: get('SHOPIFY_API_KEY') ?? null,
      apiSecret: get('SHOPIFY_API_SECRET') ?? null,
      scopes: get('SHOPIFY_SCOPES', 'read_products,write_products,write_files')!,
      apiVersion: get('SHOPIFY_API_VERSION', '2026-01')!,
      mediaReadyTimeoutMs: Number(get('SHOPIFY_MEDIA_READY_TIMEOUT_MS', '60000')),
      mediaReadyVideoTimeoutMs: Number(get('SHOPIFY_MEDIA_READY_VIDEO_TIMEOUT_MS', '300000')),
    },
    comfyLocalUrl: trimTrailingSlash(get('COMFY_LOCAL_URL', 'http://127.0.0.1:8188')!),
    // 15 min default — raise for long video / large diffusion jobs. 60s floor.
    comfyJobTimeoutMs: Math.max(60_000, Number(get('COMFY_JOB_TIMEOUT_MS', '900000'))),
    comfyRemoteUrl: comfyRemoteSeed ? trimTrailingSlash(comfyRemoteSeed) : null,
    comfyCloud: {
      apiUrl: trimTrailingSlash(get('COMFY_CLOUD_API_URL', 'https://cloud.comfy.org')!),
      apiKey: get('COMFY_CLOUD_API_KEY') ?? null,
      // 15 min default — raise for long video / large diffusion jobs.
      jobTimeoutMs: Math.max(60_000, Number(get('COMFY_CLOUD_JOB_TIMEOUT_MS', '900000'))),
    },
    tokenEncryptionKey: resolveEncryptionKey(dataDir),
  }
}

/** Real Shopify OAuth is available only when app credentials are configured. */
export function shopifyLiveMode(env: Env): boolean {
  return Boolean(env.shopify.apiKey && env.shopify.apiSecret)
}
