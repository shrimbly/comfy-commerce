import { forwardRef } from 'react'

import { cn } from '../../lib/cn.js'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
type Size = 'sm' | 'md'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-deep border border-transparent shadow-soft',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-soft hover:text-ink hover:bg-surface-2 border border-transparent',
  danger: 'bg-transparent text-danger border border-line hover:bg-danger-soft',
  success: 'bg-success-strong text-white hover:opacity-90 border border-transparent shadow-soft',
}

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2 gap-1',
  md: 'h-8 px-3 gap-1',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-lg text-sm font-medium',
        'transition-all duration-200 ease-out cursor-pointer select-none',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
})
