import type {
  NodeCandidate,
  ParamCandidate,
  WorkflowInspection,
} from '@comfy-commerce/shared'

/**
 * ComfyUI API-format graph parsing: detect where a product image can be fed
 * in, where the result comes out, and which literal inputs make sensible
 * run-time parameters.
 */

export interface GraphNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

export type Graph = Record<string, GraphNode>

const INPUT_CLASS_TYPES = new Set(['LoadImage', 'LoadImageMask'])
const OUTPUT_CLASS_TYPES = new Set([
  'SaveImage',
  'PreviewImage',
  'SaveImageWebsocket',
  'SaveAnimatedWEBP',
  'SaveAnimatedPNG',
  'SaveVideo',
  'VHS_VideoCombine',
])
/** Preview nodes are rewritten to SaveImage so outputs are persisted. */
const PREVIEW_CLASS_TYPES = new Set(['PreviewImage', 'SaveImageWebsocket'])

/** Inputs that are never useful as user-facing params. */
const PARAM_SKIP_KEYS = new Set([
  'image',
  'filename_prefix',
  'choose file to upload',
  'upload',
])

function isLink(value: unknown): boolean {
  return Array.isArray(value)
}

/**
 * COMBO option lists that aren't carried in the graph — they live in the node's
 * `/object_info` schema, which the broker doesn't fetch. Keyed by class_type then
 * by the widget's leaf name (dynamic-combo sub-widgets serialize under dotted
 * names like `model.aspect_ratio`, so we match the last segment). Add partner
 * nodes here so their dropdowns render as selects rather than free text.
 */
const KNOWN_COMBOS: Record<string, Record<string, string[]>> = {
  GeminiNanoBanana2V2: {
    aspect_ratio: ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '8:1', '1:8'],
    resolution: ['1K', '2K', '4K'],
    thinking_level: ['MINIMAL', 'HIGH'],
    response_modalities: ['IMAGE', 'IMAGE+TEXT'],
  },
}

/**
 * Discrete dropdown choices for an input when it is a combo, else null.
 * Recognises `CustomCombo` — the author-defined dropdown whose choices live in
 * its sibling `option1..optionN` inputs and are selected by the `choice` widget
 * — plus the curated `KNOWN_COMBOS` registry for partner nodes whose options
 * come from `/object_info` rather than the graph.
 */
export function comboOptions(
  node: GraphNode,
  inputKey: string,
): Array<{ value: string; label: string }> | null {
  if (node.class_type === 'CustomCombo' && inputKey === 'choice') {
    const seen = new Set<string>()
    const values = Object.entries(node.inputs)
      .filter((e): e is [string, string] => /^option\d+$/.test(e[0]) && typeof e[1] === 'string')
      .sort((a, b) => Number(a[0].slice('option'.length)) - Number(b[0].slice('option'.length)))
      .map(([, v]) => v.trim())
      .filter((v) => v !== '' && !seen.has(v) && (seen.add(v), true))
    return values.length > 0 ? values.map((v) => ({ value: v, label: v })) : null
  }
  const leaf = inputKey.includes('.') ? inputKey.slice(inputKey.lastIndexOf('.') + 1) : inputKey
  const known = KNOWN_COMBOS[node.class_type]?.[leaf]
  return known ? known.map((v) => ({ value: v, label: v })) : null
}

/** ComfyUI `/object_info` — loosely typed; only the COMBO shapes are read. */
export type ObjectInfo = Record<
  string,
  { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
>

/** Option strings from an `/object_info` input spec, or null if it isn't a COMBO. */
function optionsFromSpec(spec: unknown): string[] | null {
  if (!Array.isArray(spec)) return null
  const type = spec[0]
  // Classic combos: the type IS the array of options. V3 combos: type 'COMBO'
  // with the options under the config object.
  const raw = Array.isArray(type)
    ? type
    : type === 'COMBO' && spec[1] && typeof spec[1] === 'object'
      ? (spec[1] as { options?: unknown }).options
      : null
  if (!Array.isArray(raw)) return null
  const values = raw.filter((v): v is string => typeof v === 'string')
  return values.length > 0 ? values : null
}

/**
 * Generic COMBO option resolution from `/object_info` — works for ANY node, not
 * just the curated registry. Handles plain combos (`sampler_name`) and the
 * dotted sub-widgets of a dynamic combo (`model.aspect_ratio`): it walks each
 * dotted segment, descending into the selected dynamic-combo option's nested
 * inputs (the selected key is read from the node's own value).
 */
export function comboOptionsFromObjectInfo(
  objectInfo: ObjectInfo | undefined,
  node: GraphNode,
  inputKey: string,
): Array<{ value: string; label: string }> | null {
  const spec = objectInfo?.[node.class_type]?.input
  if (!spec) return null
  let entries: Record<string, unknown> = { ...(spec.required ?? {}), ...(spec.optional ?? {}) }
  const parts = inputKey.split('.')
  for (let depth = 0; depth < parts.length; depth += 1) {
    const entry = entries[parts[depth]!]
    if (depth === parts.length - 1) {
      const options = optionsFromSpec(entry)
      return options ? options.map((v) => ({ value: v, label: v })) : null
    }
    // Intermediate segment: descend into the selected dynamic-combo option.
    if (!Array.isArray(entry)) return null
    const cfg = entry[1] as { options?: unknown } | undefined
    const dynOptions = Array.isArray(cfg?.options) ? cfg!.options : []
    const selected = node.inputs[parts.slice(0, depth + 1).join('.')]
    const option = dynOptions.find(
      (o): o is { key: unknown; inputs?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } =>
        o !== null && typeof o === 'object' && (o as { key?: unknown }).key === selected,
    )
    if (!option?.inputs) return null
    entries = { ...(option.inputs.required ?? {}), ...(option.inputs.optional ?? {}) }
  }
  return null
}

function nodeLabel(id: string, node: GraphNode): string {
  return node._meta?.title?.trim() || `${node.class_type} (#${id})`
}

export function parseGraph(raw: unknown): Graph {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Workflow must be a ComfyUI API-format JSON object')
  }
  // Some exports wrap the graph in {prompt: {...}}.
  const candidate = ('prompt' in raw && typeof (raw as { prompt: unknown }).prompt === 'object'
    ? (raw as { prompt: unknown }).prompt
    : raw) as Record<string, unknown>

  const entries = Object.entries(candidate).filter(
    ([, v]) => v !== null && typeof v === 'object' && 'class_type' in (v as object),
  )
  if (entries.length === 0) {
    throw new Error(
      'No nodes found. Export the workflow with "Export (API)" in ComfyUI — the editor format is not runnable.',
    )
  }
  return Object.fromEntries(entries) as Graph
}

export function inspectGraph(graph: Graph, objectInfo?: ObjectInfo): WorkflowInspection {
  const inputCandidates: NodeCandidate[] = []
  const outputCandidates: NodeCandidate[] = []
  const paramCandidates: ParamCandidate[] = []

  for (const [nodeId, node] of Object.entries(graph)) {
    const label = nodeLabel(nodeId, node)
    if (INPUT_CLASS_TYPES.has(node.class_type)) {
      inputCandidates.push({ nodeId, classType: node.class_type, label })
    }
    if (OUTPUT_CLASS_TYPES.has(node.class_type)) {
      outputCandidates.push({ nodeId, classType: node.class_type, label })
    }
    for (const [inputKey, value] of Object.entries(node.inputs)) {
      if (isLink(value)) continue
      if (PARAM_SKIP_KEYS.has(inputKey.toLowerCase())) continue
      // A CustomCombo's option list and numeric index are folded into its
      // `choice` dropdown — never surface them as separate params.
      if (node.class_type === 'CustomCombo' && (inputKey === 'index' || /^option\d+$/.test(inputKey)))
        continue
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const options =
        comboOptions(node, inputKey) ?? comboOptionsFromObjectInfo(objectInfo, node, inputKey)
      paramCandidates.push({
        nodeId,
        inputKey,
        classType: node.class_type,
        label: `${label} · ${inputKey}`,
        valueType: options ? 'select' : typeof value === 'number' ? 'number' : 'text',
        currentValue: String(value),
        ...(options ? { options } : {}),
      })
    }
  }

  const autoBinding =
    inputCandidates.length === 1 && outputCandidates.length >= 1
      ? {
          inputNodeId: inputCandidates[0]!.nodeId,
          // Prefer a SaveImage over PreviewImage when both exist.
          outputNodeId: (
            outputCandidates.find((c) => c.classType === 'SaveImage') ?? outputCandidates[0]!
          ).nodeId,
        }
      : null

  return {
    nodeCount: Object.keys(graph).length,
    autoBinding,
    inputCandidates,
    outputCandidates,
    paramCandidates,
  }
}

export interface PatchParams {
  /**
   * Image bindings — each node's `image` input set to an uploaded filename.
   * Includes the product input plus any fixed reference images.
   */
  images: Array<{ nodeId: string; imageName: string }>
  /** Bound output node — converted to SaveImage if it is a preview node. */
  outputNodeId: string
  /** Param assignments: nodeId+inputKey → value (numbers coerced). */
  assignments: Array<{ nodeId: string; inputKey: string; value: string }>
  /**
   * Seed applied to every seed input for run-to-run variation — matches `seed`
   * and any `*_seed` leaf, including dotted dynamic-combo keys like
   * `output_mode.texture_seed`. Deterministic per seedKey (which carries the run
   * id), so each run varies while a given run stays reproducible.
   */
  seed: number
}

/** Produce a runnable copy of the graph bound to its concrete input images. */
export function patchGraph(graph: Graph, params: PatchParams): Graph {
  const patched: Graph = structuredClone(graph)

  for (const { nodeId, imageName } of params.images) {
    const inputNode = patched[nodeId]
    if (!inputNode) throw new Error(`Bound input node ${nodeId} missing from graph`)
    inputNode.inputs.image = imageName
  }

  const outputNode = patched[params.outputNodeId]
  if (!outputNode) throw new Error(`Bound output node ${params.outputNodeId} missing from graph`)
  if (PREVIEW_CLASS_TYPES.has(outputNode.class_type)) {
    outputNode.class_type = 'SaveImage'
    outputNode.inputs = { images: outputNode.inputs.images, filename_prefix: 'comfy-commerce' }
  }

  for (const { nodeId, inputKey, value } of params.assignments) {
    const node = patched[nodeId]
    if (!node) continue
    const current = node.inputs[inputKey]
    node.inputs[inputKey] = typeof current === 'number' ? Number(value) : value
  }

  // Randomise every seed input so runs actually vary. ComfyUI's API format names
  // seeds inconsistently: core samplers use `seed`, partner nodes use
  // `model_seed`/`noise_seed`, and dynamic-combo widgets flatten to dotted keys
  // (e.g. `output_mode.texture_seed`). Match any numeric input whose leaf name is
  // `seed` or ends in `_seed` — matching only a literal `seed` leaves those pinned
  // seeds untouched, so the node returns a byte-identical result every run.
  for (const node of Object.values(patched)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'number') continue
      const leaf = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key
      if (leaf === 'seed' || leaf.endsWith('_seed')) node.inputs[key] = params.seed
    }
  }

  // CustomCombo's executable output is driven by its numeric `index`, but App
  // Mode exposes the human-readable `choice`. A headless run has no frontend to
  // keep the two in sync, so re-derive `index` from the selected `choice` —
  // otherwise picking any option still runs whichever index was last saved.
  for (const node of Object.values(patched)) {
    if (node.class_type !== 'CustomCombo') continue
    const choice = node.inputs.choice
    if (typeof choice !== 'string') continue
    const options = Object.entries(node.inputs)
      .filter((e): e is [string, string] => /^option\d+$/.test(e[0]) && typeof e[1] === 'string')
      .sort((a, b) => Number(a[0].slice('option'.length)) - Number(b[0].slice('option'.length)))
      .map(([, v]) => v)
    const idx = options.indexOf(choice)
    if (idx >= 0) node.inputs.index = idx
  }

  return patched
}

/** Distinct node class types — used for engine compatibility checks. */
export function graphClassTypes(graph: Graph): string[] {
  return [...new Set(Object.values(graph).map((n) => n.class_type))].sort()
}
