import { useRef, useState } from 'react'

import { Button } from '../../components/ui/Button.js'
import { Spinner } from '../../components/ui/Spinner.js'

/** Card thumbnails render at 4:3, so that's what we crop to. */
const ASPECT = 4 / 3
/** Cap the exported thumbnail width — cards never need more than this. */
const MAX_OUTPUT_WIDTH = 1000
const JPEG_QUALITY = 0.9

/**
 * Pan/zoom cropper for a workflow thumbnail. The image covers a 4:3 viewport;
 * drag to reposition and zoom to scale, then Apply renders the framed region to
 * a canvas and hands back a cropped JPEG File (uploaded like any other pick — no
 * server/model changes). Works on same-origin images (/api/assets + blob:), so
 * the canvas is never tainted.
 */
export function ImageCropper({
  src,
  fileName,
  onCancel,
  onApply,
}: {
  src: string
  fileName?: string
  onCancel: () => void
  onApply: (file: File) => void
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [busy, setBusy] = useState(false)

  // The source rectangle the viewport shows at zoom 1 (cover fit, centered).
  const cover = () => {
    if (!nat) return null
    if (nat.w / nat.h >= ASPECT) {
      const visW = nat.h * ASPECT
      return { visW, visH: nat.h, cropX: (nat.w - visW) / 2, cropY: 0 }
    }
    const visH = nat.w / ASPECT
    return { visW: nat.w, visH, cropX: 0, cropY: (nat.h - visH) / 2 }
  }

  // Keep the image covering the viewport: clamp pan to the source bounds.
  const clampPan = (p: { x: number; y: number }, z: number) => {
    const coverRect = cover()
    const vp = viewportRef.current
    if (!coverRect || !vp || !nat) return p
    const vw = vp.clientWidth
    const vh = vp.clientHeight
    const sw = coverRect.visW / z
    const sh = coverRect.visH / z
    const maxX = Math.max(0, ((nat.w - sw) * vw) / (2 * sw))
    const maxY = Math.max(0, ((nat.h - sh) * vh) / (2 * sh))
    return { x: Math.max(-maxX, Math.min(maxX, p.x)), y: Math.max(-maxY, Math.min(maxY, p.y)) }
  }

  const setZoomClamped = (z: number) => {
    setZoom(z)
    setPan((p) => clampPan(p, z))
  }

  const apply = () => {
    const coverRect = cover()
    const vp = viewportRef.current
    const img = imgRef.current
    if (!coverRect || !vp || !img || !nat) return
    setBusy(true)
    const vw = vp.clientWidth
    const vh = vp.clientHeight
    const sw = coverRect.visW / zoom
    const sh = coverRect.visH / zoom
    const sx = coverRect.cropX + coverRect.visW / 2 - sw / 2 - sw * (pan.x / vw)
    const sy = coverRect.cropY + coverRect.visH / 2 - sh / 2 - sh * (pan.y / vh)
    const outW = Math.min(Math.round(sw), MAX_OUTPUT_WIDTH)
    const outH = Math.round(outW / ASPECT)
    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setBusy(false)
      return
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
    canvas.toBlob(
      (blob) => {
        setBusy(false)
        if (!blob) return
        const stem = fileName?.replace(/\.[^./\\]+$/, '') || 'thumbnail'
        onApply(new File([blob], `${stem}-crop.jpg`, { type: 'image/jpeg' }))
      },
      'image/jpeg',
      JPEG_QUALITY,
    )
  }

  return (
    <div>
      <p className="mb-2 text-sm text-ink-faint">Drag to reposition, and zoom to frame the thumbnail.</p>
      <div
        ref={viewportRef}
        className="relative aspect-[4/3] w-full cursor-grab touch-none overflow-hidden rounded-xl border border-line bg-surface-2 select-none active:cursor-grabbing"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          setPan(
            clampPan(
              { x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) },
              zoom,
            ),
          )
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <img
          ref={imgRef}
          src={src}
          draggable={false}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        />
      </div>

      <label className="mt-3 flex items-center gap-3">
        <span className="text-sm text-ink-faint">Zoom</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoomClamped(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-ink"
        />
      </label>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={apply} disabled={busy || !nat}>
          {busy && <Spinner />}
          Apply crop
        </Button>
      </div>
    </div>
  )
}
