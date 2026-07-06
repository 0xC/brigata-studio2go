import { useEffect, useState } from 'react'
import { Workspace } from './Workspace'
import { Onboarding } from './Onboarding'
import { AcceptInvite } from './AcceptInvite'
import { About } from './About'
import { Help } from './Help'
import { Privacy } from './Privacy'
import { Terms } from './Terms'
import { Contact } from './Contact'
import { StandaloneLogin } from './StandaloneLogin'
import { fetchStandalone } from './lib/standalone'
import { getPref, setPref } from './lib/prefs'

type Health = { ok: boolean; db: 'online' | 'offline' } | null
export type Me = {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  is_comp?: boolean
  is_admin?: boolean
  has_anthropic_token?: boolean
} | null

function Dot({ ok }: { ok: boolean | undefined }) {
  const cls =
    ok === true
      ? 'bg-green-500'
      : ok === false
      ? 'bg-red-500'
      : 'bg-yellow-500'
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />
}

export default function App() {
  const [health, setHealth] = useState<Health>(null)
  const [me, setMe] = useState<Me>(null)
  const [loadedMe, setLoadedMe] = useState(false)
  const [onboardingProfile, setOnboardingProfile] = useState<unknown>(undefined)
  // Self-host mode: swap the Google button for a password login. undefined
  // while loading; false in the default cloud build.
  const [standalone, setStandalone] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    fetchStandalone().then(setStandalone).catch(() => setStandalone(false))

    fetch('/api/health')
      .then(r => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, db: 'offline' }))

    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setMe(d?.user ?? null))
      .finally(() => setLoadedMe(true))

    // Detect and persist the user's local timezone so agents can use it.
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz && tz !== getPref<string>('timezone', '')) {
        setPref('timezone', tz)
      }
    } catch {}
  }, [])

  // After we know who the user is, fetch their onboarding profile.
  useEffect(() => {
    if (!me) { setOnboardingProfile(undefined); return }
    fetch('/api/workspaces/onboarding')
      .then(r => (r.ok ? r.json() : { profile: null }))
      .then(d => setOnboardingProfile(d.profile))
      .catch(() => setOnboardingProfile(null))
  }, [me?.id])

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    setMe(null)
  }

  // Public path-based routes — the marketing/legal pages and invite landing.
  // These must resolve before the signed-in Workspace redirect below, or a
  // signed-in user hitting /about, /terms, etc. falls through into the app.
  if (typeof window !== 'undefined') {
    const path = window.location.pathname
    if (path === '/contact') return <Contact defaultEmail={me?.email} defaultName={me?.name ?? undefined} />
    if (path === '/about') return <About />
    if (path === '/privacy') return <Privacy />
    if (path === '/terms') return <Terms />
    if (path === '/help' || path === '/faq') return <Help />
    // Shareable, replayable onboarding walkthrough (no login, nothing saved).
    // Off production by default — meant for studio.example.com/obdemo.
    if (path === '/obdemo' && !/(^|\.)app\.brigata\.ai$/.test(window.location.hostname)) {
      return <Onboarding demo onDone={() => window.location.reload()} userName={null} />
    }
    const inviteMatch = path.match(/^\/invite\/([A-Za-z0-9_-]+)$/)
    if (inviteMatch && loadedMe) {
      return <AcceptInvite token={inviteMatch[1]} signedIn={!!me} />
    }
  }

  if (loadedMe && me) {
    // Still loading onboarding state — keep blank to avoid flashing.
    if (onboardingProfile === undefined) return null
    // No profile yet → show the wizard.
    if (onboardingProfile === null) {
      return <Onboarding onDone={() => setOnboardingProfile({})} userName={me.name} />
    }
    return <Workspace me={me} onLogout={logout} />
  }

  return (
    <div className="min-h-full flex flex-col">
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-xl text-center">
          <h1 className="text-5xl font-medium tracking-tight mb-4">
            Agentic <span className="text-[var(--color-accent)]">Studio</span>
          </h1>
          <p className="text-lg text-[var(--color-text-dim)] mb-10">
            Your Agents, Your Rules.
          </p>

          {(!loadedMe || standalone === undefined) ? null : standalone ? (
            <StandaloneLogin onSignedIn={() => window.location.reload()} />
          ) : (
            <div className="mb-10 flex justify-center">
              <a
                href="/api/auth/google"
                className="inline-flex items-center gap-3 bg-white hover:bg-gray-50 text-[#1f1f1f] pl-3 pr-5 py-2.5 rounded-md font-medium transition shadow-sm border border-[#dadce0]"
                style={{ fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif' }}
              >
                <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                  <path fill="none" d="M0 0h48v48H0z"/>
                </svg>
                Sign in with Google
              </a>
            </div>
          )}

          <div className="inline-flex items-center gap-4 text-sm text-[var(--color-text-dim)] border border-[var(--color-border)] rounded-full px-4 py-2">
            <span className="inline-flex items-center gap-2">
              <Dot ok={health?.ok} /> backend
            </span>
            <span className="inline-flex items-center gap-2">
              <Dot ok={health?.db === 'online'} /> database
            </span>
          </div>
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
