/**
 * Workflows — the first-class editing unit. A workflow is either a built-in
 * (shipped with the app; the broker constructs its graph at run time) or a
 * user-uploaded ComfyUI API-format graph with bound input/output nodes and
 * curated run-time parameters.
 */

export type WorkflowSource = 'builtin' | 'user'

export interface WorkflowParam {
  /** Stable id used as the key in run params, e.g. "prompt". */
  id: string
  label: string
  type: 'text' | 'select' | 'number'
  /** Graph binding (user workflows only): which node input this sets. */
  nodeId?: string
  inputKey?: string
  defaultValue?: string
  placeholder?: string
  options?: Array<{ value: string; label: string }>
}

export interface EngineCompat {
  /** null = not checked (engine unreachable); true/false = checked. */
  compatible: boolean | null
  /** Node class_types the engine is missing (when incompatible). */
  missingNodes: string[]
}

/**
 * A fixed reference image baked into a workflow: a LoadImage-style node bound
 * to a constant asset (e.g. a model reference held steady across every run),
 * supplied once at upload rather than per run.
 */
export interface FixedInput {
  /** The graph node (a LoadImage/LoadImageMask) this image is fed into. */
  nodeId: string
  /** Asset id (served from /api/assets) supplying the constant image. */
  assetId: string
  /** Author's label for the slot, e.g. "Model reference". */
  label?: string
}

export interface Workflow {
  id: string
  name: string
  description: string
  source: WorkflowSource
  params: WorkflowParam[]
  /** Custom thumbnail (served from /api/assets), null ⇒ generated gradient. */
  imageUrl: string | null
  /** Second image (served from /api/assets) revealed by the grid card's hover-wipe; null ⇒ no wipe. */
  compareImageUrl: string | null
  /** Node count of the underlying graph (0 for builtins). */
  nodeCount: number
  /** Per-engine compatibility, keyed by provider id. */
  compat: Record<string, EngineCompat>
  /** Constant reference images bound at upload (empty for most workflows). */
  fixedInputs: FixedInput[]
  createdAt: string
}

/* ── upload inspection ─────────────────────────────────────────── */

export interface NodeCandidate {
  nodeId: string
  classType: string
  /** Human label: node title if present, else class type. */
  label: string
}

export interface ParamCandidate {
  nodeId: string
  inputKey: string
  classType: string
  label: string
  valueType: 'text' | 'number' | 'select'
  currentValue: string
  /** Discrete choices when the input is a combo/dropdown (e.g. CustomCombo). */
  options?: Array<{ value: string; label: string }>
}

export interface WorkflowInspection {
  nodeCount: number
  /** Non-null when binding is unambiguous (exactly one input + one output). */
  autoBinding: { inputNodeId: string; outputNodeId: string } | null
  inputCandidates: NodeCandidate[]
  outputCandidates: NodeCandidate[]
  paramCandidates: ParamCandidate[]
  /**
   * Present when the upload was a ComfyUI editor export with an App Mode
   * (linear mode) configuration — the author's curated inputs.
   */
  appMode?: {
    params: ParamCandidate[]
    inputNodeId: string | null
    outputNodeId: string | null
  }
}
