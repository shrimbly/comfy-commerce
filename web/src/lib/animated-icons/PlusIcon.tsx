import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

/**
 * Plus (add / connect). On hover it scales up a touch — a small, springy pop
 * about its centre (12,12). Used in the "Connect", "New prompt", etc. buttons.
 */
export function PlusIcon(props: AnimatedIconProps) {
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
        d="M12 6V18M18 12H6"
        variants={pop}
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
      />
    </IconSvg>
  )
}
