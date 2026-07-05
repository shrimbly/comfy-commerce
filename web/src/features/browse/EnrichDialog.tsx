import { CAPTION_WORKFLOW_ID, type Product, type ProviderInfo, type RunTarget } from '@comfy-commerce/shared'
import { Cloud, FlaskConical, ICON, IconBox, Monitor, MonitorSmartphone, Sparkles } from '../../lib/icons.js'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { useCreateRun, useProviders } from '../../api/hooks.js'
import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { cn } from '../../lib/cn.js'

const PROVIDER_ICONS: Record<ProviderInfo['id'], typeof Cloud> = {
  mock: FlaskConical,
  'comfy-local': MonitorSmartphone,
  'comfy-remote': Monitor,
  'comfy-cloud': Cloud,
}

interface TargetRef {
  productId: string
  mediaId: string
  enriched: boolean
}

/** The images a target covers, each flagged with whether it's already captioned. */
function targetRefs(products: Product[], target: RunTarget): TargetRef[] {
  if (target.kind === 'selection') {
    const isEnriched = (productId: string, mediaId: string) =>
      Boolean(products.find((p) => p.id === productId)?.media.find((m) => m.id === mediaId)?.enrichedAt)
    return (target.inputs ?? []).map((r) => ({ ...r, enriched: isEnriched(r.productId, r.mediaId) }))
  }
  return products.flatMap((p) =>
    p.media.map((m) => ({ productId: p.id, mediaId: m.id, enriched: Boolean(m.enrichedAt) })),
  )
}

/**
 * Launch a catalog-enrichment run: caption every image in the target to the
 * enrichment store (no review gate, no store changes). Engine is chosen here,
 * already-captioned images are skipped by default.
 */
export function EnrichDialog({
  open,
  onClose,
  storeId,
  products,
  target,
}: {
  open: boolean
  onClose: () => void
  storeId: string
  products: Product[]
  target: RunTarget | null
}) {
  const navigate = useNavigate()
  const { data: providers = [] } = useProviders()
  const createRun = useCreateRun()
  const [providerId, setProviderId] = useState<ProviderInfo['id'] | null>(null)
  const [skipExisting, setSkipExisting] = useState(true)

  // Auto-select a real, available engine — never the mock (it is not offered as a
  // pickable engine). If none is available, leave nothing selected so a run can't
  // silently fall back to the mock engine.
  useEffect(() => {
    if (providers.length === 0) return
    const runnable = providers.filter((p) => p.id !== 'mock' && p.available)
    setProviderId((current) =>
      runnable.some((p) => p.id === current) ? current : (runnable[0]?.id ?? null),
    )
  }, [providers])

  const refs = useMemo(() => (target ? targetRefs(products, target) : []), [products, target])
  const total = refs.length
  const alreadyDone = refs.filter((r) => r.enriched).length
  const toRun = skipExisting ? refs.filter((r) => !r.enriched) : refs

  const selectable = providers.filter((p) => p.id !== 'mock')
  // A run needs a real, available engine selected — never the mock, which is
  // never offered, so the run can't fall back to it.
  const engineReady =
    providerId != null && selectable.some((p) => p.id === providerId && p.available)
  const canRun = engineReady && toRun.length > 0 && !createRun.isPending

  const launch = () => {
    if (!canRun || !providerId) return
    createRun.mutate(
      {
        storeId,
        workflowId: CAPTION_WORKFLOW_ID,
        providerId,
        params: {},
        target: {
          kind: 'selection',
          inputs: toRun.map(({ productId, mediaId }) => ({ productId, mediaId })),
        },
        stageAction: 'add-new',
      },
      {
        onSuccess: () => {
          onClose()
          navigate('/activity')
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Caption product images"
      subtitle="Generate an AI caption and tags for each image to make products searchable and filterable. Results enrich the catalog — nothing is published to your store."
    >
      <div className="space-y-5 px-5 pb-5">
        <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
          <span className="font-medium">{total}</span> image{total === 1 ? '' : 's'} in{' '}
          {target?.kind === 'selection' ? 'your selection' : 'the catalog'}
          {alreadyDone > 0 && <span className="text-ink-faint"> · {alreadyDone} already captioned</span>}
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="text-sm">
            <span className="font-medium">Skip already-captioned</span>
            <span className="block text-ink-faint">Turn off to re-caption everything.</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={skipExisting}
            aria-label="Skip already-captioned images"
            onClick={() => setSkipExisting((v) => !v)}
            className={cn(
              'relative h-6 w-10 shrink-0 cursor-pointer rounded-full transition-colors',
              skipExisting ? 'bg-ink' : 'bg-line-strong',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 size-5 rounded-full bg-surface shadow-soft transition-all',
                skipExisting ? 'left-[1.125rem]' : 'left-0.5',
              )}
            />
          </button>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-ink-soft">Engine — local or cloud</p>
          <div className="grid gap-2">
            {selectable.map((provider) => {
              const Icon = PROVIDER_ICONS[provider.id]
              const active = provider.id === providerId
              return (
                <button
                  key={provider.id}
                  onClick={() => provider.available && setProviderId(provider.id)}
                  disabled={!provider.available}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border p-3 text-left transition-all duration-200',
                    provider.available ? 'cursor-pointer' : 'opacity-50',
                    active ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2',
                  )}
                >
                  <IconBox className={active ? 'text-ink' : 'text-ink-faint'}>
                    <Icon {...ICON} />
                  </IconBox>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{provider.name}</p>
                    <p className="truncate text-sm text-ink-soft">{provider.detail ?? provider.description}</p>
                  </div>
                  <span
                    className={cn(
                      'size-2.5 shrink-0 rounded-full',
                      provider.available ? 'bg-success' : 'bg-ink-faint',
                    )}
                  />
                </button>
              )
            })}
          </div>
          {!engineReady && (
            <p className="mt-2 text-sm text-ink-faint">
              {selectable.some((p) => p.available)
                ? 'Select an engine to run.'
                : 'No engine available — connect Comfy Local or add a Comfy Cloud key to caption.'}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={launch} disabled={!canRun}>
            {createRun.isPending ? (
              <Spinner />
            ) : (
              <IconBox>
                <Sparkles {...ICON} />
              </IconBox>
            )}
            {skipExisting && toRun.length === 0 && total > 0
              ? 'All captioned'
              : `Caption ${toRun.length} image${toRun.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
