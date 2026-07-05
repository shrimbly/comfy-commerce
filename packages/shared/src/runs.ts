/**
 * Runs — one execution of a workflow over a target set of media, on a chosen
 * engine. Targets range from a hand-picked selection up to the entire
 * in-scope catalog. Results stage into the review queue as they complete;
 * a run never publishes anything.
 */

import type { StageAction, StagedMediaType } from './staging.js'

/**
 * The internal catalog-enrichment workflow id. Runs of this workflow caption
 * images to the media_enrichment store instead of staging edits — the web app
 * keys its enrichment trigger + run presentation off this constant.
 */
export const CAPTION_WORKFLOW_ID = 'builtin:caption'

export type ProviderId = 'mock' | 'comfy-local' | 'comfy-remote' | 'comfy-cloud'

export interface ProviderInfo {
  id: ProviderId
  name: string
  kind: 'mock' | 'local' | 'remote' | 'cloud'
  description: string
  available: boolean
  detail: string | null
}

/** One image within a run. */
export interface MediaRef {
  productId: string
  mediaId: string
}

export type RunTargetKind = 'selection' | 'products' | 'catalog'

export interface RunTarget {
  kind: RunTargetKind
  /** kind = 'selection' */
  inputs?: MediaRef[]
  /** kind = 'products' */
  productIds?: string[]
}

export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type RunItemState = 'pending' | 'editing' | 'done' | 'failed'

export interface RunItem {
  input: MediaRef
  productTitle: string
  state: RunItemState
  afterUrl: string | null
  /** Output media type — set on completion (image unless the workflow emits video/3D). */
  mediaType?: StagedMediaType
  error: string | null
}

export interface Run {
  id: string
  storeId: string
  workflowId: string
  workflowName: string
  providerId: ProviderId
  params: Record<string, string>
  targetKind: RunTargetKind
  stageAction: StageAction
  source: 'ui' | 'api'
  /** True when this is a small test run cut from a larger target. */
  sample: boolean
  /** Image count of the full target this sample was cut from. */
  sampleOfTotal: number | null
  /** Root run of the retry chain, when this run was created by Retry. */
  retryOfRunId?: string | null
  state: RunState
  items: RunItem[]
  error: string | null
  createdAt: string
  updatedAt: string
}

export function runCounts(run: Pick<Run, 'items'>): { total: number; done: number; failed: number } {
  let done = 0
  let failed = 0
  for (const item of run.items) {
    if (item.state === 'done') done += 1
    else if (item.state === 'failed') failed += 1
  }
  return { total: run.items.length, done, failed }
}

export interface RunEstimate {
  images: number
  products: number
}
