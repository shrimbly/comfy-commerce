import { ICON, IconBox, X } from '../../lib/icons.js'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: React.ReactNode
  className?: string
  /** Optional control rendered in the header, to the left of the close button. */
  headerAction?: React.ReactNode
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  className,
  headerAction,
}: DialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: easeSoft }}
        >
          <div
            className="absolute inset-0 bg-ink/20 backdrop-blur-[3px] dark:bg-black/50"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn(
              'relative flex max-h-[calc(100vh-3rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lift',
              className,
            )}
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.35, ease: easeSoft }}
          >
            <header className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 pb-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-medium">{title}</h2>
                  {headerAction}
                </div>
                {subtitle && <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink cursor-pointer"
              >
                <IconBox>
                  <X {...ICON} />
                </IconBox>
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
