import { useEffect, useState } from 'react'
import { AgentAvatar } from './lib/avatar'

// ---- Shapes (subset of the real API responses we consume) -----------------
type Agent = {
  id: string
  name: string
  avatar: string | null
  model: string
  status: string
  hosting?: string | null
  created_at?: string
  last_turn_at?: string | null
  last_turn_status?: 'ok' | 'error' | null
  last_error_message?: string | null
}

type UsageDaily = { day: string; turns: number; total_cost_usd: number }
type UsageReport = {
  ok: boolean
  totals: { turns: number; total_cost_usd: number; total_tokens: number }
  daily: UsageDaily[]
  by_agent?: { agent_id: string | null; agent_name: string; turns: number; total_cost_usd: number; total_tokens: number }[]
}

type DocSummary = { id: string; title: string; updated_at: string }
type Member = { id: string; role: string }

// ---- Helpers --------------------------------------------------------------
function relTime(iso?: string | null): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

// Bucket an agent into a health category from its real status fields.
type Health = 'ok' | 'attention' | 'error' | 'idle'
function healthOf(a: Agent): Health {
  if (a.status === 'error' || a.last_turn_status === 'error' || a.last_error_message) return 'error'
  if (a.status === 'provisioning' || a.status === 'offline') return 'attention'
  if (!a.last_turn_at) return 'idle'
  return 'ok'
}
const HEALTH_COLOR: Record<Health, string> = {
  ok: 'var(--accent-chat, #5af78e)',
  attention: 'var(--accent-doc, #f6c177)',
  error: 'var(--color-danger, #e5484d)',
  idle: 'var(--color-text-dim, #7b8595)',
}

// ---- Small presentational pieces ------------------------------------------
function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-2xl border border-[var(--color-border)] p-4 md:p-5 relative overflow-hidden ${className}`}
      style={{ background: 'linear-gradient(180deg, var(--color-surface-elevated), var(--color-surface))' }}
    >
      {children}
    </div>
  )
}

function Stat({
  label, value, sub, glyph, tone = 'accent',
}: {
  label: string; value: string; sub?: React.ReactNode; glyph: string; tone?: 'accent' | 'doc' | 'info'
}) {
  const toneBg = tone === 'doc' ? 'var(--accent-doc-soft, rgba(246,193,119,.1))'
    : tone === 'info' ? 'rgba(106,168,255,.1)' : 'var(--accent-chat-soft, rgba(90,247,142,.1))'
  const toneFg = tone === 'doc' ? 'var(--accent-doc, #f6c177)'
    : tone === 'info' ? '#6aa8ff' : 'var(--accent-chat, #5af78e)'
  return (
    <Card className="col-span-6 md:col-span-3">
      <div
        className="absolute right-3 top-3 w-8 h-8 rounded-lg grid place-items-center text-[15px]"
        style={{ background: toneBg, color: toneFg }}
      >
        {glyph}
      </div>
      <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-dim)] font-semibold">{label}</div>
      <div className="text-[32px] leading-tight font-extrabold mt-2 tracking-tight">{value}</div>
      {sub && <div className="text-xs text-[var(--color-text-dim)] mt-1.5 flex gap-4">{sub}</div>}
    </Card>
  )
}

function SectionHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center mb-3">
      <h2 className="text-sm font-bold m-0">{title}</h2>
      {right && <div className="ml-auto text-xs text-[var(--color-text-dim)]">{right}</div>}
    </div>
  )
}

// ---- Main -----------------------------------------------------------------
export function Command({ workspaceId, workspaceName }: { workspaceId: string; workspaceName?: string }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const j = (url: string) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null)
    Promise.all([
      j(`/api/workspaces/${workspaceId}/agents`),
      j(`/api/workspaces/${workspaceId}/usage?days=7`),
      j(`/api/workspaces/${workspaceId}/documents`),
      j(`/api/workspaces/${workspaceId}/members`),
    ]).then(([a, u, d, m]) => {
      if (cancelled) return
      setAgents(a?.agents ?? [])
      setUsage(u?.ok ? (u as UsageReport) : null)
      setDocs(d?.documents ?? [])
      setMembers(m?.members ?? [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [workspaceId])

  // Derived, all from real data
  const errored = agents.filter(a => healthOf(a) === 'error')
  const attention = agents.filter(a => healthOf(a) === 'attention')
  const healthy = agents.filter(a => healthOf(a) === 'ok').length
  const idle = agents.filter(a => healthOf(a) === 'idle').length
  const healthScore = agents.length ? Math.round((healthy + idle) / agents.length * 100) : 100

  const turns7d = usage?.totals.turns ?? 0
  const cost7d = usage?.totals.total_cost_usd ?? 0
  const usageByAgent = new Map((usage?.by_agent ?? []).filter(x => x.agent_id).map(x => [x.agent_id as string, x]))
  // Build a fixed 7-day axis ending today so sparse data still reads as a bar
  // chart (the API only returns days that had activity).
  const turnsByDay = new Map((usage?.daily ?? []).map(d => [d.day, d.turns]))
  const days7 = Array.from({ length: 7 }, (_, i) => {
    const dt = new Date()
    dt.setDate(dt.getDate() - (6 - i))
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    return { key, turns: turnsByDay.get(key) ?? 0, label: dt.toLocaleDateString('en-US', { weekday: 'short' }) }
  })
  const maxDay = Math.max(1, ...days7.map(d => d.turns))

  const recent = [...agents]
    .filter(a => a.last_turn_at)
    .sort((a, b) => new Date(b.last_turn_at!).getTime() - new Date(a.last_turn_at!).getTime())
    .slice(0, 5)

  const needsAttention = [...errored, ...attention].slice(0, 5)

  // Deterministic radar coordinates so dots are stable across renders.
  const radarDots = agents.slice(0, 12).map((a, i) => {
    const ang = (i / Math.max(1, Math.min(agents.length, 12))) * Math.PI * 2 - Math.PI / 2
    const h = healthOf(a)
    const r = h === 'ok' ? 30 : h === 'idle' ? 44 : h === 'attention' ? 58 : 70 // healthier = closer to core
    return {
      id: a.id, name: a.name, color: HEALTH_COLOR[h],
      x: 50 + Math.cos(ang) * r * 0.78,
      y: 50 + Math.sin(ang) * r * 0.78,
    }
  })

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-5 md:px-7 py-6">
        {/* header */}
        <div className="flex items-center gap-4 mb-5">
          <div>
            <h1 className="text-xl font-bold m-0 tracking-tight">Overview</h1>
            <div className="text-[12.5px] text-[var(--color-text-dim)] mt-0.5">
              {workspaceName ?? 'Workspace'} · live overview
            </div>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-[var(--color-text-dim)] py-20 text-center">Loading overview…</div>
        ) : (
          <div className="grid grid-cols-12 gap-3 md:gap-4">
            {/* stat row */}
            <Stat
              label="Agents" glyph="▣" value={fmt(agents.length)}
              sub={<><span><b className="text-[var(--color-text)]">{healthy}</b> healthy</span>
                {errored.length > 0 && <span><b className="text-[var(--color-text)]">{errored.length}</b> errored</span>}
                {idle > 0 && <span><b className="text-[var(--color-text)]">{idle}</b> idle</span>}</>}
            />
            <Stat
              label="Turns · 7d" glyph="⌁" tone="info" value={fmt(turns7d)}
              sub={<span><b className="text-[var(--color-text)]">${cost7d.toFixed(2)}</b> spend</span>}
            />
            <Stat
              label="Documents" glyph="▤" tone="doc" value={fmt(docs.length)}
              sub={docs[0]
                ? <span>latest <b className="text-[var(--color-text)]">{relTime(docs[0].updated_at)}</b> ago</span>
                : <span>none yet</span>}
            />
            <Stat
              label="Team" glyph="⚇" value={fmt(members.length)}
              sub={<span><b className="text-[var(--color-text)]">{members.filter(m => m.role === 'owner' || m.role === 'admin').length}</b> admins</span>}
            />

            {/* radar */}
            <Card className="col-span-12 md:col-span-5">
              <SectionHead title="Agent health" right={`${healthScore}% healthy`} />
              <div className="flex gap-5 items-center">
                <div className="relative flex-shrink-0" style={{ width: 168, height: 168 }}>
                  {[168, 112, 56].map(d => (
                    <div key={d} className="absolute rounded-full border border-[var(--color-border)]"
                      style={{ width: d, height: d, left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }} />
                  ))}
                  <div className="absolute rounded-full grid place-items-center"
                    style={{
                      width: 56, height: 56, left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
                      background: 'radial-gradient(circle, var(--accent-chat-soft, rgba(90,247,142,.1)), transparent 70%)',
                      border: '1px solid var(--accent-chat-edge, rgba(90,247,142,.45))',
                    }}>
                    <div className="text-center">
                      <b className="text-[17px] font-extrabold" style={{ color: 'var(--accent-chat, #5af78e)' }}>{healthScore}</b>
                      <div className="text-[8px] tracking-[0.12em] text-[var(--color-text-dim)]">HEALTH</div>
                    </div>
                  </div>
                  {radarDots.map(d => (
                    <div key={d.id} title={d.name} className="absolute rounded-full"
                      style={{
                        width: 9, height: 9, left: `${d.x}%`, top: `${d.y}%`,
                        transform: 'translate(-50%,-50%)', background: d.color,
                        boxShadow: '0 0 0 3px rgba(0,0,0,.35)',
                      }} />
                  ))}
                </div>
                <div className="flex flex-col gap-2 text-xs text-[var(--color-text-dim)]">
                  <LegendRow color={HEALTH_COLOR.ok} label="Healthy" n={healthy} />
                  <LegendRow color={HEALTH_COLOR.idle} label="Idle" n={idle} />
                  <LegendRow color={HEALTH_COLOR.attention} label="Attention" n={attention.length} />
                  <LegendRow color={HEALTH_COLOR.error} label="Errored" n={errored.length} />
                </div>
              </div>
            </Card>

            {/* activity chart */}
            <Card className="col-span-12 md:col-span-7">
              <SectionHead title="Activity — last 7 days" right="turns / day" />
              <div className="flex items-end gap-2" style={{ height: 120 }}>
                {days7.map(d => (
                  <div key={d.key} title={`${d.key}: ${d.turns} turns`} className="flex-1 rounded-t-md"
                    style={{
                      height: `${Math.max(3, (d.turns / maxDay) * 100)}%`,
                      background: d.turns > 0
                        ? 'linear-gradient(180deg, var(--accent-chat-edge, rgba(90,247,142,.45)), var(--accent-chat-soft, rgba(90,247,142,.1)))'
                        : 'var(--color-border)',
                      border: d.turns > 0 ? '1px solid var(--accent-chat-edge, rgba(90,247,142,.45))' : '1px solid var(--color-border)',
                      borderBottom: 0,
                    }} />
                ))}
              </div>
              <div className="flex gap-2 mt-2">
                {days7.map(d => (
                  <span key={d.key} className="flex-1 text-center text-[10px] text-[var(--color-text-dim)]">{d.label}</span>
                ))}
              </div>
            </Card>

            {/* recent activity */}
            <Card className="col-span-12 md:col-span-7">
              <SectionHead title="Recent agent activity" right={`${recent.length}`} />
              {recent.length === 0 ? (
                <div className="text-xs text-[var(--color-text-dim)] py-8 text-center">No agent turns yet.</div>
              ) : recent.map((a, i) => {
                const u = usageByAgent.get(a.id)
                return (
                <div key={a.id} className={`flex items-center gap-3 py-2.5 ${i > 0 ? 'border-t border-[var(--color-border)]' : ''}`}>
                  <AgentAvatar avatar={a.avatar} size={30} />
                  <div className="flex-1 min-w-0">
                    <b className="font-semibold">{a.name}</b>
                    <div className="text-xs text-[var(--color-text-dim)] truncate">
                      {a.last_turn_status === 'error'
                        ? (a.last_error_message || 'Last turn errored')
                        : (u && u.turns > 0 ? `${a.model} · ${u.turns} turns · $${u.total_cost_usd.toFixed(2)} · 7d` : `${a.model} · last active`)}
                    </div>
                  </div>
                  <Tag tone={a.last_turn_status === 'error' ? 'error' : 'ok'}>
                    {a.last_turn_status === 'error' ? 'error' : 'ok'}
                  </Tag>
                  <span className="text-xs text-[var(--color-text-dim)] w-8 text-right">{relTime(a.last_turn_at)}</span>
                </div>
                )
              })}
            </Card>

            {/* needs attention */}
            <Card className="col-span-12 md:col-span-5">
              <SectionHead title="Needs attention" right={`${needsAttention.length}`} />
              {needsAttention.length === 0 ? (
                <div className="text-xs text-[var(--color-text-dim)] py-8 text-center">
                  <div className="text-2xl mb-1" style={{ color: 'var(--accent-chat, #5af78e)' }}>✓</div>
                  All agents healthy.
                </div>
              ) : needsAttention.map((a, i) => (
                <div key={a.id} className={`flex items-center gap-3 py-2.5 ${i > 0 ? 'border-t border-[var(--color-border)]' : ''}`}>
                  <AgentAvatar avatar={a.avatar} size={30} />
                  <div className="flex-1 min-w-0">
                    <b className="font-semibold">{a.name}</b>
                    <div className="text-xs text-[var(--color-text-dim)] truncate">
                      {a.last_error_message || (a.status === 'provisioning' ? 'Provisioning…' : a.status === 'offline' ? 'Offline' : a.status)}
                    </div>
                  </div>
                  <Tag tone={healthOf(a) === 'error' ? 'error' : 'attention'}>{healthOf(a) === 'error' ? 'error' : a.status}</Tag>
                </div>
              ))}
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}

function LegendRow({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: color }} />
      {label} · <b className="text-[var(--color-text)]">{n}</b>
    </div>
  )
}

function Tag({ tone, children }: { tone: 'ok' | 'error' | 'attention'; children: React.ReactNode }) {
  const map = {
    ok: ['var(--accent-chat-soft, rgba(90,247,142,.1))', 'var(--accent-chat, #5af78e)'],
    error: ['rgba(229,72,77,.12)', 'var(--color-danger, #e5484d)'],
    attention: ['var(--accent-doc-soft, rgba(246,193,119,.1))', 'var(--accent-doc, #f6c177)'],
  } as const
  const [bg, fg] = map[tone]
  return (
    <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap capitalize"
      style={{ background: bg, color: fg }}>{children}</span>
  )
}
