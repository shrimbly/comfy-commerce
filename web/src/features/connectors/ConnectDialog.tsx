import type { ConnectedStore } from '@comfy-commerce/shared'
import { ArrowRight, Box, Check, ICON, IconBox, Images, KeyRound } from '../../lib/icons.js'
import { useEffect, useState } from 'react'

import {
  useCatalog,
  useConnectConfig,
  useConnectStore,
  useConnectWithCredentials,
} from '../../api/hooks.js'
import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { Segmented } from '../../components/ui/Segmented.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { WatchSetupGuide } from './SetupGuide.js'

type Method = 'credentials' | 'oauth' | 'demo'

const SUBTITLES: Record<Method, string> = {
  credentials: 'Use an app from the Shopify Dev Dashboard — tokens refresh automatically.',
  oauth: "You'll approve access on Shopify, then come straight back.",
  demo: 'Creates a fully working demo store with a mock catalog.',
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  onEnter,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  type?: string
  onEnter: () => void
}) {
  return (
    <div className="mt-4 first:mt-0">
      <label className="mb-2 block text-sm font-medium text-ink-soft" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
      />
    </div>
  )
}

/** A single headline count (products / images) in the connected confirmation. */
function Stat({
  icon,
  value,
  label,
  loading,
}: {
  icon: React.ReactNode
  value: number | undefined
  label: string
  loading: boolean
}) {
  return (
    <div className="flex flex-1 items-center gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-faint">
        <IconBox>{icon}</IconBox>
      </span>
      <div className="min-w-0">
        <div className="text-xl font-semibold leading-none tabular-nums text-ink">
          {loading || value === undefined ? <span className="text-ink-faint">—</span> : value.toLocaleString()}
        </div>
        <div className="mt-1 text-sm text-ink-soft">{label}</div>
      </div>
    </div>
  )
}

/**
 * Post-connect confirmation that morphs the connect dialog in place: a spinner
 * (held for a minimum beat so it always reads as "working") while we read the
 * store's catalog, then the product + product-image counts now available.
 */
function StoreConnectedView({ store, onDone }: { store: ConnectedStore; onDone: () => void }) {
  const { data: catalog, isError } = useCatalog(store.id)
  // Always show the spinner for at least 2s, even if the catalog resolves sooner.
  const [minElapsed, setMinElapsed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), 2000)
    return () => clearTimeout(t)
  }, [])

  const loaded = Boolean(catalog) || isError
  const loading = !minElapsed || !loaded
  const counts = catalog?.counts

  return (
    <div className="px-5 pb-5">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
          {loading ? (
            <Spinner className="size-5 border-success/30 border-t-success" />
          ) : (
            <IconBox>
              <Check {...ICON} />
            </IconBox>
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{store.domain}</p>
          <p className="text-sm text-ink-soft">
            {loading ? 'Reading your catalog…' : isError ? 'Connected.' : 'Connected and ready.'}
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-3">
        <Stat icon={<Box {...ICON} />} value={counts?.products} label="Products" loading={loading} />
        <Stat icon={<Images {...ICON} />} value={counts?.images} label="Product images" loading={loading} />
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [shop, setShop] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  // Set once a store connects → swaps the form for the "Store connected" view.
  const [connectedStore, setConnectedStore] = useState<ConnectedStore | null>(null)
  const { data: config } = useConnectConfig()
  const connect = useConnectStore()
  const connectCredentials = useConnectWithCredentials()
  const isLive = config?.mode === 'live'
  const [method, setMethod] = useState<Method>('credentials')

  // Reset to a fresh form each time the dialog opens. We deliberately don't reset
  // on close so the success view stays put through the close animation.
  useEffect(() => {
    if (!open) return
    setShop('')
    setClientId('')
    setClientSecret('')
    setConnectedStore(null)
  }, [open])

  const options = [
    { value: 'credentials' as const, label: 'App credentials' },
    isLive ? { value: 'oauth' as const, label: 'OAuth' } : { value: 'demo' as const, label: 'Demo store' },
  ]

  const pending = connect.isPending || connectCredentials.isPending
  const error = (method === 'credentials' ? connectCredentials.error : connect.error) as Error | null
  const ready =
    shop.trim() && (method === 'credentials' ? clientId.trim() && clientSecret.trim() : true)

  const submit = () => {
    if (!ready || pending) return
    if (method === 'credentials') {
      connectCredentials.mutate(
        { shop: shop.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() },
        { onSuccess: (result) => result.kind === 'connected' && setConnectedStore(result.store) },
      )
    } else {
      connect.mutate(shop.trim(), {
        onSuccess: (result) => {
          if (result.kind === 'redirect') window.location.href = result.url
          else setConnectedStore(result.store)
        },
      })
    }
  }

  if (connectedStore) {
    return (
      <Dialog open={open} onClose={onClose} title="Store connected">
        <StoreConnectedView store={connectedStore} onDone={onClose} />
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onClose={onClose} title="Connect Shopify" subtitle={SUBTITLES[method]}>
      <div className="px-5 pb-5">
        <Segmented options={options} value={method} onChange={setMethod} className="mb-4" />

        <label className="mb-2 block text-sm font-medium text-ink-soft" htmlFor="shop-domain">
          Store domain
        </label>
        <div className="flex items-stretch overflow-hidden rounded-lg border border-line-strong bg-surface transition-colors focus-within:border-ink">
          <input
            id="shop-domain"
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="mystore"
            autoFocus
            className="h-9 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-ink-faint"
          />
          <span className="flex items-center border-l border-line bg-surface-2 px-3 text-sm text-ink-faint">
            .myshopify.com
          </span>
        </div>

        {method === 'credentials' && (
          <>
            <Field
              id="client-id"
              label="Client ID"
              value={clientId}
              onChange={setClientId}
              placeholder="Client ID from the app's settings"
              onEnter={submit}
            />
            <Field
              id="client-secret"
              label="Client secret"
              value={clientSecret}
              onChange={setClientSecret}
              placeholder="Client secret"
              type="password"
              onEnter={submit}
            />
            <div className="mt-4 rounded-xl border border-line bg-surface-2 p-4">
              <p className="text-sm text-ink-soft">
                At <span className="font-medium text-ink">dev.shopify.com</span>: create an app, grant
                the Admin API scopes{' '}
                <span className="font-medium text-ink">read_products, write_products, write_files</span>,
                install it on your store, then copy the Client ID and secret from the app's settings.
                Access tokens expire every 24 hours and are re-exchanged automatically.
                Credentials are encrypted at rest and never leave this machine.
              </p>
              <div className="mt-3">
                <WatchSetupGuide variant="ghost" size="sm" className="-ml-2" />
              </div>
            </div>
          </>
        )}

        {error && <p className="mt-3 text-sm text-danger">{error.message}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!ready || pending}>
            {pending ? (
              <Spinner className="border-accent-ink/40 border-t-accent-ink" />
            ) : (
              <IconBox>
                {method === 'oauth' ? <ArrowRight {...ICON} /> : method === 'demo' ? <Check {...ICON} /> : <KeyRound {...ICON} />}
              </IconBox>
            )}
            {method === 'oauth'
              ? 'Continue to Shopify'
              : method === 'demo'
                ? 'Connect demo store'
                : 'Connect store'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
