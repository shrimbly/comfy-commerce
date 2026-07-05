import type { ProviderId, ProviderInfo, StagedMediaType } from '@comfy-commerce/shared'

import type { Graph } from '../workflows/parse.js'

/** What an engine is asked to execute, resolved by the run service. */
export type WorkflowExecution =
  | {
      kind: 'graph'
      graph: Graph
      /** Bound node fed the per-run product image. */
      inputNodeId: string
      outputNodeId: string
      /** Param assignments already resolved to node inputs. */
      assignments: Array<{ nodeId: string; inputKey: string; value: string }>
      /**
       * Constant reference images, resolved from assets to bytes once per run.
       * Each is uploaded by the provider and bound to its node alongside the
       * product image.
       */
      fixedImages: Array<{
        nodeId: string
        bytes: Buffer
        mimeType: string
        filename: string
      }>
      /** Stable hash of the workflow for deterministic mock rendering. */
      workflowKey: string
    }
  | {
      /**
       * Catalog enrichment: caption an image to TEXT (no pixels produced). The
       * provider builds a VLM graph from these params, runs it, and returns the
       * sink node's text — which the run service parses into caption + tags.
       */
      kind: 'caption'
      /** VLM checkpoint, e.g. "Qwen2.5-VL-3B-Instruct". */
      model: string
      /** Instruction handed to the VLM (asks for a caption + a TAGS: line). */
      prompt: string
      workflowKey: string
    }

export interface EditRequest {
  /** Absolute URL the provider can fetch the "before" image from. */
  imageUrl: string
  altText: string
  workflow: WorkflowExecution
  /** Stable key for deterministic output (mediaId). */
  seedKey: string
  /**
   * Aborted when the run is cancelled — providers should interrupt the
   * in-flight engine job and throw.
   */
  signal?: AbortSignal
}

export interface EditOutput {
  /** Root-relative or absolute URL of a produced result. */
  url: string
  mediaType: StagedMediaType
}

export interface EditResult {
  /** Everything the workflow produced — graphs can emit several images and/or videos. */
  outputs: EditOutput[]
}

export interface CaptionRequest {
  /** Absolute URL the provider can fetch the image from. */
  imageUrl: string
  /** VLM checkpoint to run. */
  model: string
  /** Instruction handed to the VLM. */
  prompt: string
  /** Stable key for deterministic mock output (mediaId). */
  seedKey: string
  signal?: AbortSignal
}

export interface CaptionResult {
  /** Raw text from the workflow's text sink, before caption/tag parsing. */
  text: string
}

/**
 * Generation provider — the pluggable engine that does the pixel work.
 * The review pipeline never depends on which provider produced an image.
 */
export interface GenerationProvider {
  id: ProviderId
  name: string
  kind: ProviderInfo['kind']
  description: string
  availability(): Promise<{ available: boolean; detail: string | null }>
  edit(request: EditRequest): Promise<EditResult>
  /** Caption an image to text (catalog enrichment). */
  caption(request: CaptionRequest): Promise<CaptionResult>
}
