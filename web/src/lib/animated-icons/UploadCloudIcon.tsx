import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

/** easeOutCubic — a soft, settling rise, no overshoot. */
const EASE = [0.33, 1, 0.68, 1] as const

/**
 * Upload (cloud-upload). On hover the cloud and the arrow gently lift up into
 * place — a small upward settle, the arrow rising clearly more than the cloud so
 * it reads as an upload. Kept deliberately subtle; the units are viewBox (24)
 * coordinates, so a `y` of 5 ≈ 3.75px rendered.
 */
export function UploadCloudIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  const transition = { duration: 0.4 * scale, ease: EASE }

  const cloud = {
    rest: { y: 0 },
    hover: { y: [1.5, 0], transition },
  }
  const arrow = {
    rest: { y: 0 },
    hover: { y: [5, 0], transition },
  }

  return (
    <IconSvg {...props}>
      {/* cloud */}
      <motion.path
        d="M7 19L5.78311 18.9954C3.12231 18.8818 1 16.6888 1 14C1 11.3501 3.06139 9.18169 5.66806 9.01084C6.78942 6.64027 9.20316 5 12 5C15.5268 5 18.4445 7.60822 18.9293 11.001L19 11C21.2091 11 23 12.7909 23 15C23 17.1422 21.316 18.8911 19.1996 18.9951L17 19"
        variants={cloud}
        style={{ transformBox: 'view-box' }}
      />
      {/* arrow — shaft + head, lifts a touch more */}
      <motion.g variants={arrow} style={{ transformBox: 'view-box' }}>
        <path d="M12 20V12" />
        <path d="M9 15L12 12L15 15" />
      </motion.g>
    </IconSvg>
  )
}
