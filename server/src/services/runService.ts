import { createHash, randomUUID } from 'node:crypto'

import {
  matchesScope,
  mediaInScope,
  type MediaRef,
  type Product,
  type Run,
  type RunItem,
  type RunTarget,
  type StageAction,
} from '@comfy-commerce/shared'
import { desc, eq, inArray } from 'drizzle-orm'

import type { ConnectorRegistry } from '../connectors/index.js'
import type { Db } from '../db/client.js'
import { runs } from '../db/schema.js'
import type { Env } from '../env.js'
import type { ProviderRegistry } from '../providers/index.js'
import type { WorkflowExecution } from '../providers/types.js'
import { parseCaption } from '../workflows/caption.js'
import type { WorkflowService } from '../workflows/service.js'
import type { AssetStore } from './assetStore.js'
import type { Audit } from './audit.js'
import type { EnrichmentService } from './enrichmentService.js'
import type { StagingService } from './stagingService.js'
import type { StoreService } from './storeService.js'

type Row = typeof runs.$inferSelect

function toRun(row: Row): Run {
  return {
    id: row.id,
    storeId: row.storeId,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    providerId: row.providerId as Run['providerId'],
    params: row.params,
    targetKind: row.targetKind,
    stageAction: row.stageAction,
    source: row.source,
    sample: row.sample,
    sampleOfTotal: row.sampleOfTotal,
    retryOfRunId: row.retryOfRunId,
    state: row.state,
    items: row.items,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface CreateRunParams {
  storeId: string
  workflowId: string
  providerId: Run['providerId']
  params: Record<string, string>
  target: RunTarget
  stageAction: StageAction
  source: 'ui' | 'api'
  /** When set, cut a representative sample of this size from the target. */
  sampleSize?: number
}

/**
 * Whether a failed attempt is worth retrying. Most provider failures are
 * transient (network blips, 5xx, rate limits, timeouts, a flaky download) and
 * should be retried. A few are terminal — retrying only wastes attempts:
 * cancellation/skip (abort), bad credentials/credits/config, vanished media,
 * and anything the cloud explicitly flags `non_retryable`.
 */
export function isRetryableRunError(err: unknown): boolean {
  if (!(err instanceof Error)) return true
  if (err.name === 'AbortError') return false
  const msg = err.message.toLowerCase()
  const terminal = [
    'cancelled',
    'aborted',
    'insufficient credits',
    'api key', //               missing / rejected Comfy Cloud key
    'not configured',
    'no longer exists', //       media removed from the catalog mid-run
    'can only edit demo', //     mock-engine guard
    'non_retryable',
    // Hit a job ceiling — the engine is still grinding; re-running stacks a
    // duplicate job. LOAD-BEARING PHRASE: it must match both Comfy Cloud's
    // "…waiting for Comfy Cloud to finish" and comfyHttp's "…waiting for
    // ComfyUI to finish" timeout messages (and any future provider message
    // containing it becomes terminal too). Per-request timeouts ("Request to
    // X timed out after Nms") deliberately do NOT match and stay retryable.
    'waiting for comfy',
  ]
  return !terminal.some((t) => msg.includes(t))
}

/** Sleep that resolves early if the signal aborts — so a cancel doesn't wait out a backoff. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** Spread a sample across distinct products before taking seconds. */
export function pickSample(items: RunItem[], size: number): RunItem[] {
  if (items.length <= size) return items
  const byProduct = new Map<string, RunItem[]>()
  for (const item of items) {
    const list = byProduct.get(item.input.productId) ?? []
    list.push(item)
    byProduct.set(item.input.productId, list)
  }
  const groups = [...byProduct.values()]
  const sample: RunItem[] = []
  for (let round = 0; sample.length < size; round += 1) {
    let took = false
    for (const group of groups) {
      const item = group[round]
      if (!item) continue
      sample.push(item)
      took = true
      if (sample.length >= size) break
    }
    if (!took) break
  }
  return sample
}

export function createRunService(
  db: Db,
  env: Env,
  providers: ProviderRegistry,
  connectors: ConnectorRegistry,
  storeService: StoreService,
  workflowService: WorkflowService,
  staging: StagingService,
  audit: Audit,
  assetStore: AssetStore,
  enrichment: EnrichmentService,
) {
  function update(id: string, patch: Partial<Row>): void {
    db.update(runs)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(runs.id, id))
      .run()
  }

  function findRow(id: string): Row | undefined {
    return db.select().from(runs).where(eq(runs.id, id)).get()
  }

  /** Runs whose execute() loop is alive in THIS process. */
  const executing = new Set<string>()
  /** Abort handles for in-flight provider work, keyed by run id. */
  const aborters = new Map<string, AbortController>()
  /** Settlement promises of live executors — awaited by disconnect/shutdown drains. */
  const settled = new Map<string, Promise<void>>()
  /** Run ids awaiting a concurrency slot, and how many are running now. */
  const waiting: string[] = []
  let active = 0

  /**
   * A run finalized elsewhere — its executor loop must stop touching it. Set
   * whenever another path (shutdown's markInterrupted, a direct fail) records a
   * terminal state while an executor is mid-flight; the loop checks this and
   * bails without re-issuing work or overwriting the recorded state/items.
   */
  const isFinal = (row: Row): boolean =>
    row.state === 'failed' || row.state === 'cancelled' || row.state === 'completed'

  /** Fail every still-unfinished item, returning a fresh copy of the list. */
  function failUnfinishedItems(row: Row, reason: string): RunItem[] {
    const items = structuredClone(row.items)
    for (const item of items) {
      if (item.state === 'editing' || item.state === 'pending') {
        item.state = 'failed'
        item.error = reason
      }
    }
    return items
  }

  /** Mark a run (and its unfinished items) interrupted, in place. */
  function markInterrupted(row: Row, reason: string): void {
    update(row.id, { state: 'failed', error: reason, items: failUnfinishedItems(row, reason) })
    audit.record({ storeId: row.storeId, action: 'run.interrupted', detail: { runId: row.id } })
  }

  /**
   * Recover runs orphaned by a broker restart: their executor loop is gone,
   * so they would sit in queued/running forever (and cancel would no-op).
   * Filtered in SQL — this runs at construction, on the pre-window boot path,
   * and must not read (and JSON-parse) the entire runs history.
   */
  function recoverOrphanedRuns(): void {
    const orphans = db
      .select()
      .from(runs)
      .where(inArray(runs.state, ['queued', 'running']))
      .all()
    for (const row of orphans) {
      markInterrupted(row, 'Interrupted — the broker restarted mid-run')
    }
  }
  recoverOrphanedRuns()

  /**
   * Concurrency gate. create/promote/retry enqueue a run id; pump() starts as
   * many as RUN_CONCURRENCY allows, freeing a slot when each run settles. A run
   * cancelled while still waiting is skipped — never started — when its slot
   * opens.
   */
  function enqueue(runId: string): void {
    waiting.push(runId)
    pump()
  }
  function pump(): void {
    while (active < env.runConcurrency && waiting.length > 0) {
      const runId = waiting.shift()!
      const row = findRow(runId)
      if (!row || row.state !== 'queued' || row.cancelRequested) continue
      active += 1
      const promise = execute(runId).finally(() => {
        active -= 1
        settled.delete(runId)
        pump()
      })
      settled.set(runId, promise)
    }
  }

  function absolutize(url: string): string {
    return url.startsWith('/') ? `${env.appUrl}${url}` : url
  }

  /**
   * Run one item's work with bounded retries on transient failures. Re-running
   * a single attempt is safe: nothing is committed (staging/enrichment) until
   * the attempt returns, so a retry just produces a fresh result. Stops early
   * on cancellation/skip (abort) or a terminal error.
   */
  async function withRetry<T>(runId: string, attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n += 1) {
      try {
        return await attempt()
      } catch (err) {
        const aborted = aborters.get(runId)?.signal.aborted || findRow(runId)?.cancelRequested
        if (aborted || !isRetryableRunError(err) || n >= env.runItemMaxAttempts) throw err
        audit.record({
          storeId: findRow(runId)?.storeId ?? '',
          action: 'run.item-retry',
          detail: {
            runId,
            attempt: n,
            of: env.runItemMaxAttempts,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        // Exponential backoff (1×, 2×, 4× …); interruptible so cancel is snappy.
        await abortableSleep(env.runItemRetryBaseMs * 2 ** (n - 1), aborters.get(runId)?.signal)
      }
    }
  }

  /** Expand a run target into concrete items (in-scope media only). */
  async function expandTarget(storeId: string, target: RunTarget): Promise<RunItem[]> {
    const store = storeService.requireRow(storeId)
    const connector = connectors.forStore(store)
    const products = await connector.listProducts(store)
    const byId = new Map(products.map((p) => [p.id, p]))

    const makeItems = (product: Product, refs?: MediaRef[]): RunItem[] => {
      const media = refs
        ? product.media.filter((m) => refs.some((r) => r.mediaId === m.id))
        : mediaInScope(product, store.scopeProfile)
      return media.map((m) => ({
        input: { productId: product.id, mediaId: m.id },
        productTitle: product.title,
        state: 'pending' as const,
        afterUrl: null,
        error: null,
      }))
    }

    if (target.kind === 'selection') {
      const refs = target.inputs ?? []
      const grouped = new Map<string, MediaRef[]>()
      for (const ref of refs) {
        grouped.set(ref.productId, [...(grouped.get(ref.productId) ?? []), ref])
      }
      return [...grouped.entries()].flatMap(([productId, productRefs]) => {
        const product = byId.get(productId)
        return product ? makeItems(product, productRefs) : []
      })
    }
    if (target.kind === 'products') {
      return (target.productIds ?? []).flatMap((id) => {
        const product = byId.get(id)
        return product ? makeItems(product) : []
      })
    }
    // catalog: everything the scope profile exposes
    return products.filter((p) => matchesScope(p, store.scopeProfile)).flatMap((p) => makeItems(p))
  }

  /** Resolve run params into an engine-executable workflow. */
  async function toExecution(
    run: Pick<Run, 'workflowId' | 'params' | 'providerId'>,
  ): Promise<WorkflowExecution> {
    const resolved = await workflowService.resolveForRun(run.workflowId, run.providerId)
    if (resolved.execution.kind === 'caption') {
      return {
        kind: 'caption',
        model: resolved.execution.model,
        prompt: resolved.execution.prompt,
        workflowKey: createHash('sha1').update(run.workflowId).digest('hex').slice(0, 8),
      }
    }
    const { graph, inputNodeId, outputNodeId, params: paramDefs, fixedInputs } = resolved.execution
    const assignments = paramDefs
      .filter((p) => p.nodeId && p.inputKey)
      .map((p) => ({
        nodeId: p.nodeId!,
        inputKey: p.inputKey!,
        value: run.params[p.id] ?? p.defaultValue ?? '',
      }))
      .filter((a) => a.value !== '')
    // Resolve each fixed reference image to bytes once per run — the providers
    // upload them alongside the per-run product image.
    const fixedImages = await Promise.all(
      fixedInputs.map(async (fixed) => {
        const asset = await assetStore.read(fixed.assetId)
        if (!asset) {
          throw new Error(
            `Fixed reference image for node ${fixed.nodeId} is missing (asset ${fixed.assetId})`,
          )
        }
        return {
          nodeId: fixed.nodeId,
          bytes: asset.bytes,
          mimeType: asset.contentType,
          filename: asset.filename,
        }
      }),
    )
    return {
      kind: 'graph',
      graph,
      inputNodeId,
      outputNodeId,
      assignments,
      fixedImages,
      workflowKey: createHash('sha1').update(run.workflowId).digest('hex').slice(0, 8),
    }
  }

  async function execute(runId: string): Promise<void> {
    executing.add(runId)
    aborters.set(runId, new AbortController())
    try {
      await executeInner(runId)
    } finally {
      executing.delete(runId)
      aborters.delete(runId)
    }
  }

  async function executeInner(runId: string): Promise<void> {
    const row = findRow(runId)
    if (!row) return
    update(runId, { state: 'running' })

    const store = storeService.getRow(row.storeId)
    if (!store) {
      update(runId, { state: 'failed', error: 'Store not found' })
      return
    }
    const provider = providers.get(row.providerId as Run['providerId'])
    const connector = connectors.forStore(store)
    const items = structuredClone(row.items)

    let execution: WorkflowExecution
    try {
      execution = await toExecution(toRun(row))
    } catch (err) {
      update(runId, { state: 'failed', error: err instanceof Error ? err.message : String(err) })
      return
    }

    for (const item of items) {
      // Re-read the cancel flag so the UI can stop a long catalog run.
      const fresh = findRow(runId)
      // A deleted row is a stop signal (store disconnect purged the run) —
      // the invariant remove() documents. Touch nothing and bail.
      if (!fresh) return
      // Finalized while we were mid-item (broker shutdown recorded interrupted
      // state) — stop without re-issuing work or clobbering the recorded state.
      if (isFinal(fresh)) return
      if (fresh.cancelRequested) {
        update(runId, { state: 'cancelled', items })
        audit.record({ storeId: row.storeId, action: 'run.cancelled', detail: { runId } })
        return
      }

      item.state = 'editing'
      update(runId, { items })
      try {
        // Resolve the live media fresh on each attempt — a transient connector
        // blip is retryable, a genuinely vanished media is terminal.
        const resolveMedia = async () => {
          const product = await connector.getProduct(store, item.input.productId)
          const media = product?.media.find((m) => m.id === item.input.mediaId)
          if (!product || !media) throw new Error('Media no longer exists in the catalog')
          return media
        }

        if (execution.kind === 'caption') {
          // Enrichment: caption to text, written straight to the enrichment
          // store. No review gate — this is internal metadata, not a store edit.
          const { caption, tags } = await withRetry(runId, async () => {
            const media = await resolveMedia()
            const result = await provider.caption({
              imageUrl: absolutize(media.url),
              model: execution.model,
              prompt: execution.prompt,
              // Per-run seed — same cache-collision reason as the edit path:
              // a constant seed lets Comfy serve a re-caption entirely from
              // cache, which then surfaces no text.
              seedKey: `${runId}:${item.input.mediaId}`,
              signal: aborters.get(runId)?.signal,
            })
            return parseCaption(result.text)
          })
          enrichment.upsert({
            storeId: row.storeId,
            productId: item.input.productId,
            mediaId: item.input.mediaId,
            caption,
            tags,
            model: execution.model,
          })
          item.state = 'done'
        } else {
          // The empty-output check lives inside the retry so a barren attempt
          // is retried rather than failing the item outright.
          const outputs = await withRetry(runId, async () => {
            const media = await resolveMedia()
            const edit = await provider.edit({
              imageUrl: absolutize(media.url),
              altText: media.altText,
              workflow: execution,
              // Seed per RUN, not just per media: the input/reference images
              // upload under content-hash names and the prompts are fixed, so a
              // media-only seed makes every re-run a byte-identical graph. Comfy
              // (local and Cloud) then serves it entirely from cache and a fully
              // cached job emits no new output files — surfacing as "completed
              // with no outputs". Folding in runId guarantees a fresh seed (cache
              // miss → real generation) each run, which is also what re-running
              // should do: produce a new variation.
              seedKey: `${runId}:${item.input.mediaId}`,
              signal: aborters.get(runId)?.signal,
            })
            if (edit.outputs.length === 0) throw new Error('The workflow produced no outputs')
            return edit.outputs
          })
          item.afterUrl = outputs[0]!.url
          item.mediaType = outputs[0]!.mediaType
          item.state = 'done'

          // Stream into the review queue once the edit has succeeded — pending,
          // always. The first output honors the chosen stage action; any
          // additional outputs (multi-image/video workflows) are staged as
          // new product media. Kept OUTSIDE the retry so a retried edit can
          // never double-stage.
          await staging.stage(
            outputs.map((output, index) => ({
              storeId: row.storeId,
              productId: item.input.productId,
              mediaId: item.input.mediaId,
              afterUrl: output.url,
              mediaType: output.mediaType,
              action: index === 0 ? row.stageAction : ('add-new' as const),
              recipeId: row.workflowName,
              runId,
              source: row.source,
            })),
          )
        }
      } catch (err) {
        item.state = 'failed'
        item.error = err instanceof Error ? err.message : String(err)
      }
      // A finalize can land while this item was in flight (shutdown aborts the
      // provider call): writing here would resurrect 'editing' / overwrite the
      // interrupted items, so re-check before persisting.
      const afterItem = findRow(runId)
      if (!afterItem || isFinal(afterItem)) return
      update(runId, { items })
    }

    // Re-read before the final update/audit: a run deleted mid-flight (store
    // disconnect) must never record 'run.completed' for a purged store, and a
    // run finalized by shutdown must keep its interrupted state.
    const finalRow = findRow(runId)
    if (!finalRow || isFinal(finalRow)) return
    const failed = items.filter((i) => i.state === 'failed').length
    const cancelled = finalRow.cancelRequested
    update(runId, {
      state: cancelled
        ? 'cancelled'
        : failed === items.length && items.length > 0
          ? 'failed'
          : 'completed',
    })
    audit.record({
      storeId: row.storeId,
      action: failed > 0 ? 'run.completed-with-failures' : 'run.completed',
      detail: { runId, workflow: row.workflowName, images: items.length, failed },
    })
  }

  return {
    async estimate(storeId: string, target: RunTarget) {
      const items = await expandTarget(storeId, target)
      return { images: items.length, products: new Set(items.map((i) => i.input.productId)).size }
    },

    async create(params: CreateRunParams): Promise<Run> {
      providers.get(params.providerId) // throws on unknown provider
      workflowService.resolve(params.workflowId) // throws on unknown workflow
      const fullItems = await expandTarget(params.storeId, params.target)
      if (fullItems.length === 0) {
        throw Object.assign(new Error('Target matches no in-scope media'), { statusCode: 400 })
      }
      const sampling = Boolean(params.sampleSize && params.sampleSize < fullItems.length)
      const items = sampling ? pickSample(fullItems, params.sampleSize!) : fullItems

      const resolved = workflowService.resolve(params.workflowId)
      const now = new Date().toISOString()
      const row: typeof runs.$inferInsert = {
        id: randomUUID(),
        storeId: params.storeId,
        workflowId: params.workflowId,
        workflowName: resolved.name,
        providerId: params.providerId,
        params: params.params,
        targetKind: params.target.kind,
        // Persist the FULL target: promote() re-expands from it, and retry()/
        // promote() spread `...row`, so it propagates through chains for free.
        target: params.target,
        stageAction: params.stageAction,
        source: params.source,
        sample: sampling,
        sampleOfTotal: sampling ? fullItems.length : null,
        state: 'queued',
        cancelRequested: false,
        items,
        error: null,
        createdAt: now,
        updatedAt: now,
      }
      db.insert(runs).values(row).run()
      audit.record({
        storeId: params.storeId,
        action: 'run.created',
        detail: {
          runId: row.id,
          workflow: resolved.name,
          provider: params.providerId,
          target: params.target.kind,
          images: items.length,
          sample: sampling,
        },
      })
      enqueue(row.id)
      return toRun(row as Row)
    },

    /** Promote a sample run to the full target (skipping already-edited media). */
    async promote(runId: string): Promise<Run> {
      const row = findRow(runId)
      if (!row) throw Object.assign(new Error('Run not found'), { statusCode: 404 })
      if (!row.sample) throw Object.assign(new Error('Only sample runs can be promoted'), { statusCode: 400 })

      const doneIds = new Set(
        row.items.filter((i) => i.state === 'done').map((i) => i.input.mediaId),
      )
      // Expand from the persisted full target. Legacy rows (pre-persistence)
      // carry null: 'catalog' needs no more than its kind, so it still works;
      // selection/products would silently expand to [] — refuse honestly.
      const target =
        row.target ?? (row.targetKind === 'catalog' ? { kind: 'catalog' as const } : null)
      if (!target) {
        throw Object.assign(
          new Error(
            'This sample run predates target persistence — start a new run over the same selection',
          ),
          { statusCode: 400 },
        )
      }
      const fullItems = await expandTarget(row.storeId, target)
      const remaining = fullItems.filter((i) => !doneIds.has(i.input.mediaId))
      if (remaining.length === 0) {
        throw Object.assign(new Error('Nothing left to run — the sample covered the target'), { statusCode: 400 })
      }
      const now = new Date().toISOString()
      const promoted: typeof runs.$inferInsert = {
        ...row,
        id: randomUUID(),
        sample: false,
        sampleOfTotal: null,
        retryOfRunId: null,
        state: 'queued',
        cancelRequested: false,
        items: remaining,
        error: null,
        createdAt: now,
        updatedAt: now,
      }
      db.insert(runs).values(promoted).run()
      audit.record({
        storeId: row.storeId,
        action: 'run.promoted',
        detail: { fromRunId: runId, runId: promoted.id, images: remaining.length },
      })
      enqueue(promoted.id)
      return toRun(promoted as Row)
    },

    /** Re-run a finished run's unfinished items as a fresh run. */
    retry(runId: string): Run {
      const row = findRow(runId)
      if (!row) throw Object.assign(new Error('Run not found'), { statusCode: 404 })
      if (row.state === 'queued' || row.state === 'running') {
        throw Object.assign(new Error('Run is still active — cancel it first'), { statusCode: 400 })
      }
      const remaining: RunItem[] = row.items
        .filter((i) => i.state !== 'done')
        .map((i) => ({ ...i, state: 'pending' as const, afterUrl: null, error: null }))
      if (remaining.length === 0) {
        throw Object.assign(new Error('Nothing to retry — every image completed'), { statusCode: 400 })
      }
      const now = new Date().toISOString()
      const retried: typeof runs.$inferInsert = {
        ...row,
        id: randomUUID(),
        // Chains always point at the root run so grouping is a single key.
        retryOfRunId: row.retryOfRunId ?? runId,
        state: 'queued',
        cancelRequested: false,
        items: remaining,
        error: null,
        createdAt: now,
        updatedAt: now,
      }
      db.insert(runs).values(retried).run()
      audit.record({
        storeId: row.storeId,
        action: 'run.retried',
        detail: { fromRunId: runId, runId: retried.id, images: remaining.length },
      })
      enqueue(retried.id)
      return toRun(retried as Row)
    },

    /**
     * Cancel every queued/running run for a store and wait (bounded) for their
     * executors to settle. Called by storeService.disconnect BEFORE purging
     * rows, so no executor reads the catalog — or resurrects it — after purge.
     * The 15s drain bound keeps disconnect responsive if a provider fetch is
     * wedged; a straggler past it exits harmlessly at its next missing-row check.
     */
    async cancelAllForStore(storeId: string): Promise<void> {
      const activeRuns = db
        .select()
        .from(runs)
        .all()
        .filter((r) => r.storeId === storeId && (r.state === 'queued' || r.state === 'running'))
      // cancel() handles both live executors (flag + abort) and queued-not-
      // started runs (direct 'cancelled').
      for (const row of activeRuns) this.cancel(row.id)
      const pending = activeRuns
        .map((r) => settled.get(r.id))
        .filter((p): p is Promise<void> => Boolean(p))
      if (pending.length > 0) {
        await Promise.race([Promise.allSettled(pending), abortableSleep(15_000)])
      }
    },

    cancel(runId: string): Run {
      const row = findRow(runId)
      if (!row) throw Object.assign(new Error('Run not found'), { statusCode: 404 })
      if (row.state === 'queued' || row.state === 'running') {
        if (executing.has(runId)) {
          // Live executor: it re-reads the flag before each item, and the
          // abort tells the provider to interrupt the in-flight engine job.
          update(runId, { cancelRequested: true })
          aborters.get(runId)?.abort()
        } else {
          // No executor in this process (orphaned run) — cancel directly.
          const items = failUnfinishedItems(row, 'Cancelled')
          update(runId, { state: 'cancelled', cancelRequested: true, items })
          audit.record({ storeId: row.storeId, action: 'run.cancelled', detail: { runId } })
          return toRun({ ...row, state: 'cancelled', cancelRequested: true, items })
        }
      }
      return toRun({ ...row, cancelRequested: true })
    },

    /** Abort only the in-flight image; the rest of the batch keeps going. */
    skipCurrent(runId: string): Run {
      const row = findRow(runId)
      if (!row) throw Object.assign(new Error('Run not found'), { statusCode: 404 })
      if (!(row.state === 'running' || row.state === 'queued') || !executing.has(runId)) {
        throw Object.assign(new Error('No job is in flight for this run'), { statusCode: 400 })
      }
      // Swap in a fresh controller BEFORE aborting so the next item in the
      // loop picks up a live signal; only the current edit sees the abort.
      const inFlight = aborters.get(runId)
      aborters.set(runId, new AbortController())
      inFlight?.abort()
      audit.record({ storeId: row.storeId, action: 'run.item-skipped', detail: { runId } })
      return toRun(findRow(runId) ?? row)
    },

    /**
     * Clear a finished run from the history. Active runs must be cancelled
     * first — deleting a row mid-execution would strand its executor loop. Any
     * edits the run already staged stay in the review queue.
     */
    remove(runId: string): void {
      const row = findRow(runId)
      if (!row) throw Object.assign(new Error('Run not found'), { statusCode: 404 })
      if (row.state === 'queued' || row.state === 'running') {
        throw Object.assign(new Error('Cancel the run before clearing it'), { statusCode: 400 })
      }
      db.delete(runs).where(eq(runs.id, runId)).run()
      audit.record({ storeId: row.storeId, action: 'run.cleared', detail: { runId } })
    },

    get(id: string): Run | null {
      const row = findRow(id)
      return row ? toRun(row) : null
    },

    list(storeId?: string): Run[] {
      const base = db.select().from(runs)
      const query = storeId ? base.where(eq(runs.storeId, storeId)) : base
      return query.orderBy(desc(runs.createdAt)).limit(50).all().map(toRun)
    },

    /**
     * Stop cleanly on broker shutdown: drop anything still queued, abort
     * in-flight engine jobs, and record interrupted state now (boot recovery
     * remains the safety net for hard kills). The abort + markInterrupted
     * block MUST stay synchronous — callers rely on interrupted state being
     * recorded before shutdown() yields. Only then bounded-await executor
     * teardown so provider poll loops can fire their best-effort cancel/
     * interrupt calls before the process exits (the 8s bound stays under the
     * 10s force-exit timer so the WAL checkpoint still runs).
     */
    async shutdown(): Promise<void> {
      waiting.length = 0
      for (const controller of aborters.values()) controller.abort()
      for (const runId of executing) {
        const row = findRow(runId)
        if (row) {
          // Flag the run cancelled AND record interrupted state. The flag stops
          // the executor's next iteration; the terminal 'failed' state (via
          // isFinal) stops it from overwriting these values when the aborted
          // provider call unwinds during the drain below.
          update(runId, { cancelRequested: true })
          markInterrupted(row, 'Interrupted — broker shutting down')
        }
      }
      const pending = [...settled.values()]
      if (pending.length > 0) {
        await Promise.race([Promise.allSettled(pending), abortableSleep(8_000)])
      }
    },
  }
}

export type RunService = ReturnType<typeof createRunService>
