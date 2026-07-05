import { motion } from 'motion/react'

import { IconSvg, useIconAnimScale, type AnimatedIconProps } from './shared.js'

/**
 * Moon (dark mode toggle). On hover the terminator nudges into place: the icon
 * starts as a slightly-opened crescent and the occluded edge settles across to
 * the full crescent. Done by morphing the path `d` — OPEN and CRESCENT share the
 * same command structure (M + 6 cubics + Z), so only the three inner-curve
 * segments differ; the outer limb is identical in both, so it stays put while
 * the shadow edge travels. OPEN is a ~40% interpolation toward the full disc —
 * just enough to read, a short sweep rather than a full reveal.
 */
const CRESCENT =
  'M19.5761 14.5765C18.7677 14.8513 17.9013 15.0003 17 15.0003C12.5817 15.0003 9 11.4186 9 7.00029C9 6.09888 9.14908 5.23229 9.42394 4.42383C6.26952 5.49607 4 8.48301 4 12C4 16.4183 7.58172 20 12 20C15.5169 20 18.5037 17.7307 19.5761 14.5765Z'
const OPEN =
  'M19.5761 14.5765C19.349 13.984 18.7928 13.2466 17.9304 12.5142C14.9578 11.7818 12.2232 9.046 11.4912 6.0722C10.7592 5.2085 10.0163 4.651 9.42394 4.42383C6.26952 5.49607 4 8.48301 4 12C4 16.4183 7.58172 20 12 20C15.5169 20 18.5037 17.7307 19.5761 14.5765Z'

/** easeOutCubic — the shadow edge settles cleanly into place. */
const EASE = [0.33, 1, 0.68, 1] as const

export function MoonIcon(props: AnimatedIconProps) {
  const scale = useIconAnimScale()
  const moon = {
    rest: { d: CRESCENT },
    hover: { d: [OPEN, CRESCENT], transition: { duration: 0.42 * scale, ease: EASE } },
  }

  return (
    <IconSvg {...props}>
      <motion.path d={CRESCENT} variants={moon} />
    </IconSvg>
  )
}
