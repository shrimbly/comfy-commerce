import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

/**
 * Activity (history). On hover the arrow's pointed end starts just shy of 12
 * o'clock and rubberbands round to its resting point (~10:30); the tail end and
 * the clock hands stay put.
 *
 * The dial circle is centre (12,12) r 8. The arc is drawn from the fixed tail
 * (~8 o'clock) via `pathLength`, so the tail is anchored and the leading edge
 * sweeps. The arrowhead rides that leading edge — it pivots around the dial
 * centre, and shares the arc's spring so the two stay joined through the
 * overshoot. The arc path runs a little past rest (to ~-70°) to give the
 * rubberband somewhere to draw into; `pathLength` rest is < 1 to match.
 */

const ARC = 'M4.582 14.997A8 8 0 1 0 4.482 9.264'
const ARC_REST = 0.9214 // leading edge at the resting head (~10:30 / -45°)
const ARC_FROM = 0.796 // leading edge just shy of 12 o'clock (-5°) — a short sweep
const HEAD_FROM = 40 // arrowhead rotation (deg) at the start, matched to ARC_FROM

export function ActivityIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  // Shared so the arc's leading edge and the arrowhead spring in lockstep.
  const spring = { type: 'spring' as const, visualDuration: 0.4 * scale, bounce: 0.4 }

  const arc = {
    rest: { pathLength: ARC_REST },
    hover: { pathLength: [ARC_FROM, ARC_REST], transition: spring },
  }
  const arrowhead = {
    rest: { rotate: 0 },
    hover: { rotate: [HEAD_FROM, 0], transition: spring },
  }

  return (
    <IconSvg {...props}>
      {/* arc sweeps out from the fixed tail */}
      <motion.path d={ARC} variants={arc} />
      {/* arrowhead (+ its lead-in to the circle) rides the leading edge */}
      <motion.path
        d="M6.34315 6.34315L3.0156 10L3.0156 6M3.0156 10L6.99999 10"
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
        variants={arrowhead}
      />
      {/* clock hands — static */}
      <path d="M12 9V13L15 14.5" />
    </IconSvg>
  )
}
