export function RailFooter() {
  return (
    <div className="border-t border-[var(--color-border)] px-3 py-2.5 text-[11px] text-[var(--color-text-dim)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a href="/about" className="hover:text-[var(--color-text)]">About</a>
        <a href="/help" className="hover:text-[var(--color-text)]">Help</a>
        <a href="/privacy" className="hover:text-[var(--color-text)]">Privacy</a>
        <a href="/terms" className="hover:text-[var(--color-text)]">Terms</a>
        <a href="/contact" className="hover:text-[var(--color-text)]">Contact</a>
      </div>
      <div className="mt-1.5 opacity-70">© {new Date().getFullYear()} brigata.ai</div>
    </div>
  )
}
