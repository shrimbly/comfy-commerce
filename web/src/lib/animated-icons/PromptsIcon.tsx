import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

const T = 0.34
/** easeOutCubic — steady, gentle settle. */
const DRAW = [0.33, 1, 0.68, 1] as const

/**
 * Prompts (note-01). On hover the two content lines "write in" left-to-right,
 * staggered, like text being typed. The page and folded corner stay put.
 */
export function PromptsIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  const duration = T * scale
  const at = (seconds: number) => seconds / T

  // A line stays blank until `start`, then draws to full by `end`.
  const line = (start: number, end: number) => ({
    rest: { pathLength: 1 },
    hover: {
      pathLength: [0, 0, 1],
      transition: { duration, ease: DRAW, times: [0, at(start), at(end)] },
    },
  })

  return (
    <IconSvg {...props}>
      {/* note outline + folded corner — static */}
      <path d="M19 9L13 3H7C5.89543 3 5 3.89543 5 5V19C5 20.1046 5.89543 21 7 21H17C18.1046 21 19 20.1046 19 19V9Z" />
      <path d="M13 3V8C13 8.55228 13.4477 9 14 9H19" />
      {/* two content lines write in, staggered */}
      <motion.path d="M9 13H15" variants={line(0.02, 0.22)} />
      <motion.path d="M9 17H15" variants={line(0.12, 0.32)} />
    </IconSvg>
  )
}
