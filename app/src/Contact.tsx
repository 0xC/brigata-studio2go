import { useState } from 'react'

export function Contact({ defaultEmail, defaultName, onClose }: { defaultEmail?: string; defaultName?: string; onClose?: () => void }) {
  const [name, setName] = useState(defaultName ?? '')
  const [email, setEmail] = useState(defaultEmail ?? '')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<'idle' | 'sent' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !message.trim()) return
    setSubmitting(true); setError(null)
    const r = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), email: email.trim(), message: message.trim() }),
    })
    setSubmitting(false)
    if (r.ok) {
      setStatus('sent')
      setMessage('')
      return
    }
    const body = await r.json().catch(() => null)
    setError(body?.error ?? 'Something went wrong sending your message.')
    setStatus('error')
  }

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="h-12 border-b border-[var(--color-border)] flex items-center px-4 gap-3 bg-[var(--color-surface)] flex-shrink-0">
        <a href="/" className="text-sm font-medium hover:text-[var(--color-accent)]">← Back</a>
        <span className="text-sm text-[var(--color-text-dim)]">Contact</span>
        <div className="flex-1" />
        {onClose && (
          <button onClick={onClose} className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)]">
            Close
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto flex items-start justify-center p-6">
        <div className="max-w-xl w-full">
          <h1 className="text-3xl font-medium tracking-tight mb-2">Get in touch</h1>
          <p className="text-sm text-[var(--color-text-dim)] mb-8">
            Questions, feedback, bug reports, or anything else — drop us a line and
            we'll get back to you. We read every message.
          </p>

          {status === 'sent' ? (
            <div className="border border-[var(--color-border)] rounded-md p-6 bg-[var(--color-surface)]">
              <div className="text-base font-medium mb-2">Thanks — message received.</div>
              <div className="text-sm text-[var(--color-text-dim)] mb-4">
                We'll reply to <span className="font-mono">{email}</span> as soon as we
                can. If you'd like to send another, refresh and try again.
              </div>
              <a
                href="/"
                className="inline-block bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90"
              >
                Back to Brigata Studio
              </a>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Name (optional)</label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                  placeholder="Your name"
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Message</label>
                <textarea
                  required
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={8}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm resize-y focus:outline-none focus:border-[var(--color-accent)]"
                  placeholder="What's on your mind?"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={!email.trim() || !message.trim() || submitting}
                  className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
                >
                  {submitting ? 'Sending…' : 'Send message'}
                </button>
                {error && <div className="text-xs text-red-400">{error}</div>}
              </div>
            </form>
          )}
        </div>
      </div>

      <footer className="border-t border-[var(--color-border)] py-4 px-6 text-xs text-[var(--color-text-dim)] flex items-center justify-between flex-wrap gap-3">
        <div>© {new Date().getFullYear()} brigata.ai. All rights reserved.</div>
        <div className="flex items-center gap-4">
          <a href="/about" className="hover:text-[var(--color-text)]">About</a>
          <a href="/help" className="hover:text-[var(--color-text)]">Help</a>
          <a href="/privacy" className="hover:text-[var(--color-text)]">Privacy</a>
          <a href="/terms" className="hover:text-[var(--color-text)]">Terms</a>
          <a href="/contact" className="hover:text-[var(--color-text)]">Contact</a>
        </div>
      </footer>
    </div>
  )
}
