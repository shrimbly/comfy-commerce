import type { Graph, GraphNode } from './parse.js'

/**
 * ComfyUI editor-format (save format) support: convert a saved workflow into
 * an executable API-format graph, and read its App Mode (linear mode)
 * configuration when present.
 *
 * Conversion needs a node catalog (`/object_info` from a reachable engine) to
 * map positional `widgets_values` onto named inputs — the save format does
 * not store widget names.
 */

export type ObjectInfo = Record<
  string,
  {
    input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }
  }
>

interface EditorNodeInput {
  name: string
  type?: string
  link?: number | null
  widget?: { name?: string }
}

interface EditorNode {
  id: number | string
  type: string
  title?: string
  mode?: number
  inputs?: EditorNodeInput[]
  outputs?: Array<{ name?: string; type?: string }>
  widgets_values?: unknown[] | Record<string, unknown>
}

type EditorLinkTuple = [number, number | string, number, number | string, number, ...unknown[]]
interface EditorLinkObject {
  id: number
  origin_id: number | string
  origin_slot: number
  target_id: number | string
  target_slot: number
}

type EditorLink = EditorLinkTuple | EditorLinkObject

/** A subgraph definition — an inner graph with declared boundary slots. */
export interface SubgraphDef {
  id: string
  name?: string
  nodes: EditorNode[]
  links?: EditorLink[]
  /** Boundary inputs, in slot order; linkIds are the inner links they feed. */
  inputs?: Array<{ name?: string; type?: string; linkIds?: number[] | null }>
  /** Boundary outputs, in slot order; linkIds are the inner links feeding them. */
  outputs?: Array<{ name?: string; type?: string; linkIds?: number[] | null }>
}

export interface EditorFile {
  nodes: EditorNode[]
  links?: EditorLink[]
  definitions?: { subgraphs?: SubgraphDef[] }
  extra?: {
    linearMode?: boolean
    linearData?: {
      inputs?: Array<[string | number, string, ...unknown[]]>
      outputs?: Array<string | number>
    }
  }
}

export function isEditorFormat(raw: unknown): raw is EditorFile {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    Array.isArray((raw as { nodes?: unknown }).nodes)
  )
}

/** Nodes that exist only for the editor canvas — never part of execution. */
const COSMETIC_TYPES = new Set(['Note', 'MarkdownNote', 'Reroute'])

const SEED_CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])

/** A widget spec is `[type, options?]`; this reads the options object safely. */
function specOptions(spec: unknown[]): Record<string, unknown> {
  return (spec[1] && typeof spec[1] === 'object' ? spec[1] : {}) as Record<string, unknown>
}

/**
 * The engine's default for a standard widget — used to fill a *required* widget
 * the editor save omitted (the frontend always sends a value, so the engine
 * expects one). Returns undefined for custom widgets with no declared default.
 */
function widgetDefault(spec: unknown[]): unknown {
  const type = spec[0]
  const opts = specOptions(spec)
  if ('default' in opts) return opts.default
  if (Array.isArray(type)) return type[0]
  if (type === 'COMBO') {
    const options = Array.isArray(opts.options) ? opts.options : []
    return options[0]
  }
  if (type === 'INT' || type === 'FLOAT') return 0
  if (type === 'STRING') return ''
  if (type === 'BOOLEAN') return false
  return undefined
}

interface SpecInputGroups {
  required?: Record<string, unknown[]>
  optional?: Record<string, unknown[]>
}

/** Input specs of a node (or a dynamic-combo option), in declaration order. */
function specEntries(input: SpecInputGroups | undefined): Array<{ name: string; spec: unknown[] }> {
  const all = { ...(input?.required ?? {}), ...(input?.optional ?? {}) }
  return Object.entries(all)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([name, spec]) => ({ name, spec }))
}

/**
 * Map positional `widgets_values` onto named inputs by walking the node spec
 * in declaration order (mirrors the frontend's widget instantiation order).
 *
 * V3 dynamic schemas: a `COMFY_DYNAMICCOMBO_*` input is a widget whose value
 * is the selected option key; the option's nested inputs follow immediately
 * after it in `widgets_values` and serialize under dotted names
 * (`model.aspect_ratio`). `COMFY_AUTOGROW_*` / `COMFY_MATCHTYPE_*` groups
 * create input sockets only — their connected slots arrive as links with
 * dotted names already, and consume no widget values.
 */
function assignWidgetValues(
  inputs: Record<string, unknown>,
  entries: Array<{ name: string; spec: unknown[] }>,
  values: unknown[],
  state: { i: number },
  connectionNames: Set<string>,
  prefix = '',
): void {
  for (const { name, spec } of entries) {
    const type = spec[0]
    const opts = specOptions(spec)
    if (typeof type === 'string' && type.startsWith('COMFY_DYNAMICCOMBO_')) {
      if (state.i >= values.length) return
      const selected = values[state.i]
      state.i += 1
      inputs[`${prefix}${name}`] = selected
      const options = Array.isArray(opts.options) ? opts.options : []
      const option = options.find(
        (o): o is { key: unknown; inputs?: SpecInputGroups } =>
          o !== null && typeof o === 'object' && (o as { key?: unknown }).key === selected,
      )
      if (option?.inputs) {
        assignWidgetValues(
          inputs,
          specEntries(option.inputs),
          values,
          state,
          connectionNames,
          `${prefix}${name}.`,
        )
      }
      continue
    }
    if (typeof type === 'string' && (type.startsWith('COMFY_AUTOGROW_') || type.startsWith('COMFY_MATCHTYPE_'))) {
      continue
    }
    // A connection consumes no widgets_values slot. It's a connection if the
    // node lists it as a real input slot (this covers both link types like IMAGE
    // and custom input-only types like GEMINI_INPUT_FILES) or it's forced.
    // Everything else is a widget — including custom widgets like curve editors.
    const fullName = `${prefix}${name}`
    if (connectionNames.has(fullName) || opts.forceInput === true) continue
    if (state.i >= values.length) return
    // Arrays as widget values would read as links — wrap like the frontend.
    inputs[fullName] = Array.isArray(values[state.i]) ? { __value__: values[state.i] } : values[state.i]
    state.i += 1
    // Seed widgets serialize a companion control value ("randomize", …).
    const seedLike =
      Boolean(opts.control_after_generate) || name === 'seed' || name === 'noise_seed'
    if (
      seedLike &&
      typeof values[state.i] === 'string' &&
      SEED_CONTROL_VALUES.has(values[state.i] as string)
    ) {
      state.i += 1
    }
    // Upload widgets serialize a trailing pseudo-value.
    if (opts.image_upload === true && values[state.i] === 'image') state.i += 1
  }
}

/**
 * CustomCombo (the author-defined dropdown) carries dynamic `option1..optionN`
 * widgets the engine's static schema only partially declares, so the generic
 * spec-driven mapping drops options past the first few. Map them all directly
 * from the positional `widgets_values` ([choice, index, option1, option2, …])
 * so every choice stays selectable at run time and the app can offer the full
 * dropdown. Empty option slots (a trailing blank the editor leaves to grow
 * into) are skipped.
 */
function assignCustomComboValues(inputs: Record<string, unknown>, values: unknown[]): void {
  if (values.length > 0) inputs.choice = values[0]
  if (values.length > 1) inputs.index = values[1]
  let n = 1
  for (let k = 2; k < values.length; k += 1) {
    const v = values[k]
    if (typeof v === 'string' && v.trim() === '') continue
    inputs[`option${n}`] = v
    n += 1
  }
}

interface NormalizedLink {
  origin: string
  originSlot: number
}

function normalizeLinks(links: EditorLink[] | undefined): Map<number, NormalizedLink> {
  const map = new Map<number, NormalizedLink>()
  for (const link of links ?? []) {
    if (Array.isArray(link)) {
      map.set(link[0], { origin: String(link[1]), originSlot: link[2] })
    } else if (link && typeof link === 'object') {
      map.set(link.id, { origin: String(link.origin_id), originSlot: link.origin_slot })
    }
  }
  return map
}

/**
 * One graph level: the root workflow, or a subgraph instance's inner graph.
 * Subgraph instances are expanded recursively — inner nodes get namespaced
 * ids (`instance:inner`, matching ComfyUI's own API export).
 */
interface Scope {
  prefix: string
  nodes: Map<string, EditorNode>
  links: Map<number, NormalizedLink>
  /** Inner link id → boundary input slot it originates from. */
  boundaryOwner: Map<number, number>
  /** Boundary input name → promoted widget value on the instance. */
  boundaryWidgetValue: Map<string, unknown>
  instance: EditorNode | null
  def: SubgraphDef | null
  parent: Scope | null
  /** Child scopes keyed by the instance node id (within this scope). */
  children: Map<string, Scope>
}

type Resolved = { kind: 'link'; key: string; slot: number } | { kind: 'value'; value: unknown }

function buildScope(
  nodes: EditorNode[],
  links: EditorLink[] | undefined,
  defs: Map<string, SubgraphDef>,
  prefix: string,
  parent: Scope | null,
  instance: EditorNode | null,
  def: SubgraphDef | null,
  depth: number,
): Scope {
  if (depth > 10) {
    throw Object.assign(new Error('Subgraphs nest too deeply (or recursively)'), {
      statusCode: 422,
    })
  }
  const scope: Scope = {
    prefix,
    nodes: new Map(nodes.map((n) => [String(n.id), n])),
    links: normalizeLinks(links),
    boundaryOwner: new Map(),
    boundaryWidgetValue: new Map(),
    instance,
    def,
    parent,
    children: new Map(),
  }
  for (const [slot, input] of (def?.inputs ?? []).entries()) {
    for (const linkId of input.linkIds ?? []) scope.boundaryOwner.set(linkId, slot)
  }
  // Promoted widgets: instance inputs marked as widgets carry their values
  // positionally in the instance's widgets_values. Keyed by NAME — an
  // instance may materialize only a subset of the boundary inputs.
  if (instance && Array.isArray(instance.widgets_values)) {
    let i = 0
    for (const input of instance.inputs ?? []) {
      if (!input.widget) continue
      if (i >= instance.widgets_values.length) break
      scope.boundaryWidgetValue.set(input.name, instance.widgets_values[i])
      i += 1
    }
  }
  for (const node of nodes) {
    const childDef = defs.get(String(node.type))
    if (childDef) {
      scope.children.set(
        String(node.id),
        buildScope(
          childDef.nodes,
          childDef.links,
          defs,
          `${prefix}${node.id}:`,
          scope,
          node,
          childDef,
          depth + 1,
        ),
      )
    }
  }
  return scope
}

function resolveLinkId(scope: Scope, linkId: number, depth: number): Resolved | null {
  if (depth > 100) return null
  // Links originating at a boundary input resolve in the parent scope.
  const boundarySlot = scope.boundaryOwner.get(linkId)
  if (boundarySlot !== undefined) {
    // Match the instance's input BY NAME — instances materialize only the
    // boundary inputs the author touched, so indexes don't line up.
    const boundaryName = scope.def?.inputs?.[boundarySlot]?.name
    const outer = boundaryName
      ? (scope.instance?.inputs ?? []).find((i) => i.name === boundaryName)
      : scope.instance?.inputs?.[boundarySlot]
    if (outer?.link != null && scope.parent) {
      return resolveLinkId(scope.parent, outer.link, depth + 1)
    }
    const value = boundaryName ? scope.boundaryWidgetValue.get(boundaryName) : undefined
    if (value !== undefined && value !== null) return { kind: 'value', value }
    return null // unconnected optional input — inner defaults apply
  }
  const link = scope.links.get(linkId)
  if (!link) return null
  return resolveOrigin(scope, link.origin, link.originSlot, depth)
}

function resolveOrigin(scope: Scope, originId: string, slot: number, depth: number): Resolved | null {
  if (depth > 100) return null
  // Source is a subgraph instance: follow its boundary output inward.
  const child = scope.children.get(originId)
  if (child) {
    const innerLinkId = child.def?.outputs?.[slot]?.linkIds?.[0]
    if (innerLinkId == null) return null
    return resolveLinkId(child, innerLinkId, depth + 1)
  }
  const node = scope.nodes.get(originId)
  if (!node) return null
  if (node.type === 'Reroute') {
    const upstream = node.inputs?.[0]?.link
    return upstream == null ? null : resolveLinkId(scope, upstream, depth + 1)
  }
  if (node.mode === 4) {
    // Bypassed: route through, mirroring the frontend's slot matching —
    // wildcard prefers the same slot, then same-slot type match, then the
    // first input of the exact type.
    const outType = node.outputs?.[slot]?.type
    const inputs = node.inputs ?? []
    const compatible = (a?: string, b?: string) => !a || !b || a === b || a === '*' || b === '*'
    let match: EditorNodeInput | undefined
    if (outType === '*' || outType === '' || outType === undefined) {
      match = inputs[slot] ?? inputs[0]
    } else if (inputs[slot] && compatible(inputs[slot].type, outType)) {
      match = inputs[slot]
    } else {
      match = inputs.find((i) => i.type === outType) ?? inputs.find((i) => compatible(i.type, outType))
    }
    return match?.link != null ? resolveLinkId(scope, match.link, depth + 1) : null
  }
  if (node.mode === 2) return null // muted — produces nothing
  return { kind: 'link', key: `${scope.prefix}${originId}`, slot }
}

/**
 * Convert an editor-format workflow to an executable API graph, expanding
 * subgraphs. Throws (statusCode 422) for graphs the converter cannot handle.
 */
export function convertEditorGraph(file: EditorFile, objectInfo: ObjectInfo): Graph {
  const defs = new Map<string, SubgraphDef>()
  for (const def of file.definitions?.subgraphs ?? []) defs.set(String(def.id), def)

  const root = buildScope(file.nodes, file.links, defs, '', null, null, null, 0)
  const graph: Graph = {}

  function emitScope(scope: Scope): void {
    for (const node of scope.nodes.values()) {
      const id = String(node.id)
      if (node.mode === 2 || node.mode === 4) continue // muted / bypassed
      const child = scope.children.get(id)
      if (child) {
        emitScope(child)
        continue
      }
      if (COSMETIC_TYPES.has(node.type)) continue

      const api: GraphNode = {
        class_type: node.type,
        inputs: {},
        ...(node.title ? { _meta: { title: node.title } } : {}),
      }

      // The node's own input slots are connections — only widgets consume a
      // widgets_values slot. A widget converted to an input carries a `widget`
      // flag and still has a value, so it's excluded from the connection set.
      const connectionNames = new Set(
        (node.inputs ?? []).filter((inp) => !inp.widget).map((inp) => inp.name),
      )

      // Positional widget values → named inputs, via the engine's catalog.
      const values = node.widgets_values
      if (node.type === 'CustomCombo' && Array.isArray(values)) {
        // Mapped directly (not via the catalog): its options are dynamic and
        // the static schema underdeclares them. Works even if no engine knows
        // CustomCombo, so the dropdown still surfaces during inspection.
        assignCustomComboValues(api.inputs, values)
      } else if (values && !Array.isArray(values) && typeof values === 'object') {
        // Some packs (VHS) serialize widgets as a named object already. Keep
        // object values too (custom widgets) — only arrays must be wrapped so
        // they're not mistaken for a [node, slot] link.
        for (const [key, value] of Object.entries(values)) {
          if (value === null) continue
          api.inputs[key] = Array.isArray(value) ? { __value__: value } : value
        }
      } else if (Array.isArray(values) && values.length > 0) {
        if (!objectInfo[node.type]) {
          throw Object.assign(
            new Error(
              `No reachable engine knows the node "${node.type}" — cannot interpret this editor export. Install its node pack on an engine, or use "Export (API)".`,
            ),
            { statusCode: 422 },
          )
        }
        assignWidgetValues(
          api.inputs,
          specEntries(objectInfo[node.type]?.input),
          values,
          { i: 0 },
          connectionNames,
        )
      }

      // Connections override widget placeholders.
      for (const input of node.inputs ?? []) {
        if (input.link == null) continue
        const resolved = resolveLinkId(scope, input.link, 0)
        if (resolved?.kind === 'link') api.inputs[input.name] = [resolved.key, resolved.slot]
        else if (resolved?.kind === 'value') api.inputs[input.name] = resolved.value
      }

      // Required widgets the editor save omitted get the engine's default — the
      // frontend always sends a widget value, so the engine expects one (e.g.
      // ImageCompare.compare_view). Connections and custom widgets without a
      // declared default are left alone.
      for (const [name, spec] of Object.entries(objectInfo[node.type]?.input?.required ?? {})) {
        if (!Array.isArray(spec) || name in api.inputs || connectionNames.has(name)) continue
        const opts = specOptions(spec)
        if (opts.forceInput === true) continue
        const fallback = widgetDefault(spec)
        if (fallback !== undefined) api.inputs[name] = fallback
      }

      graph[`${scope.prefix}${id}`] = api
    }
  }
  emitScope(root)

  // Final prune (mirrors the frontend): drop link inputs that reference
  // nodes excluded from the prompt (muted/bypassed/virtual).
  for (const node of Object.values(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string' && !graph[value[0]]) {
        delete node.inputs[key]
      }
    }
  }

  if (Object.keys(graph).length === 0) {
    throw Object.assign(new Error('No executable nodes found in this workflow'), {
      statusCode: 422,
    })
  }
  return graph
}

export interface AppModeData {
  /** Author-exposed inputs: node + widget name (dangling entries dropped). */
  inputs: Array<{ nodeId: string; widget: string }>
  outputNodeId: string | null
}

/** Read App Mode (linear mode) configuration from an editor export. */
export function extractAppMode(file: EditorFile): AppModeData | null {
  const data = file.extra?.linearData
  // App Mode is on unless explicitly disabled: newer ComfyUI exports carry the
  // curated `linearData` without a separate `linearMode` flag, so requiring
  // `linearMode === true` would silently ignore the author's curated inputs.
  if (file.extra?.linearMode === false || !data?.inputs?.length) return null
  const ids = new Set(file.nodes.map((n) => String(n.id)))
  const inputs = data.inputs
    .filter((entry) => Array.isArray(entry) && entry.length >= 2 && ids.has(String(entry[0])))
    .map(([nodeId, widget]) => ({ nodeId: String(nodeId), widget: String(widget) }))
  const output = (data.outputs ?? []).map(String).find((id) => ids.has(id)) ?? null
  if (inputs.length === 0 && !output) return null
  return { inputs, outputNodeId: output }
}
