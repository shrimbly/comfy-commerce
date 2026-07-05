import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

/**
 * Play (run). On hover it scales up a touch — a small, springy pop about its
 * centre, matching the Plus button. Used in the run buttons ("Run catalog",
 * "Run workflow", …) and the guide "Watch"/"How to" triggers.
 */
export function PlayIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  const pop = {
    rest: { scale: 1 },
    hover: {
      scale: 1.18,
      transition: { type: 'spring' as const, visualDuration: 0.2 * scale, bounce: 0.45 },
    },
  }

  return (
    <IconSvg {...props}>
      <motion.path
        d="M8 17.259V6.74104C8 5.96925 8.83721 5.48837 9.50387 5.87726L19.2596 11.5681C19.5904 11.761 19.5904 12.2389 19.2596 12.4319L9.50387 18.1227C8.83721 18.5116 8 18.0308 8 17.259Z"
        variants={pop}
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
      />
    </IconSvg>
  )
}
