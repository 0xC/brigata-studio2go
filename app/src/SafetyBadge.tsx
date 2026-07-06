import { computeSafety, type SafetyProfile } from './agentSafety'

// Compact rule-of-two badge for cards (In Focus, Brigade). An agent whose profile
// hasn't been set shows a neutral "not set" chip — never a false green — which
// also nudges the owner to declare it.
export function SafetyBadge({ profile }: { profile?: SafetyProfile | null }) {
  const declared = !!profile && Object.values(profile).some(Boolean)
  if (!declared) {
    return (
      <span
        title="Safety not assessed yet — set this agent's rule-of-two profile in Settings → Advanced → Agent safety."
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
          padding: '1px 7px', borderRadius: 999, color: 'var(--ink-3)',
          background: 'var(--surface2)', border: '1px solid var(--line)',
        }}
      >
        ⚪ Safety: not set
      </span>
    )
  }
  const s = computeSafety(profile)
  const tone = s.level === 'violation'
    ? { fg: '#f87171', bg: 'rgba(239,68,68,.12)', bd: 'rgba(239,68,68,.4)', dot: '🔴', label: 'Rule-of-two' }
    : s.level === 'caution'
    ? { fg: '#fbbf24', bg: 'rgba(245,158,11,.12)', bd: 'rgba(245,158,11,.4)', dot: '🟡', label: 'Caution' }
    : { fg: '#4ade80', bg: 'rgba(34,197,94,.10)', bd: 'rgba(34,197,94,.35)', dot: '🟢', label: 'Safe' }
  return (
    <span
      title={`${s.label} — ${s.detail}${s.remediation ? ` Fix: ${s.remediation}` : ''}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700,
        padding: '1px 7px', borderRadius: 999, color: tone.fg,
        background: tone.bg, border: `1px solid ${tone.bd}`,
      }}
    >
      {tone.dot} {tone.label} · {s.hotAxes}/3
    </span>
  )
}
