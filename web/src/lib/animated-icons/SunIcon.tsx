import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

/**
 * Sun (light mode toggle). On hover the whole sun turns a little — a slight,
 * springy rotation about its centre (12,12). The core disc is rotationally
 * symmetric, so it's the rays that read the turn; it settles a touch shy of the
 * next ray so the rotation stays visible while hovered.
 */
export function SunIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  const spin = {
    rest: { rotate: 0 },
    hover: {
      rotate: 30,
      transition: { type: 'spring' as const, visualDuration: 0.5 * scale, bounce: 0.35 },
    },
  }

  return (
    <IconSvg {...props}>
      <motion.path
        d="M5 12H3M12 5V3M21 12H19M12 21V19M16.9496 16.9498L18.3638 18.364M5.63602 5.63608L7.05023 7.05029M16.9496 7.0502L18.3638 5.63599M5.63602 18.3639L7.05023 16.9497M15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12Z"
        variants={spin}
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
      />
    </IconSvg>
  )
}
