import type { FixedInput, Workflow } from '@comfy-commerce/shared'
import { Crop, ICON, IconBox, ImageUp, Trash2 } from '../../lib/icons.js'
import { useEffect, useRef, useState } from 'react'

import { useUpdateWorkflow, useUploadAsset } from '../../api/hooks.js'
import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { Spinner } from '../../components/ui/Spinner.js'
import { gradientFor } from '../../lib/gradient.js'
import { FixedImageField } from './FixedImageField.js'
import { ImageCropper } from './ImageCropper.js'

/** A 160px image picker — choose / remove, with a gradient or empty fallback. */
function ImageField({
  image,
  gradientSeed,
  emptyHint,
  onPick,
  onRemove,
  onCrop,
}: {
  image: string | null
  gradientSeed?: string
  emptyHint: string
  onPick: (file: File) => void
  onRemove: () => void
  onCrop?: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-start gap-4">
      <div className="relative aspect-square w-40 shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2">
        {image ? (
          <img src={image} alt="" className="h-full w-full object-cover" />
        ) : gradientSeed ? (
          <div className="h-full w-full" style={gradientFor(gradientSeed)} />
        ) : null}
      </div>
      <div className="flex flex-col items-start gap-2">
        <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
          <IconBox>
            <ImageUp {...ICON} />
          </IconBox>
          Choose image
        </Button>
        {image && onCrop && (
          <Button variant="ghost" size="sm" onClick={onCrop}>
            <IconBox>
              <Crop {...ICON} />
            </IconBox>
            Crop
          </Button>
        )}
        {image ? (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <IconBox>
              <Trash2 {...ICON} />
            </IconBox>
            Remove
          </Button>
        ) : (
          <span className="max-w-48 text-sm text-ink-faint">{emptyHint}</span>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])}
        />
      </div>
    </div>
  )
}

export function EditWorkflowDialog({
  workflow,
  onClose,
}: {
  workflow: Workflow | null
  onClose: () => void
}) {
  const update = useUpdateWorkflow()
  const uploadAsset = useUploadAsset()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [removeImage, setRemoveImage] = useState(false)
  const [compareFile, setCompareFile] = useState<File | null>(null)
  const [comparePreview, setComparePreview] = useState<string | null>(null)
  const [removeCompare, setRemoveCompare] = useState(false)
  /** Swapped fixed reference images, keyed by node — uploaded on save. */
  const [fixedSwaps, setFixedSwaps] = useState<Record<string, { file: File; preview: string }>>({})
  const [error, setError] = useState<string | null>(null)
  /** When set, the dialog shows the cropper for this image; apply re-picks it. */
  const [crop, setCrop] = useState<{ src: string; fileName?: string; apply: (file: File) => void } | null>(
    null,
  )

  useEffect(() => {
    if (!workflow) return
    setName(workflow.name)
    setDescription(workflow.description)
    setFile(null)
    setPreview(null)
    setRemoveImage(false)
    setCompareFile(null)
    setComparePreview(null)
    setRemoveCompare(false)
    setFixedSwaps((prev) => {
      Object.values(prev).forEach((s) => URL.revokeObjectURL(s.preview))
      return {}
    })
    setError(null)
    setCrop(null)
  }, [workflow])

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])
  useEffect(() => () => void (comparePreview && URL.revokeObjectURL(comparePreview)), [comparePreview])

  const swapFixed = (nodeId: string, picked: File) =>
    setFixedSwaps((prev) => {
      if (prev[nodeId]) URL.revokeObjectURL(prev[nodeId]!.preview)
      return { ...prev, [nodeId]: { file: picked, preview: URL.createObjectURL(picked) } }
    })

  const pick = (picked: File) => {
    if (preview) URL.revokeObjectURL(preview)
    setFile(picked)
    setPreview(URL.createObjectURL(picked))
    setRemoveImage(false)
  }

  const removeMainImage = () => {
    if (preview) URL.revokeObjectURL(preview)
    setFile(null)
    setPreview(null)
    setRemoveImage(true)
  }

  const pickCompare = (picked: File) => {
    if (comparePreview) URL.revokeObjectURL(comparePreview)
    setCompareFile(picked)
    setComparePreview(URL.createObjectURL(picked))
    setRemoveCompare(false)
  }

  const removeCompareImage = () => {
    if (comparePreview) URL.revokeObjectURL(comparePreview)
    setCompareFile(null)
    setComparePreview(null)
    setRemoveCompare(true)
  }

  const busy = update.isPending || uploadAsset.isPending
  const currentImage = preview ?? (removeImage ? null : workflow?.imageUrl)
  const currentCompare = comparePreview ?? (removeCompare ? null : (workflow?.compareImageUrl ?? null))

  const save = async () => {
    if (!workflow) return
    setError(null)
    try {
      let imageAssetId: string | null | undefined
      if (file) imageAssetId = (await uploadAsset.mutateAsync(file)).id
      else if (removeImage) imageAssetId = null

      let compareImageAssetId: string | null | undefined
      if (compareFile) compareImageAssetId = (await uploadAsset.mutateAsync(compareFile)).id
      else if (removeCompare) compareImageAssetId = null

      // Re-upload only the swapped slots; keep the rest pointing at their asset.
      let fixedInputs: FixedInput[] | undefined
      if (Object.keys(fixedSwaps).length > 0) {
        fixedInputs = await Promise.all(
          workflow.fixedInputs.map(async (fixed) => {
            const swap = fixedSwaps[fixed.nodeId]
            return swap ? { ...fixed, assetId: (await uploadAsset.mutateAsync(swap.file)).id } : fixed
          }),
        )
      }

      await update.mutateAsync({
        id: workflow.id,
        name: name.trim() || workflow.name,
        description,
        ...(imageAssetId !== undefined ? { imageAssetId } : {}),
        ...(compareImageAssetId !== undefined ? { compareImageAssetId } : {}),
        ...(fixedInputs !== undefined ? { fixedInputs } : {}),
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <Dialog open={workflow !== null} onClose={onClose} title={crop ? 'Crop image' : 'Edit workflow'}>
      {workflow && (
        <div className="px-5 pb-5">
          {crop ? (
            <ImageCropper
              src={crop.src}
              fileName={crop.fileName}
              onCancel={() => setCrop(null)}
              onApply={(f) => {
                crop.apply(f)
                setCrop(null)
              }}
            />
          ) : (
            <>
              <div className="grid gap-4">
                <div>
                  <p className="mb-2 text-sm font-medium">Thumbnail</p>
                  <ImageField
                    image={currentImage ?? null}
                    gradientSeed={workflow.id}
                    emptyHint="Without an image, the generated gradient shows."
                    onPick={pick}
                    onRemove={removeMainImage}
                    onCrop={
                      currentImage
                        ? () => setCrop({ src: currentImage, fileName: file?.name, apply: pick })
                        : undefined
                    }
                  />
                </div>
                <div>
                  <p className="text-sm font-medium">Comparison image</p>
                  <p className="mt-0.5 mb-2 text-sm text-ink-faint">
                    Optional. In the grid view, hovering the card wipes between the thumbnail and this
                    image.
                  </p>
                  <ImageField
                    image={currentCompare}
                    emptyHint="Add an image to enable the hover-wipe."
                    onPick={pickCompare}
                    onRemove={removeCompareImage}
                    onCrop={
                      currentCompare
                        ? () =>
                            setCrop({
                              src: currentCompare,
                              fileName: compareFile?.name,
                              apply: pickCompare,
                            })
                        : undefined
                    }
                  />
                </div>
              </div>

          <label className="mt-4 block">
            <span className="text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm outline-none transition-colors focus:border-ink"
            />
          </label>

          <label className="mt-3 block">
            <span className="text-sm font-medium">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition-colors focus:border-ink"
            />
          </label>

          {workflow.fixedInputs.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-medium">Reference images</p>
              <p className="mt-0.5 mb-2 text-sm text-ink-faint">
                Held constant on every run. Add or remove slots by re-uploading the workflow.
              </p>
              <div className="grid gap-3">
                {workflow.fixedInputs.map((fixed) => {
                  const swap = fixedSwaps[fixed.nodeId]
                  return (
                    <div key={fixed.nodeId} className="rounded-xl border border-line p-3">
                      <p className="mb-2 truncate text-sm font-medium">
                        {fixed.label || 'Reference image'}
                      </p>
                      <FixedImageField
                        image={swap?.preview ?? `/api/assets/${fixed.assetId}`}
                        fileName={swap?.file.name}
                        onPick={(picked) => swapFixed(fixed.nodeId, picked)}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={busy || !name.trim()}>
              {busy && <Spinner />}
              Save
            </Button>
          </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}
