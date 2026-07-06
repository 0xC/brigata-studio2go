import type { ReactNode } from 'react'

export function StaticPage({ title, children }: { title: string; children: ReactNode }) {
  // Static pages respect the user's chosen workspace theme (graphite / ember
  // / atelier). The legacy version forced 'dark' to match the old landing
  // page's orange/black look — that's gone now; pages read consistently
  // across all three Brigata themes.
  return (
    <div className="h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="h-12 border-b border-[var(--color-border)] flex items-center px-4 gap-3 bg-[var(--color-surface)] flex-shrink-0">
        <a href="/" className="text-sm font-medium hover:text-[var(--color-accent)]">← Back</a>
        <span className="text-sm text-[var(--color-text-dim)]">{title}</span>
      </header>

      <div className="flex-1 overflow-y-auto flex justify-center p-6">
        <article className="max-w-2xl w-full prose-doc text-sm leading-relaxed">
          {children}
        </article>
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
