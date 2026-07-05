import type { ConnectedStore } from '@comfy-commerce/shared'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import { useStores } from '../api/hooks.js'

interface StoreContextValue {
  stores: ConnectedStore[]
  activeStore: ConnectedStore | null
  setActiveStoreId: (id: string) => void
  isLoading: boolean
}

const StoreContext = createContext<StoreContextValue | null>(null)

const ACTIVE_STORE_KEY = 'cc-active-store'

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const { data: stores = [], isLoading } = useStores()
  const [activeStoreId, setActiveStoreId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_STORE_KEY),
  )

  useEffect(() => {
    if (activeStoreId) localStorage.setItem(ACTIVE_STORE_KEY, activeStoreId)
  }, [activeStoreId])

  const activeStore = useMemo(
    () => stores.find((s) => s.id === activeStoreId) ?? stores[0] ?? null,
    [stores, activeStoreId],
  )

  // Memoized so provider re-renders with unchanged data don't hand every
  // consumer a fresh object. (setActiveStoreId is referentially stable.)
  const value = useMemo(
    () => ({ stores, activeStore, setActiveStoreId, isLoading }),
    [stores, activeStore, isLoading],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStoreContext(): StoreContextValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStoreContext outside StoreProvider')
  return ctx
}
