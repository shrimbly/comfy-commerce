import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

/** The lock home: keeps moving in, then ramps into a steep, sharp finish — no bounce. */
const SOFT_IN_SHARP_OUT = [0.3, 0.1, 0.8, 0.12] as const

/**
 * Connectors (link-2). On hover the two brackets start a touch wider apart and
 * lock into place; the centre bar holds still. Geometry is split out of the
 * single iconcino path so the brackets can move independently.
 */
export function ConnectorsIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()

  // On hover each bracket starts a touch wider apart and snaps home with a
  // soft-in / steep-out lock — no windup, just the lock-in.
  const bracket = (offset: number) => ({
    rest: { x: 0 },
    hover: {
      x: [offset, 0],
      transition: { duration: 0.28 * scale, ease: SOFT_IN_SHARP_OUT },
    },
  })

  return (
    <IconSvg {...props}>
      {/* left bracket */}
      <motion.path
        d="M10 8H7C4.79086 8 3 9.79086 3 12C3 14.2091 4.79086 16 7 16H10"
        variants={bracket(-2.5)}
      />
      {/* right bracket */}
      <motion.path
        d="M14 8H17C19.2091 8 21 9.79086 21 12C21 14.2091 19.2091 16 17 16H14"
        variants={bracket(2.5)}
      />
      {/* centre bar — static */}
      <motion.path d="M9 12H15" />
    </IconSvg>
  )
}
