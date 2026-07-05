import { motion } from 'motion/react'
import { useId } from 'react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

const T = 0.34
const FRAME =
  'M6 20H18C19.1046 20 20 19.1046 20 18V6C20 4.89543 19.1046 4 18 4H6C4.89543 4 4 4.89543 4 6V18C4 19.1046 4.89543 20 6 20Z'
const HILL =
  'M4 17L7.58959 13.7694C8.38025 13.0578 9.58958 13.0896 10.3417 13.8417L11.5 15L15.0858 11.4142C15.8668 10.6332 17.1332 10.6332 17.9142 11.4142L20 13.5'
/** Everything above the ridge — the hill line closed up to the frame's top corners. */
const SKY = `${HILL}L20 4L4 4Z`
/** easeOutCubic — the sun rises and settles. */
const RISE = [0.33, 1, 0.68, 1] as const

/**
 * Browse products (image). On hover the sun rises from behind the hills to its
 * resting spot. It's clipped to the sky (above the ridge), so it emerges from
 * behind the hill line rather than crossing it. The hill and frame stay put.
 */
export function BrowseIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  const duration = T * scale
  const clipId = `browse-sky-${useId().replace(/:/g, '')}`

  // Sun climbs up from behind the ridge to its resting position.
  const sun = {
    rest: { y: 0 },
    hover: { y: [6, 0], transition: { duration, ease: RISE } },
  }

  return (
    <IconSvg {...props}>
      <clipPath id={clipId}>
        <path d={SKY} />
      </clipPath>
      {/* sun rises, clipped to the sky so it comes up from behind the hills */}
      <g clipPath={`url(#${clipId})`}>
        <motion.path
          d="M11 9C11 9.55228 10.5523 10 10 10C9.44772 10 9 9.55228 9 9C9 8.44772 9.44772 8 10 8C10.5523 8 11 8.44772 11 9Z"
          variants={sun}
        />
      </g>
      {/* hill sits over the sun's base; frame border on top */}
      <path d={HILL} />
      <path d={FRAME} />
    </IconSvg>
  )
}
