import { useEffect, useState } from 'react'

type InviteInfo = {
  workspace_name: string
  inviter_name: string | null
  inviter_email: string
  expires_at: string
}

export function AcceptInvite({ token, signedIn }: { token: string; signedIn: boolean }) {
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    fetch(`/api/workspaces/invites/${token}`)
      .then(async r => {
        if (r.ok) {
          const d = await r.json()
          setInfo(d.invite)
        } else {
          const d = await r.json().catch(() => null)
          setError(d?.error ?? 'Invite is invalid or expired.')
        }
      })
      .catch(() => setError('Could not reach the server.'))
      .finally(() => setLoading(false))
  }, [token])

  async function accept() {
    setAccepting(true); setError(null)
    const r = await fetch(`/api/workspaces/invites/${token}/accept`, { method: 'POST' })
    setAccepting(false)
    if (!r.ok) {
      const d = await r.json().catch(() => null)
      setError(d?.error ?? 'Could not accept invite.')
      return
    }
    setDone(true)
    setTimeout(() => { window.location.href = '/' }, 1200)
  }

  const inviterName = info?.inviter_name ?? info?.inviter_email ?? ''

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center flex flex-col items-center gap-6">
        <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-[0.14em] text-[var(--color-text-dim)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-chat)]" style={{ boxShadow: '0 0 6px var(--accent-chat-edge)' }} />
          <span>workspace invitation</span>
        </div>

        {loading && (
          <p className="text-sm text-[var(--color-text-dim)]">Looking up your invite…</p>
        )}

        {error && !loading && (
          <>
            <h1 className="font-display text-4xl font-bold tracking-tight text-[var(--color-text)] leading-tight">
              That invite isn’t usable.
            </h1>
            <p className="text-sm text-[var(--color-text-dim)]">{error}</p>
            <p className="text-sm text-[var(--color-text-dim)]">
              Reach out to whoever sent you the link and ask them to generate a fresh one.
            </p>
          </>
        )}

        {info && !error && !done && (
          <>
            <h1 className="font-display text-4xl font-bold tracking-tight text-[var(--color-text)] leading-tight">
              You’ve been invited.
            </h1>
            <p className="text-sm text-[var(--color-text-dim)] max-w-sm leading-relaxed">
              <strong className="text-[var(--color-text)]">{inviterName}</strong>
              {info.inviter_name && <> ({info.inviter_email})</>}
              {' '}has invited you to join <strong className="text-[var(--color-text)]">“{info.workspace_name}”</strong> on Brigata Studio.
            </p>
            <div className="text-xs text-[var(--color-text-dim)] max-w-sm leading-relaxed">
              You’ll see every channel, document, and agent in that workspace, and you can talk to them.
              The owner’s Claude account funds agent activity — you don’t need your own to participate there.
            </div>
            {signedIn ? (
              <button
                onClick={() => void accept()}
                disabled={accepting}
                className="bg-[var(--accent-chat)] text-[var(--bg-deep)] px-6 py-2.5 rounded-md text-xs font-mono font-semibold uppercase tracking-wider hover:opacity-90 disabled:opacity-40"
              >
                {accepting ? 'Joining…' : '▶ Accept and join'}
              </button>
            ) : (
              <a
                href={`/api/auth/google?return_to=${encodeURIComponent('/invite/' + token)}`}
                className="inline-flex items-center gap-3 bg-white hover:bg-gray-50 text-[#1f1f1f] pl-3 pr-5 py-2.5 rounded-md font-medium transition shadow-sm border border-[#dadce0]"
                style={{ fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.83z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
                </svg>
                Sign in with Google to accept
              </a>
            )}
          </>
        )}

        {done && (
          <>
            <h1 className="font-display text-4xl font-bold tracking-tight text-[var(--color-text)] leading-tight">
              Welcome aboard.
            </h1>
            <p className="text-sm text-[var(--color-text-dim)]">Taking you to the workspace…</p>
          </>
        )}
      </div>
    </div>
  )
}
