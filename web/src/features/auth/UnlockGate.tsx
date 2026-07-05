import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { api, getBrokerToken, setBrokerToken } from '../../api/client.js'
import { Button } from '../../components/ui/Button.js'
import { Dialog } from '../../components/ui/Dialog.js'

/**
 * Token gate for a broker started with BROKER_API_TOKEN. Locks the studio when
 * a request 401s (the 'cc-unauthorized' event from api/client.ts) or, proactively,
 * when /api/health reports authRequired and no token is stored yet — avoiding an
 * error-flash on first load. Never locks inside the desktop shell, whose preload
 * injects the broker's token directly. While locked the dialog cannot be
 * dismissed (a closed gate over a dead UI helps nobody) — entering the token is
 * the only way through.
 */
export function UnlockGate() {
  const queryClient = useQueryClient()
  const [locked, setLocked] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    // Desktop shell: the preload injects the token — the gate never engages.
    if (window.comfyDesktop?.apiToken) return
    const onUnauthorized = () => setLocked(true)
    window.addEventListener('cc-unauthorized', onUnauthorized)
    // Proactive probe — /api/health is exempt from the gate and reports whether
    // a token is required, so the lock appears before the first query 401s.
    let cancelled = false
    api
      .get<{ authRequired: boolean }>('/api/health')
      .then((health) => {
        if (!cancelled && health.authRequired && getBrokerToken() === null) setLocked(true)
      })
      .catch(() => {
        /* broker unreachable — the queries surface their own errors */
      })
    return () => {
      cancelled = true
      window.removeEventListener('cc-unauthorized', onUnauthorized)
    }
  }, [])

  const trimmed = draft.trim()
  const unlock = async () => {
    if (!trimmed || pending) return
    setPending(true)
    setError(null)
    try {
      // Raw fetch, not api.get: the candidate token must override any (stale)
      // stored one, and a 401 here must not re-broadcast 'cc-unauthorized'.
      const res = await fetch('/api/stores', {
        headers: { authorization: `Bearer ${trimmed}`, 'x-comfy-commerce-client': 'web' },
      })
      if (!res.ok) {
        setError(
          res.status === 401
            ? 'Invalid token — not the value this broker was started with.'
            : `Could not verify the token (${res.status}).`,
        )
        return
      }
      setBrokerToken(trimmed)
      setDraft('')
      setLocked(false)
      await queryClient.invalidateQueries()
    } catch {
      setError('Could not reach the broker — is it still running?')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={locked}
      // No-op while locked: dismissing would leave a dead UI behind the gate.
      onClose={() => {}}
      title="Unlock studio"
      subtitle="This broker requires an API token."
    >
      <div className="px-5 pb-5">
        <label htmlFor="broker-token" className="mb-2 block text-sm font-medium text-ink-soft">
          API token
        </label>
        <input
          id="broker-token"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void unlock()}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-ink"
        />
        <div className="mt-4 rounded-xl border border-line bg-surface-2 p-4">
          <p className="text-sm text-ink-soft">
            This broker was started with <code className="text-ink">BROKER_API_TOKEN</code> — paste
            that token to unlock the studio. It stays in this browser.
          </p>
        </div>
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={() => void unlock()} disabled={!trimmed || pending}>
            Unlock
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
