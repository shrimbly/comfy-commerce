import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

/** How far the bottom arrow starts off to the left before sliding home. */
const SLIDE = 10

/** Soft ease-out so the arrow settles gently at the end of its slide. */
const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** Total animation length — matches the Connectors icon. */
const T = 0.34

/**
 * Workflows (flows-1). On hover only the bottom arrow slides in from the left;
 * its leading dots are hidden on the first frame and reveal inner-then-outer as
 * it arrives. The top arrow stays put. The SVG clips to its box so the off-left
 * parts wipe in cleanly, and timing rides one delay-0 timeline via `times` so
 * the dots never flash before their reveal.
 */
export function WorkflowsIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  const duration = T * scale
  const at = (seconds: number) => seconds / T // seconds → fraction of the timeline

  // Slides home from `SLIDE` units off-left over the first 0.25s.
  const arrow = {
    rest: { x: 0 },
    hover: { x: [-SLIDE, 0], transition: { duration, ease: EASE_OUT, times: [0, at(0.25)] } },
  }

  // A dot stays hidden until `start`, then fades in over 0.12s.
  const dot = (start: number) => ({
    rest: { opacity: 1 },
    hover: {
      opacity: [0, 0, 1],
      transition: { duration, ease: EASE_OUT, times: [0, at(start), at(start + 0.12)] },
    },
  })

  return (
    <IconSvg {...props} className="overflow-hidden">
      {/* top arrow — static */}
      <path d="M10.9999 7.99994H20.9999" />
      <path d="M18 10.9999L20.9999 7.99994L18 5" />
      <path d="M8 8H8.01" />
      <path d="M5 8H5.01" />
      {/* bottom arrow slides in; its dots reveal inner-then-outer */}
      <motion.g variants={arrow}>
        <path d="M9.99994 15.9999H16.9999" />
        <path d="M13.9999 19L16.9999 15.9999L13.9999 12.9999" />
        <motion.path d="M7 16H7.01" variants={dot(0.12)} />
        <motion.path d="M4 16H4.01" variants={dot(0.17)} />
      </motion.g>
    </IconSvg>
  )
}
