import {
  DEFAULT_SCOPE_PROFILE,
  type ConnectedStore,
  type MediaItem,
  type StagingItem,
  type StagingState,
} from '@comfy-commerce/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { FinalizePage } from './FinalizePage.js'
import { CtaSlotContext } from '../../lib/navDirection.js'
import { StoreProvider } from '../../store/StoreContext.js'

// jsdom has no ResizeObserver; PageHeader's CTA label measurer needs one once
// a slot is provided (the pill portal path is exercised here, unlike the
// ReviewPage tests where the slot stays null).
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

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
    action: 'add-new',
    targetPosition: 1,
    targetMediaId: 'm1',
    priorMediaSnapshot: null,
    publishedMediaId: null,
    state: 'approved',
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

function makeMedia(id: string, position: number): MediaItem {
  return { id, url: `https://cdn.example/${id}.jpg`, altText: '', position }
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

/** Route GETs by URL — the staging list plus one gallery model per product. */
function respondWith(items: StagingItem[]) {
  getMock.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/staging/gallery')) {
      const productId = new URLSearchParams(path.split('?')[1]).get('productId')!
      const approvedItems = items.filter(
        (i) => i.productId === productId && i.state === 'approved',
      )
      return {
        productId,
        productTitle: approvedItems[0]?.productTitle ?? productId,
        media: [makeMedia(`${productId}-m1`, 1), makeMedia(`${productId}-m2`, 2)],
        approvedItems,
        arrangement: null,
      }
    }
    if (path.startsWith('/api/staging')) {
      if (!path.includes('storeId=')) return new Promise(() => {})
      return { items, counts: countsOf(items) }
    }
    if (path.startsWith('/api/stores')) return { stores: [STORE] }
    return {}
  })
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      {/* The header CTA portals its label into the shell pill — stand in for
          the slot with document.body so the Publish button is reachable. */}
      <CtaSlotContext.Provider value={document.body}>
        <MemoryRouter initialEntries={['/review/finalize']}>
          <StoreProvider>
            <Routes>
              <Route path="/review/finalize" element={<FinalizePage />} />
              <Route path="/review" element={<div>REVIEW ROUTE</div>} />
            </Routes>
          </StoreProvider>
        </MemoryRouter>
      </CtaSlotContext.Provider>
    </QueryClientProvider>,
  )
}

const TWO_LISTINGS = [
  makeItem({ productId: 'prod-1', productTitle: 'Linen Tee' }),
  makeItem({ productId: 'prod-2', productTitle: 'Oak Table' }),
]

beforeEach(() => {
  respondWith(TWO_LISTINGS)
  postMock.mockImplementation(async (path: string) => {
    if (path === '/api/staging/publish-gallery') {
      return { results: [{ id: 'x', ok: true, state: 'published', error: null }], reordered: true, error: null }
    }
    return { results: [] }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('FinalizePage', () => {
  it('renders one reorderable gallery per staged listing', async () => {
    renderPage()

    await screen.findByText('Linen Tee')
    await screen.findByText('Oak Table')
    // Each listing shows its staged result as a "New" tile.
    await waitFor(() => expect(screen.getAllByText('New')).toHaveLength(2))
  })

  it('publish saves each shown order, publishes each gallery, then returns to review', async () => {
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: /Publish 2 listings/ }))

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/api/staging/publish-gallery',
        expect.objectContaining({ storeId: STORE.id, productId: 'prod-1' }),
      )
      expect(postMock).toHaveBeenCalledWith(
        '/api/staging/publish-gallery',
        expect.objectContaining({ storeId: STORE.id, productId: 'prod-2' }),
      )
    })
    // The shown order was persisted before each publish so the server
    // reorders against exactly what the user saw.
    const arrangementCalls = postMock.mock.calls.filter(([p]) => p === '/api/staging/arrangement')
    expect(arrangementCalls.map(([, body]) => body.productId).sort()).toEqual(['prod-1', 'prod-2'])

    await screen.findByText('REVIEW ROUTE')
  })

  it('a per-product publish failure lands in the banner and blocks the redirect', async () => {
    postMock.mockImplementation(async (path: string, body?: { productId?: string }) => {
      if (path === '/api/staging/publish-gallery') {
        if (body?.productId === 'prod-1') {
          return {
            results: [{ id: 'x', ok: false, state: 'failed', error: 'Media too large' }],
            reordered: false,
            error: null,
          }
        }
        return { results: [{ id: 'y', ok: true, state: 'published', error: null }], reordered: true, error: null }
      }
      return { results: [] }
    })
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: /Publish 2 listings/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Linen Tee: Media too large')
    expect(screen.queryByText('REVIEW ROUTE')).toBeNull()
  })
})
