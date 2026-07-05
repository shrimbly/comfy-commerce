import { useState } from 'react'

import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'
import { ArrowRight, ICON, IconBox, Play } from '../../lib/icons.js'
import { PlayIcon } from '../../lib/animated-icons/PlayIcon.js'
import { useHover } from '../../lib/useHover.js'

/**
 * The Shopify setup walkthrough. App credentials is the one supported path for
 * connecting a real store, and it takes a few manual steps in the Shopify Dev
 * Dashboard — this gives that flow a guided video plus a written checklist, so
 * the connect dialog itself can stay lean.
 *
 * The player reads from `web/public/setup`, which Vite copies into `web/dist`
 * and the desktop app ships as a bundled resource — so the walkthrough plays
 * same-origin and offline. Clear VIDEO_SRC to fall back to the placeholder.
 */
const VIDEO_SRC: string | null = '/setup/shopify-connect.mp4'
const VIDEO_POSTER: string | null = '/setup/shopify-connect.jpg'

const STEPS = [
  { title: 'Create an app', body: 'At dev.shopify.com, create a new app for your store.' },
  {
    title: 'Grant access',
    body: 'Add the Admin API scopes read_products, write_products and write_files.',
  },
  { title: 'Install it', body: 'Install the app on your store to switch it on.' },
  { title: 'Paste your keys', body: 'Copy the Client ID and Client secret into Comfy Commerce.' },
]

/** The numbered connect checklist — reused in the guide modal and the empty state. */
export function SetupSteps({ className }: { className?: string }) {
  return (
    <ol className={className}>
      {STEPS.map((step, i) => (
        <li key={step.title} className="flex gap-3 first:mt-0 [&:not(:first-child)]:mt-3">
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
  )
}

function SetupGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect your Shopify store"
      subtitle="A short walkthrough, from creating the app to pasting your keys."
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

        <SetupSteps className="mt-5" />

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-line pt-4">
          <a
            href="https://dev.shopify.com"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink transition-all duration-200 hover:bg-surface-2"
          >
            Open Shopify Dev Dashboard
            <IconBox>
              <ArrowRight {...ICON} />
            </IconBox>
          </a>
          <Button variant="primary" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** Drop-in "Watch setup guide" trigger; owns the guide modal's open state. */
export function WatchSetupGuide({
  variant = 'secondary',
  size = 'md',
  label = 'Watch setup guide',
  className,
}: {
  variant?: 'secondary' | 'ghost'
  size?: 'sm' | 'md'
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const hover = useHover()
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
        {...hover.props}
      >
        <IconBox>
          <PlayIcon size={18} animate={hover.state} />
        </IconBox>
        {label}
      </Button>
      <SetupGuideDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
