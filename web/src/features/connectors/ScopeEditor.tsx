import type { MediaRole, ProductStatus, ScopeProfile } from '@comfy-commerce/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'

import { useCatalog, useScopePreview, useUpdateScope } from '../../api/hooks.js'
import { Button } from '../../components/ui/Button.js'
import { Segmented } from '../../components/ui/Segmented.js'
import { ChevronDown, ICON, IconBox } from '../../lib/icons.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { useStoreContext } from '../../store/StoreContext.js'

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'h-7 rounded-[40px] border px-3 text-sm font-medium transition-all duration-200 cursor-pointer',
        active
          ? 'border-ink bg-ink text-surface'
          : 'border-line bg-surface text-ink-soft hover:bg-surface-2 hover:text-ink',
      )}
    >
      {label}
    </button>
  )
}

/** "What syncs into Comfy Commerce" — the saved per-store sync profile that
 *  decides which product media is pulled in for editing. */
export function ScopeEditor() {
  const { activeStore } = useStoreContext()
  const { data: catalog } = useCatalog(activeStore?.id)
  const updateScope = useUpdateScope(activeStore?.id ?? '')

  const [draft, setDraft] = useState<ScopeProfile | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setDraft(activeStore ? activeStore.scopeProfile : null)
  }, [activeStore])

  const { data: preview } = useScopePreview(activeStore?.id, draft)

  const dirty = useMemo(
    () =>
      Boolean(
        draft && activeStore && JSON.stringify(draft) !== JSON.stringify(activeStore.scopeProfile),
      ),
    [draft, activeStore],
  )

  if (!activeStore || !draft) return null

  const toggleCollection = (id: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = prev.collectionIds === 'all' ? [] : prev.collectionIds
      const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id]
      return { ...prev, collectionIds: next.length === 0 ? 'all' : next }
    })
  }

  const toggleTag = (tag: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = prev.tags.includes(tag) ? prev.tags.filter((t) => t !== tag) : [...prev.tags, tag]
      return { ...prev, tags: next }
    })
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.15, ease: easeSoft }}
      className="rounded-2xl border border-line bg-surface p-5 shadow-soft"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-medium leading-none">Product Filters</h2>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          Show filters
          <IconBox className={cn('transition-transform duration-200', expanded && 'rotate-180')}>
            <ChevronDown {...ICON} />
          </IconBox>
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="filters"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: easeSoft }}
            className="overflow-hidden"
          >
            <div className="mt-5 flex flex-wrap items-start gap-x-6 gap-y-4">
              <div>
                <p className="mb-2 text-sm font-medium text-ink-soft">Product status</p>
                <Segmented<ProductStatus>
                  value={draft.productStatus}
                  onChange={(productStatus) => setDraft({ ...draft, productStatus })}
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'draft', label: 'Draft' },
                    { value: 'archived', label: 'Archived' },
                  ]}
                />
              </div>
              <div>
                <p className="mb-2 text-sm font-medium text-ink-soft">Media</p>
                <Segmented<MediaRole>
                  value={draft.mediaRole}
                  onChange={(mediaRole) => setDraft({ ...draft, mediaRole })}
                  options={[
                    { value: 'featured', label: 'Featured only' },
                    { value: 'all', label: 'All images' },
                    { value: 'all-with-video', label: 'All + video/3D' },
                  ]}
                />
              </div>
            </div>

            {catalog && (catalog.collections.length > 0 || catalog.tags.length > 0) && (
              <div className="mt-5 grid gap-4">
                {catalog.collections.length > 0 && (
                  <div>
                    <p className="mb-2 text-sm font-medium text-ink-soft">Collections</p>
                    <div className="flex flex-wrap gap-2">
                      <FilterChip
                        label="All collections"
                        active={draft.collectionIds === 'all'}
                        onClick={() => setDraft({ ...draft, collectionIds: 'all' })}
                      />
                      {catalog.collections.map((collection) => (
                        <FilterChip
                          key={collection.id}
                          label={collection.title}
                          active={
                            draft.collectionIds !== 'all' &&
                            draft.collectionIds.includes(collection.id)
                          }
                          onClick={() => toggleCollection(collection.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {catalog.tags.length > 0 && (
                  <div>
                    <p className="mb-2 text-sm font-medium text-ink-soft">Tags</p>
                    <div className="flex flex-wrap gap-2">
                      {catalog.tags.map((tag) => (
                        <FilterChip
                          key={tag}
                          label={`#${tag}`}
                          active={draft.tags.includes(tag)}
                          onClick={() => toggleTag(tag)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
              <p className="text-sm text-ink-soft">
                Syncing{' '}
                <motion.span
                  key={`${preview?.images}-${preview?.products}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.25, ease: easeSoft }}
                  className="inline-block"
                >
                  ≈ <span className="font-semibold text-ink">{preview?.images ?? '—'}</span> images
                  across <span className="font-semibold text-ink">{preview?.products ?? '—'}</span>{' '}
                  products
                </motion.span>
              </p>
              <AnimatePresence>
                {dirty && (
                  <motion.div
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    transition={{ duration: 0.25, ease: easeSoft }}
                    className="flex shrink-0 items-center gap-2"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDraft(activeStore.scopeProfile)}
                    >
                      Discard
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={updateScope.isPending}
                      onClick={() => updateScope.mutate(draft)}
                    >
                      Save profile
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  )
}
