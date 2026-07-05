import { useRef } from 'react'

import { ICON, IconBox, ImageUp } from '../../lib/icons.js'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'

/**
 * A single fixed reference-image slot: a thumbnail plus a choose/replace
 * control. Shared by the upload (new slots) and edit (swap existing) dialogs.
 */
export function FixedImageField({
  image,
  fileName,
  onPick,
  hint = 'PNG, JPG, or WebP — held constant on every run.',
  needsImage = false,
}: {
  /** URL to preview (a local object URL or a stored /api/assets URL), or null. */
  image: string | null
  /** Caption under the button — the picked file name, when known. */
  fileName?: string | null
  onPick: (file: File) => void
  hint?: string
  /** Highlight the slot as incomplete until an image is chosen. */
  needsImage?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => input.current?.click()}
        className={cn(
          'flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-surface-2 transition-colors',
          image
            ? 'border-line'
            : needsImage
              ? 'border-dashed border-ink-faint text-ink-soft hover:bg-surface'
              : 'border-dashed border-line-strong text-ink-faint hover:bg-surface',
        )}
      >
        {image ? (
          <img src={image} alt="" className="h-full w-full object-cover" />
        ) : (
          <IconBox>
            <ImageUp {...ICON} />
          </IconBox>
        )}
      </button>
      <div className="min-w-0">
        <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
          <IconBox>
            <ImageUp {...ICON} />
          </IconBox>
          {image ? 'Replace' : 'Choose image'}
        </Button>
        <p className={cn('mt-1 truncate text-sm', needsImage ? 'text-ink-soft' : 'text-ink-faint')}>
          {fileName || (needsImage ? 'Image will be used on every run' : hint)}
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onPick(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
