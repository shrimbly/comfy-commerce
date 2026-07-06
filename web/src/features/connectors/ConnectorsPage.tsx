import { ICON, IconBox, Settings, Unplug } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

import type { ConnectedStore } from '@comfy-commerce/shared'

import { PlusIcon } from '../../lib/animated-icons/PlusIcon.js'
import { StoreAvatar } from '../../components/ui/StoreAvatar.js'
import { useHover } from '../../lib/useHover.js'
import {
  useConnectConfig,
  useProviders,
  useSettings,
  useStores,
  useUpdateCloudApiKey,
  useUpdateRemoteComfyUrl,
} from '../../api/hooks.js'
import { ComfyMark } from '../../components/shell/ComfyMark.js'
import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { PageHeader } from '../../components/ui/PageHeader.js'
import { easeSoft, staggerChild, staggerParent } from '../../lib/motion.js'
import { ConnectDialog } from './ConnectDialog.js'
import { DisconnectDialog } from './DisconnectDialog.js'
import { ScopeEditor } from './ScopeEditor.js'
import { SetupSteps, WatchSetupGuide } from './SetupGuide.js'

/** Configure the Remote ComfyUI URL — a ComfyUI on another machine on your
 *  network. Saving takes effect on the next availability poll. */
function RemoteEngineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounted (closed) from boot — fetch settings at open time, not mid-entrance.
  const { data: settings } = useSettings({ enabled: open })
  const updateUrl = useUpdateRemoteComfyUrl()
  const saved = settings?.remoteComfyUrl ?? ''
  const [draft, setDraft] = useState('')

  // Re-seed the field from the saved value each time the dialog opens.
  useEffect(() => {
    if (open) setDraft(saved)
  }, [open, saved])

  const trimmed = draft.trim()
  const validish = trimmed === '' || /^https?:\/\/.+/i.test(trimmed)
  const save = () => {
    if (!validish) return
    updateUrl.mutate(trimmed === '' ? null : trimmed, { onSuccess: onClose })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Remote ComfyUI"
      subtitle="Run edits on a ComfyUI instance on another machine on your network."
    >
      <div className="px-5 pb-5">
        <label htmlFor="remote-comfy-url" className="mb-2 block text-sm font-medium text-ink-soft">
          Server URL
        </label>
        <input
          id="remote-comfy-url"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="http://192.168.1.50:8188"
          autoFocus
          spellCheck={false}
          className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
        />
        <div className="mt-4 rounded-xl border border-line bg-surface-2 p-4">
          <p className="text-sm text-ink-soft">
            Enter the address of a ComfyUI server reachable from this machine. Start that ComfyUI
            with <code className="text-ink">--listen</code> so it accepts connections from your
            network. Leave blank to disable this engine.
          </p>
        </div>
        {!validish && (
          <p className="mt-3 text-sm text-danger">Enter a full http(s) URL, or leave blank.</p>
        )}
        {updateUrl.error && (
          <p className="mt-3 text-sm text-danger">{(updateUrl.error as Error).message}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!validish || updateUrl.isPending}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** Configure the Comfy Cloud API key. Write-only: the saved value is encrypted
 *  at rest and never returned — the field shows only a masked hint. Saving takes
 *  effect on the next availability poll. */
function CloudEngineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounted (closed) from boot — fetch settings at open time, not mid-entrance.
  const { data: settings } = useSettings({ enabled: open })
  const updateKey = useUpdateCloudApiKey()
  const status = settings?.cloudApiKey
  const [draft, setDraft] = useState('')

  // Never seed the field with the secret (we don't have it) — start empty each open.
  useEffect(() => {
    if (open) setDraft('')
  }, [open])

  const trimmed = draft.trim()
  const save = () => {
    if (!trimmed) return
    updateKey.mutate(trimmed, { onSuccess: onClose })
  }
  const clear = () => updateKey.mutate(null, { onSuccess: onClose })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Comfy Cloud"
      subtitle="Run edits on Comfy Cloud — no local GPU required."
    >
      <div className="px-5 pb-5">
        <label htmlFor="cloud-api-key" className="mb-2 block text-sm font-medium text-ink-soft">
          API key
        </label>
        <input
          id="cloud-api-key"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder={
            status?.configured ? `Key set (${status.masked}) — enter a new one to replace` : 'comfyui-…'
          }
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
        />
        <div className="mt-4 space-y-2 rounded-xl border border-line bg-surface-2 p-4 text-sm text-ink-soft">
          <p>
            Create a key at{' '}
            <a
              href="https://platform.comfy.org"
              target="_blank"
              rel="noreferrer"
              className="text-ink underline"
            >
              platform.comfy.org
            </a>
            . You'll need an active Comfy Cloud plan. Encrypted at rest and never leaves this machine.
          </p>
          {status?.source === 'env' && (
            <p>
              Looks like you already have a key from <code className="text-ink">COMFY_CLOUD_API_KEY</code>{' '}
              — save one here and it'll take over.
            </p>
          )}
        </div>
        {updateKey.error && (
          <p className="mt-3 text-sm text-danger">{(updateKey.error as Error).message}</p>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          {status?.source === 'ui' && (
            <Button
              variant="ghost"
              onClick={clear}
              disabled={updateKey.isPending}
              className="mr-auto text-ink-faint hover:text-danger"
            >
              Remove key
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!trimmed || updateKey.isPending}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function EnginesCard() {
  const { data: providers = [] } = useProviders()
  const [configuring, setConfiguring] = useState<'comfy-remote' | 'comfy-cloud' | null>(null)
  // The mock engine is an internal demo/test fallback — never list it as a
  // real generation engine. Operators only see local, remote, and cloud.
  const engines = providers.filter((p) => p.id !== 'mock')
  if (engines.length === 0) return null

  return (
    <motion.section
      variants={staggerChild}
      className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft"
    >
      <div className="flex items-center gap-3 px-5 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink">
          <ComfyMark className="size-4" />
        </div>
        <h2 className="text-base font-medium">ComfyUI</h2>
      </div>
      <ul className="border-t border-line">
        {engines.map((provider) => (
          <li
            key={provider.id}
            className="flex items-center gap-3 border-b border-line/60 py-2.5 pr-5 pl-6 last:border-b-0"
          >
            <span
              className={`size-2.5 shrink-0 rounded-full ${provider.available ? 'bg-success' : 'bg-ink-faint'}`}
            />
            <p className="shrink-0 text-sm font-medium">{provider.name}</p>
            {provider.detail && (
              <span className="min-w-0 truncate rounded-lg bg-surface-2 px-2 py-0.5 text-sm text-ink-soft">
                {provider.detail}
              </span>
            )}
            {provider.id === 'comfy-remote' || provider.id === 'comfy-cloud' ? (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto shrink-0"
                onClick={() => setConfiguring(provider.id as 'comfy-remote' | 'comfy-cloud')}
              >
                <IconBox>
                  <Settings {...ICON} />
                </IconBox>
                Configure
              </Button>
            ) : (
              <span className="ml-auto shrink-0 text-sm text-ink-faint">
                {provider.available ? 'Ready' : 'Not configured'}
              </span>
            )}
          </li>
        ))}
      </ul>
      <RemoteEngineDialog open={configuring === 'comfy-remote'} onClose={() => setConfiguring(null)} />
      <CloudEngineDialog open={configuring === 'comfy-cloud'} onClose={() => setConfiguring(null)} />
    </motion.section>
  )
}

export function ConnectorsPage() {
  const { data: stores = [] } = useStores()
  const { data: config } = useConnectConfig()
  const [dialogOpen, setDialogOpen] = useState(false)
  // Disconnect is destructive (wipes the store's local review queue, runs,
  // captions and audit trail) — the row button only opens the confirmation.
  const [disconnecting, setDisconnecting] = useState<ConnectedStore | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const headerConnect = useHover()
  const emptyConnect = useHover()

  // Surface OAuth redirect outcomes (?connected= / ?error=).
  useEffect(() => {
    const connected = searchParams.get('connected')
    const error = searchParams.get('error')
    if (connected) setBanner({ kind: 'ok', text: `${connected} connected successfully.` })
    if (error) setBanner({ kind: 'error', text: error })
    if (connected || error) setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams])

  return (
    <>
      <PageHeader
        actions={
          <Button variant="primary" onClick={() => setDialogOpen(true)} {...headerConnect.props}>
            <IconBox>
              <PlusIcon size={18} animate={headerConnect.state} />
            </IconBox>
            Connect
          </Button>
        }
      />

      <AnimatePresence>
        {banner && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: easeSoft }}
            className={`mb-4 rounded-xl px-4 py-3 text-sm ${
              banner.kind === 'ok' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
            }`}
          >
            {banner.text}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div variants={staggerParent} initial="initial" animate="animate" className="space-y-4">
        <motion.section
          variants={staggerChild}
          className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft"
        >
          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink">
                <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
                  <path d="M15.34 4.18c-.13-.01-.29-.02-.47-.02-.6-.74-1.4-1.42-2.37-1.42-.07 0-.14 0-.2.01C11.84 2.1 11.18 1.8 10.5 1.8 7.96 1.8 6.74 4.97 6.36 6.58c-.99.31-1.69.52-1.78.55-.55.17-.57.19-.64.71C3.88 8.23 2.4 19.66 2.4 19.66l11.52 2.16 6.24-1.35S15.47 4.19 15.34 4.18zm-2.9.9c-.57.18-1.2.37-1.86.58.18-.69.52-1.38 1.94-1.38-.03.25-.05.52-.08.8zm-1.93-1.7c.2 0 .4.07.59.2-.87.41-1.4 1.43-1.62 2.5-.54.17-1.07.33-1.56.48.43-1.48 1.46-3.18 2.59-3.18zm.83 8.04s-.66-.35-1.46-.35c-1.18 0-1.24.74-1.24.93 0 1.02 2.66 1.41 2.66 3.8 0 1.88-1.19 3.09-2.8 3.09-1.93 0-2.92-1.2-2.92-1.2l.52-1.71s1.01.87 1.87.87c.56 0 .79-.44.79-.76 0-1.33-2.18-1.39-2.18-3.58 0-1.84 1.32-3.62 3.99-3.62 1.03 0 1.54.29 1.54.29l-.77 2.24zm1.89-7.42c0-.25 0-.5-.02-.74.62.1 1.02.78 1.28 1.36-.38.12-.81.25-1.26.39v-1.01z" />
                </svg>
              </div>
              <div>
                <h2 className="text-base font-medium">Shopify</h2>
                {stores.length === 0 && (
                  <p className="text-sm text-ink-soft">
                    {config?.mode === 'live'
                      ? 'Connect a Shopify app, or use one-click OAuth.'
                      : 'Create a Shopify app and paste your keys, or try the demo catalog.'}
                  </p>
                )}
              </div>
            </div>
          </div>

          {stores.length === 0 ? (
            <div className="border-t border-line px-5 py-6">
              <p className="max-w-prose text-sm text-ink-soft">
                Connect a Shopify store to pull its product media in for editing. You'll create a
                small app in Shopify and paste its keys here — about two minutes. Nothing is
                published back to your store without your approval.
              </p>
              <SetupSteps className="mt-5 max-w-md" />
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => setDialogOpen(true)} {...emptyConnect.props}>
                  <IconBox>
                    <PlusIcon size={18} animate={emptyConnect.state} />
                  </IconBox>
                  Connect Shopify
                </Button>
                <WatchSetupGuide variant="secondary" />
              </div>
              {config?.mode !== 'live' && (
                <p className="mt-4 text-sm text-ink-faint">
                  Just exploring? Choose <span className="font-medium text-ink">Demo store</span> in
                  the connect dialog for a fully working mock catalog.
                </p>
              )}
            </div>
          ) : (
            <ul className="border-t border-line">
              <AnimatePresence initial={false}>
                {stores.map((store) => (
                  <motion.li
                    key={store.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.35, ease: easeSoft }}
                    className="flex items-center justify-between gap-4 border-b border-line/60 py-2.5 pr-5 pl-6 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <StoreAvatar faviconUrl={store.faviconUrl} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{store.shopName || store.domain}</p>
                        {store.shopName && (
                          <p className="truncate text-sm text-ink-faint">{store.domain}</p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDisconnecting(store)}
                      className="text-ink-faint hover:text-danger"
                    >
                      <IconBox>
                        <Unplug {...ICON} />
                      </IconBox>
                      Disconnect
                    </Button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </motion.section>

        <EnginesCard />

        {stores.length > 0 && <ScopeEditor />}
      </motion.div>

      <ConnectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <DisconnectDialog store={disconnecting} onClose={() => setDisconnecting(null)} />
    </>
  )
}
