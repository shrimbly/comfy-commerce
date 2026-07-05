import { randomUUID } from 'node:crypto'

import type { ProviderId, ProviderInfo } from '@comfy-commerce/shared'

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
import { resilientFetch } from './http.js'
import { fetchInputImage } from './imageInput.js'
import type {
  CaptionRequest,
  CaptionResult,
  EditOutput,
  EditRequest,
  EditResult,
  GenerationProvider,
} from './types.js'

export const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf-binary',
  usdz: 'model/vnd.usdz+zip',
}

export function mimeForFilename(filename: string, fallback: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? fallback
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const POLL_INTERVAL_MS = 1500
// Poll ceiling is derived from the configured job timeout (COMFY_JOB_TIMEOUT_MS)
// so long generations (video, big diffusion) aren't cut off at a fixed bound.
const DEFAULT_JOB_TIMEOUT_MS = 900_000 // 15 minutes

/**
 * A ComfyUI instance reached over its HTTP API: upload input image → submit an
 * img2img graph to /prompt → poll /history → download the output and take
 * custody of the bytes locally.
 *
 * Used for both the localhost engine (`comfy-local`) and an engine on another
 * machine on your network (`comfy-remote`).
 * The base URL is resolved on every call (`resolveBaseUrl`) so it can come from
 * runtime config (the DB) and change without a restart; it returns null when
 * the engine isn't configured yet. Every request goes through `resilientFetch`
 * (timeouts + bounded retries) — essential once the engine is across a real
 * network, where a bare fetch can hang forever or die on a transient blip.
 */
export class ComfyHttpProvider implements GenerationProvider {
  get id(): ProviderId {
    return this.opts.id
  }
  get name(): string {
    return this.opts.name
  }
  get kind(): ProviderInfo['kind'] {
    return this.opts.kind
  }
  get description(): string {
    return this.opts.description
  }

  constructor(
    private opts: {
      id: ProviderId
      name: string
      kind: ProviderInfo['kind']
      description: string
      /** Resolve the engine base URL fresh each call; null = not configured. */
      resolveBaseUrl: () => string | null
      checkpoint?: string | undefined
      /** Resolve the comfy.org key fresh each call — lets API nodes (partner
       *  models) authenticate; shares the Comfy Cloud key, settable in the UI. */
      resolveComfyOrgApiKey?: (() => string | null | undefined) | undefined
      /** Availability probe timeout — generous for a first hop over a VPN. */
      availabilityTimeoutMs?: number | undefined
      /** Total job-completion ceiling, in ms (how long to keep polling /history). */
      jobTimeoutMs?: number | undefined
      assetStore: AssetStore
    },
  ) {}

  /** How many history polls fit in the configured job ceiling (mirrors comfyCloud). */
  private get maxPolls(): number {
    return Math.ceil((this.opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS) / POLL_INTERVAL_MS)
  }

  /** The configured base URL, or throw a clear 400 when unset. */
  private baseUrl(): string {
    const url = this.opts.resolveBaseUrl()
    if (!url) {
      throw Object.assign(new Error(`${this.name} URL is not configured`), { statusCode: 400 })
    }
    return url
  }

  async availability() {
    const baseUrl = this.opts.resolveBaseUrl()
    if (!baseUrl) return { available: false, detail: `Set a ${this.name} URL in Connectors` }
    try {
      const res = await resilientFetch(`${baseUrl}/system_stats`, {
        timeoutMs: this.opts.availabilityTimeoutMs ?? 4000,
      })
      if (!res.ok) return { available: false, detail: `ComfyUI responded ${res.status}` }
      return { available: true, detail: baseUrl }
    } catch {
      return { available: false, detail: `No ComfyUI at ${baseUrl}` }
    }
  }

  private async resolveCheckpoint(baseUrl: string): Promise<string> {
    if (this.opts.checkpoint) return this.opts.checkpoint
    const res = await resilientFetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, {
      timeoutMs: 15_000,
      retries: 2,
    })
    if (!res.ok) throw new Error('Could not list ComfyUI checkpoints')
    const info = (await res.json()) as {
      CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } }
    }
    const names = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
    const first = names[0]
    if (!first) throw new Error('No checkpoints installed in ComfyUI (set COMFY_LOCAL_CHECKPOINT)')
    return first
  }

  /**
   * Best-effort stop for a cancelled run: a queued prompt is deleted from
   * the queue; an executing one is interrupted.
   */
  private async interrupt(baseUrl: string, promptId: string): Promise<void> {
    try {
      const queueRes = await resilientFetch(`${baseUrl}/queue`, { timeoutMs: 5_000 })
      const queue = (await queueRes.json()) as {
        queue_running?: Array<[number, string]>
        queue_pending?: Array<[number, string]>
      }
      if (queue.queue_pending?.some(([, id]) => id === promptId)) {
        await resilientFetch(`${baseUrl}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] }),
          timeoutMs: 5_000,
        })
      }
      if (queue.queue_running?.some(([, id]) => id === promptId)) {
        await resilientFetch(`${baseUrl}/interrupt`, { method: 'POST', timeoutMs: 5_000 })
      }
    } catch {
      // Cancellation must never fail the cancel itself.
    }
  }

  private async uploadImage(
    baseUrl: string,
    bytes: Buffer,
    filename: string,
    mimeType?: string,
  ): Promise<string> {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(bytes)], mimeType ? { type: mimeType } : {}), filename)
    form.append('overwrite', 'true')
    const res = await resilientFetch(`${baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      timeoutMs: 60_000,
      retries: 2, // safe to retry — the upload uses overwrite:true
    })
    if (!res.ok) throw new Error(`ComfyUI image upload failed: ${res.status}`)
    const body = (await res.json()) as { name: string }
    return body.name
  }

  /** Submit a graph to /prompt and return its prompt id. */
  private async submit(baseUrl: string, graph: Record<string, unknown>): Promise<string> {
    const comfyOrgApiKey = this.opts.resolveComfyOrgApiKey?.()
    const res = await resilientFetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // API nodes read comfy.org credentials from extra_data — without it
      // they fail with "Please login first to use this node".
      body: JSON.stringify({
        prompt: graph,
        client_id: `comfy-commerce-${randomUUID()}`,
        ...(comfyOrgApiKey ? { extra_data: { api_key_comfy_org: comfyOrgApiKey } } : {}),
      }),
      timeoutMs: 60_000,
      // No retries: a re-POST could enqueue a duplicate job.
    })
    if (!res.ok) {
      throw new Error(`ComfyUI rejected the workflow: ${res.status} ${await res.text()}`)
    }
    const { prompt_id: promptId } = (await res.json()) as { prompt_id: string }
    return promptId
  }

  /** Poll /history for a finished prompt, returning its outputs. */
  private async pollHistory(
    baseUrl: string,
    promptId: string,
    signal: AbortSignal | undefined,
  ): Promise<ComfyOutputs | undefined> {
    for (let poll = 0; poll < this.maxPolls; poll++) {
      await sleep(POLL_INTERVAL_MS)
      if (signal?.aborted) {
        await this.interrupt(baseUrl, promptId)
        throw new Error('Cancelled')
      }
      const historyRes = await resilientFetch(`${baseUrl}/history/${promptId}`, {
        timeoutMs: 15_000,
        retries: 2,
      })
      if (!historyRes.ok) continue
      const history = (await historyRes.json()) as Record<
        string,
        { status?: { status_str?: string }; outputs?: ComfyOutputs }
      >
      const entry = history[promptId]
      if (!entry) continue
      if (entry.status?.status_str === 'error') throw new Error('ComfyUI workflow errored')
      if (collectOutputFiles(entry.outputs).length > 0 || collectText(entry.outputs) !== null) {
        return entry.outputs
      }
    }
    // Ceiling hit: the engine may still be grinding — interrupt it (best-
    // effort, never throws) so a run-level resubmit can't stack a duplicate
    // job on a busy GPU. The message is terminal under isRetryableRunError
    // ('waiting for comfy' is the load-bearing marker).
    await this.interrupt(baseUrl, promptId)
    const ceilingMs = this.opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    throw new Error(
      `Timed out after ${Math.round(ceilingMs / 60_000)} min waiting for ComfyUI to finish (raise COMFY_JOB_TIMEOUT_MS for long runs)`,
    )
  }

  async edit(request: EditRequest): Promise<EditResult> {
    const baseUrl = this.baseUrl()
    const input = await fetchInputImage(request.imageUrl, { signal: request.signal })
    const imageName = await this.uploadImage(baseUrl, input.bytes, input.filename, input.mimeType)
    const fixedImages = await uploadFixedImages(request.workflow, (b, f, m) =>
      this.uploadImage(baseUrl, b, f, m),
    )

    const graph = await buildExecutionGraph(request.workflow, {
      imageName,
      fixedImages,
      seedKey: request.seedKey,
      resolveCheckpoint: () => this.resolveCheckpoint(baseUrl),
    })

    const promptId = await this.submit(baseUrl, graph)
    const outputs = await this.pollHistory(baseUrl, promptId, request.signal)

    const files = collectOutputFiles(outputs)
    if (files.length === 0) throw new Error('ComfyUI finished with no image outputs')
    const results: EditOutput[] = []
    for (const file of files) {
      const view = new URL(`${baseUrl}/view`)
      view.searchParams.set('filename', file.filename)
      view.searchParams.set('subfolder', file.subfolder)
      view.searchParams.set('type', file.type)
      const outputRes = await resilientFetch(view, { timeoutMs: 120_000, retries: 3 })
      if (!outputRes.ok) throw new Error(`Could not download ComfyUI output ${file.filename}`)
      const outputBytes = Buffer.from(await outputRes.arrayBuffer())
      const saved = await this.opts.assetStore.save(outputBytes, mimeForFilename(file.filename, 'image/png'))
      results.push({ url: saved.url, mediaType: file.mediaType })
    }
    return { outputs: results }
  }

  async caption(request: CaptionRequest): Promise<CaptionResult> {
    const baseUrl = this.baseUrl()
    const input = await fetchInputImage(request.imageUrl, { signal: request.signal })
    const imageName = await this.uploadImage(baseUrl, input.bytes, input.filename, input.mimeType)
    const { graph, sinkNodeId } = buildCaptionGraph(
      request.model,
      request.prompt,
      imageName,
      hashSeed(request.seedKey),
    )

    const promptId = await this.submit(baseUrl, graph)
    const outputs = await this.pollHistory(baseUrl, promptId, request.signal)

    const text = collectText(outputs, sinkNodeId)
    if (text === null) throw new Error('ComfyUI caption job produced no text')
    return { text }
  }
}
