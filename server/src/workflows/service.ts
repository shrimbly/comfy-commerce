import { randomUUID } from 'node:crypto'

import type {
  EngineCompat,
  FixedInput,
  ParamCandidate,
  Workflow,
  WorkflowParam,
} from '@comfy-commerce/shared'
import { desc, eq } from 'drizzle-orm'

import type { Db } from '../db/client.js'
import { workflows } from '../db/schema.js'
import type { Env } from '../env.js'
import { resilientFetch } from '../providers/http.js'
import type { Audit } from '../services/audit.js'
import type { SettingsService } from '../services/settingsService.js'
import { apiToWorkflow } from './apiToWorkflow.js'
import { BUILTIN_PREFIX, BUILTIN_WORKFLOWS, getBuiltin } from './builtins.js'
import {
  CAPTION_MODEL,
  CAPTION_PROMPT,
  CAPTION_WORKFLOW_ID,
  CAPTION_WORKFLOW_NAME,
} from './caption.js'
import {
  convertEditorGraph,
  extractAppMode,
  isEditorFormat,
  type AppModeData,
  type ObjectInfo,
} from './editor.js'
import {
  comboOptions,
  comboOptionsFromObjectInfo,
  graphClassTypes,
  inspectGraph,
  parseGraph,
  type Graph,
} from './parse.js'

type Row = typeof workflows.$inferSelect

/** Class types whose `image` widget binds a reference image, not a text param. */
const IMAGE_LOADER_CLASS_TYPES = new Set(['LoadImage', 'LoadImageMask'])

/** kebab-case a workflow name for a download filename. */
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export interface SaveWorkflowInput {
  name: string
  description?: string
  graph: unknown
  inputNodeId?: string
  outputNodeId?: string
  params?: WorkflowParam[]
  fixedInputs?: FixedInput[]
}

export interface ResolvedWorkflow {
  id: string
  name: string
  /** Caption workflows run via provider.caption(); everything else via its graph. */
  execution:
    | { kind: 'caption'; model: string; prompt: string }
    | {
        kind: 'graph'
        graph: Graph
        inputNodeId: string
        outputNodeId: string
        params: WorkflowParam[]
        fixedInputs: FixedInput[]
      }
}

/**
 * Validate fixed reference images against a graph: each must point at a
 * LoadImage-style node that isn't the per-run product input, with an asset,
 * and no node may be claimed twice.
 */
function validateFixedInputs(
  graph: Graph,
  productNodeId: string,
  fixedInputs: FixedInput[],
): FixedInput[] {
  const imageNodeIds = new Set(
    Object.entries(graph)
      .filter(([, n]) => IMAGE_LOADER_CLASS_TYPES.has(n.class_type))
      .map(([id]) => id),
  )
  const seen = new Set<string>()
  const clean: FixedInput[] = []
  for (const fixed of fixedInputs) {
    const assetId = fixed.assetId?.trim()
    if (!assetId) {
      throw Object.assign(new Error('A fixed reference image is missing its asset'), { statusCode: 422 })
    }
    if (!imageNodeIds.has(fixed.nodeId)) {
      throw Object.assign(
        new Error(`Fixed-image node ${fixed.nodeId} is not a LoadImage in this graph`),
        { statusCode: 422 },
      )
    }
    if (fixed.nodeId === productNodeId) {
      throw Object.assign(new Error('The product input node cannot also hold a fixed image'), {
        statusCode: 422,
      })
    }
    if (seen.has(fixed.nodeId)) {
      throw Object.assign(new Error(`Node ${fixed.nodeId} has more than one fixed image`), {
        statusCode: 422,
      })
    }
    seen.add(fixed.nodeId)
    clean.push({ nodeId: fixed.nodeId, assetId, ...(fixed.label?.trim() ? { label: fixed.label.trim() } : {}) })
  }
  return clean
}

/**
 * Engine node catalogs for compatibility checks, cached briefly. An engine
 * that can't be reached reports `compatible: null` (unknown), not false.
 */
/** Engines whose object_info we probe for compatibility, in display order. */
const COMPAT_ENGINES = ['comfy-local', 'comfy-remote', 'comfy-cloud'] as const
type CompatEngine = (typeof COMPAT_ENGINES)[number]

/** The object_info endpoint for an engine, or null when it isn't configured. */
function engineObjectInfo(
  engine: CompatEngine,
  env: Env,
  settings: SettingsService,
): { url: string; headers: Record<string, string> } | null {
  if (engine === 'comfy-local') return { url: `${env.comfyLocalUrl}/object_info`, headers: {} }
  if (engine === 'comfy-remote') {
    const base = settings.getRemoteComfyUrl()
    return base ? { url: `${base}/object_info`, headers: {} } : null
  }
  const cloudKey = settings.getCloudApiKey()
  return cloudKey
    ? { url: `${env.comfyCloud.apiUrl}/api/object_info`, headers: { 'X-API-Key': cloudKey } }
    : null
}

function createCompatChecker(env: Env, settings: SettingsService) {
  interface CacheEntry {
    at: number
    /** Shared in-flight (or settled) probe, so concurrent callers don't stampede. */
    probe: Promise<Set<string> | null>
  }
  const cache = new Map<string, CacheEntry>()
  const refreshing = new Set<CompatEngine>()
  const TTL = 60_000

  // Read an engine's node catalog. `fast` is the list-blocking read: short
  // timeout, no retries, so an unreachable or slow engine can't stall the page —
  // it fails to null ("Unchecked") in ~2.5s. `patient` is the background read
  // (15s timeout, retries) a remote/cloud engine's large catalog may need; its
  // result upgrades the cache without ever blocking a request.
  async function probe(engine: CompatEngine, mode: 'fast' | 'patient'): Promise<Set<string> | null> {
    const source = engineObjectInfo(engine, env, settings)
    if (!source) return null
    try {
      const res = await resilientFetch(source.url, {
        headers: source.headers,
        timeoutMs: mode === 'fast' ? 2_500 : 15_000,
        retries: mode === 'fast' ? 0 : 2,
      })
      if (!res.ok) return null
      return new Set(Object.keys((await res.json()) as Record<string, unknown>))
    } catch {
      return null
    }
  }

  // Patiently re-read an engine in the background; on success, replace its cache
  // entry with the settled catalog. De-duped so a burst of cold requests (or a
  // boot warm) never stampedes the same engine.
  function refreshPatiently(engine: CompatEngine): void {
    if (refreshing.has(engine) || !engineObjectInfo(engine, env, settings)) return
    refreshing.add(engine)
    void probe(engine, 'patient')
      .then((types) => {
        if (types) cache.set(engine, { at: Date.now(), probe: Promise.resolve(types) })
      })
      .finally(() => refreshing.delete(engine))
  }

  function fetchNodeTypes(engine: CompatEngine): Promise<Set<string> | null> {
    const cached = cache.get(engine)
    if (cached && Date.now() - cached.at < TTL) return cached.probe
    // Cold/expired: a fast probe unblocks the list; if it can't reach the engine
    // in the short window, a patient background read upgrades the cache for next
    // time (this request just reports "Unchecked").
    const entry = {
      at: Date.now(),
      probe: probe(engine, 'fast').then((types) => {
        if (!types) refreshPatiently(engine)
        return types
      }),
    }
    cache.set(engine, entry)
    return entry.probe
  }

  async function compatFor(classTypes: string[]): Promise<Record<string, EngineCompat>> {
    const compat: Record<string, EngineCompat> = {
      mock: { compatible: true, missingNodes: [] },
    }
    // Probe engines concurrently — one slow engine no longer delays the others.
    await Promise.all(
      COMPAT_ENGINES.map(async (engine) => {
        const nodeTypes = await fetchNodeTypes(engine)
        if (!nodeTypes) {
          compat[engine] = { compatible: null, missingNodes: [] }
          return
        }
        const missing = classTypes.filter((t) => !nodeTypes.has(t))
        compat[engine] = { compatible: missing.length === 0, missingNodes: missing }
      }),
    )
    return compat
  }

  // Prime every configured engine's catalog in the background — called once at
  // boot so the first Workflows-page load hits a warm cache.
  function warm(): void {
    for (const engine of COMPAT_ENGINES) refreshPatiently(engine)
  }

  return { compatFor, warm }
}

/**
 * Node catalogs from every reachable engine, merged — needed to interpret
 * editor-format exports (widget names are not stored in the save file). A
 * workflow may use nodes that exist only on one engine, so a single
 * engine's catalog is not enough.
 */
function createObjectInfoFetcher(env: Env, settings: SettingsService) {
  const cache = new Map<string, { at: number; info: ObjectInfo }>()
  const TTL = 60_000

  return async function fetchObjectInfo(prefer?: CompatEngine): Promise<ObjectInfo> {
    const cacheKey = prefer ?? 'any'
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.at < TTL) return cached.info
    // The preferred engine's catalog wins on conflicts: node specs drift
    // between engine versions, and a conversion must match the spec of the
    // engine that will actually execute the graph. Default order puts the
    // local engine first; the rest fill gaps.
    const order: CompatEngine[] =
      prefer === 'comfy-cloud'
        ? ['comfy-cloud', 'comfy-local', 'comfy-remote']
        : prefer === 'comfy-remote'
          ? ['comfy-remote', 'comfy-local', 'comfy-cloud']
          : ['comfy-local', 'comfy-remote', 'comfy-cloud']
    const sources = order
      .map((engine) => engineObjectInfo(engine, env, settings))
      .filter((s): s is { url: string; headers: Record<string, string> } => s !== null)
    const catalogs = await Promise.all(
      sources.map(async (source) => {
        try {
          const res = await fetch(source.url, {
            headers: source.headers,
            signal: AbortSignal.timeout(15_000),
          })
          return res.ok ? ((await res.json()) as ObjectInfo) : null
        } catch {
          return null
        }
      }),
    )
    const reachable = catalogs.filter((c): c is ObjectInfo => c !== null)
    if (reachable.length === 0) {
      throw Object.assign(
        new Error(
          'Interpreting an editor-format workflow needs a reachable engine (local ComfyUI, a remote ComfyUI, or Comfy Cloud). Start one, or upload the "Export (API)" file instead.',
        ),
        { statusCode: 422 },
      )
    }
    // Later catalogs fill gaps; earlier ones win on conflicts.
    const info: ObjectInfo = {}
    for (const catalog of reachable) {
      for (const [key, value] of Object.entries(catalog)) {
        if (!(key in info)) info[key] = value
      }
    }
    cache.set(cacheKey, { at: Date.now(), info })
    return info
  }
}

export function createWorkflowService(db: Db, env: Env, audit: Audit, settings: SettingsService) {
  const { compatFor, warm: primeCompat } = createCompatChecker(env, settings)
  const fetchObjectInfo = createObjectInfoFetcher(env, settings)

  /** Accept either format; editor exports also yield their App Mode config. */
  async function prepare(
    rawGraph: unknown,
  ): Promise<{ graph: Graph; appMode: AppModeData | null; objectInfo: ObjectInfo | undefined }> {
    if (isEditorFormat(rawGraph)) {
      const objectInfo = await fetchObjectInfo()
      return {
        graph: convertEditorGraph(rawGraph, objectInfo),
        appMode: extractAppMode(rawGraph),
        objectInfo,
      }
    }
    return { graph: parseGraph(rawGraph), appMode: null, objectInfo: undefined }
  }

  function resolveWorkflow(id: string): ResolvedWorkflow {
    if (id === CAPTION_WORKFLOW_ID) {
      return {
        id,
        name: CAPTION_WORKFLOW_NAME,
        execution: { kind: 'caption', model: CAPTION_MODEL, prompt: CAPTION_PROMPT },
      }
    }
    const builtin = getBuiltin(id)
    if (builtin) {
      // Resolve to the canonical built-in id so a legacy-id lookup still routes.
      return {
        id: builtin.id,
        name: builtin.name,
        execution: {
          kind: 'graph',
          graph: builtin.graph as Graph,
          inputNodeId: builtin.inputNodeId,
          outputNodeId: builtin.outputNodeId,
          params: builtin.params,
          fixedInputs: builtin.fixedInputs,
        },
      }
    }
    const row = db.select().from(workflows).where(eq(workflows.id, id)).get()
    if (!row) throw Object.assign(new Error(`Unknown workflow: ${id}`), { statusCode: 404 })
    return {
      id,
      name: row.name,
      execution: {
        kind: 'graph',
        graph: row.graph as Graph,
        inputNodeId: row.inputNodeId,
        outputNodeId: row.outputNodeId,
        params: row.params,
        fixedInputs: row.fixedInputs ?? [],
      },
    }
  }

  function toWorkflow(row: Row, compat: Record<string, EngineCompat>): Workflow {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      source: 'user',
      params: row.params,
      imageUrl: row.imageAssetId ? `/api/assets/${row.imageAssetId}` : null,
      compareImageUrl: row.compareImageAssetId ? `/api/assets/${row.compareImageAssetId}` : null,
      nodeCount: row.nodeCount,
      compat,
      fixedInputs: row.fixedInputs ?? [],
      createdAt: row.createdAt,
    }
  }

  return {
    /** Prime engine node-catalog caches in the background (called once at boot)
     *  so the first Workflows-page load doesn't pay for a cold compat probe. */
    warmCompat() {
      primeCompat()
    },

    async inspect(rawGraph: unknown) {
      const { graph, appMode, objectInfo } = await prepare(rawGraph)
      const inspection = inspectGraph(graph, objectInfo)
      if (appMode) {
        const params = appMode.inputs.flatMap((entry): ParamCandidate[] => {
          const node = graph[entry.nodeId]
          if (!node) return []
          const value = node.inputs[entry.widget]
          // Image widgets define the binding, not a text param.
          if (IMAGE_LOADER_CLASS_TYPES.has(node.class_type)) return []
          if (value === undefined || (typeof value !== 'string' && typeof value !== 'number')) return []
          const options =
            comboOptions(node, entry.widget) ??
            comboOptionsFromObjectInfo(objectInfo, node, entry.widget)
          return [
            {
              nodeId: entry.nodeId,
              inputKey: entry.widget,
              classType: node.class_type,
              label: node._meta?.title?.trim() || `${node.class_type} · ${entry.widget}`,
              valueType: options ? 'select' : typeof value === 'number' ? 'number' : 'text',
              currentValue: String(value),
              ...(options ? { options } : {}),
            },
          ]
        })
        const inputNodeId =
          appMode.inputs.find(
            (e) => graph[e.nodeId] && IMAGE_LOADER_CLASS_TYPES.has(graph[e.nodeId]!.class_type),
          )?.nodeId ?? null
        const outputNodeId =
          appMode.outputNodeId && graph[appMode.outputNodeId] ? appMode.outputNodeId : null
        inspection.appMode = { params, inputNodeId, outputNodeId }
        // App Mode declarations can complete an otherwise ambiguous binding.
        if (!inspection.autoBinding) {
          const input = inputNodeId ?? inspection.inputCandidates[0]?.nodeId
          const output =
            outputNodeId ??
            (inspection.outputCandidates.find((c) => c.classType === 'SaveImage') ??
              inspection.outputCandidates[0])?.nodeId
          if (input && output) inspection.autoBinding = { inputNodeId: input, outputNodeId: output }
        }
      }
      return inspection
    },

    async list(): Promise<Workflow[]> {
      // Built-ins are graphs, checked against their own class types like user workflows.
      const builtins: Workflow[] = await Promise.all(
        BUILTIN_WORKFLOWS.map(async (w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          source: w.source,
          params: w.params,
          imageUrl: w.imageUrl,
          compareImageUrl: w.compareImageUrl,
          nodeCount: w.nodeCount,
          compat: await compatFor(graphClassTypes(w.graph as Graph)),
          fixedInputs: w.fixedInputs,
          createdAt: w.createdAt,
        })),
      )
      const rows = db.select().from(workflows).orderBy(desc(workflows.createdAt)).all()
      const users = await Promise.all(
        rows.map(async (row) =>
          toWorkflow(row, await compatFor(graphClassTypes(row.graph as Graph))),
        ),
      )
      return [...users, ...builtins]
    },

    async save(input: SaveWorkflowInput): Promise<Workflow> {
      const { graph, objectInfo } = await prepare(input.graph)
      const inspection = inspectGraph(graph, objectInfo)
      const binding =
        input.inputNodeId && input.outputNodeId
          ? { inputNodeId: input.inputNodeId, outputNodeId: input.outputNodeId }
          : inspection.autoBinding
      if (!binding) {
        throw Object.assign(
          new Error('Binding is ambiguous — specify inputNodeId and outputNodeId'),
          { statusCode: 422, inspection },
        )
      }
      if (!graph[binding.inputNodeId] || !graph[binding.outputNodeId]) {
        throw Object.assign(new Error('Bound node ids are not in the graph'), { statusCode: 400 })
      }
      const fixedInputs = validateFixedInputs(graph, binding.inputNodeId, input.fixedInputs ?? [])
      const row: typeof workflows.$inferInsert = {
        id: randomUUID(),
        name: input.name.trim() || 'Untitled workflow',
        description: input.description?.trim() ?? '',
        graph: graph as Record<string, unknown>,
        // Keep the original editor file: run time re-converts it with the
        // executing engine's catalog (and any converter fixes since upload).
        rawGraph: isEditorFormat(input.graph)
          ? (input.graph as unknown as Record<string, unknown>)
          : null,
        inputNodeId: binding.inputNodeId,
        outputNodeId: binding.outputNodeId,
        params: input.params ?? [],
        fixedInputs,
        nodeCount: inspection.nodeCount,
        createdAt: new Date().toISOString(),
      }
      db.insert(workflows).values(row).run()
      audit.record({ action: 'workflow.upload', detail: { name: row.name, nodes: row.nodeCount } })
      return toWorkflow(row as Row, await compatFor(graphClassTypes(graph)))
    },

    /**
     * Edit display metadata and fixed reference images — never the graph
     * itself (re-upload for that).
     */
    async update(
      id: string,
      patch: {
        name?: string
        description?: string
        imageAssetId?: string | null
        compareImageAssetId?: string | null
        fixedInputs?: FixedInput[]
      },
    ): Promise<Workflow> {
      if (id.startsWith(BUILTIN_PREFIX)) {
        throw Object.assign(new Error('Built-in workflows cannot be edited'), { statusCode: 400 })
      }
      const row = db.select().from(workflows).where(eq(workflows.id, id)).get()
      if (!row) throw Object.assign(new Error('Workflow not found'), { statusCode: 404 })
      const fixedInputs =
        patch.fixedInputs !== undefined
          ? validateFixedInputs(row.graph as Graph, row.inputNodeId, patch.fixedInputs)
          : (row.fixedInputs ?? [])
      const updated = {
        ...row,
        name: patch.name?.trim() || row.name,
        description: patch.description !== undefined ? patch.description.trim() : row.description,
        imageAssetId: patch.imageAssetId !== undefined ? patch.imageAssetId : row.imageAssetId,
        compareImageAssetId:
          patch.compareImageAssetId !== undefined
            ? patch.compareImageAssetId
            : row.compareImageAssetId,
        fixedInputs,
      }
      db.update(workflows)
        .set({
          name: updated.name,
          description: updated.description,
          imageAssetId: updated.imageAssetId,
          compareImageAssetId: updated.compareImageAssetId,
          fixedInputs: updated.fixedInputs,
        })
        .where(eq(workflows.id, id))
        .run()
      audit.record({ action: 'workflow.update', detail: { name: updated.name } })
      return toWorkflow(updated, await compatFor(graphClassTypes(updated.graph as Graph)))
    },

    delete(id: string): void {
      if (id.startsWith(BUILTIN_PREFIX)) {
        throw Object.assign(new Error('Built-in workflows cannot be deleted'), { statusCode: 400 })
      }
      db.delete(workflows).where(eq(workflows.id, id)).run()
      audit.record({ action: 'workflow.delete', detail: { id } })
    },

    /**
     * Build a ComfyUI-loadable workflow JSON for a workflow id. The original
     * editor graph (rawGraph) is used when present; otherwise the API graph is
     * converted to editor format so ComfyUI's Load never opens an empty canvas.
     */
    async downloadGraph(id: string): Promise<{ filename: string; json: unknown }> {
      if (id === CAPTION_WORKFLOW_ID) {
        throw Object.assign(new Error('The caption workflow is not downloadable'), { statusCode: 400 })
      }
      const builtin = getBuiltin(id)
      if (builtin) {
        // Editor format loads as-is; otherwise convert so ComfyUI doesn't open empty.
        return {
          filename: `${slugify(builtin.name)}.json`,
          json: builtin.rawGraph ?? apiToWorkflow(builtin.graph as Graph),
        }
      }
      const row = db.select().from(workflows).where(eq(workflows.id, id)).get()
      if (!row) throw Object.assign(new Error(`Unknown workflow: ${id}`), { statusCode: 404 })
      const rawGraph = row.rawGraph as Record<string, unknown> | null
      return {
        filename: `${slugify(row.name)}.json`,
        json: rawGraph ?? apiToWorkflow(row.graph as Graph),
      }
    },

    /** Resolve a workflow id into something an engine can execute. */
    resolve: resolveWorkflow,

    /**
     * Resolve for an actual run: editor-format uploads are re-converted
     * fresh, with the executing engine's catalog winning spec conflicts —
     * so converter fixes and engine spec drift never strand a stored
     * conversion. Falls back to the upload-time conversion if no engine is
     * reachable or the re-conversion breaks the saved binding.
     */
    async resolveForRun(id: string, providerId?: string): Promise<ResolvedWorkflow> {
      const base = resolveWorkflow(id)
      if (base.execution.kind !== 'graph') return base
      const row = db.select().from(workflows).where(eq(workflows.id, id)).get()
      const raw = row?.rawGraph
      if (!raw || !isEditorFormat(raw)) return base
      try {
        const prefer =
          providerId === 'comfy-cloud' || providerId === 'comfy-local' ? providerId : undefined
        const graph = convertEditorGraph(raw, await fetchObjectInfo(prefer))
        if (graph[base.execution.inputNodeId] && graph[base.execution.outputNodeId]) {
          return { ...base, execution: { ...base.execution, graph } }
        }
      } catch {
        // No reachable engine, or the file no longer converts — run with
        // the conversion stored at upload time rather than failing outright.
      }
      return base
    },
  }
}

export type WorkflowService = ReturnType<typeof createWorkflowService>
