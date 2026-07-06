// Password login screen for self-host ("standalone") mode. Rendered by App.tsx
// in place of the Google sign-in button when /api/standalone-status reports
// { standalone: true } and the operator is signed out. There is no Google OAuth
// in a self-host install — the single operator authenticates with the shared
// STANDALONE_ADMIN_PASSWORD via POST /api/auth/standalone-login.
//
// This whole component is dead code in the cloud build (never mounted), so it
// cannot affect default behavior.
import { useState } from 'react'

export function StandaloneLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/auth/standalone-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (r.ok) {
        const d = await r.json().catch(() => ({}))
        if (d?.ok) { onSignedIn(); return }
      }
      // 403 (wrong or unconfigured password) or any non-ok shape.
      setError(r.status === 403 ? 'Incorrect password.' : 'Could not sign in. Check the server logs.')
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="standalone-login mb-10 mx-auto flex w-full max-w-xs flex-col items-stretch gap-3 text-left"
    >
      <label className="text-sm text-[var(--color-text-dim)]" htmlFor="standalone-password">
        Admin password
      </label>
      <input
        id="standalone-password"
        type="password"
        autoFocus
        autoComplete="current-password"
        value={password}
        onChange={e => { setPassword(e.target.value); if (error) setError(null) }}
        placeholder="Enter your admin password"
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      {error && <div className="text-sm text-red-400">{error}</div>}
      <button
        type="submit"
        disabled={busy || !password}
        className="w-full rounded-md bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-black transition hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-center text-xs text-[var(--color-text-dim)]">
        Self-hosted instance · single admin
      </p>
    </form>
  )
}
