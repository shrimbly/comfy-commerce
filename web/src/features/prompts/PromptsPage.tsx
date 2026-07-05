import { ICON, IconBox, NotebookPen, Pencil, Search, Trash2 } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'

import { useSavePrompt, useUpdatePrompt, type SavedPrompt } from '../../api/hooks.js'
import { PlusIcon } from '../../lib/animated-icons/PlusIcon.js'
import { useHover } from '../../lib/useHover.js'
import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { PageHeader } from '../../components/ui/PageHeader.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { easeSoft } from '../../lib/motion.js'
import { usePromptLibrary } from '../../lib/promptLibrary.js'
import { timeAgo } from '../../lib/time.js'

/** Create / edit a prompt — same editor either way. */
function PromptDialog({
  open,
  prompt,
  onClose,
}: {
  open: boolean
  prompt: SavedPrompt | null
  onClose: () => void
}) {
  const create = useSavePrompt()
  const update = useUpdatePrompt()
  const [name, setName] = useState('')
  const [text, setText] = useState('')

  useEffect(() => {
    if (open) {
      setName(prompt?.name ?? '')
      setText(prompt?.text ?? '')
    }
  }, [open, prompt])

  const busy = create.isPending || update.isPending
  const save = async () => {
    if (!text.trim()) return
    if (prompt) await update.mutateAsync({ id: prompt.id, name, text })
    else await create.mutateAsync({ text, ...(name.trim() ? { name } : {}) })
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title={prompt ? 'Edit prompt' : 'New prompt'} className="max-w-2xl">
      <div className="px-5 pb-5">
        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional — e.g. Marble pedestal scene"
            className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
          />
        </label>
        <label className="mt-3 block">
          <span className="text-sm font-medium">Prompt</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus={!prompt}
            placeholder="Write the prompt — line breaks are kept."
            className="mt-1 h-[40vh] w-full resize-none rounded-xl border border-line-strong bg-surface p-4 text-base outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || !text.trim()}>
            {busy && <Spinner />}
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function PromptsPage() {
  // usePromptLibrary also folds any pre-server localStorage prompts in.
  const { prompts, remove } = usePromptLibrary()
  const [dialog, setDialog] = useState<{ open: boolean; prompt: SavedPrompt | null }>({
    open: false,
    prompt: null,
  })
  const [query, setQuery] = useState('')
  const headerNew = useHover()
  const emptyNew = useHover()

  const q = query.trim().toLowerCase()
  const filtered = q
    ? prompts.filter(
        (p) => (p.name ?? '').toLowerCase().includes(q) || p.text.toLowerCase().includes(q),
      )
    : prompts

  return (
    <>
      <PageHeader
        subtitle="Reusable prompts — write once, use in any run."
        actions={
          <Button
            variant="primary"
            onClick={() => setDialog({ open: true, prompt: null })}
            {...headerNew.props}
          >
            <IconBox>
              <PlusIcon size={18} animate={headerNew.state} />
            </IconBox>
            New prompt
          </Button>
        }
      />

      {prompts.length === 0 ? (
        <EmptyState
          icon={<NotebookPen {...ICON} />}
          title="No prompts yet"
          body="Save prompts here (or from any run's prompt field) and reuse them across workflows."
          action={
            <Button
              variant="primary"
              onClick={() => setDialog({ open: true, prompt: null })}
              {...emptyNew.props}
            >
              <IconBox>
                <PlusIcon size={18} animate={emptyNew.state} />
              </IconBox>
              Write a prompt
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          {/* Filter bar — the header of the listing card. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-3">
            <div className="flex h-8 w-64 items-center gap-1 rounded-lg border border-line bg-surface px-2 transition-colors focus-within:border-ink">
              <IconBox className="shrink-0 text-ink-faint">
                <Search {...ICON} />
              </IconBox>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search prompts…"
                className="h-full w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
              />
            </div>
            <span className="px-1 text-sm text-ink-faint">
              {q ? `${filtered.length} of ${prompts.length}` : prompts.length} prompt
              {prompts.length === 1 ? '' : 's'}
            </span>
          </div>

          {filtered.length === 0 && (
            <p className="px-5 py-16 text-center text-sm text-ink-soft">No prompts match.</p>
          )}

          <AnimatePresence mode="popLayout">
            {filtered.map((prompt) => (
              <motion.article
                key={prompt.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.3, ease: easeSoft }}
                onClick={() => setDialog({ open: true, prompt })}
                className="group flex cursor-pointer items-center gap-4 border-b border-line px-5 py-3 transition-colors last:border-b-0 hover:bg-surface-2/50"
              >
                <div className="min-w-0 flex-1">
                  {prompt.name && <p className="truncate text-sm font-medium">{prompt.name}</p>}
                  <p className={prompt.name ? 'truncate text-sm text-ink-faint' : 'truncate text-sm text-ink-soft'}>
                    {prompt.text}
                  </p>
                </div>
                <span className="w-20 shrink-0 text-right text-sm text-ink-faint">
                  {timeAgo(prompt.updatedAt)}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setDialog({ open: true, prompt })
                  }}
                  aria-label="Edit prompt"
                  title="Edit"
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-surface-2 hover:text-ink cursor-pointer"
                >
                  <IconBox>
                    <Pencil {...ICON} />
                  </IconBox>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(prompt.id)
                  }}
                  aria-label="Delete prompt"
                  title="Delete"
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-faint opacity-0 transition-all group-hover:opacity-100 hover:bg-danger-soft hover:text-danger cursor-pointer"
                >
                  <IconBox>
                    <Trash2 {...ICON} />
                  </IconBox>
                </button>
              </motion.article>
            ))}
          </AnimatePresence>
        </div>
      )}

      <PromptDialog
        open={dialog.open}
        prompt={dialog.prompt}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
      />
    </>
  )
}
