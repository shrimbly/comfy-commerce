import type { AssetStore } from '../services/assetStore.js'
import {
  buildCaptionGraph,
  buildExecutionGraph,
  collectOutputFiles,
  collectText,
  hashSeed,
  uploadFixedImages,
  type ComfyOutputs,
} from './comfyGraph.js'
import { mimeForFilename } from './comfyHttp.js'
import { resilientFetch } from './http.js'
import { fetchInputImage } from './imageInput.js'
import type {
  CaptionRequest,
  CaptionResult,
  EditRequest,
  EditResult,
  GenerationProvider,
} from './types.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Status is polled every ~2s per the Cloud docs. The number of polls is derived
// from the configured job ceiling so long generations (video, big diffusion)
// aren't cut off. IMPORTANT: this bounds total JOB time, not each request — the
// generation runs server-side; we only poll for completion, so a long job is
// just many short polls, not one long-held connection.
const POLL_INTERVAL_MS = 2000
const DEFAULT_JOB_TIMEOUT_MS = 900_000 // 15 minutes
// After a job reports done, its outputs (esp. text/ui sinks) can lag a beat.
// Keep polling this many extra times before declaring no output, rather than
// failing on the first empty read.
const OUTPUT_GRACE_POLLS = 8

/**
 * Comfy Cloud provider (https://cloud.comfy.org — docs.comfy.org/development/cloud).
 *
 * The Cloud API is wire-compatible with local ComfyUI plus cloud additions:
 * `X-API-Key` auth, `GET /api/job/{id}/status` for polling, and `/api/view`
 * responding with a 302 to a signed download URL.
 */
export class ComfyCloudProvider implements GenerationProvider {
  id = 'comfy-cloud' as const
  name = 'Comfy Cloud'
  kind = 'cloud' as const
  description = 'Runs edits on Comfy Cloud — no local GPU required.'

  constructor(
    private opts: {
      apiUrl: string
      /** Resolve the API key fresh each call — a UI change takes effect with no restart. */
      resolveApiKey: () => string | null
      checkpoint?: string | undefined
      /** Total job-completion ceiling, in ms (how long to keep polling). */
      jobTimeoutMs?: number | undefined
      assetStore: AssetStore
    },
  ) {}

  /** The currently-configured API key (UI value or env seed), or null. */
  private get apiKey(): string | null {
    return this.opts.resolveApiKey()
  }

  /** How many status polls fit in the configured job ceiling. */
  private get maxPolls(): number {
    return Math.ceil((this.opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS) / POLL_INTERVAL_MS)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'X-API-Key': this.apiKey ?? '', ...extra }
  }

  async availability() {
    if (!this.apiKey) {
      return { available: false, detail: 'Add a Comfy Cloud API key (Connectors → Configure)' }
    }
    try {
      const res = await fetch(`${this.opts.apiUrl}/api/queue`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(4000),
      })
      if (res.status === 401) return { available: false, detail: 'Comfy Cloud rejected the API key' }
      if (res.status === 429) return { available: false, detail: 'Comfy Cloud subscription inactive' }
      if (!res.ok) return { available: false, detail: `Comfy Cloud responded ${res.status}` }
      return { available: true, detail: null }
    } catch {
      return { available: false, detail: `Could not reach ${this.opts.apiUrl}` }
    }
  }

  private async resolveCheckpoint(): Promise<string> {
    if (this.opts.checkpoint) return this.opts.checkpoint
    const res = await resilientFetch(`${this.opts.apiUrl}/api/object_info/CheckpointLoaderSimple`, {
      headers: this.headers(),
      timeoutMs: 15_000,
      retries: 2,
    })
    if (!res.ok) throw new Error('Could not list Comfy Cloud checkpoints')
    const info = (await res.json()) as {
      CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } }
    }
    const names = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
    const first = names[0]
    if (!first) throw new Error('No checkpoints available (set COMFY_CLOUD_CHECKPOINT)')
    return first
  }

  private async uploadImage(bytes: Buffer, filename: string, mimeType: string): Promise<string> {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename)
    form.append('type', 'input')
    form.append('overwrite', 'true')
    const upload = await resilientFetch(`${this.opts.apiUrl}/api/upload/image`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
      timeoutMs: 60_000,
      retries: 2, // safe to retry — the upload uses overwrite:true
    })
    if (!upload.ok) throw new Error(`Comfy Cloud image upload failed: ${upload.status}`)
    const { name } = (await upload.json()) as { name: string }
    return name
  }

  async edit(request: EditRequest): Promise<EditResult> {
    if (!this.apiKey) throw new Error('Comfy Cloud API key not configured')

    const input = await fetchInputImage(request.imageUrl, { signal: request.signal })

    // 1. Upload the product image plus any fixed reference images.
    const imageName = await this.uploadImage(input.bytes, input.filename, input.mimeType)
    const fixedImages = await uploadFixedImages(request.workflow, (b, f, m) =>
      this.uploadImage(b, f, m),
    )

    // 2. Submit the workflow (API-format graph).
    const graph = await buildExecutionGraph(request.workflow, {
      imageName,
      fixedImages,
      seedKey: request.seedKey,
      resolveCheckpoint: () => this.resolveCheckpoint(),
    })
    const submit = await resilientFetch(`${this.opts.apiUrl}/api/prompt`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      // API nodes (partner models) read their credentials from extra_data,
      // not the request headers — without this they fail with "Please login
      // first to use this node" even though the job itself is authorized.
      body: JSON.stringify({
        prompt: graph,
        extra_data: { api_key_comfy_org: this.apiKey },
      }),
      timeoutMs: 60_000,
      // No retries: a re-POST could enqueue a duplicate (billable) job.
      signal: request.signal,
    })
    if (submit.status === 402) throw new Error('Comfy Cloud: insufficient credits')
    if (!submit.ok) {
      throw new Error(`Comfy Cloud rejected the workflow: ${submit.status} ${await submit.text()}`)
    }
    const { prompt_id: promptId } = (await submit.json()) as { prompt_id: string }

    // 3. Poll job status, then fetch outputs.
    let graceLeft = OUTPUT_GRACE_POLLS
    for (let poll = 0; poll < this.maxPolls; poll++) {
      await sleep(POLL_INTERVAL_MS)
      if (request.signal?.aborted) {
        // Best-effort: job-level cancel, falling back to queue interrupt.
        await fetch(`${this.opts.apiUrl}/api/jobs/${promptId}/cancel`, {
          method: 'POST',
          headers: this.headers(),
        }).catch(() => null)
        await fetch(`${this.opts.apiUrl}/api/interrupt`, {
          method: 'POST',
          headers: this.headers(),
        }).catch(() => null)
        throw new Error('Cancelled')
      }
      const statusRes = await resilientFetch(`${this.opts.apiUrl}/api/job/${promptId}/status`, {
        headers: this.headers(),
        timeoutMs: 15_000,
        retries: 2,
        signal: request.signal,
      })
      if (!statusRes.ok) continue
      // Live status values: running states, then 'success' | 'completed' on
      // finish, or 'failed' | 'cancelled' | '*_error' (e.g.
      // 'non_retryable_error') with the detail in `error_message`.
      const statusBody = (await statusRes.json()) as {
        status?: string
        error_message?: string | null
      }
      const status = statusBody.status ?? ''
      if (status === 'failed' || status === 'cancelled' || status.includes('error')) {
        let detail = statusBody.error_message ?? null
        if (detail) {
          try {
            detail = (JSON.parse(detail) as { exception_message?: string }).exception_message ?? detail
          } catch {
            // keep raw detail
          }
        }
        throw new Error(`Comfy Cloud job ${status}${detail ? `: ${detail}` : ''}`)
      }
      // 'executed' is an intermediate Cloud state (a node ran) — NOT final.
      // Reading outputs then is premature: file/text sinks may not be surfaced
      // yet. Only 'success'/'completed' are terminal; keep polling otherwise.
      if (!['completed', 'success'].includes(status)) continue

      const jobRes = await resilientFetch(`${this.opts.apiUrl}/api/jobs/${promptId}`, {
        headers: this.headers(),
        timeoutMs: 30_000,
        retries: 3,
        signal: request.signal,
      })
      if (!jobRes.ok) throw new Error(`Could not fetch Comfy Cloud job details (${jobRes.status})`)
      const job = (await jobRes.json()) as { outputs?: ComfyOutputs }
      const files = collectOutputFiles(job.outputs)
      if (files.length === 0) {
        // Done but outputs not surfaced yet — give them a beat, then fail.
        if (graceLeft-- > 0) continue
        throw new Error('Comfy Cloud job completed with no outputs')
      }

      // 4. Download each via /api/view — 302 redirect to a signed URL.
      const outputs = []
      for (const file of files) {
        const view = new URL(`${this.opts.apiUrl}/api/view`)
        view.searchParams.set('filename', file.filename)
        view.searchParams.set('subfolder', file.subfolder)
        view.searchParams.set('type', file.type)
        const outputRes = await resilientFetch(view, {
          headers: this.headers(),
          redirect: 'follow',
          timeoutMs: 120_000, // generous — a single output (esp. video) can be large
          retries: 3,
          signal: request.signal,
        })
        if (!outputRes.ok) throw new Error(`Could not download Comfy Cloud output ${file.filename}`)
        const outputBytes = Buffer.from(await outputRes.arrayBuffer())
        const saved = await this.opts.assetStore.save(
          outputBytes,
          mimeForFilename(file.filename, 'image/png'),
        )
        outputs.push({ url: saved.url, mediaType: file.mediaType })
      }
      return { outputs }
    }
    throw new Error(
      `Timed out after ${Math.round((this.opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS) / 60_000)} min waiting for Comfy Cloud to finish (raise COMFY_CLOUD_JOB_TIMEOUT_MS for long runs)`,
    )
  }

  async caption(request: CaptionRequest): Promise<CaptionResult> {
    if (!this.apiKey) throw new Error('Comfy Cloud API key not configured')

    const input = await fetchInputImage(request.imageUrl, { signal: request.signal })
    const imageName = await this.uploadImage(input.bytes, input.filename, input.mimeType)
    const { graph, sinkNodeId } = buildCaptionGraph(
      request.model,
      request.prompt,
      imageName,
      hashSeed(request.seedKey),
    )

    const submit = await resilientFetch(`${this.opts.apiUrl}/api/prompt`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prompt: graph, extra_data: { api_key_comfy_org: this.apiKey } }),
      timeoutMs: 60_000,
      // No retries: a re-POST could enqueue a duplicate (billable) job.
      signal: request.signal,
    })
    if (submit.status === 402) throw new Error('Comfy Cloud: insufficient credits')
    if (!submit.ok) {
      throw new Error(`Comfy Cloud rejected the workflow: ${submit.status} ${await submit.text()}`)
    }
    const { prompt_id: promptId } = (await submit.json()) as { prompt_id: string }

    let graceLeft = OUTPUT_GRACE_POLLS
    for (let poll = 0; poll < this.maxPolls; poll++) {
      await sleep(POLL_INTERVAL_MS)
      if (request.signal?.aborted) {
        await fetch(`${this.opts.apiUrl}/api/jobs/${promptId}/cancel`, {
          method: 'POST',
          headers: this.headers(),
        }).catch(() => null)
        throw new Error('Cancelled')
      }
      const statusRes = await resilientFetch(`${this.opts.apiUrl}/api/job/${promptId}/status`, {
        headers: this.headers(),
        timeoutMs: 15_000,
        retries: 2,
        signal: request.signal,
      })
      if (!statusRes.ok) continue
      const statusBody = (await statusRes.json()) as { status?: string; error_message?: string | null }
      const status = statusBody.status ?? ''
      if (status === 'failed' || status === 'cancelled' || status.includes('error')) {
        throw new Error(`Comfy Cloud job ${status}${statusBody.error_message ? `: ${statusBody.error_message}` : ''}`)
      }
      // 'executed' is an intermediate Cloud state (a node ran) — NOT final.
      // Reading outputs then is premature: file/text sinks may not be surfaced
      // yet. Only 'success'/'completed' are terminal; keep polling otherwise.
      if (!['completed', 'success'].includes(status)) continue

      const jobRes = await resilientFetch(`${this.opts.apiUrl}/api/jobs/${promptId}`, {
        headers: this.headers(),
        timeoutMs: 30_000,
        retries: 3,
        signal: request.signal,
      })
      if (!jobRes.ok) throw new Error(`Could not fetch Comfy Cloud job details (${jobRes.status})`)
      const job = (await jobRes.json()) as { outputs?: ComfyOutputs }
      const text = collectText(job.outputs, sinkNodeId)
      if (text === null) {
        // Done but the text sink hasn't surfaced yet — give it a beat, then fail.
        if (graceLeft-- > 0) continue
        throw new Error('Comfy Cloud caption job produced no text')
      }
      return { text }
    }
    throw new Error(
      `Timed out after ${Math.round((this.opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS) / 60_000)} min waiting for Comfy Cloud to finish (raise COMFY_CLOUD_JOB_TIMEOUT_MS for long runs)`,
    )
  }
}
