import { Check, ICON, IconBox, X } from '../../lib/icons.js'
import { motion } from 'motion/react'
import { createPortal } from 'react-dom'

import { Button } from '../../components/ui/Button.js'
import { PlayIcon } from '../../lib/animated-icons/PlayIcon.js'
import { useHover } from '../../lib/useHover.js'
import { easeSoft } from '../../lib/motion.js'

export interface Selection {
  productId: string
  mediaId: string
  productTitle: string
  url: string
}

/** Floating action bar that rises when media is selected. */
export function SelectionBar({
  count,
  allSelected,
  onSelectAll,
  onClear,
  onRun,
}: {
  count: number
  allSelected: boolean
  onSelectAll: () => void
  onClear: () => void
  onRun: () => void
}) {
  const run = useHover()
  // Portal to the body so `fixed` is anchored to the viewport, not the
  // max-width-animated page container in AppShell (which is a containing block
  // for fixed descendants and would otherwise pin this to the bottom of the
  // scrollable content instead of the screen).
  return createPortal(
    <motion.div
      initial={{ opacity: 0, y: 64 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 64 }}
      transition={{ duration: 0.4, ease: easeSoft }}
      className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-6"
    >
      <div className="flex items-center gap-3 rounded-[40px] border border-line bg-surface/95 p-2 pl-4 shadow-lift backdrop-blur-md">
        <span className="text-sm text-ink-soft">
          <span className="font-medium text-ink">{count}</span> selected
        </span>
        <span className="h-5 w-px bg-line" />
        <Button
          variant="ghost"
          size="sm"
          onClick={onSelectAll}
          disabled={allSelected}
          aria-label="Select all visible"
          className="rounded-[40px]"
        >
          <IconBox>
            <Check {...ICON} />
          </IconBox>
          Select all
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear} aria-label="Clear selection" className="rounded-[40px]">
          <IconBox>
            <X {...ICON} />
          </IconBox>
          Clear
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onRun}
          className="rounded-[40px]"
          {...run.props}
        >
          <IconBox>
            <PlayIcon size={18} animate={run.state} />
          </IconBox>
          Run workflow
        </Button>
      </div>
    </motion.div>,
    document.body,
  )
}
