import { cn } from '../../lib/cn.js'

/** Hairline divider — crisp in the centre, softly blurred toward the ends. */
export function BlurDivider({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('relative h-px', className)}>
      {/* crisp centre, faded ends */}
      <div
        className="absolute inset-0 bg-line"
        style={{
          WebkitMaskImage: 'linear-gradient(to right, transparent, #000 30%, #000 70%, transparent)',
          maskImage: 'linear-gradient(to right, transparent, #000 30%, #000 70%, transparent)',
        }}
      />
      {/* blurred copy shown only toward the ends → progressive blur */}
      <div
        className="absolute inset-0 bg-line"
        style={{
          filter: 'blur(0.8px)',
          WebkitMaskImage: 'linear-gradient(to right, #000, transparent 34%, transparent 66%, #000)',
          maskImage: 'linear-gradient(to right, #000, transparent 34%, transparent 66%, #000)',
        }}
      />
    </div>
  )
}
