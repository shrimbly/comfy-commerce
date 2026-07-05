import type {
  Collection,
  ConnectedStore,
  FixedInput,
  GallerySlotRef,
  MediaItem,
  Product,
  ProviderInfo,
  Run,
  RunEstimate,
  RunTarget,
  ScopeCount,
  ScopeProfile,
  StagingItem,
  StagingState,
  Workflow,
  WorkflowInspection,
  WorkflowParam,
} from '@comfy-commerce/shared'
import type { QueryClient } from '@tanstack/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from './client.js'

/* ── connect / stores ──────────────────────────────────────────── */

export interface ConnectConfig {
  mode: 'live' | 'mock'
  scopes: string[]
}

export const useConnectConfig = () =>
  useQuery({
    queryKey: ['connect-config'],
    queryFn: () => api.get<ConnectConfig>('/api/connect/shopify/config'),
    staleTime: Infinity,
  })

export const useStores = () =>
  useQuery({
    queryKey: ['stores'],
    queryFn: async () => (await api.get<{ stores: ConnectedStore[] }>('/api/stores')).stores,
  })

export type ConnectResult =
  | { kind: 'connected'; store: ConnectedStore }
  | { kind: 'redirect'; url: string }

export const useConnectStore = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (shop: string) => api.post<ConnectResult>('/api/connect/shopify', { shop }),
    onSuccess: (result) => {
      if (result.kind === 'connected') void qc.invalidateQueries({ queryKey: ['stores'] })
    },
  })
}

export const useConnectWithToken = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { shop: string; accessToken: string }) =>
      api.post<ConnectResult>('/api/connect/shopify/token', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stores'] }),
  })
}

export const useConnectWithCredentials = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { shop: string; clientId: string; clientSecret: string }) =>
      api.post<ConnectResult>('/api/connect/shopify/credentials', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stores'] }),
  })
}

export const useDisconnectStore = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (storeId: string) => api.delete(`/api/stores/${storeId}`),
    onSuccess: () => void qc.invalidateQueries(),
  })
}

export const useUpdateScope = (storeId: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (profile: ScopeProfile) =>
      api.patch<{ store: ConnectedStore; counts: ScopeCount }>(`/api/stores/${storeId}/scope`, profile),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stores'] })
      void qc.invalidateQueries({ queryKey: ['catalog', storeId] })
    },
  })
}

export const useScopePreview = (storeId: string | undefined, profile: ScopeProfile | null) =>
  useQuery({
    queryKey: ['scope-preview', storeId, profile],
    queryFn: () => api.post<ScopeCount>(`/api/stores/${storeId}/scope-preview`, profile),
    enabled: Boolean(storeId && profile),
    placeholderData: (prev) => prev,
  })

/* ── catalog ───────────────────────────────────────────────────── */

export interface Catalog {
  collections: Collection[]
  tags: string[]
  counts: ScopeCount
  products: Product[]
  scopeProfile: ScopeProfile
}

export const useCatalog = (storeId: string | undefined) =>
  useQuery({
    queryKey: ['catalog', storeId],
    queryFn: () => api.get<Catalog>(`/api/stores/${storeId}/catalog`),
    enabled: Boolean(storeId),
    // Boot mounts several catalog observers at once (ScopeEditor + dialogs);
    // a short staleTime keeps that to one crawl. Mutations invalidate the key.
    staleTime: 30_000,
  })

/** Idle/boot warm for the browse grid: same key + staleTime as useCatalog so
 *  the first navigation renders from cache instead of fetching mid-transition. */
export const prefetchCatalog = (qc: QueryClient, storeId: string) =>
  qc.prefetchQuery({
    queryKey: ['catalog', storeId],
    queryFn: () => api.get<Catalog>(`/api/stores/${storeId}/catalog`),
    staleTime: 30_000,
  })

/** Edit an image's AI search tags (e.g. remove one in the inspector). Optimistic. */
export const useSetMediaTags = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { storeId: string; productId: string; mediaId: string; tags: string[] }) =>
      api.patch<{ ok: boolean }>(`/api/stores/${v.storeId}/enrichment/tags`, {
        productId: v.productId,
        mediaId: v.mediaId,
        tags: v.tags,
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['catalog', v.storeId] })
      const prev = qc.getQueryData<Catalog>(['catalog', v.storeId])
      if (prev) {
        qc.setQueryData<Catalog>(['catalog', v.storeId], {
          ...prev,
          products: prev.products.map((p) =>
            p.id === v.productId
              ? {
                  ...p,
                  media: p.media.map((m) => (m.id === v.mediaId ? { ...m, tags: v.tags } : m)),
                }
              : p,
          ),
        })
      }
      return { prev }
    },
    onError: (_e, v, context) => {
      if (context?.prev) qc.setQueryData(['catalog', v.storeId], context.prev)
    },
    onSettled: (_d, _e, v) => void qc.invalidateQueries({ queryKey: ['catalog', v.storeId] }),
  })
}

/* ── providers ─────────────────────────────────────────────────── */

export const useProviders = () =>
  useQuery({
    queryKey: ['providers'],
    queryFn: async () => (await api.get<{ providers: ProviderInfo[] }>('/api/providers')).providers,
    refetchInterval: 15_000,
    // Matches the refetchInterval — a second observer mounting between polls
    // (e.g. a run sheet opening) reuses the data instead of re-probing.
    staleTime: 15_000,
  })

/* ── settings ──────────────────────────────────────────────────── */

/** Secret-safe status of the Comfy Cloud API key (never the raw key). */
export interface CloudApiKeyStatus {
  configured: boolean
  /** 'ui' = saved here, 'env' = COMFY_CLOUD_API_KEY, null = unset. */
  source: 'ui' | 'env' | null
  /** A `…last4` hint so you can recognise which key is in use. */
  masked: string | null
}

/** Status of the "Sign in with Comfy Cloud" OAuth connection. */
export interface CloudOAuthStatus {
  connected: boolean
  /**
   * Whether the cloud REST API accepted the sign-in grant. False means signed
   * in, but the cloud hasn't enabled API access for self-registered apps yet
   * — generations still need an API key. Null when not connected.
   */
  apiAccess: boolean | null
  email: string | null
}

export interface AppSettings {
  /** URL of the Remote ComfyUI engine, or null when unconfigured. */
  remoteComfyUrl: string | null
  /** Comfy Cloud API key status — write-only over the API. */
  cloudApiKey: CloudApiKeyStatus
  /** Comfy Cloud sign-in status. */
  cloudOauth: CloudOAuthStatus
}

export const useSettings = (opts?: { enabled?: boolean }) =>
  useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AppSettings>('/api/settings'),
    // Gateable so consumers hidden at boot (the engine Configure dialogs)
    // fetch at open time, not during the entrance; staleTime makes reopening
    // instant. Mutations invalidate the key.
    enabled: opts?.enabled ?? true,
    staleTime: 30_000,
  })

/** Set or clear (null) the Remote ComfyUI URL; refreshes engine availability. */
export const useUpdateRemoteComfyUrl = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (remoteComfyUrl: string | null) =>
      api.patch<AppSettings>('/api/settings', { remoteComfyUrl }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void qc.invalidateQueries({ queryKey: ['providers'] })
    },
  })
}

/** Set or clear (null) the Comfy Cloud API key; refreshes engine availability. */
export const useUpdateCloudApiKey = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cloudApiKey: string | null) =>
      api.patch<AppSettings>('/api/settings', { cloudApiKey }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void qc.invalidateQueries({ queryKey: ['providers'] })
    },
  })
}

/**
 * Begin "Sign in with Comfy Cloud": the broker readies the OAuth request and
 * returns the authorize URL; the caller navigates the browser there. The
 * flow returns to /connectors?connected= (or ?error=) via the broker callback.
 */
export const useConnectComfyCloud = () =>
  useMutation({
    mutationFn: () => api.post<{ url: string }>('/api/connect/comfy', {}),
    onSuccess: ({ url }) => window.location.assign(url),
  })

/** Sign out of Comfy Cloud (any saved API key is untouched). */
export const useDisconnectComfyCloud = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete('/api/connect/comfy'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void qc.invalidateQueries({ queryKey: ['providers'] })
    },
  })
}

/* ── workflows ─────────────────────────────────────────────────── */

export const useWorkflows = () =>
  useQuery({
    queryKey: ['workflows'],
    queryFn: async () => (await api.get<{ workflows: Workflow[] }>('/api/workflows')).workflows,
    // staleTime matches the poll so mounting an observer mid page-transition
    // (BrowsePage renders a closed RunSheet) reuses cache instead of refetching.
    refetchInterval: 30_000,
    staleTime: 30_000,
  })

/** Idle/boot warm — same key + staleTime as useWorkflows. */
export const prefetchWorkflows = (qc: QueryClient) =>
  qc.prefetchQuery({
    queryKey: ['workflows'],
    queryFn: async () => (await api.get<{ workflows: Workflow[] }>('/api/workflows')).workflows,
    staleTime: 30_000,
  })

export const useInspectWorkflow = () =>
  useMutation({
    mutationFn: (graph: unknown) =>
      api.post<WorkflowInspection>('/api/workflows/inspect', { graph }),
  })

export interface SaveWorkflowInput {
  name: string
  description?: string
  graph: unknown
  inputNodeId?: string
  outputNodeId?: string
  params?: WorkflowParam[]
  fixedInputs?: FixedInput[]
}

export const useSaveWorkflow = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveWorkflowInput) =>
      (await api.post<{ workflow: Workflow }>('/api/workflows', input)).workflow,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workflows'] }),
  })
}

export const useDeleteWorkflow = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/workflows/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workflows'] }),
  })
}

export const useUpdateWorkflow = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: {
      id: string
      name?: string
      description?: string
      imageAssetId?: string | null
      compareImageAssetId?: string | null
      fixedInputs?: FixedInput[]
    }) => (await api.patch<{ workflow: Workflow }>(`/api/workflows/${id}`, patch)).workflow,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workflows'] }),
  })
}

async function fileToBase64(file: File): Promise<string> {
  // Chunk the byte array: String.fromCharCode(...) overflows the call stack on
  // large files, so feed it a bounded number of arguments at a time.
  const CHUNK_SIZE = 0x8000
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE))
  }
  return btoa(binary)
}

export const useUploadAsset = () =>
  useMutation({
    mutationFn: async (file: File) =>
      api.post<{ id: string; url: string }>('/api/assets', {
        contentType: file.type,
        data: await fileToBase64(file),
      }),
  })

/* ── runs ──────────────────────────────────────────────────────── */

export const useRunEstimate = (storeId: string | undefined, target: RunTarget | null) =>
  useQuery({
    queryKey: ['run-estimate', storeId, target],
    queryFn: () => api.post<RunEstimate>('/api/runs/estimate', { storeId, target }),
    enabled: Boolean(storeId && target),
    placeholderData: (prev) => prev,
  })

export interface CreateRunInput {
  storeId: string
  workflowId: string
  providerId: ProviderInfo['id']
  params: Record<string, string>
  target: RunTarget
  stageAction: 'add-featured' | 'replace-position' | 'add-new'
  sampleSize?: number
}

export const useCreateRun = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateRunInput) =>
      (await api.post<{ run: Run }>('/api/runs', input)).run,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  })
}

const runsRefetch = (runs: Run[] | undefined) =>
  runs?.some((r) => r.state === 'queued' || r.state === 'running') ? 1200 : 8000

export const useRuns = (storeId?: string, opts?: { enabled?: boolean }) =>
  useQuery({
    queryKey: ['runs', storeId ?? 'all'],
    queryFn: async () => (await api.get<{ runs: Run[] }>(`/api/runs${storeId ? `?storeId=${storeId}` : ''}`)).runs,
    enabled: opts?.enabled ?? true,
    refetchInterval: (query) => runsRefetch(query.state.data),
  })

export const useRun = (runId: string | null) =>
  useQuery({
    queryKey: ['run', runId],
    queryFn: async () => (await api.get<{ run: Run }>(`/api/runs/${runId}`)).run,
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const state = query.state.data?.state
      return state === 'queued' || state === 'running' ? 700 : false
    },
  })

export const useCancelRun = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/runs/${id}/cancel`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  })
}

export const useSkipRunItem = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/runs/${id}/skip-current`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  })
}

export const useClearRun = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/runs/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  })
}

/* ── prompts ───────────────────────────────────────────────────── */

export interface SavedPrompt {
  id: string
  name: string
  text: string
  createdAt: string
  updatedAt: string
}

export const usePrompts = () =>
  useQuery({
    queryKey: ['prompts'],
    queryFn: async () => (await api.get<{ prompts: SavedPrompt[] }>('/api/prompts')).prompts,
  })

export const useSavePrompt = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { text: string; name?: string }) =>
      (await api.post<{ prompt: SavedPrompt }>('/api/prompts', input)).prompt,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['prompts'] }),
  })
}

export const useUpdatePrompt = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; name?: string; text?: string }) =>
      (await api.patch<{ prompt: SavedPrompt }>(`/api/prompts/${id}`, patch)).prompt,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['prompts'] }),
  })
}

export const useDeletePrompt = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/prompts/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['prompts'] }),
  })
}

export const useRetryRun = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => (await api.post<{ run: Run }>(`/api/runs/${id}/retry`)).run,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  })
}

export const usePromoteRun = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => (await api.post<{ run: Run }>(`/api/runs/${id}/promote`)).run,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  })
}

/* ── staging ───────────────────────────────────────────────────── */

export interface StagingResponse {
  items: StagingItem[]
  counts: Record<StagingState, number>
}

export const useStaging = <T = StagingResponse>(
  storeId?: string,
  opts?: {
    enabled?: boolean
    /** Narrow the subscription (e.g. the shell reads only counts.pending) so
     *  poll responses only re-render consumers whose slice actually changed. */
    select?: (data: StagingResponse) => T
  },
) =>
  useQuery({
    queryKey: ['staging', storeId ?? 'all'],
    queryFn: () =>
      api.get<StagingResponse>(`/api/staging${storeId ? `?storeId=${storeId}` : ''}`),
    enabled: opts?.enabled ?? true,
    select: opts?.select,
    refetchInterval: 5000,
    // Just under the poll cadence — a second observer mounting between polls
    // (ReviewPage after the shell) reuses the badge fetch instead of refetching.
    staleTime: 4_000,
  })

export interface OperationResult {
  id: string
  ok: boolean
  state: StagingState
  error: string | null
}

function stagingMutation(path: 'approve' | 'reject' | 'publish' | 'revert') {
  return async (ids: string[]) =>
    (await api.post<{ results: OperationResult[] }>(`/api/staging/${path}`, { ids })).results
}

export const useStagingAction = (action: 'approve' | 'reject' | 'publish' | 'revert') => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: stagingMutation(action),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staging'] })
      void qc.invalidateQueries({ queryKey: ['catalog'] })
      void qc.invalidateQueries({ queryKey: ['gallery'] })
    },
  })
}

/* ── gallery arrangement (Finalize-step reorder) ───────────────── */

export interface GalleryEditorData {
  productId: string
  productTitle: string
  media: MediaItem[]
  approvedItems: StagingItem[]
  arrangement: GallerySlotRef[] | null
}

/** Query options, not a hook — the Finalize page mounts one per staged listing via useQueries. */
export const galleryEditorQuery = (storeId: string, productId: string) => ({
  queryKey: ['gallery', storeId, productId] as const,
  queryFn: () =>
    api.get<GalleryEditorData>(`/api/staging/gallery?storeId=${storeId}&productId=${productId}`),
})

export const useSaveArrangement = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { storeId: string; productId: string; order: GallerySlotRef[] }) =>
      api.post('/api/staging/arrangement', input),
    onSuccess: (_r, v) =>
      void qc.invalidateQueries({ queryKey: ['gallery', v.storeId, v.productId] }),
  })
}

export const usePublishGallery = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { storeId: string; productId: string }) =>
      api.post<{ results: OperationResult[]; reordered: boolean; error: string | null }>(
        '/api/staging/publish-gallery',
        input,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staging'] })
      void qc.invalidateQueries({ queryKey: ['catalog'] })
      void qc.invalidateQueries({ queryKey: ['gallery'] })
    },
  })
}
