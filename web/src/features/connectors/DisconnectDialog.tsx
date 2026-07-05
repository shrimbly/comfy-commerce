import type { ConnectedStore } from '@comfy-commerce/shared'
import { useEffect, useState } from 'react'

import { useDisconnectStore, useRuns, useStaging } from '../../api/hooks.js'
import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * Confirmation gate for store Disconnect. Disconnecting hard-deletes all
 * LOCAL working state for the store — the review queue, run history, AI
 * captions and audit trail — with no undo, so the one destructive click gets
 * a human step that spells out the blast radius with live counts. No typed
 * confirmation: the Shopify store itself is untouched, so an enumerated
 * consequence list behind an explicit danger button is proportionate here.
 */
export function DisconnectDialog({
  store,
  onClose,
}: {
  store: ConnectedStore | null
  onClose: () => void
}) {
  // Persist the last store so the content survives the close animation.
  const [shown, setShown] = useState(store)
  useEffect(() => {
    if (store) setShown(store)
  }, [store])

  const open = store !== null
  // Only fetch while the dialog is up — and never fetch ALL stores' data
  // when no store is selected.
  const { data: staging } = useStaging(shown?.id, { enabled: open })
  const { data: runs } = useRuns(shown?.id, { enabled: open })
  const disconnect = useDisconnectStore()

  const counts = staging?.counts
  // Publishing/failed rows are staged work too — fold them into one bucket.
  const otherStaged = counts ? counts.publishing + counts.failed : 0
  const activeRuns = runs?.filter((r) => r.state === 'queued' || r.state === 'running').length ?? 0

  // Counts are best-effort context: while loading (or on error) the bullets
  // fall back to generic wording — the confirm button is never gated on them.
  const queueLine = counts
    ? `${counts.pending} pending and ${counts.approved} approved edits in the review queue` +
      (otherStaged > 0 ? `, and ${plural(otherStaged, 'other staged item')}` : '')
    : 'All pending and approved edits in the review queue'
  const runsLine = runs ? `${plural(runs.length, 'run')} in the activity history` : 'All runs in the activity history'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Disconnect store?"
      subtitle={shown ? `${shown.shopName ? `${shown.shopName} — ` : ''}${shown.domain}` : undefined}
    >
      <div className="px-5 pb-5">
        <p className="text-sm text-ink-soft">This permanently deletes:</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink-soft">
          <li>{queueLine}</li>
          <li>{runsLine}</li>
          <li>AI captions and tags for this store's images</li>
          <li>This store's audit history</li>
        </ul>
        <p className="mt-3 text-sm text-ink-faint">
          Nothing on the Shopify store itself is deleted — published media stays live. Reconnecting
          later will not restore this data.
        </p>
        {activeRuns > 0 && (
          <div className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
            {activeRuns === 1 ? '1 run is' : `${activeRuns} runs are`} still in progress — cancel
            them from Activity first, or disconnecting will orphan them.
          </div>
        )}
        {disconnect.error && (
          <p className="mt-3 text-sm text-danger">{(disconnect.error as Error).message}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => shown && disconnect.mutate(shown.id, { onSuccess: onClose })}
            disabled={disconnect.isPending}
          >
            Disconnect store
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
