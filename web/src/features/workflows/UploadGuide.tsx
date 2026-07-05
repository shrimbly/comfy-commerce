import { useState } from 'react'

import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { PlayIcon } from '../../lib/animated-icons/PlayIcon.js'
import { ICON, IconBox, Play } from '../../lib/icons.js'
import { useHover } from '../../lib/useHover.js'

/**
 * "How to" guide for exporting a ComfyUI workflow to upload here. Mirrors the
 * Shopify setup guide: a walkthrough video plus a short checklist. The file
 * lives in `web/public/setup` (copied into web/dist and bundled with the
 * desktop app); clear VIDEO_SRC to fall back to the placeholder.
 */
const VIDEO_SRC: string | null = '/setup/upload-workflow.mp4'
const VIDEO_POSTER: string | null = '/setup/upload-workflow.jpg'

const STEPS = [
  {
    title: 'Set up App Mode',
    body: 'In ComfyUI, mark the inputs and the output you want to expose on your workflow.',
  },
  { title: 'Export it', body: 'Use Workflow → Export — or Export (API) if you prefer.' },
  { title: 'Upload here', body: 'Drop the downloaded JSON into this dialog.' },
]

function UploadGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Upload a workflow"
      subtitle="A short walkthrough, from exporting in ComfyUI to dropping it here."
      className="max-w-2xl"
    >
      <div className="px-5 pb-5">
        <div className="aspect-[40/27] w-full overflow-hidden rounded-xl border border-line bg-surface-2">
          {VIDEO_SRC ? (
            <video
              src={VIDEO_SRC}
              poster={VIDEO_POSTER ?? undefined}
              controls
              playsInline
              preload="none"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-12 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-soft">
                <IconBox>
                  <Play {...ICON} />
                </IconBox>
              </div>
              <p className="text-sm text-ink-soft">Walkthrough video coming soon</p>
            </div>
          )}
        </div>

        <ol className="mt-5">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3 [&:not(:first-child)]:mt-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-sm font-medium text-ink-soft">
                {i + 1}
              </span>
              <div className="min-w-0 pt-0.5">
                <p className="text-sm font-medium text-ink">{step.title}</p>
                <p className="text-sm text-ink-soft">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-5 flex justify-end border-t border-line pt-4">
          <Button variant="primary" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** Drop-in "How to" trigger; owns the guide modal's open state. */
export function WatchUploadGuide({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const hover = useHover()
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
        {...hover.props}
      >
        <IconBox>
          <PlayIcon size={18} animate={hover.state} />
        </IconBox>
        How to
      </Button>
      <UploadGuideDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
