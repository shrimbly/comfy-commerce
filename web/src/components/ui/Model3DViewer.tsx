import { useEffect, useState } from 'react'

import { cn } from '../../lib/cn.js'
import { Box } from '../../lib/icons.js'
import { Spinner } from './Spinner.js'

// model-viewer is a heavy Web Component, so import it lazily — the module only
// ships once a 3D result is actually opened. Importing it self-registers the
// <model-viewer> custom element; we keep one shared registration promise.
let registration: Promise<unknown> | null = null
function ensureModelViewer(): Promise<unknown> {
  registration ??= import('@google/model-viewer')
  return registration
}

// The custom element isn't a real React component — render the host tag through
// a loose prop type so we can set its hyphenated attributes (camera-controls…).
const ModelViewerTag = 'model-viewer' as unknown as React.ComponentType<{
  src: string
  className?: string
  'camera-controls'?: string
  'auto-rotate'?: string
  'touch-action'?: string
  'environment-image'?: string
  'shadow-intensity'?: string
  'shadow-softness'?: string
  exposure?: string
}>

/** Interactive GLB viewer — lazy-loads the model-viewer web component. */
export function Model3DViewer({ src, className }: { src: string; className?: string }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    void ensureModelViewer().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!ready) {
    return (
      <div className={cn('flex items-center justify-center bg-surface-2', className)}>
        <Spinner />
      </div>
    )
  }
  return (
    <ModelViewerTag
      src={src}
      camera-controls=""
      auto-rotate=""
      touch-action="pan-y"
      // Built-in studio-neutral IBL + a soft contact shadow so the model is
      // evenly lit and grounded rather than floating. Tone mapping defaults to
      // Khronos PBR Neutral in v4, which is the commerce-friendly look.
      environment-image="neutral"
      shadow-intensity="1"
      shadow-softness="0.75"
      exposure="1"
      className={cn('bg-surface-2', className)}
    />
  )
}

/** Static stand-in for a 3D result in lists — the real viewer lives in the lightbox. */
export function Model3DThumb({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 text-ink-faint',
        className,
      )}
    >
      <Box size={28} strokeWidth={1.5} absoluteStrokeWidth />
      <span className="text-[11px] leading-4">3D model</span>
    </div>
  )
}
