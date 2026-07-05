import { motion } from 'motion/react'
import { useId, type ReactNode } from 'react'

import { cn } from '../../lib/cn.js'
import { easeSoft } from '../../lib/motion.js'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** When set, rendered in place of the label text; `label` becomes the accessible name. */
  icon?: ReactNode
}

/** Segmented control with a morphing active indicator. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  const groupId = useId()
  return (
    <div
      role="radiogroup"
      className={cn(
        'inline-flex items-center gap-1 rounded-xl border border-line bg-surface-2 p-1',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            role="radio"
            aria-checked={active}
            aria-label={option.icon ? option.label : undefined}
            title={option.icon ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative h-7 rounded-lg text-sm font-medium whitespace-nowrap cursor-pointer',
              'transition-colors duration-200',
              option.icon ? 'px-2.5' : 'px-3',
              active ? 'text-ink' : 'text-ink-soft hover:text-ink',
            )}
          >
            {active && (
              <motion.span
                layoutId={`segmented-${groupId}`}
                className="absolute inset-0 rounded-lg border border-line bg-surface shadow-soft"
                transition={{ duration: 0.35, ease: easeSoft }}
              />
            )}
            <span className="relative flex items-center">{option.icon ?? option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
