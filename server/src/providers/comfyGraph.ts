/**
 * Graph construction and output helpers for ComfyUI-API-compatible engines
 * (local ComfyUI and Comfy Cloud — the Cloud API is wire-compatible).
 */

import type { StagedMediaType } from '@comfy-commerce/shared'

export function hashSeed(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * Caption graph: LoadImage → downscale → Google Gemini → PreviewAny.
 *
 * `GeminiNode` is a Comfy Cloud partner/API node (authenticated via the
 * comfy.org key both providers put in `extra_data`). It emits a STRING; the core
 * PreviewAny "sink" — an OUTPUT node — surfaces it into the job `outputs` as
 * outputs[sink].text, which collectText reads back.
 *
 * Two empirically-verified gotchas (Gemini returns an empty/null result, not an
 * error, when violated): the image MUST be downscaled first (its vision endpoint
 * yields nothing for very large inputs — Florence resized internally, Gemini does
 * not), and the prompt must phrase the keyword list as natural prose — asking for
 * a rigid "TAGS:"/JSON structure makes Gemini return nothing (see CAPTION_PROMPT).
 */
export function buildCaptionGraph(
  model: string,
  prompt: string,
  imageName: string,
  // Per-run seed. The image uploads under a content-hash name and the prompt is
  // fixed, so a constant seed makes every re-caption a byte-identical graph that
  // Comfy (local/Cloud) serves entirely from cache — and a fully cached job
  // surfaces no text. A run-varying seed forces a real execution each time.
  seed: number,
): { graph: Record<string, unknown>; sinkNodeId: string } {
  const graph: Record<string, unknown> = {
    '1': { class_type: 'LoadImage', inputs: { image: imageName } },
    // ~1 MP keeps ample detail for captioning while staying under Gemini's limit.
    '2': {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: ['1', 0], upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 1 },
    },
    '3': {
      class_type: 'GeminiNode',
      inputs: { prompt, model, seed, images: ['2', 0] },
    },
    // GeminiNode's STRING is output index 0; PreviewAny surfaces it into the job
    // outputs as outputs[sink].text.
    '4': { class_type: 'PreviewAny', inputs: { source: ['3', 0] } },
  }
  return { graph, sinkNodeId: '4' }
}

/**
 * Upload a graph's fixed reference images via the provider's own upload
 * mechanism, returning the node→filename bindings for buildExecutionGraph.
 * Built-ins have none, so this is a no-op for them.
 */
export async function uploadFixedImages(
  execution: import('./types.js').WorkflowExecution,
  upload: (bytes: Buffer, filename: string, mimeType: string) => Promise<string>,
): Promise<Array<{ nodeId: string; imageName: string }>> {
  if (execution.kind !== 'graph') return []
  const bound: Array<{ nodeId: string; imageName: string }> = []
  for (const fixed of execution.fixedImages) {
    bound.push({ nodeId: fixed.nodeId, imageName: await upload(fixed.bytes, fixed.filename, fixed.mimeType) })
  }
  return bound
}

/**
 * Resolve a WorkflowExecution into a submittable API-format graph: built-ins
 * use the img2img builder (adapting to the engine's checkpoint); user
 * workflows get their bound nodes patched.
 */
export async function buildExecutionGraph(
  execution: import('./types.js').WorkflowExecution,
  opts: {
    imageName: string
    /** Uploaded fixed reference images, node→filename (from uploadFixedImages). */
    fixedImages?: Array<{ nodeId: string; imageName: string }>
    seedKey: string
    resolveCheckpoint: () => Promise<string>
  },
): Promise<Record<string, unknown>> {
  const seed = hashSeed(opts.seedKey)
  if (execution.kind === 'caption') {
    throw new Error('Caption workflows run via provider.caption(), not buildExecutionGraph')
  }
  const { patchGraph } = await import('../workflows/parse.js')
  return patchGraph(execution.graph, {
    images: [
      { nodeId: execution.inputNodeId, imageName: opts.imageName },
      ...(opts.fixedImages ?? []),
    ],
    outputNodeId: execution.outputNodeId,
    assignments: execution.assignments,
    seed,
  }) as Record<string, unknown>
}

interface ComfyFileRef {
  filename: string
  subfolder: string
  type: string
}

/**
 * Outputs object shape shared by local /history and cloud /api/jobs.
 * Image nodes report under `images`; video nodes (core SaveVideo,
 * VideoHelperSuite, …) report under `videos` or `gifs`.
 */
export interface ComfyOutputs {
  [nodeId: string]: {
    images?: ComfyFileRef[]
    videos?: ComfyFileRef[]
    gifs?: ComfyFileRef[]
    /** Text sinks (PreviewAny / ShowText) report their string here. */
    text?: string[]
    /** 3D and other save nodes report file refs under their own keys. */
    [key: string]: unknown
  }
}

export interface ComfyOutputFile extends ComfyFileRef {
  mediaType: StagedMediaType
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i
const MODEL_EXT = /\.(glb|gltf|usdz)$/i

function mediaTypeForFile(filename: string): StagedMediaType {
  if (MODEL_EXT.test(filename)) return 'model3d'
  if (VIDEO_EXT.test(filename)) return 'video'
  return 'image'
}

/** A history-output entry that points at a produced file (carries a filename). */
function isFileRef(value: unknown): value is ComfyFileRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { filename?: unknown }).filename === 'string'
  )
}

/**
 * Collect every file the workflow produced, across all output nodes and
 * media kinds. Scans every array-valued output field — not just
 * images/videos/gifs — so 3D save nodes that report GLBs under their own
 * keys are picked up too. Files saved by output nodes (`type === 'output'`)
 * are preferred over temp/preview files when both exist.
 */
export function collectOutputFiles(outputs: ComfyOutputs | undefined): ComfyOutputFile[] {
  const files: ComfyOutputFile[] = []
  for (const node of Object.values(outputs ?? {})) {
    for (const value of Object.values(node)) {
      if (!Array.isArray(value)) continue
      for (const ref of value) {
        if (isFileRef(ref)) files.push({ ...ref, mediaType: mediaTypeForFile(ref.filename) })
      }
    }
  }
  const saved = files.filter((f) => f.type === 'output')
  return saved.length > 0 ? saved : files
}

/**
 * Read the text a sink node surfaced into the history outputs. Prefers the
 * known sink node id, falling back to any node that carries text. Returns null
 * while no text is present yet (so the caller keeps polling).
 */
export function collectText(outputs: ComfyOutputs | undefined, preferNodeId?: string): string | null {
  const textOf = (node?: { text?: string[] }): string | null => {
    const joined = (node?.text ?? []).join('').trim()
    return joined.length > 0 ? joined : null
  }
  if (preferNodeId) {
    const preferred = textOf(outputs?.[preferNodeId])
    if (preferred !== null) return preferred
  }
  for (const node of Object.values(outputs ?? {})) {
    const text = textOf(node)
    if (text !== null) return text
  }
  return null
}
