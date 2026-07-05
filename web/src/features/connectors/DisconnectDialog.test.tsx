import { DEFAULT_SCOPE_PROFILE, type ConnectedStore, type Run, type StagingState } from '@comfy-commerce/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorsPage } from './ConnectorsPage.js'
import { DisconnectDialog } from './DisconnectDialog.js'
import { StoreProvider } from '../../store/StoreContext.js'

// Mock the transport, not the hooks — the tests exercise the real react-query
// wiring so the dialog's enabled-flags and invalidation behave as shipped.
const { getMock, deleteMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  deleteMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}))

vi.mock('../../api/client.js', () => ({
  api: { get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
}))

const STORE: ConnectedStore = {
  id: 'store-1',
  domain: 'demo.myshopify.com',
  connectorId: 'shopify',
  status: 'connected',
  scopes: ['read_products', 'write_products'],
  lastSyncedAt: null,
  scopeProfile: DEFAULT_SCOPE_PROFILE,
  shopName: 'Demo Store',
  faviconUrl: null,
}

const emptyCounts: Record<StagingState, number> = {
  pending: 0,
  approved: 0,
  publishing: 0,
  published: 0,
  rejected: 0,
  failed: 0,
}

let nextRun = 0
function makeRun(state: Run['state']): Run {
  nextRun += 1
  return {
    id: `run-${nextRun}`,
    storeId: STORE.id,
    workflowId: 'wf-1',
    workflowName: 'Relight',
    providerId: 'mock',
    params: {},
    targetKind: 'selection',
    stageAction: 'replace-position',
    source: 'ui',
    sample: false,
    sampleOfTotal: null,
    retryOfRunId: null,
    state,
    items: [],
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** Route GETs by URL — staging and runs must not bleed into each other. */
function respondWith({
  runs = [] as Run[],
  counts = emptyCounts,
}: { runs?: Run[]; counts?: Record<StagingState, number> } = {}) {
  getMock.mockImplementation(async (path: string) => {
    if (path.includes('/catalog')) {
      return { collections: [], tags: [], counts: { products: 0, images: 0 }, products: [], scopeProfile: DEFAULT_SCOPE_PROFILE }
    }
    if (path.startsWith('/api/staging')) return { items: [], counts }
    if (path.startsWith('/api/runs')) return { runs }
    if (path.startsWith('/api/stores')) return { stores: [STORE] }
    if (path.startsWith('/api/connect/shopify/config')) return { mode: 'mock', scopes: [] }
    if (path.startsWith('/api/providers')) return { providers: [] }
    if (path.startsWith('/api/settings')) {
      return { remoteComfyUrl: null, cloudApiKey: { configured: false, source: null, masked: null } }
    }
    return {}
  })
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  respondWith()
  deleteMock.mockResolvedValue({ ok: true })
  postMock.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DisconnectDialog', () => {
  it('disconnect requires explicit confirmation (#11): nothing is deleted until the danger button', async () => {
    respondWith({ counts: { ...emptyCounts, pending: 3, approved: 2 } })
    const onClose = vi.fn()
    renderWithClient(<DisconnectDialog store={STORE} onClose={onClose} />)

    // Rendering the dialog must never mutate.
    expect(deleteMock).not.toHaveBeenCalled()

    // The store being disconnected is named…
    expect(screen.getByText(/Demo Store — demo\.myshopify\.com/)).toBeTruthy()
    // …and the consequences are enumerated, with live counts once loaded.
    await screen.findByText(/3 pending and 2 approved edits in the review queue/)
    expect(screen.getByText(/runs? in the activity history/)).toBeTruthy()
    expect(screen.getByText(/AI captions and tags/)).toBeTruthy()
    expect(screen.getByText(/audit history/)).toBeTruthy()
    expect(screen.getByText(/Nothing on the Shopify store itself is deleted/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect store' }))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(`/api/stores/${STORE.id}`))
    expect(deleteMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('confirm is available while counts are still loading — generic wording, button enabled', async () => {
    // Queries that never resolve: the dialog must not gate the human step on them.
    getMock.mockImplementation(() => new Promise(() => {}))
    renderWithClient(<DisconnectDialog store={STORE} onClose={() => {}} />)

    expect(
      screen.getByText(/All pending and approved edits in the review queue/),
    ).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'Disconnect store' })
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
  })

  it('active runs are surfaced as a warning — but do not block disconnect', async () => {
    respondWith({ runs: [makeRun('running'), makeRun('completed')] })
    renderWithClient(<DisconnectDialog store={STORE} onClose={() => {}} />)

    await screen.findByText(/still in progress/)
    expect(screen.getByText(/cancel them from Activity first/)).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'Disconnect store' })
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows no active-run warning when nothing is queued or running', async () => {
    respondWith({ runs: [makeRun('completed'), makeRun('failed')] })
    renderWithClient(<DisconnectDialog store={STORE} onClose={() => {}} />)

    await screen.findByText(/2 runs in the activity history/)
    expect(screen.queryByText(/still in progress/)).toBeNull()
  })
})

describe('ConnectorsPage disconnect flow', () => {
  it("clicking a store row's Disconnect opens the confirmation instead of mutating", async () => {
    renderWithClient(
      <MemoryRouter>
        <StoreProvider>
          <ConnectorsPage />
        </StoreProvider>
      </MemoryRouter>,
    )

    const rowButton = await screen.findByRole('button', { name: 'Disconnect' })
    await userEvent.click(rowButton)

    // The first click opens the dialog — the destructive call never fires.
    expect(deleteMock).not.toHaveBeenCalled()
    await screen.findByRole('dialog', { name: 'Disconnect store?' })
  })
})
