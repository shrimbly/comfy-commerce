/** Shared motion vocabulary — one soft ease, consistent durations. */

export const easeSoft = [0.22, 1, 0.36, 1] as const

export const fadeRise = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, ease: easeSoft },
}

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.4, ease: easeSoft },
}

/** Stagger container for lists/grids. */
export const staggerParent = {
  animate: { transition: { staggerChildren: 0.045, delayChildren: 0.05 } },
}

export const staggerChild = {
  initial: { opacity: 0, y: 10, scale: 0.99 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: easeSoft } },
}
