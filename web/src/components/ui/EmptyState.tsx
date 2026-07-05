import { motion } from 'motion/react'

import { IconBox } from '../../lib/icons.js'
import { fadeRise } from '../../lib/motion.js'

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode
  title: string
  body: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <motion.div
      {...fadeRise}
      className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center"
    >
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-faint">
          <IconBox>{icon}</IconBox>
        </div>
      )}
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-2 max-w-xs text-sm text-ink-soft">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </motion.div>
  )
}
