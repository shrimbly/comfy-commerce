/**
 * A filled sparkle with a subtle violet gradient — a small flourish for the
 * "App Mode detected" note. (lucide's Sparkles is stroke-only, so this is a
 * hand-rolled SVG.)
 */
export function GradientSparkle({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="cc-sparkle-grad" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a08fe4" />
          <stop offset="1" stopColor="#6750a8" />
        </linearGradient>
      </defs>
      <path
        d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275z"
        fill="url(#cc-sparkle-grad)"
      />
      <path
        d="M5 3v4M19 17v4M3 5h4M17 19h4"
        stroke="url(#cc-sparkle-grad)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
