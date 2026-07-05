import { Bookmark, BookmarkCheck, BookmarkPlus, ICON, IconBox, Maximize2, Trash2 } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'
import { usePromptLibrary } from '../../lib/promptLibrary.js'

// Cap auto-grow at ~7 lines; beyond that the textarea scrolls internally
// rather than pushing the rest of the form down the page.
const MAX_TEXTAREA_HEIGHT = 176

function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={3}
      className="min-h-[72px] w-full resize-none rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
    />
  )
}

function LibraryMenu({
  open,
  onClose,
  current,
  onInsert,
}: {
  open: boolean
  onClose: () => void
  current: string
  onInsert: (text: string) => void
}) {
  const { prompts, save, remove } = usePromptLibrary()
  const alreadySaved = prompts.some((p) => p.text === current.trim())

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.99 }}
          transition={{ duration: 0.22, ease: easeSoft }}
          className="absolute top-full right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-lift"
        >
          <button
            disabled={!current.trim() || alreadySaved}
            onClick={() => {
              save(current)
              onClose()
            }}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium cursor-pointer',
              'transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-45',
            )}
          >
            <IconBox className="text-ink-faint">
              <BookmarkPlus {...ICON} />
            </IconBox>
            {alreadySaved ? 'Current prompt saved' : 'Save current prompt'}
          </button>

          {prompts.length > 0 && <div className="mx-3 my-1 border-t border-line" />}

          <div className="max-h-64 overflow-y-auto">
            {prompts.map((prompt) => (
              <div key={prompt.id} className="group/item flex items-center gap-1 rounded-lg transition-colors hover:bg-surface-2">
                <button
                  onClick={() => {
                    onInsert(prompt.text)
                    onClose()
                  }}
                  title={prompt.text}
                  className="h-9 min-w-0 flex-1 truncate px-3 text-left text-sm text-ink-soft cursor-pointer"
                >
                  {prompt.name ? (
                    <>
                      <span className="font-medium text-ink">{prompt.name}</span>
                      <span className="text-ink-faint"> · {prompt.text}</span>
                    </>
                  ) : (
                    prompt.text
                  )}
                </button>
                <button
                  onClick={() => remove(prompt.id)}
                  aria-label="Delete saved prompt"
                  className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-faint opacity-0 transition-all group-hover/item:opacity-100 hover:bg-danger-soft hover:text-danger cursor-pointer"
                >
                  <IconBox>
                    <Trash2 {...ICON} />
                  </IconBox>
                </button>
              </div>
            ))}
            {prompts.length === 0 && (
              <p className="px-3 py-2 text-sm text-ink-faint">
                Nothing saved yet — write a prompt, then save it here for reuse.
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function PromptEditorDialog({
  open,
  label,
  value,
  onApply,
  onClose,
}: {
  open: boolean
  label: string
  value: string
  onApply: (next: string) => void
  onClose: () => void
}) {
  const { prompts, save } = usePromptLibrary()
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  const alreadySaved = prompts.some((p) => p.text === draft.trim())

  return (
    <Dialog open={open} onClose={onClose} title={label} className="max-w-2xl">
      <div className="px-5 pb-5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          className="h-[48vh] w-full resize-none rounded-xl border border-line-strong bg-surface p-4 text-base outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
        />
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => save(draft)} disabled={!draft.trim() || alreadySaved}>
            <IconBox>
              <BookmarkPlus {...ICON} />
            </IconBox>
            {alreadySaved ? 'Saved' : 'Save to library'}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onApply(draft)
                onClose()
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * Multi-line prompt input: auto-grows with the text (line breaks supported),
 * expands into a large editor, and hooks into the saved-prompt library.
 */
export function PromptField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (next: string) => void
}) {
  const [editorOpen, setEditorOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const { prompts, save } = usePromptLibrary()
  const alreadySaved = prompts.some((p) => p.text === value.trim())

  useEffect(() => {
    if (!libraryOpen) return
    const onClick = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setLibraryOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [libraryOpen])

  return (
    <div ref={wrap} className="relative">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-ink-soft">{label}</p>
        <div className="flex items-center gap-1">
          <button
            onClick={() => save(value)}
            disabled={!value.trim() || alreadySaved}
            aria-label={alreadySaved ? 'Prompt saved' : 'Save prompt'}
            title={alreadySaved ? 'Prompt saved' : 'Save prompt'}
            className={cn(
              'flex size-6 items-center justify-center rounded-lg transition-colors',
              alreadySaved
                ? 'text-success'
                : 'text-ink-faint hover:bg-surface-2 hover:text-ink cursor-pointer disabled:pointer-events-none disabled:opacity-45',
            )}
          >
            <IconBox>{alreadySaved ? <BookmarkCheck {...ICON} /> : <BookmarkPlus {...ICON} />}</IconBox>
          </button>
          <button
            onClick={() => setLibraryOpen((v) => !v)}
            aria-label="Saved prompts"
            title="Saved prompts"
            className={cn(
              'flex size-6 items-center justify-center rounded-lg transition-colors cursor-pointer',
              libraryOpen ? 'bg-surface-2 text-ink' : 'text-ink-faint hover:bg-surface-2 hover:text-ink',
            )}
          >
            <IconBox>
              <Bookmark {...ICON} />
            </IconBox>
          </button>
          <button
            onClick={() => setEditorOpen(true)}
            aria-label={`Expand ${label} editor`}
            title="Open large editor"
            className="flex size-6 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
          >
            <IconBox>
              <Maximize2 {...ICON} />
            </IconBox>
          </button>
        </div>
      </div>

      <AutoGrowTextarea value={value} onChange={onChange} placeholder={placeholder} />

      <LibraryMenu
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        current={value}
        onInsert={onChange}
      />
      <PromptEditorDialog
        open={editorOpen}
        label={label}
        value={value}
        onApply={onChange}
        onClose={() => setEditorOpen(false)}
      />
    </div>
  )
}
