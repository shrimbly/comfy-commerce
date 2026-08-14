import type { Asset, Comfy, Job, Workflow } from '@comfyorg/sdk'

import type { AssetStore } from '../services/assetStore.js'
import { buildCaptionGraph, buildExecutionGraph, hashSeed } from './comfyGraph.js'
import {
  ComfyError,
  Forbidden,
  NotFound,
  SUCCEEDED,
  Unauthorized,
  contentTypeForOutput,
  createComfyClient,
  describeComfyError,
  describeJobFailure,
  readTextOutput,
  stageableOutputs,
} from './comfySdk.js'
import { fetchInputImage } from './imageInput.js'
import type {
  CaptionRequest,
  CaptionResult,
  EditRequest,
  EditResult,
  GenerationProvider,
} from './types.js'

/** Total job-completion ceiling — how long we keep polling before giving up. */
const DEFAULT_JOB_TIMEOUT_MS = 900_000 // 15 minutes
/**
 * Per-HTTP-request ceiling. IMPORTANT: this is not the job ceiling — the
 * generation runs server-side and we poll for it, so a long job is many short
 * requests, never one long-held connection. Generous because the same client
 * streams multipart uploads and output downloads (video can be large).
 */
const REQUEST_TIMEOUT_MS = 120_000
const AVAILABILITY_TIMEOUT_MS = 4_000
/**
 * Consecutive failed status polls to absorb before giving up on a running job.
 * The SDK's `wait` surfaces the first one; the classic provider retried every
 * poll, and a 15-minute video job must not die because one request lost its
 * connection.
 */
export const POLL_FAILURE_TOLERANCE = 3
const POLL_RETRY_PAUSE_MS = 2_000

/** Pause that ends early when the run is cancelled, so Cancel stays snappy. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
/**
 * A well-formed job id no account can own. The availability probe wants the
 * 404 — reaching it at all proves the surface is up and the key is accepted.
 */
const PROBE_JOB_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Comfy Cloud provider (https://cloud.comfy.org — docs.comfy.org/development/cloud),
 * running on **`@comfyorg/sdk`** against the Comfy API **v2**.
 *
 * The SDK does the protocol work: input images become content-addressed
 * assets (hashed locally with blake3, deduped server-side, uploaded only when
 * the bytes are new) that substitute into the graph as `core/ASSET`
 * references; submits carry an idempotency key so an accidental resend can't
 * enqueue a second billable job; completion is polled with adaptive backoff;
 * outputs come back as typed handles. All this provider adds is our own
 * concerns — graph patching, taking custody of the produced bytes, and error
 * wording the run service can classify.
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
      /** Total job-completion ceiling, in ms (how long to keep polling). */
      jobTimeoutMs?: number | undefined
      assetStore: AssetStore
      /** Injectable transport, for tests. */
      fetch?: typeof fetch | undefined
    },
  ) {}

  /** The currently-configured API key (UI value or env seed), or null. */
  private get apiKey(): string | null {
    return this.opts.resolveApiKey()
  }

  private get jobTimeoutMs(): number {
    return this.opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
  }

  /** A client bound to the configured deployment and the live API key. */
  private client(timeoutMs = REQUEST_TIMEOUT_MS): Comfy {
    return createComfyClient({
      baseUrl: this.opts.apiUrl,
      apiKey: this.apiKey,
      timeoutMs,
      fetch: this.opts.fetch,
    })
  }

  private requireKey(): string {
    const key = this.apiKey
    if (!key) throw new Error('Comfy Cloud API key not configured')
    return key
  }

  async availability() {
    if (!this.apiKey) {
      return { available: false, detail: 'Add a Comfy Cloud API key (Connectors → Configure)' }
    }
    try {
      await this.client(AVAILABILITY_TIMEOUT_MS).jobs.get(PROBE_JOB_ID)
      return { available: true, detail: null }
    } catch (err) {
      // The expected answer: the surface is up and authorized us, and simply
      // has no such job.
      if (err instanceof NotFound) return { available: true, detail: null }
      if (err instanceof Unauthorized) {
        return { available: false, detail: 'Comfy Cloud rejected the API key' }
      }
      if (err instanceof Forbidden) {
        return { available: false, detail: 'Comfy Cloud subscription inactive' }
      }
      if (err instanceof ComfyError && err.httpStatus === 429) {
        return { available: false, detail: 'Comfy Cloud subscription inactive' }
      }
      return { available: false, detail: `Could not reach ${this.opts.apiUrl}` }
    }
  }

  /** Upload-on-use handle for bytes we already hold in memory. */
  private asset(client: Comfy, bytes: Buffer, filename: string, contentType: string): Asset {
    return client.assets.fromBytes(new Uint8Array(bytes), { filename, contentType })
  }

  /**
   * Submit, wait for a terminal state, and hand back the finished job.
   *
   * Cancellation and the job ceiling both stop the job server-side before
   * throwing: leaving it running would burn credits for a result nobody reads,
   * and a run-level resubmit could stack a duplicate on top of it.
   */
  private async runJob(client: Comfy, workflow: Workflow, signal?: AbortSignal): Promise<Job> {
    let job: Job
    try {
      // Partner/API nodes (Gemini, …) read their comfy.org credential from
      // extra_data, not the request headers — without it they fail with
      // "Please login first to use this node" even though the job is authorized.
      job = await client.submit(workflow, { apiKey: this.requireKey(), signal })
    } catch (err) {
      throw describeComfyError(err, 'Comfy Cloud')
    }

    try {
      await this.waitForJob(job, signal)
    } catch (err) {
      // Whatever went wrong, stop the job: leaving it running would burn
      // credits for a result nobody reads, and a run-level retry could stack a
      // duplicate on top of it.
      await job.cancel().catch(() => null)
      throw err
    }

    if (job.status !== SUCCEEDED) throw describeJobFailure(job, 'Comfy Cloud')
    return job
  }

  /**
   * Poll to a terminal state, tolerating a few consecutive poll failures.
   *
   * `job.wait` re-reads authoritative state on entry, so calling it again after
   * a dropped request simply resumes — with the ceiling carried across attempts
   * as a shrinking budget rather than restarting per attempt.
   */
  private async waitForJob(job: Job, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.jobTimeoutMs
    let failures = 0
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw this.ceilingError()
      try {
        await job.wait(remaining, signal)
        return
      } catch (err) {
        if (signal?.aborted) throw new Error('Cancelled')
        // `wait`'s own deadline message — the job is still running, we stopped waiting.
        if (err instanceof Error && err.message.includes('not terminal after')) {
          throw this.ceilingError()
        }
        if (++failures > POLL_FAILURE_TOLERANCE) throw describeComfyError(err, 'Comfy Cloud')
        await sleep(POLL_RETRY_PAUSE_MS, signal)
      }
    }
  }

  /**
   * Hit the job ceiling. 'waiting for Comfy' is load-bearing: the run service
   * reads it as terminal, so a retry can't stack a second billable job.
   */
  private ceilingError(): Error {
    return new Error(
      `Timed out after ${Math.round(this.jobTimeoutMs / 60_000)} min waiting for Comfy Cloud to finish (raise COMFY_CLOUD_JOB_TIMEOUT_MS for long runs)`,
    )
  }

  async edit(request: EditRequest): Promise<EditResult> {
    this.requireKey()
    if (request.workflow.kind !== 'graph') {
      throw new Error('Caption workflows run via provider.caption(), not provider.edit()')
    }
    const client = this.client()
    const input = await fetchInputImage(request.imageUrl, { signal: request.signal })

    // Build the graph first (this validates the bindings and patches params /
    // seeds), then swap the bound image inputs for asset handles: the SDK
    // materializes each into a `core/ASSET` reference at submit time, so the
    // upload is deduped and the graph never carries a filename.
    const graph = await buildExecutionGraph(request.workflow, {
      imageName: input.filename,
      fixedImages: request.workflow.fixedImages.map((f) => ({
        nodeId: f.nodeId,
        imageName: f.filename,
      })),
      seedKey: request.seedKey,
    })
    const workflow = client.workflows.fromJson(graph)
    workflow.setInput(
      request.workflow.inputNodeId,
      'image',
      this.asset(client, input.bytes, input.filename, input.mimeType),
    )
    for (const fixed of request.workflow.fixedImages) {
      workflow.setInput(
        fixed.nodeId,
        'image',
        this.asset(client, fixed.bytes, fixed.filename, fixed.mimeType),
      )
    }

    const job = await this.runJob(client, workflow, request.signal)

    const staged = stageableOutputs(job)
    if (staged.length === 0) throw new Error('Comfy Cloud job completed with no outputs')
    const outputs = []
    for (const { output, mediaType } of staged) {
      const bytes = Buffer.from(await output.toBytes())
      const saved = await this.opts.assetStore.save(bytes, contentTypeForOutput(output))
      outputs.push({ url: saved.url, mediaType })
    }
    return { outputs }
  }

  async caption(request: CaptionRequest): Promise<CaptionResult> {
    this.requireKey()
    const client = this.client()
    const input = await fetchInputImage(request.imageUrl, { signal: request.signal })

    const { graph, inputNodeId, sinkNodeId } = buildCaptionGraph(
      request.model,
      request.prompt,
      input.filename,
      hashSeed(request.seedKey),
    )
    const workflow = client.workflows.fromJson(graph)
    workflow.setInput(
      inputNodeId,
      'image',
      this.asset(client, input.bytes, input.filename, input.mimeType),
    )

    const job = await this.runJob(client, workflow, request.signal)

    const text = await readTextOutput(job, sinkNodeId)
    if (text === null) throw new Error('Comfy Cloud caption job produced no text')
    return { text }
  }
}
