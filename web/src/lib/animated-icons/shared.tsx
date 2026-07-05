import { motion } from 'motion/react'
import { createContext, useContext, type ReactNode } from 'react'

export type IconAnimState = 'rest' | 'hover'

export interface AnimatedIconProps {
  size?: number
  /** Active animation state — usually driven by the parent row's hover. */
  animate?: IconAnimState
  className?: string
}

/**
 * Duration multiplier for the icon lab — 1 in the app, >1 to slow animations
 * down for review. Each animated icon scales its transition durations by this.
 */
const ScaleContext = createContext(1)
export const IconAnimScaleProvider = ScaleContext.Provider
export const useIconAnimScale = () => useContext(ScaleContext)

/**
 * Shared motion-SVG shell for animated icons: a 24px box with iconcino's stroke
 * (2px, round caps), inherited by child paths. It forwards the `animate` label
 * ('rest' | 'hover') to every child motion element via variant propagation, so
 * each icon only declares per-shape `rest`/`hover` variants. At `rest` an icon
 * is pixel-identical to its static iconcino counterpart.
 */
export function IconSvg({
  size = 18,
  animate = 'rest',
  className,
  children,
}: AnimatedIconProps & { children: ReactNode }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      initial="rest"
      animate={animate}
      className={className}
    >
      {children}
    </motion.svg>
  )
}
