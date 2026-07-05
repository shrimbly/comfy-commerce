import { motion, useMotionValue, useSpring, useTransform } from 'motion/react'
import { useRef } from 'react'

import { cn } from '../../lib/cn.js'
import { gradientFor } from '../../lib/gradient.js'
import { ThumbMedia } from './ThumbMedia.js'

/**
 * A thumbnail that wipes between a base image and a comparison image as the
 * cursor moves across it — left of the cursor shows the base, right shows the
 * compare. It rests on the base when not hovered. Falls back to a generated
 * gradient when there's no base image, and renders a plain static thumbnail
 * whenever there's nothing to compare (no compare image, or no base to wipe
 * from).
 *
 * The wipe boundary is spring-driven: on hover it eases in from the right edge
 * to the cursor and tracks the cursor while moving. When the cursor leaves, the
 * boundary stays wherever it was last rather than springing back to the edge.
 */
export function HoverWipe({
  base,
  compare,
  seed,
  alt = '',
  className,
}: {
  base: string | null
  compare: string | null
  seed: string
  alt?: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Boundary as a percent from the left edge: HIDDEN = compare fully hidden
  // (boundary at the right edge), 0 = compare fully revealed. The spring chases
  // `target`, so enter/leave glide instead of snapping.
  const HIDDEN = 100
  const target = useMotionValue(HIDDEN)
  const pos = useSpring(target, { stiffness: 300, damping: 32 })
  const clipPath = useTransform(pos, (p) => `inset(0 0 0 ${p}%)`)
  const dividerLeft = useTransform(pos, (p) => `${p}%`)
  const dividerOpacity = useTransform(pos, [86, HIDDEN], [1, 0])
  const canWipe = Boolean(base && compare)

  const moveTo = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const percentFromLeft = ((clientX - rect.left) / rect.width) * 100
    target.set(Math.min(HIDDEN, Math.max(0, percentFromLeft)))
  }

  const baseLayer = base ? (
    <ThumbMedia src={base} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
  ) : (
    <div className="absolute inset-0" style={gradientFor(seed)} />
  )

  if (!canWipe) {
    return <div className={cn('relative h-full w-full overflow-hidden', className)}>{baseLayer}</div>
  }

  return (
    // Root is sized to the thumbnail (the ref the wipe is measured against) but
    // does NOT clip — so the hover target below can spill past the edge.
    <div ref={ref} className={cn('relative h-full w-full select-none', className)}>
      {/* Visual layers, clipped to the rounded thumbnail bounds. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
        {baseLayer}
        <motion.div className="absolute inset-0" style={{ clipPath }}>
          <ThumbMedia src={compare!} className="absolute inset-0 h-full w-full object-cover" />
        </motion.div>
        <motion.span
          aria-hidden
          className="absolute inset-y-0 w-px bg-white/90 shadow-lift"
          style={{ left: dividerLeft, opacity: dividerOpacity }}
        />
      </div>
      {/* Hover target, extended 15px past the LEFT edge so a small cursor drift
          off that side doesn't drop the wipe. Position is still measured against
          the thumbnail (the ref), so the left ring clamps to 0%. On leave we keep
          the last boundary position instead of resetting it. */}
      <div
        className="absolute top-0 right-0 bottom-0 -left-[15px]"
        onMouseMove={(e) => moveTo(e.clientX)}
      />
    </div>
  )
}
