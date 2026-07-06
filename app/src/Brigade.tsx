import { useEffect, useState } from 'react'
import { AgentAvatar } from './lib/avatar'
import { isByovps } from './agentHosting'
import { useResilientWs } from './lib/useWs'
import { SafetyBadge } from './SafetyBadge'
import { type SafetyProfile } from './agentSafety'

// Roster view: every agent on one page as a detailed card, plus a plan/tier
// strip that makes the workspace plan vs. Pro server upgrade legible. Reads
// the same APIs the Settings editor uses; navigation back into Settings is
// delegated to the host (Workspace) via the callbacks.

type AgentRow = {
  id: string
  name: string
  avatar: string | null
  model: string
  status: string
  hosting?: string | null
  last_turn_at?: string | null
  last_turn_status?: string | null
  safety_profile?: SafetyProfile
}
type Droplet = {
  id: number
  ip: string | null
  region: string
  size: string
  price_monthly: number
  created_at: string
  status: string
}
type Member = AgentRow & {
  channels: { id: string; name: string }[]
  blurb: string
  droplet: Droplet | null
  external_url?: string | null
}

function handle(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
}

// Role line under the name. Template avatars encode the archetype in their path
// (/avatars/templates/<role>.png); for custom/extra avatars there's no role, so
// fall back to the @handle.
function roleLabel(m: AgentRow): string {
  const tpl = m.avatar?.match(/^\/avatars\/templates\/([^/]+)\.png$/)
  if (tpl) return tpl[1]
  return '@' + handle(m.name)
}

// Trim the model id to the readable core: drop the "claude-" prefix and any
// trailing date stamp (e.g. claude-haiku-4-5-20251001 -> haiku-4-5).
function shortModel(id: string): string {
  return id.replace(/^claude-/, '').replace(/-\d{6,}$/, '')
}
function isOpus(id: string): boolean {
  return /opus/i.test(id)
}

// Pull a one-line blurb out of the agent's soul: the first sentence under
// "## Who I Am", else the first non-heading line.
function extractBlurb(soul: string): string {
  if (!soul) return ''
  const lines = soul.split('\n')
  let inWho = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^#{1,6}\s/.test(line)) {
      inWho = /who i am/i.test(line)
      continue
    }
    if (!line) continue
    if (inWho) return firstSentence(line)
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || /^#{1,6}\s/.test(line)) continue
    return firstSentence(line)
  }
  return ''
}
function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/)
  const out = (m ? m[0] : s).trim()
  return out.length > 140 ? out.slice(0, 137).trimEnd() + '…' : out
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Client-derived VPS name — matches the server provisioner's deterministic
// scheme (pro-<safe-name>-<agentId[:8]>), so we can show it without a new API.
function vpsName(m: AgentRow): string {
  const safe = m.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'pro-agent'
  return `pro-${safe}-${m.id.slice(0, 8)}`
}

type Dot = 'on' | 'off' | 'prov' | 'err'
function statusDot(status: string): Dot {
  if (status === 'online') return 'on'
  if (status === 'provisioning') return 'prov'
  if (status === 'error') return 'err'
  return 'off'
}
function lastTurnText(m: AgentRow): { text: string; tone: Dot } {
  if (m.status === 'provisioning') return { text: 'provisioning…', tone: 'prov' }
  if (m.status === 'error') return { text: 'needs attention', tone: 'err' }
  const when = m.last_turn_at ? timeAgo(m.last_turn_at) : ''
  if (m.status === 'online') return { text: when ? `active ${when}` : 'online', tone: 'on' }
  return { text: when ? `idle · ${when}` : 'offline', tone: 'off' }
}

const GOLD = 'var(--accent-doc)'
const GOLD_SOFT = 'var(--accent-doc-soft)'
const GOLD_EDGE = 'var(--accent-doc-edge)'

// BYOVPS (self-hosted) accent — a cool blue, kept distinct from gold Pro and
// the plain Standard pill so the three hosting modes read apart at a glance.
const BYO = '#6cb6ff'
const BYO_SOFT = 'rgba(108,182,255,0.10)'
const BYO_EDGE = 'rgba(108,182,255,0.38)'

export function Brigade({
  workspaceId, workspaceName, onManage, onNew, onManagePlan,
}: {
  workspaceId: string
  workspaceName?: string
  onManage: (agentId: string) => void
  onNew: () => void
  onManagePlan: () => void
}) {
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [planActive, setPlanActive] = useState(false)
  const [periodEnd, setPeriodEnd] = useState<string | null>(null)
  const [showPro, setShowPro] = useState(false)
  const [tasks, setTasks] = useState<HandoffTask[]>([])
  const [counts, setCounts] = useState<Map<string, number>>(new Map()) // agent_id -> handoffs picked up
  const [usage, setUsage] = useState<Map<string, { turns: number; cost: number }>>(new Map()) // agent_id -> 30d usage
  const wsName = workspaceName ?? ''

  async function loadUsage() {
    const u = await fetch(`/api/workspaces/${workspaceId}/usage?days=30`).then(r => r.json()).catch(() => null)
    if (u?.ok) {
      setUsage(new Map(
        (u.by_agent ?? [])
          .filter((x: { agent_id: string | null }) => x.agent_id)
          .map((x: { agent_id: string; turns: number; total_cost_usd: number }) => [x.agent_id, { turns: x.turns, cost: x.total_cost_usd }]),
      ))
    }
  }

  async function loadRelay() {
    const [t, c] = await Promise.all([
      fetch(`/api/workspaces/${workspaceId}/tasks`).then(r => r.json()).catch(() => null),
      fetch(`/api/workspaces/${workspaceId}/handoff-counts`).then(r => r.json()).catch(() => null),
    ])
    if (t?.ok) setTasks(t.tasks ?? [])
    if (c?.ok) setCounts(new Map((c.counts ?? []).map((x: { agent_id: string; picked_up: number }) => [x.agent_id, x.picked_up])))
  }

  async function load() {
    const list = await fetch(`/api/workspaces/${workspaceId}/agents`).then(r => r.json()).catch(() => null)
    const rows: AgentRow[] = list?.agents ?? []
    const detailed = await Promise.all(rows.map(async (a): Promise<Member> => {
      const d = await fetch(`/api/workspaces/${workspaceId}/agents/${a.id}`).then(r => r.json()).catch(() => null)
      const detail = d?.agent
      let droplet: Droplet | null = null
      if (a.hosting === 'pro_droplet' && a.status === 'online') {
        droplet = await fetch(`/api/workspaces/${workspaceId}/agents/${a.id}/pro-droplet`)
          .then(r => r.json()).then(r => r.droplet ?? null).catch(() => null)
      }
      return { ...a, channels: detail?.channels ?? [], blurb: extractBlurb(detail?.soul_md ?? ''), droplet, external_url: detail?.external_url ?? null }
    }))
    setMembers(detailed)
    setLoading(false)
  }

  useEffect(() => {
    setLoading(true)
    void load()
    void loadRelay()
    void loadUsage()
    fetch('/api/billing/status').then(r => (r.ok ? r.json() : null)).then(d => {
      if (!d?.ok) return
      setPlanActive(!!d.active)
      setPeriodEnd(d.current_period_end ?? null)
    }).catch(() => {})
  }, [workspaceId])

  // Live Relay updates: refetch handoffs + counts when a task transitions.
  useResilientWs('/ws', {
    onMessage: (data) => {
      const p = data as { type?: string; workspaceId?: string }
      if (p?.type === 'task_updated' && p.workspaceId === workspaceId) void loadRelay()
    },
  })

  const total = members.length
  const online = members.filter(m => m.status === 'online').length
  const proCount = members.filter(m => m.hosting === 'pro_droplet').length
  const byoCount = members.filter(m => isByovps(m.hosting)).length

  return (
    <div className="h-full overflow-auto bg-[var(--color-bg)]">
      <div className="max-w-[1180px] mx-auto px-7 pt-8 pb-20">

        {/* Header */}
        <div className="flex items-end justify-between gap-5 flex-wrap mb-1.5">
          <div>
            <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-[var(--color-text-dim)] mb-2">
              {wsName ? `${wsName} workspace` : 'Workspace'}
            </p>
            <h1 className="text-[40px] font-bold tracking-[-0.02em] leading-[1.15] m-0 text-[var(--color-text)]">
              Your <span style={{ color: 'var(--color-accent)' }}>Brigade</span>
            </h1>
            <p className="text-[var(--color-text-dim)] text-sm mt-2.5">
              {total} {total === 1 ? 'agent' : 'agents'}
              {' · '}<span style={{ color: 'var(--color-accent)' }}>{online} online</span>
              {proCount > 0 && <> · {proCount} on a dedicated Pro server</>}
              {byoCount > 0 && <> · <span style={{ color: BYO }}>{byoCount} self-hosted (BYOVPS)</span></>}
            </p>
          </div>
          <button
            onClick={onNew}
            className="inline-flex items-center gap-2 font-bold text-[13.5px] px-[18px] py-[11px] rounded-[9px] transition hover:-translate-y-px"
            style={{ background: 'var(--color-accent)', color: '#06210f', boxShadow: '0 6px 22px -8px rgba(90,247,142,.5)' }}
          >
            ＋ New agent
          </button>
        </div>

        {/* Plan / tier strip — the upgrade-clarity element */}
        <div
          className="my-7 rounded-[14px] overflow-hidden grid gap-px"
          style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', backgroundColor: 'var(--color-border)', border: '1px solid var(--color-border)' }}
        >
          <div className="bg-[var(--color-surface)] px-[22px] py-5 flex flex-col gap-0.5">
            <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-[var(--color-text-dim)]">Workspace plan</span>
            <span className="text-[17px] font-bold mt-0.5">{planActive ? 'Standard · $15/mo' : 'Free tier'}</span>
            <span className="text-[12.5px] text-[var(--color-text-dim)] leading-snug mt-0.5">
              {planActive
                ? <>Unlimited agents on shared infrastructure.{periodEnd ? ` Renews ${new Date(periodEnd).toLocaleDateString()}.` : ''}</>
                : <>One agent on shared infrastructure. Upgrade to add your whole brigade.</>}
            </span>
            <div className="mt-2.5">
              <button
                onClick={onManagePlan}
                className="bg-transparent text-[12.5px] font-semibold px-3.5 py-2 rounded-lg cursor-pointer transition"
                style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              >
                {planActive ? 'Manage plan' : 'Upgrade plan'}
              </button>
            </div>
          </div>
          <div
            className="px-[22px] py-5 flex flex-col gap-0.5"
            style={{ background: `linear-gradient(135deg,${GOLD_SOFT},var(--color-surface) 70%)` }}
          >
            <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-[var(--color-text-dim)]">Pro servers · up to 3 agents each</span>
            <span className="text-[17px] font-bold mt-0.5" style={{ color: GOLD }}>★ Pro server · $25/mo, flat</span>
            <span className="text-[12.5px] text-[var(--color-text-dim)] leading-snug mt-0.5">
              <b className="text-[var(--color-text)] font-semibold">{proCount} of {total}</b> on Pro servers. A Pro server runs up to 3 agents — shell, cron, 24/7 background, integrations. Add a fourth agent and you add a second server.
            </span>
            <div className="mt-2.5">
              <button
                onClick={() => setShowPro(true)}
                className="bg-transparent text-[12.5px] font-semibold px-3.5 py-2 rounded-lg cursor-pointer transition"
                style={{ border: `1px solid ${GOLD_EDGE}`, color: GOLD }}
              >
                See what Pro unlocks
              </button>
            </div>
          </div>
        </div>

        {/* Roster grid */}
        {loading ? (
          <div className="text-[var(--color-text-dim)] text-sm py-10 text-center">Loading your brigade…</div>
        ) : (
          <div className="grid gap-[18px]" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))' }}>
            {members.map(m => (
              <MemberCard key={m.id} m={m} handoffs={counts.get(m.id) ?? 0} usage={usage.get(m.id)} onManage={() => onManage(m.id)} />
            ))}
            <button
              onClick={onNew}
              className="flex flex-col items-center justify-center gap-2.5 rounded-[16px] min-h-[230px] cursor-pointer transition text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              style={{ border: '1px dashed var(--color-border)', background: 'transparent' }}
            >
              <span className="w-[42px] h-[42px] rounded-full flex items-center justify-center text-[22px] font-light" style={{ border: '1px solid currentColor' }}>＋</span>
              <span className="text-sm font-semibold">Add a brigade member</span>
            </button>
          </div>
        )}

        {!loading && members.length > 0 && <BrigadeRelay tasks={tasks} members={members} />}
      </div>

      {showPro && <ProInfoModal proCount={proCount} onClose={() => setShowPro(false)} />}
    </div>
  )
}

// ---- Relay: the agent handoff inbox -----------------------------------------
// "Relay" — an email-style inbox of agent↔agent (and human→agent) handoffs: who
// dropped it → who owns it, read vs unread, with the result surfaced when done.
// Wired to GET /api/workspaces/:id/tasks; live via the task_updated ws event.
type HandoffTask = {
  id: string
  from_kind: 'user' | 'agent'
  from_user_id: string | null
  from_agent_id: string | null
  to_agent_id: string
  title: string
  body_md: string | null
  status: string // queued | delivered | in_progress | done | failed | declined | cancelled
  result_summary: string | null
  created_at: string
}

function relShort(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function RelayRow({ t, byId }: { t: HandoffTask; byId: Map<string, Member> }) {
  const unread = t.status === 'delivered' || t.status === 'queued'
  const done = t.status === 'done'
  const working = t.status === 'in_progress'
  const fromName = t.from_kind === 'user' ? 'You' : byId.get(t.from_agent_id ?? '')?.name ?? 'Agent'
  const fromAvatar = t.from_kind === 'user' ? null : byId.get(t.from_agent_id ?? '')?.avatar ?? null
  const to = byId.get(t.to_agent_id)
  const preview = done ? (t.result_summary ?? 'Done.') : (t.body_md ?? '')
  const status = done
    ? { label: '✓ Done', color: 'var(--color-accent)' }
    : working
      ? { label: 'Working…', color: GOLD }
      : (t.status === 'failed' || t.status === 'declined' || t.status === 'cancelled')
        ? { label: t.status === 'cancelled' ? 'Cancelled' : t.status === 'declined' ? 'Declined' : 'Failed', color: '#ef4444' }
        : { label: 'New', color: 'var(--color-accent)' }
  return (
    <div
      className="flex items-center gap-3.5 px-5 py-3 transition hover:bg-[var(--color-hover-bg)]"
      style={{
        borderTop: '1px solid color-mix(in srgb, var(--color-border) 55%, transparent)',
        background: unread ? 'color-mix(in srgb, var(--color-accent) 5%, transparent)' : 'transparent',
      }}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: unread ? 'var(--color-accent)' : 'transparent' }} />
      <span className="flex items-center gap-1 flex-shrink-0" title={`${fromName} → ${to?.name ?? 'agent'}`}>
        {t.from_kind === 'user' ? (
          <span className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[12px]" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>👤</span>
        ) : (
          <AgentAvatar avatar={fromAvatar} size={22} />
        )}
        <span className="text-[var(--color-text-dim)] text-[11px]">→</span>
        <AgentAvatar avatar={to?.avatar ?? null} size={22} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-sm truncate text-[var(--color-text)] ${unread ? 'font-semibold' : ''}`}>{t.title}</div>
        <div className="text-xs text-[var(--color-text-dim)] truncate">
          {fromName} → {to?.name ?? 'agent'} · {preview}
        </div>
      </div>
      <div className="flex flex-col items-end flex-shrink-0 gap-0.5 w-[68px]">
        <span className="text-[11px] font-semibold leading-none" style={{ color: status.color }}>{status.label}</span>
        <span className="text-[10.5px] text-[var(--color-text-dim)] leading-none">{relShort(t.created_at)}</span>
      </div>
    </div>
  )
}

function BrigadeRelay({ tasks, members }: { tasks: HandoffTask[]; members: Member[] }) {
  const byId = new Map(members.map(m => [m.id, m]))
  const unread = tasks.filter(t => t.status === 'delivered' || t.status === 'queued').length
  return (
    <div className="mt-[18px] rounded-[16px] overflow-hidden" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
      <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <span className="text-[15px] font-bold text-[var(--color-text)]">Relay</span>
        <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-[var(--color-text-dim)]">Handoffs between your agents</span>
        {unread > 0 && (
          <span className="ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}>
            {unread} new
          </span>
        )}
      </div>
      {tasks.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <div className="text-sm text-[var(--color-text)]">No handoffs yet</div>
          <div className="text-xs text-[var(--color-text-dim)] mt-1 max-w-[460px] mx-auto">When you or an agent hands work to another agent, it lands here — with a read/unread signal and the result when it’s done.</div>
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {tasks.map(t => <RelayRow key={t.id} t={t} byId={byId} />)}
        </div>
      )}
    </div>
  )
}

const PRO_PERKS: { title: string; body: string }[] = [
  { title: 'A Pro server — up to 3 agents', body: 'A managed VPS that runs up to 3 agents at one flat price — not shared infrastructure. Provisioned and managed for you; you never SSH in. Add a fourth agent and you add a second server.' },
  { title: 'Shell access', body: 'Real bash, a persistent filesystem, and the ability to install and run its own tools.' },
  { title: 'Scheduled tasks', body: 'Cron jobs that fire on a timer — daily digests, periodic checks, recurring work.' },
  { title: 'Runs 24/7 in the background', body: 'Keeps working when you’re away and when the app is closed, not just while you’re chatting.' },
  { title: 'Integrations', body: 'Connect external services that need a persistent, always-on host to call back into.' },
]

function ProInfoModal({ proCount, onClose }: { proCount: number; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="What Pro unlocks"
    >
      <div
        className="relative w-full max-w-[520px] max-h-[85vh] overflow-auto rounded-[16px] p-6"
        style={{ background: `linear-gradient(180deg,${GOLD_SOFT},var(--color-surface) 22%)`, border: `1px solid ${GOLD_EDGE}` }}
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3.5 right-3.5 w-7 h-7 rounded-full flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] transition"
          style={{ border: '1px solid var(--color-border)' }}
        >
          ✕
        </button>

        <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-[var(--color-text-dim)]">Add a Pro server</div>
        <h2 className="text-[22px] font-bold mt-1 mb-1" style={{ color: GOLD }}>★ What Pro unlocks</h2>
        <p className="text-[13px] text-[var(--color-text-dim)] leading-relaxed m-0">
          Pro is a server, not an agent. One Pro server runs up to 3 agents at one flat price — add a fourth and you add a second server. It’s separate from your workspace plan, and lets your agents do things a shared agent can’t.
        </p>

        <div className="flex flex-col gap-3 mt-5">
          {PRO_PERKS.map(p => (
            <div key={p.title} className="flex gap-3">
              <span className="mt-0.5 flex-shrink-0" style={{ color: GOLD }}>★</span>
              <div>
                <div className="text-[14px] font-semibold text-[var(--color-text)]">{p.title}</div>
                <div className="text-[12.5px] text-[var(--color-text-dim)] leading-relaxed">{p.body}</div>
              </div>
            </div>
          ))}
        </div>

        <div
          className="font-mono text-[11px] rounded-[8px] px-3 py-2.5 mt-5 leading-relaxed"
          style={{ color: GOLD, background: GOLD_SOFT, border: `1px solid ${GOLD_EDGE}` }}
        >
          +$25/mo per server, flat — runs up to 3 agents · provisioned in ~90 seconds · fully managed.
          {proCount > 0 && ` ${proCount} of your agents ${proCount === 1 ? 'is' : 'are'} already on a Pro server.`}
        </div>

        <p className="text-[12.5px] text-[var(--color-text-dim)] mt-4 mb-0">
          To upgrade an agent, use the <span className="text-[var(--color-text)] font-semibold">⚡ Upgrade</span> button on its card.
        </p>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="text-[13px] font-semibold px-4 py-2 rounded-[9px] cursor-pointer transition"
            style={{ background: GOLD, color: '#1a1304' }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

function MemberCard({ m, handoffs = 0, usage, onManage }: { m: Member; handoffs?: number; usage?: { turns: number; cost: number }; onManage: () => void }) {
  const isPro = m.hosting === 'pro_droplet'
  const isByo = isByovps(m.hosting)
  const dot = statusDot(m.status)
  const lt = lastTurnText(m)
  const dotColor: Record<Dot, string> = {
    on: 'var(--color-accent)', off: '#4a525f', prov: GOLD, err: '#ef4444',
  }
  const toneColor: Record<Dot, string> = {
    on: 'var(--color-accent)', off: 'var(--color-text-dim)', prov: GOLD, err: '#ef4444',
  }

  return (
    <div
      className="relative rounded-[16px] p-5 flex flex-col gap-3.5 overflow-hidden transition hover:-translate-y-0.5"
      style={{
        border: isPro ? `1px solid ${GOLD_EDGE}` : isByo ? `1px solid ${BYO_EDGE}` : '1px solid var(--color-border)',
        background: isPro
          ? `linear-gradient(180deg,${GOLD_SOFT},var(--color-surface) 60%)`
          : isByo
            ? `linear-gradient(180deg,${BYO_SOFT},var(--color-surface) 60%)`
            : 'var(--color-surface)',
      }}
    >
      <div className="flex items-center gap-3.5">
        <div
          className="w-[54px] h-[54px] rounded-full flex-shrink-0 overflow-hidden flex items-center justify-center"
          style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-elevated)' }}
        >
          <AgentAvatar avatar={m.avatar} size={54} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[18px] font-bold tracking-[-0.01em] flex items-center gap-2">
            <span className="truncate">{m.name}</span>
            <span
              title={m.status}
              className="w-2 h-2 rounded-full flex-shrink-0 inline-block"
              style={{ background: dotColor[dot], boxShadow: dot === 'on' || dot === 'prov' ? `0 0 0 3px ${dot === 'on' ? 'var(--accent-chat-soft)' : GOLD_SOFT}` : undefined }}
            />
          </div>
          <div className="font-mono text-[11.5px] text-[var(--color-text-dim)] mt-0.5 lowercase tracking-[0.02em] truncate">{roleLabel(m)}</div>
        </div>
        <span
          className="font-mono text-[9.5px] tracking-[0.1em] uppercase font-semibold px-2 py-[3px] rounded-full whitespace-nowrap"
          style={isPro
            ? { color: '#1a1304', background: GOLD, border: `1px solid ${GOLD}` }
            : isByo
              ? { color: BYO, background: BYO_SOFT, border: `1px solid ${BYO_EDGE}` }
              : { color: 'var(--color-text-dim)', border: '1px solid var(--color-border)' }}
        >
          {isPro ? '★ Pro' : isByo ? 'BYOVPS' : 'Standard'}
        </span>
      </div>

      <div><SafetyBadge profile={m.safety_profile} /></div>

      {m.blurb && <p className="text-[13px] text-[var(--color-text)] leading-relaxed m-0 opacity-80">{m.blurb}</p>}

      {isPro && (
        <div
          className="font-mono text-[10.5px] rounded-[7px] px-2.5 py-[7px] leading-relaxed"
          style={{ color: GOLD, background: GOLD_SOFT, border: `1px solid ${GOLD_EDGE}` }}
        >
          <b style={{ color: '#ffe6bd', fontWeight: 600 }}>{vpsName(m)}</b>
          {m.droplet
            ? <> · {m.status === 'online' ? '● Online' : m.status} · {m.droplet.region.toUpperCase()} · {m.droplet.size} · {m.droplet.ip ?? 'pending IP'} · ${m.droplet.price_monthly ?? 25}/mo</>
            : <> · {m.status === 'provisioning' ? 'provisioning…' : m.status}</>}
        </div>
      )}

      {isByo && (
        <div
          className="font-mono text-[10.5px] rounded-[7px] px-2.5 py-[7px] leading-relaxed break-all"
          style={{ color: BYO, background: BYO_SOFT, border: `1px solid ${BYO_EDGE}` }}
        >
          <b style={{ fontWeight: 600 }}>Self-hosted VPS</b>
          {' · '}{m.external_url ? m.external_url.replace(/^https?:\/\//, '') : 'no URL set'}
        </div>
      )}

      <div className="flex flex-col gap-2 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
        <Fact k="Model">
          <span
            className="font-mono text-[11px] px-[7px] py-0.5 rounded-[5px]"
            style={isOpus(m.model)
              ? { color: 'var(--accent-chat-hot)', border: '1px solid var(--accent-chat-edge)' }
              : { color: 'var(--color-text-dim)', border: '1px solid var(--color-border)' }}
          >
            {shortModel(m.model)}
          </span>
        </Fact>
        <Fact k="Channels">
          {m.channels.length === 0
            ? <span className="text-[12px] text-[var(--color-text-dim)]">none</span>
            : m.channels.slice(0, 4).map(c => (
              <span key={c.id} className="font-mono text-[10.5px] px-[7px] py-0.5 rounded-[5px] text-[var(--color-text-dim)]" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}>
                #{c.name}
              </span>
            ))}
          {m.channels.length > 4 && <span className="text-[10.5px] text-[var(--color-text-dim)]">+{m.channels.length - 4}</span>}
        </Fact>
        <Fact k="Last turn">
          <span className="text-[12px]" style={{ color: toneColor[lt.tone] }}>{lt.text}</span>
        </Fact>
        {handoffs > 0 && (
          <Fact k="Handoffs">
            <span className="text-[12px] text-[var(--color-text)]">
              {handoffs} picked up
            </span>
          </Fact>
        )}
        {usage && (
          <Fact k="Usage 30d">
            <span className="text-[12px] text-[var(--color-text)]">
              {usage.turns} {usage.turns === 1 ? 'turn' : 'turns'} · ${usage.cost.toFixed(2)}
            </span>
          </Fact>
        )}
      </div>

      <div className="flex gap-2.5 mt-0.5">
        <button
          onClick={onManage}
          className="flex-1 text-[12.5px] font-semibold px-3 py-2.5 rounded-[9px] cursor-pointer transition text-[var(--color-text)]"
          style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}
        >
          Manage
        </button>
        {!isPro && (
          <button
            onClick={onManage}
            title={`Move ${m.name} onto a Pro server`}
            className="flex-1 text-[12.5px] font-semibold px-3 py-2.5 rounded-[9px] cursor-pointer transition flex items-center justify-center gap-1.5"
            style={{ background: 'transparent', border: `1px solid ${GOLD_EDGE}`, color: GOLD }}
          >
            ⚡ Upgrade
          </button>
        )}
      </div>
    </div>
  )
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[12px] min-h-[18px]">
      <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-[var(--color-text-dim)] w-16 flex-shrink-0">{k}</span>
      <span className="text-[var(--color-text)] flex items-center gap-1.5 flex-wrap">{children}</span>
    </div>
  )
}
