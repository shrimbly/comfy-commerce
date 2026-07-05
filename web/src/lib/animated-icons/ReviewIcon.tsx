import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

const T = 0.34
/** Back-out: a small overshoot past full size, then settle — a "stamp". */
const POP = [0.34, 1.56, 0.64, 1] as const

/**
 * Review & publish (shield). On hover the shield stamps in — scaling up from
 * slightly small with a small overshoot, like a seal of approval going down.
 */
export function ReviewIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  const duration = T * 0.85 * scale // a touch quicker — a stamp, not a drift

  const shield = {
    rest: { scale: 1 },
    hover: { scale: [0.8, 1], transition: { duration, ease: POP } },
  }

  return (
    <IconSvg {...props}>
      <motion.path
        d="M4 5L4.69699 5.07744C7.14576 5.34953 9.60878 4.70802 11.6137 3.27594L12 3L12.3863 3.27594C14.3912 4.70802 16.8542 5.34953 19.303 5.07744L20 5V12.0557C20 15.0859 18.288 17.856 15.5777 19.2111L12 21L8.42229 19.2111C5.71202 17.856 4 15.0859 4 12.0557V5Z"
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        variants={shield}
      />
    </IconSvg>
  )
}
