import {
  DEFAULT_SCOPE_PROFILE,
  type ConnectedStore,
  type StagingItem,
  type StagingState,
} from '@comfy-commerce/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReviewPage } from './ReviewPage.js'
import { StoreProvider } from '../../store/StoreContext.js'

// Mock the transport, not the hooks — the tests exercise the real react-query
// wiring so mutation results and errors flow exactly as shipped (#23, #52).
const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
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

let nextId = 0
function makeItem(overrides: Partial<StagingItem> = {}): StagingItem {
  nextId += 1
  return {
    id: `item-${nextId}`,
    storeId: STORE.id,
    productId: 'prod-1',
    productTitle: 'Linen Tee',
    variantTitle: null,
    beforeUrl: 'https://cdn.example/before.jpg',
    afterUrl: 'https://cdn.example/after.jpg',
    mediaType: 'image',
    action: 'replace-position',
    targetPosition: 1,
    targetMediaId: 'm1',
    priorMediaSnapshot: null,
    publishedMediaId: null,
    state: 'pending',
    error: null,
    recipeId: 'relight',
    runId: null,
    sourceMediaId: 'm1',
    source: 'ui',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function countsOf(items: StagingItem[]): Record<StagingState, number> {
  const counts: Record<StagingState, number> = {
    pending: 0,
    approved: 0,
    publishing: 0,
    published: 0,
    rejected: 0,
    failed: 0,
  }
  for (const item of items) counts[item.state] += 1
  return counts
}

/** Route GETs by URL — every query the page (and its RunSheet) mounts. */
function respondWith(items: StagingItem[]) {
  getMock.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/staging')) {
      // The page mounts with the storeless key, then re-keys to the active
      // store and REMOUNTS the list. Answer only the store-scoped query so the
      // cards render exactly once — clicks never land on a detached node.
      if (!path.includes('storeId=')) return new Promise(() => {})
      return { items, counts: countsOf(items) }
    }
    if (path.startsWith('/api/stores')) return { stores: [STORE] }
    if (path.startsWith('/api/workflows')) return { workflows: [] }
    if (path.startsWith('/api/providers')) return { providers: [] }
    if (path.startsWith('/api/runs')) return { runs: [] }
    return {}
  })
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StoreProvider>
          <ReviewPage />
        </StoreProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}


beforeEach(() => {
  respondWith([makeItem()])
  postMock.mockResolvedValue({ results: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ReviewPage error surfacing (#23)', () => {
  it('a rejected mutation renders a dismissible error banner', async () => {
    postMock.mockImplementation(async (path: string) => {
      if (path === '/api/staging/approve') throw new Error('Shopify scopes missing')
      return { results: [] }
    })
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/staging/approve', expect.anything()),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Approve failed: Shopify scopes missing')

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('an OperationResult with ok:false surfaces its per-item message', async () => {
    // The API never throws for per-item failures — it answers 200 with
    // { id, ok:false, error } entries. Those must become visible too.
    postMock.mockImplementation(async (path: string) => {
      if (path === '/api/staging/approve') {
        return {
          results: [
            { id: 'item-1', ok: false, state: 'pending', error: 'Cannot approve from rejected' },
          ],
        }
      }
      return { results: [] }
    })
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Approve failed: Cannot approve from rejected')
  })
})

describe('two-step flow for adds', () => {
  it('with staged adds the header offers Finalize, and approval only stages', async () => {
    respondWith([
      makeItem({ action: 'add-new' }), // pending add
      makeItem({
        state: 'approved',
        action: 'add-new',
        productId: 'prod-2',
        productTitle: 'Oak Table',
      }),
    ])
    renderPage()

    // Pending + staged CTAs render together in-flow; Finalize counts listings.
    await screen.findByRole('button', { name: /Finalize 1 listing/ })
    await userEvent.click(screen.getByRole('button', { name: /Approve all \(1\)/ }))
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/staging/approve', expect.anything()),
    )
    expect(postMock).not.toHaveBeenCalledWith('/api/staging/publish', expect.anything())
  })

  it('an approved add row funnels through Finalize — no per-row Publish', async () => {
    respondWith([makeItem({ state: 'approved', action: 'add-new' })])
    renderPage()

    await screen.findByText('Linen Tee')
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('an approved in-place replacement keeps its one-click Publish', async () => {
    respondWith([makeItem({ state: 'approved' })])
    renderPage()

    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy()
  })
})

describe('failed-card error display (#52)', () => {
  it('shows the recorded failure reason on the failed card', async () => {
    respondWith([makeItem({ state: 'failed', error: 'Media too large — Shopify limit is 20MB' })])
    renderPage()

    await screen.findByText('Publish failed: Media too large — Shopify limit is 20MB')
  })

  it('falls back to generic copy when no reason was recorded', async () => {
    respondWith([makeItem({ state: 'failed', error: null })])
    renderPage()

    await screen.findByText('Publish failed — retry or reject.')
  })
})
