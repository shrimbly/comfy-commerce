/**
 * Bridge from our `GenerationProvider` contract to **`@comfyorg/sdk`** — the
 * official TypeScript client for the Comfy API **v2** (`/api/v2/jobs`,
 * `/api/v2/assets`).
 *
 * The SDK owns everything the provider used to hand-roll: content-addressed
 * asset upload (local blake3 + server-side dedup, so re-running a workflow
 * re-uploads nothing), idempotent submit with `queue_full` backoff, adaptive
 * poll-to-terminal, range-aware output download, and typed errors. What lives
 * here is only the glue our domain needs — client construction against a
 * configured base URL, output → `StagedMediaType` mapping, and error messages
 * shaped for `isRetryableRunError` in the run service.
 *
 * Scope note: this is the v2 surface only (Comfy Cloud, serverless, or a
 * self-hosted ComfyUI behind `comfy-api-proxy`). A raw ComfyUI on :8188 speaks
 * the classic `/prompt` + `/history` API and stays on `comfyHttp.ts`.
 */

import type { StagedMediaType } from '@comfy-commerce/shared'
import {
  BASE_URL_ENV_VAR,
  Comfy,
  ComfyError,
  Forbidden,
  InsufficientCredits,
  JobFailed,
  NotFound,
  Unauthorized,
  type Job,
  type Output,
} from '@comfyorg/sdk'

import { mimeForFilename } from './comfyHttp.js'

/** Attributes our traffic in Comfy's request logs (`User-Agent: … app/…`). */
const CLIENT_INFO = 'comfy-commerce'

/** Terminal job state meaning the graph ran to completion. */
export const SUCCEEDED = 'succeeded'

export interface ComfyClientOptions {
  /** Deployment root, e.g. `https://cloud.comfy.org`. */
  baseUrl: string
  /** Bearer key; omit for a self-hosted proxy, which needs none. */
  apiKey?: string | null | undefined
  /** Per-request timeout (NOT the job ceiling — jobs are polled). */
  timeoutMs?: number | undefined
  /** Injectable transport, for tests. */
  fetch?: typeof fetch | undefined
}

/**
 * Build a client pointed at `baseUrl`.
 *
 * The SDK deliberately takes no base-URL argument: it reads `COMFY_BASE_URL`
 * from the environment, freshly on every construction, so one process can
 * point successive clients at different deployments. We hold the base URL in
 * our own config (env seed + DB settings), so we set the variable around the
 * constructor and put it straight back. `new Comfy()` is synchronous and
 * nothing is awaited in between, so on Node's single thread no concurrent run
 * can observe the swapped value.
 */
export function createComfyClient(opts: ComfyClientOptions): Comfy {
  const previous = process.env[BASE_URL_ENV_VAR]
  process.env[BASE_URL_ENV_VAR] = opts.baseUrl
  try {
    return new Comfy({
      apiKey: opts.apiKey ?? undefined,
      timeoutMs: opts.timeoutMs,
      fetch: opts.fetch,
      clientInfo: CLIENT_INFO,
    })
  } finally {
    if (previous === undefined) delete process.env[BASE_URL_ENV_VAR]
    else process.env[BASE_URL_ENV_VAR] = previous
  }
}

const MODEL_EXT = /\.(glb|gltf|usdz)$/i

/**
 * Map a v2 output to the media type the review queue stages, or null when the
 * output isn't stageable media (text, latent, audio).
 *
 * v2 normalizes the kind server-side (`image` | `video` | `audio` | `text` |
 * `file` | `latent`), which is strictly better than the classic API's
 * guess-from-the-history-key — but a 3D or video save node can still land under
 * the catch-all `file`, so the resolved MIME/extension breaks the tie.
 */
export function mediaTypeForOutput(output: {
  type: string
  name: string
  contentType: string
}): StagedMediaType | null {
  // Never stageable, whatever the bytes look like.
  if (output.type === 'text' || output.type === 'latent' || output.type === 'audio') return null
  const contentType = contentTypeForOutput(output)
  if (MODEL_EXT.test(output.name) || contentType.startsWith('model/')) return 'model3d'
  if (output.type === 'video' || contentType.startsWith('video/')) return 'video'
  if (output.type === 'image' || output.type === 'file') return 'image'
  return null
}

/**
 * MIME to store an output's bytes under.
 *
 * Prefers the server's `content_type`, but it can come back empty — verified
 * against live Comfy Cloud, where a SaveImage output reported `""`. Storing
 * that would leave the asset unservable, so fall back to the filename, then to
 * PNG (what the classic-API provider has always assumed).
 */
export function contentTypeForOutput(output: { name: string; contentType: string }): string {
  return output.contentType || mimeForFilename(output.name, 'image/png')
}

/** Every output of a finished job that stages as media, in server order. */
export function stageableOutputs(job: Job): Array<{ output: Output; mediaType: StagedMediaType }> {
  const staged: Array<{ output: Output; mediaType: StagedMediaType }> = []
  for (const output of job.outputs) {
    const mediaType = mediaTypeForOutput(output)
    if (mediaType) staged.push({ output, mediaType })
  }
  return staged
}

/**
 * Read the text a sink node produced. v2 surfaces a text sink (PreviewAny /
 * ShowText) as an ordinary output asset of type `text`, so unlike the classic
 * API — where the string sat inline in the history payload — the bytes are
 * fetched. Prefers the known sink node, falling back to any text output.
 * Returns null when no text is present.
 */
export async function readTextOutput(job: Job, preferNodeId?: string): Promise<string | null> {
  const isText = (o: Output) => o.type === 'text' || o.contentType.startsWith('text/')
  const preferred = preferNodeId ? job.getOutputs(preferNodeId).filter(isText) : []
  const seen = new Set(preferred.map((o) => o.id))
  const candidates = [...preferred, ...job.outputs.filter((o) => isText(o) && !seen.has(o.id))]
  for (const output of candidates) {
    const text = Buffer.from(await output.toBytes()).toString('utf8').trim()
    if (text.length > 0) return text
  }
  return null
}

/**
 * Turn an SDK error into one of ours.
 *
 * The wording is load-bearing: `isRetryableRunError` in the run service
 * classifies a failure by substring, so 'insufficient credits' and 'API key'
 * must survive into the message or a terminal failure gets retried (and
 * re-billed). Anything unrecognised keeps the SDK's own message and stays
 * retryable, which is the right default for a transient platform blip.
 */
export function describeComfyError(err: unknown, surface: string): Error {
  if (err instanceof InsufficientCredits) return new Error(`${surface}: insufficient credits`)
  if (err instanceof Unauthorized) return new Error(`${surface} rejected the API key`)
  if (err instanceof Forbidden) {
    return new Error(`${surface} refused the request — check the API key's plan and permissions`)
  }
  if (err instanceof JobFailed) return jobFailure(surface, 'failed', err.error)
  if (err instanceof ComfyError) return new Error(`${surface}: ${err.message}`)
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Message for a job that reached a terminal state other than success.
 *
 * `node_id`/`class_type` pinpoint which node blew up — a real gain over the
 * classic API, whose `error_message` was an opaque JSON blob we had to
 * re-parse. A cancelled job reports as our own 'Cancelled', which the run
 * service treats as terminal rather than a failure to retry.
 */
function jobFailure(surface: string, status: string, error: Job['error']): Error {
  if (status === 'canceled') return new Error('Cancelled')
  if (!error) return new Error(`${surface} job ${status}`)
  const at = error.node_id
    ? ` (node ${error.node_id}${error.class_type ? ` — ${error.class_type}` : ''})`
    : ''
  return new Error(`${surface} job ${status}${at}: ${error.message}`)
}

/** As {@link describeComfyError}, for a job that finished in a non-success state. */
export function describeJobFailure(job: Job, surface: string): Error {
  return jobFailure(surface, job.status, job.error)
}

export { ComfyError, Forbidden, NotFound, Unauthorized }
