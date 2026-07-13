import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useRailState, useIsDesktop, RailResizeHandle } from './lib/rail'
import { AGENT_TEMPLATES, type AgentTemplate } from './lib/agentTemplates'
import { AgentAvatar, AvatarPicker } from './lib/avatar'
import { useResilientWs } from './lib/useWs'
import { IconChannel, IconTrash } from './lib/icons'
import { WORKSPACE_ICONS, workspaceIconSrc } from './workspaceIcons'
import { hostingKind, HOSTING_LABEL } from './agentHosting'
import { computeSafety, SAFETY_ITEMS, type SafetyProfile } from './agentSafety'
import { useStandalone } from './lib/standalone'

type AgentListItem = {
  id: string
  name: string
  avatar: string | null
  model: string
  status: string
  hosting?: string | null
  last_turn_at?: string | null
  last_turn_status?: string | null
  last_error_message?: string | null
}
type AgentDetail = AgentListItem & {
  soul_md: string
  mission_md: string
  identity_md: string
  instructions: string
  hosting: string
  external_url: string | null
  external_token: string | null
  web_domain?: string | null
  web_app_port?: number | null
  bridge_privilege?: 'standard' | 'root'
  channels: { id: string; name: string }[]
  enabled_skills?: string[]
  safety_profile?: SafetyProfile
}
type Channel = { id: string; name: string }
type Version = {
  id: string
  saved_at: string
  soul_md: string
  saved_by_name: string | null
}

function ProDot({ size = 10 }: { size?: number }) {
  return (
    <span
      title="Pro agent"
      aria-label="Pro agent"
      className="absolute -bottom-0.5 -right-1 rounded-full bg-[var(--color-bg)] flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        width={size - 2}
        height={size - 2}
        fill="var(--color-accent)"
        stroke="var(--color-accent)"
        strokeWidth="1"
        strokeLinejoin="round"
      >
        <polygon points="12,2 14.9,8.6 22,9.3 16.5,14 18.2,21 12,17.3 5.8,21 7.5,14 2,9.3 9.1,8.6" />
      </svg>
    </span>
  )
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

function HealthDot({ agent, size = 9 }: { agent: AgentListItem; size?: number }) {
  const status = agent.last_turn_status
  if (status !== 'ok' && status !== 'error') return null
  const ok = status === 'ok'
  const when = agent.last_turn_at ? timeAgo(agent.last_turn_at) : ''
  const title = ok
    ? `Responding${when ? ` — last turn ${when}` : ''}`
    : `Erroring${when ? ` — ${when}` : ''}${agent.last_error_message ? `: ${agent.last_error_message}` : ''}`
  return (
    <span
      title={title}
      aria-label={title}
      className="absolute -top-0.5 -right-1 rounded-full ring-2 ring-[var(--color-bg)]"
      style={{ width: size, height: size, background: ok ? '#22c55e' : '#ef4444' }}
    />
  )
}

function agentHandle(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
}

interface ModelOption { id: string; label: string; recommended?: boolean }

// Fallback list rendered instantly + used if /api/models can't be reached. The
// authoritative catalog lives server-side (server/src/models.ts) and is fetched
// by useModels() so adding a model is a one-file backend change.
const FALLBACK_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (most capable)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (very capable, slower)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced, recommended)', recommended: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast, lightweight)' },
]

let modelsCache: ModelOption[] | null = null

function useModels(): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>(modelsCache ?? FALLBACK_MODELS)
  useEffect(() => {
    if (modelsCache) return
    fetch('/api/models')
      .then(r => r.json())
      .then(d => {
        if (d?.ok && Array.isArray(d.models) && d.models.length) {
          modelsCache = d.models
          setModels(d.models)
        }
      })
      .catch(() => {})
  }, [])
  return models
}

type Section =
  | { kind: 'workspace' }
  | { kind: 'agent'; id: string }
  | { kind: 'agent-new' }
  | { kind: 'discord' }
  | { kind: 'matrix' }
  | { kind: 'github' }
  | { kind: 'claude' }
  | { kind: 'members' }
  | { kind: 'usage' }
  | null

// Sections the host can deep-link into (e.g. from the Brigade roster).
export type SettingsTarget =
  | { kind: 'workspace' }
  | { kind: 'agent'; id: string }
  | { kind: 'agent-new' }

export function Settings({ workspaceId, onWorkspaceChanged, openClaudeNonce, openTarget, openTargetNonce }: { workspaceId: string; onWorkspaceChanged?: () => void; openClaudeNonce?: number; openTarget?: SettingsTarget; openTargetNonce?: number }) {
  const [agents, setAgents] = useState<AgentListItem[]>([])
  const [section, setSection] = useState<Section>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [railOpen, setRailOpen] = useState(false)
  const isDesktop = useIsDesktop()
  const rail = useRailState('bw_settings_rail')

  async function loadAgents() {
    const r = await fetch(`/api/workspaces/${workspaceId}/agents`).then(r => r.json())
    setAgents(r.agents ?? [])
  }
  async function loadChannels() {
    const r = await fetch(`/api/workspaces/${workspaceId}/channels`).then(r => r.json())
    setChannels(r.channels ?? [])
  }
  useEffect(() => {
    void loadAgents()
    void loadChannels()
  }, [workspaceId])

  // Deep-link from elsewhere (e.g. the "connect Claude" banner) opens this section.
  useEffect(() => {
    if (openClaudeNonce) setSection({ kind: 'claude' })
  }, [openClaudeNonce])

  // GitHub App / install flow redirects back to /settings?github=… — land the
  // user back on the GitHub panel and clean the query string.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('github')) {
      setSection({ kind: 'github' })
      params.delete('github')
      const qs = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
  }, [])

  // Deep-link from the Brigade roster: open a specific agent, the new-agent
  // form, or the workspace/plan section. Nonce-gated so repeat targets re-fire.
  useEffect(() => {
    if (openTargetNonce && openTarget) setSection(openTarget)
  }, [openTargetNonce])

  // Keep the channel list in sync when channels are added/renamed elsewhere.
  useResilientWs('/ws', {
    onMessage: (payload) => {
      const p = payload as { type?: string; workspaceId?: string }
      if (p.type === 'channels_updated' && (!p.workspaceId || p.workspaceId === workspaceId)) {
        void loadChannels()
      }
    },
  })

  function startCreate() {
    setSection({ kind: 'agent-new' })
  }
  const activeAgentId = section?.kind === 'agent' ? section.id : null

  return (
    <div className="h-full flex relative">
      {railOpen && (
        <div
          className="absolute inset-0 bg-black/40 z-20"
          onClick={() => setRailOpen(false)}
        />
      )}
      <aside
        style={isDesktop && rail.pinned && !rail.collapsed ? { width: rail.width, flex: '0 0 auto' } : undefined}
        className={`
          ${isDesktop && rail.pinned ? 'static' : 'absolute'} inset-y-0 left-0 z-30
          w-64 bg-[var(--color-surface)]
          border-r border-[var(--color-border)] flex-col
          transition-transform duration-200
          ${railOpen || (isDesktop && rail.pinned && !rail.collapsed) ? 'translate-x-0 flex' : '-translate-x-full flex'}
          ${isDesktop && rail.pinned && rail.collapsed ? 'hidden' : ''}
        `}
      >
        {/* Thin chrome row at the top — pin/collapse moved out of section headers */}
        <div className="sb-chrome">
          <button
            onClick={() => rail.setPinned(!rail.pinned)}
            className="ctl hidden md:block"
            style={rail.pinned ? undefined : { filter: 'grayscale(1)', opacity: 0.45 }}
            title={rail.pinned ? 'Unpin (overlay mode)' : 'Pin (dock)'}
          >
            📌
          </button>
          <button
            onClick={() => rail.pinned ? rail.setCollapsed(true) : setRailOpen(false)}
            className="ctl"
            title={rail.pinned ? 'Collapse sidebar' : 'Close'}
          >
            ◀
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="sb-section">
            <div className="sb-section-head">
              <span className="label">Workspace</span>
            </div>
            <button
              type="button"
              onClick={() => { setSection({ kind: 'workspace' }); setRailOpen(false) }}
              className={`sb-item ${section?.kind === 'workspace' ? 'active' : ''}`}
            >
              <span className="glyph">⚙</span>
              <span className="name">General</span>
            </button>
            <button
              type="button"
              onClick={() => { setSection({ kind: 'members' }); setRailOpen(false) }}
              className={`sb-item ${section?.kind === 'members' ? 'active' : ''}`}
            >
              <span className="glyph">👥</span>
              <span className="name">Members &amp; invites</span>
            </button>
            <button
              type="button"
              onClick={() => { setSection({ kind: 'usage' }); setRailOpen(false) }}
              className={`sb-item ${section?.kind === 'usage' ? 'active' : ''}`}
            >
              <span className="glyph">📊</span>
              <span className="name">Usage</span>
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-section-head">
              <span className="label">Agents</span>
              <button
                onClick={() => { startCreate(); setRailOpen(false) }}
                className="add"
                title="New agent"
              >
                +
              </button>
            </div>
            {agents.length === 0 ? (
              <div className="px-4 py-2 text-xs text-[var(--color-text-dim)]">
                No agents yet.
              </div>
            ) : (
              agents.map(a => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => { setSection({ kind: 'agent', id: a.id }); setRailOpen(false) }}
                  className={`sb-item agent ${a.id === activeAgentId ? 'active' : ''}`}
                >
                  <span className="av">
                    <AgentAvatar avatar={a.avatar} size={22} />
                  </span>
                  <span className="name">{a.name}</span>
                  {/* Both managed-Pro and BYOVPS are Pro-tier → Pro-styled badge; Standard shows nothing. */}
                  {hostingKind(a.hosting) === 'pro' && <span className="pro-tag">{HOSTING_LABEL.pro}</span>}
                  {hostingKind(a.hosting) === 'byovps' && <span className="pro-tag byovps-tag">{HOSTING_LABEL.byovps}</span>}
                  <HealthDot agent={a} />
                </button>
              ))
            )}
          </div>

          <div className="sb-section">
            <div className="sb-section-head">
              <span className="label">Account</span>
            </div>
            <button
              type="button"
              onClick={() => { setSection({ kind: 'claude' }); setRailOpen(false) }}
              className={`sb-item ${section?.kind === 'claude' ? 'active' : ''}`}
            >
              <span className="glyph">🔑</span>
              <span className="name">Connect Claude</span>
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-section-head">
              <span className="label">Integrations</span>
            </div>
            <button
              type="button"
              onClick={() => { setSection({ kind: 'discord' }); setRailOpen(false) }}
              className={`sb-item ${section?.kind === 'discord' ? 'active' : ''}`}
            >
              <span className="glyph">💬</span>
              <span className="name">Discord</span>
            </button>
            <button
              type="button"
              onClick={() => { setSection({ kind: 'matrix' }); setRailOpen(false) }}
              className={`sb-item ${section?.kind === 'matrix' ? 'active' : ''}`}
            >
              <span className="glyph">🛰️</span>
              <span className="name">Matrix</span>
            </button>
            <button
              type="button"
              onClick={() => { setSection({ kind: 'github' }); setRailOpen(false) }}
              className={`sb-item ${section?.kind === 'github' ? 'active' : ''}`}
            >
              <span className="glyph">🐙</span>
              <span className="name">GitHub docs</span>
            </button>
          </div>
        </div>
      </aside>
      {isDesktop && rail.pinned && !rail.collapsed && (
        <RailResizeHandle width={rail.width} setWidth={rail.setWidth} />
      )}

      <main className="flex-1 min-w-0 overflow-y-auto">
        {(!rail.pinned || rail.collapsed || !isDesktop) && (
          <header className="h-14 border-b border-[var(--color-border)] flex items-center px-4 gap-3">
            <button onClick={() => { if (isDesktop && rail.pinned && rail.collapsed) rail.setCollapsed(false); else setRailOpen(true) }} className="text-xl text-[var(--color-text-dim)] hover:text-[var(--color-text)]" aria-label="Open settings">☰</button>
            <span className="text-sm text-[var(--color-text-dim)]">Settings</span>
          </header>
        )}
        {section?.kind === 'workspace' ? (
          <WorkspaceSettings workspaceId={workspaceId} onChanged={() => onWorkspaceChanged?.()} />
        ) : section?.kind === 'agent-new' ? (
          <AgentCreate
            workspaceId={workspaceId}
            channels={channels}
            onSaved={(id) => {
              setSection({ kind: 'agent', id })
              void loadAgents()
            }}
            onCancel={() => setSection(null)}
          />
        ) : section?.kind === 'agent' ? (
          <AgentEdit
            key={section.id}
            workspaceId={workspaceId}
            agentId={section.id}
            channels={channels}
            onChanged={() => void loadAgents()}
            onDeleted={() => { setSection(null); void loadAgents() }}
          />
        ) : section?.kind === 'discord' ? (
          <DiscordIntegration workspaceId={workspaceId} channels={channels} />
        ) : section?.kind === 'matrix' ? (
          <MatrixIntegration workspaceId={workspaceId} channels={channels} />
        ) : section?.kind === 'github' ? (
          <GitHubIntegration workspaceId={workspaceId} />
        ) : section?.kind === 'claude' ? (
          <ClaudeAccountPanel />
        ) : section?.kind === 'members' ? (
          <WorkspaceMembers workspaceId={workspaceId} />
        ) : section?.kind === 'usage' ? (
          <UsagePanel workspaceId={workspaceId} />
        ) : (
          <SettingsLanding agents={agents} onPick={setSection} onNewAgent={startCreate} workspaceId={workspaceId} />
        )}
      </main>
    </div>
  )
}

// Settings landing shown when no section is selected. The section menu IS the
// content here (not a "look to the left" pointer) so it's reachable on mobile,
// where the rail is an off-canvas overlay behind the ☰.
function SettingsRow({ glyph, name, onClick }: { glyph: string; name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] text-left transition"
    >
      <span className="text-base w-5 text-center" aria-hidden>{glyph}</span>
      <span className="flex-1 text-sm">{name}</span>
      <span className="text-[var(--color-text-dim)]" aria-hidden>›</span>
    </button>
  )
}

function SettingsLanding({
  agents,
  onPick,
  onNewAgent,
  workspaceId,
}: {
  agents: AgentListItem[]
  onPick: (section: Section) => void
  onNewAgent: () => void
  workspaceId: string
}) {
  const standalone = useStandalone()
  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <h1 className="text-lg font-medium">Settings</h1>
      <p className="text-sm text-[var(--color-text-dim)] mt-1 mb-6">
        Manage your workspace, agents, account, and integrations.
      </p>

      <div className="mb-6">
        <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Workspace</div>
        <div className="space-y-1.5">
          <SettingsRow glyph="⚙" name="General" onClick={() => onPick({ kind: 'workspace' })} />
          <SettingsRow glyph="👥" name="Members & invites" onClick={() => onPick({ kind: 'members' })} />
          <SettingsRow glyph="📊" name="Usage" onClick={() => onPick({ kind: 'usage' })} />
        </div>
      </div>

      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-dim)]">Agents</div>
          <button type="button" onClick={onNewAgent} className="text-xs text-[var(--color-accent)] hover:opacity-80">
            + New agent
          </button>
        </div>
        <div className="space-y-1.5">
          {agents.length === 0 ? (
            <div className="text-xs text-[var(--color-text-dim)] px-1 py-2">No agents yet.</div>
          ) : (
            agents.map(a => (
              <button
                key={a.id}
                type="button"
                onClick={() => onPick({ kind: 'agent', id: a.id })}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] text-left transition"
              >
                <AgentAvatar avatar={a.avatar} size={22} />
                <span className="flex-1 text-sm truncate">{a.name}</span>
                {/* Both managed-Pro and BYOVPS are Pro-tier → Pro-styled badge; Standard shows nothing. */}
                {hostingKind(a.hosting) === 'pro' && <span className="pro-tag">{HOSTING_LABEL.pro}</span>}
                {hostingKind(a.hosting) === 'byovps' && <span className="pro-tag byovps-tag">{HOSTING_LABEL.byovps}</span>}
                <HealthDot agent={a} />
                <span className="text-[var(--color-text-dim)]" aria-hidden>›</span>
              </button>
            ))
          )}
        </div>
      </div>

      {standalone !== true && (
      <div className="mb-6">
        <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Account</div>
        <div className="space-y-1.5">
          <SettingsRow glyph="🔑" name="Connect Claude" onClick={() => onPick({ kind: 'claude' })} />
        </div>
      </div>
      )}

      <div className="mb-6">
        <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Integrations</div>
        <IntegrationsCards workspaceId={workspaceId} onPick={onPick} />
      </div>
    </div>
  )
}

// Integrations laid out as cards (like the Brigade roster) rather than a menu
// list — scales as more connectors land (Slack/Teams/Google Chat). Available
// ones open their connect/manage panel; upcoming ones show a "Soon" chip.
type IntegrationCard = {
  name: string
  glyph: string
  desc: string
  kind?: 'discord' | 'matrix' | 'github'  // set = clickable → opens that panel
  type?: string           // integrations-row type for connected status
  soon?: boolean
}
const INTEGRATION_CARDS: IntegrationCard[] = [
  { name: 'Discord', glyph: '💬', desc: 'Mirror workspace channels to a Discord server, both directions.', kind: 'discord', type: 'discord' },
  { name: 'Matrix', glyph: '🛰️', desc: 'Bridge to your own Matrix homeserver — encrypted rooms supported.', kind: 'matrix', type: 'matrix' },
  { name: 'GitHub docs', glyph: '🐙', desc: 'Two-way sync your workspace documents with a GitHub repo.', kind: 'github', type: 'github' },
  { name: 'Slack', glyph: '🔷', desc: 'Bring your crew into the Slack workspace your team already uses.', soon: true },
  { name: 'Microsoft Teams', glyph: '🟦', desc: 'Reach your agents from Microsoft Teams.', soon: true },
  { name: 'Google Chat', glyph: '🟢', desc: 'Connect Google Workspace Chat.', soon: true },
]

function IntegrationsCards({ workspaceId, onPick }: { workspaceId: string; onPick: (s: Section) => void }) {
  const [connected, setConnected] = useState<Set<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    fetch(`/api/workspaces/${workspaceId}/integrations`)
      .then(r => r.json())
      .then((d: { ok?: boolean; integrations?: { type: string; status: string }[] }) => {
        if (cancelled || !d?.ok) return
        setConnected(new Set((d.integrations ?? []).filter(i => i.status === 'active').map(i => i.type)))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId])

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(215px,1fr))' }}>
      {INTEGRATION_CARDS.map(c => {
        const isConnected = !!c.type && connected.has(c.type)
        const chip = c.soon
          ? { label: 'Soon', fg: 'var(--color-text-dim)', bg: 'var(--surface2)', bd: 'var(--line)' }
          : isConnected
            ? { label: 'Connected', fg: '#4ade80', bg: 'rgba(34,197,94,.10)', bd: 'rgba(34,197,94,.35)' }
            : { label: 'Connect', fg: 'var(--ember)', bg: 'var(--ember-soft)', bd: 'var(--ember-edge)' }
        return (
          <button
            key={c.name}
            type="button"
            disabled={c.soon}
            onClick={() => { if (!c.soon && c.kind) onPick({ kind: c.kind } as Section) }}
            className="text-left rounded-[14px] p-4 flex flex-col gap-2 transition hover:-translate-y-0.5"
            style={{
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface)',
              opacity: c.soon ? 0.6 : 1,
              cursor: c.soon ? 'default' : 'pointer',
            }}
          >
            <div className="flex items-center justify-between">
              <span style={{ fontSize: 24 }}>{c.glyph}</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: chip.fg, background: chip.bg, border: `1px solid ${chip.bd}` }}>
                {chip.label}
              </span>
            </div>
            <div className="text-sm font-semibold">{c.name}</div>
            <div className="text-xs text-[var(--color-text-dim)] leading-relaxed">{c.desc}</div>
          </button>
        )
      })}
    </div>
  )
}

const WS_THEME_CHOICES: { id: string; label: string; swatch: [string, string] }[] = [
  { id: 'graphite', label: 'Charcoal', swatch: ['#17171b', '#a78bfa'] },
  { id: 'ember', label: 'Ember', swatch: ['#14100c', '#ff7a5c'] },
  { id: 'atelier', label: 'Atelier', swatch: ['#f0eadc', '#1a5fb4'] },
]

function WorkspaceSettings({
  workspaceId,
  onChanged,
}: {
  workspaceId: string
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [theme, setTheme] = useState<string | null>(null)
  const [icon, setIcon] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const wsR = await fetch('/api/workspaces').then(r => r.json())
    const w = (wsR.workspaces ?? []).find((x: { id: string }) => x.id === workspaceId)
    if (w) {
      setName(w.name)
      setTheme(w.theme ?? null)
      setIcon(w.icon ?? '')
    }
    setLoaded(true)
  }
  useEffect(() => { void load() }, [workspaceId])

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    setSavedMsg(null)
    const trimmedIcon = icon.trim()
    const r = await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        theme: theme,
        icon: trimmedIcon || null,
      }),
    }).then(r => r.json())
    setSaving(false)
    if (!r.ok) { setError(r.error ?? 'Save failed'); return }
    setSavedMsg('Saved')
    setTimeout(() => setSavedMsg(null), 2000)
    onChanged()
  }

  if (!loaded) return <div className="p-8 text-sm text-[var(--color-text-dim)]">Loading…</div>

  return (
    <div className="max-w-2xl p-8 space-y-5">
      <h2 className="text-xl font-medium">Workspace settings</h2>
      <label className="block">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Name</div>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <div className="block">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Icon</div>
        <div className="text-xs text-[var(--color-text-dim)] mb-2">
          Shown in the workspace switcher so it's easy to spot at a glance. Choose “None” to use the first letter of the name.
        </div>
        <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
          <button
            type="button"
            onClick={() => setIcon('')}
            title="None"
            className={`aspect-square rounded-md border flex items-center justify-center text-xs text-[var(--color-text-dim)] transition ${
              icon === ''
                ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
                : 'border-[var(--color-border)] hover:border-[var(--color-text-dim)]'
            }`}
          >
            None
          </button>
          {WORKSPACE_ICONS.map(ic => (
            <button
              key={ic.key}
              type="button"
              onClick={() => setIcon(ic.key)}
              title={ic.label}
              className={`aspect-square rounded-md overflow-hidden border transition ${
                icon === ic.key
                  ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-text-dim)]'
              }`}
            >
              <img src={workspaceIconSrc(ic.key)} alt={ic.label} className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      </div>

      <div className="block">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Theme</div>
        <div className="text-xs text-[var(--color-text-dim)] mb-2">
          Sets the look of this workspace for everyone. Choose “Use my theme” to fall back to your personal setting.
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => setTheme(null)}
            className={`text-left border rounded p-2 transition ${
              theme === null
                ? 'border-[var(--color-accent)] bg-[var(--color-surface)]'
                : 'border-[var(--color-border)] hover:border-[var(--color-text-dim)]'
            }`}
          >
            <div className="inline-flex border border-[var(--color-border)] rounded overflow-hidden mb-1" style={{ width: 36, height: 20 }}>
              <span style={{ background: 'var(--color-surface)', flex: 1 }} />
            </div>
            <div className="text-xs">Use my theme</div>
          </button>
          {WS_THEME_CHOICES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              className={`text-left border rounded p-2 transition ${
                theme === t.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-surface)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-text-dim)]'
              }`}
            >
              <div className="inline-flex border border-[var(--color-border)] rounded overflow-hidden mb-1" style={{ width: 36, height: 20 }}>
                <span style={{ background: t.swatch[0], flex: 1 }} />
                <span style={{ background: t.swatch[1], flex: 1 }} />
              </div>
              <div className="text-xs">{t.label}</div>
            </button>
          ))}
        </div>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !name.trim()}
          className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedMsg && <span className="text-xs text-green-400">{savedMsg}</span>}
      </div>

      <div className="border-t border-[var(--color-border)] pt-5">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">
          Export
        </div>
        <p className="text-sm text-[var(--color-text-dim)] mb-3">
          Download a full export of this workspace — agents, rooms, documents,
          conversation history, settings. Yours to keep. Leave whenever you want.
        </p>
        <a
          href={`/api/workspaces/${workspaceId}/export`}
          className="inline-block bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-accent)] text-sm px-4 py-2 rounded transition"
        >
          Download workspace export (.json)
        </a>
      </div>

      <WorkspaceSecrets workspaceId={workspaceId} />

      <BillingSection />

      <div className="border-t border-[var(--color-border)] pt-5">
        <div className="text-xs uppercase tracking-wide text-red-400/80 mb-2">
          Danger zone
        </div>
        <p className="text-sm text-[var(--color-text-dim)] mb-3">
          Reset everything in this workspace — rooms, agents, documents, message
          history. Any Pro servers are destroyed. You'll get a fresh workspace with
          a new Concierge, like a brand-new subscriber.
        </p>
        <ResetButton workspaceId={workspaceId} />
        <p className="text-sm text-[var(--color-text-dim)] mt-6 mb-3">
          Permanently delete this workspace — rooms, agents, documents, message
          history, and any Pro servers. This can't be undone and there's no fresh
          workspace afterward. Owner only.
        </p>
        <DeleteWorkspaceButton workspaceId={workspaceId} />
      </div>
    </div>
  )
}

// ---------- Account-level Claude credential (powers Standard-tier agents) ----------

function ClaudeAccountPanel() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function refresh() {
    const r = await fetch('/api/auth/me').then(r => r.json()).catch(() => null)
    setConnected(!!r?.user?.has_anthropic_token)
  }
  useEffect(() => { void refresh() }, [])

  async function connect() {
    const t = token.trim()
    if (!t) return
    setBusy(true); setFeedback(null)
    const r = await fetch('/api/auth/me/anthropic-token', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'network error' }))
    setBusy(false)
    if (r.ok) {
      setToken('')
      setConnected(true)
      setFeedback({ kind: 'ok', text: 'Connected. Your agents will reply using this credential.' })
    } else {
      setFeedback({ kind: 'err', text: r.error ?? 'Could not save token' })
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect your Claude credential? Your agents will stop responding until you connect another.')) return
    setBusy(true); setFeedback(null)
    const r = await fetch('/api/auth/me/anthropic-token', { method: 'DELETE' })
      .then(r => r.json()).catch(() => ({ ok: false }))
    setBusy(false)
    if (r.ok) { setConnected(false); setFeedback({ kind: 'ok', text: 'Disconnected.' }) }
    else setFeedback({ kind: 'err', text: 'Could not disconnect' })
  }

  if (connected === null) return <div className="p-8 text-sm text-[var(--color-text-dim)]">Loading…</div>

  return (
    <div className="max-w-2xl p-8 space-y-5">
      <div>
        <h2 className="text-xl font-medium">Connect Claude</h2>
        <p className="text-sm text-[var(--color-text-dim)] mt-1">
          Your agents think using your own Claude credential. Connect a Claude
          Pro/Max subscription token or an Anthropic API key — either works.
        </p>
      </div>

      <div className="flex items-center justify-between border border-[var(--color-border)] rounded px-3 py-2 bg-[var(--color-surface)]">
        <span className="text-sm">Status</span>
        {connected
          ? <span className="text-xs text-green-400">● Connected</span>
          : <span className="text-xs text-[var(--color-text-dim)]">Not connected — agents can’t reply yet</span>}
      </div>

      {!connected && (
        <>
          <div className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)] text-sm space-y-2">
            <div className="font-medium">Option A — Claude subscription (recommended)</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Runs on your Claude Pro/Max plan, no extra charges.
            </div>
            <ol className="text-xs text-[var(--color-text-dim)] list-decimal pl-5 space-y-1">
              <li>Install the Claude CLI: <code className="text-[var(--color-text)]">npm install -g @anthropic-ai/claude-code</code></li>
              <li>Run <code className="text-[var(--color-text)]">claude setup-token</code></li>
              <li>Paste the <code>sk-ant-oat…</code> token it prints below.</li>
            </ol>
          </div>
          <div className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)] text-sm space-y-2">
            <div className="font-medium">Option B — Anthropic API key</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Bills against your Anthropic console credit. Create one at{' '}
              <code>console.anthropic.com</code>; format is <code>sk-ant-api03-…</code>.
            </div>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="sk-ant-oat-… or sk-ant-api03-…"
              className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
            />
            <button
              onClick={connect}
              disabled={busy || !token.trim()}
              className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Connect'}
            </button>
          </div>
        </>
      )}

      {connected && (
        <button
          onClick={disconnect}
          disabled={busy}
          className="text-sm text-[var(--color-text-dim)] hover:text-red-400 disabled:opacity-50"
        >
          {busy ? '…' : 'Disconnect credential'}
        </button>
      )}

      {feedback && (
        <div className={`text-sm ${feedback.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {feedback.text}
        </div>
      )}
    </div>
  )
}

// ---------- Workspace Members + invites ----------

type WorkspaceMember = {
  id: string
  email: string
  name: string | null
  google_name?: string | null
  display_name?: string | null
  avatar_url: string | null
  role: string
  joined_at: string
}
type WorkspaceInvite = {
  id: string
  token: string
  email: string | null
  created_at: string
  expires_at: string
}

function WorkspaceMembers({ workspaceId }: { workspaceId: string }) {
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [meUser, setMeUser] = useState<{ id: string; email: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [lastInvite, setLastInvite] = useState<WorkspaceInvite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [displayDraft, setDisplayDraft] = useState('')
  const [displaySaved, setDisplaySaved] = useState(false)

  async function loadMembers() {
    const r = await fetch(`/api/workspaces/${workspaceId}/members`)
      .then(r => r.ok ? r.json() : null).catch(() => null)
    const ms: WorkspaceMember[] = r?.members ?? []
    setMembers(ms)
    if (meUser?.id) {
      const mine = ms.find(m => m.id === meUser.id)
      setDisplayDraft(mine?.display_name ?? '')
    }
  }
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => setMeUser(d?.user ?? null))
  }, [])
  useEffect(() => {
    void loadMembers()
  }, [workspaceId, meUser?.id])

  const myRole = members.find(m => m.id === meUser?.id)?.role
  // Self-host is single-tenant — no multi-member invites. Hide the invite UI
  // (member management itself still renders). Undefined = still loading = treat
  // as cloud so nothing flashes; only an explicit true suppresses invites.
  const standalone = useStandalone()
  const canInvite = (myRole === 'owner' || myRole === 'admin') && standalone !== true
  const myMember = members.find(m => m.id === meUser?.id)
  const googleName = myMember?.google_name ?? myMember?.name ?? ''

  async function createInvite() {
    setBusy(true); setError(null); setCopied(false)
    const r = await fetch(`/api/workspaces/${workspaceId}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail.trim() || null }),
    })
    setBusy(false)
    if (!r.ok) {
      const b = await r.json().catch(() => null)
      setError(b?.error ?? 'Could not create invite')
      return
    }
    const body = await r.json()
    setLastInvite(body.invite)
    setInviteEmail('')
  }

  async function removeMember(userId: string) {
    const target = members.find(m => m.id === userId)
    if (!target) return
    const self = userId === meUser?.id
    const msg = self
      ? `Leave ${target.email}'s workspace? You'll lose access to its rooms and documents.`
      : `Remove ${target.email} from this workspace?`
    if (!confirm(msg)) return
    const r = await fetch(`/api/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' })
    if (!r.ok) {
      const b = await r.json().catch(() => null)
      alert(b?.error ?? 'Could not remove member')
      return
    }
    if (self) {
      window.location.href = '/'
      return
    }
    await loadMembers()
  }

  async function saveDisplayName() {
    setDisplaySaved(false)
    const r = await fetch(`/api/workspaces/${workspaceId}/members/me/display-name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: displayDraft }),
    })
    if (r.ok) {
      setDisplaySaved(true)
      setTimeout(() => setDisplaySaved(false), 2000)
      await loadMembers()
    }
  }

  const inviteUrl = lastInvite ? `${window.location.origin}/invite/${lastInvite.token}` : null

  return (
    <div className="max-w-2xl p-8 space-y-7">
      <div>
        <h2 className="text-xl font-medium">Members &amp; invites</h2>
        <p className="text-sm text-[var(--color-text-dim)] mt-1">
          Anyone you add can see every room and document here, and talk to every agent. The workspace owner's Claude account funds all agent activity in this workspace.
        </p>
      </div>

      {/* Members list */}
      <div>
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">In this workspace · {members.length}</div>
        <div className="space-y-1.5">
          {members.length === 0 && (
            <div className="text-xs text-[var(--color-text-dim)]">Loading…</div>
          )}
          {members.map(m => (
            <div key={m.id} className="flex items-center gap-3 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded">
              {m.avatar_url
                ? <img src={m.avatar_url} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                : <div className="w-8 h-8 rounded-full bg-[var(--accent-chat)] text-[var(--bg-deep)] flex items-center justify-center text-xs font-semibold flex-shrink-0">{(m.display_name ?? m.name ?? m.email)[0]?.toUpperCase()}</div>}
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{m.display_name ?? m.name ?? m.email}</div>
                <div className="text-xs text-[var(--color-text-dim)] truncate">{m.email}</div>
              </div>
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-dim)] font-mono flex-shrink-0">{m.role}</span>
              {m.role !== 'owner' && (canInvite || m.id === meUser?.id) && (
                <button
                  onClick={() => void removeMember(m.id)}
                  className="text-xs text-red-400 hover:text-red-300 flex-shrink-0 px-2"
                >
                  {m.id === meUser?.id ? 'Leave' : 'Remove'}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Your per-workspace display name */}
      {meUser && (
        <div className="border-t border-[var(--color-border)] pt-5">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Your display name here</div>
          <p className="text-sm text-[var(--color-text-dim)] mb-3">
            What other members see when you post. Leave blank to use your Google name
            {googleName && <> (<span className="font-mono">{googleName}</span>)</>}.
          </p>
          <div className="flex items-center gap-2">
            <input
              value={displayDraft}
              onChange={e => setDisplayDraft(e.target.value)}
              placeholder={googleName}
              maxLength={80}
              className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
            />
            <button
              onClick={() => void saveDisplayName()}
              className="bg-[var(--accent-chat)] text-[var(--bg-deep)] px-4 py-2 rounded text-sm font-medium hover:opacity-90"
            >
              Save
            </button>
            {displaySaved && <span className="text-xs text-green-400">Saved</span>}
          </div>
        </div>
      )}

      {/* Invite link creation */}
      {canInvite && (
        <div className="border-t border-[var(--color-border)] pt-5 space-y-3">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Invite a member</div>
          <p className="text-sm text-[var(--color-text-dim)]">
            Generate an invite link, share it however you like — email, Discord, text. Whoever opens it signs in with Google and joins.
          </p>
          <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 text-xs space-y-1.5">
            <div className="font-medium text-amber-300">Before you invite, know what they get:</div>
            <ul className="list-disc list-inside text-[var(--color-text-dim)] space-y-1">
              <li>Full read access to every room, document, and conversation in this workspace.</li>
              <li>They can talk to every agent here.</li>
              <li>Agent activity they trigger is billed to your Claude account.</li>
              <li>You can remove them at any time from this same panel.</li>
            </ul>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="optional — tag with email for tracking"
              className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
            />
            <button
              onClick={() => void createInvite()}
              disabled={busy}
              className="bg-[var(--accent-chat)] text-[var(--bg-deep)] px-4 py-2 rounded text-sm font-medium hover:opacity-90 disabled:opacity-40"
            >
              {busy ? '…' : 'Create invite'}
            </button>
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
          {inviteUrl && (
            <div className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded p-3 space-y-2">
              <div className="text-xs text-[var(--color-text-dim)]">Share this link with the person you're inviting. Valid 14 days.</div>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={inviteUrl}
                  onFocus={e => e.target.select()}
                  className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 text-xs font-mono"
                />
                <button
                  onClick={() => {
                    if (navigator.clipboard) {
                      void navigator.clipboard.writeText(inviteUrl)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1800)
                    }
                  }}
                  className="text-xs px-2.5 py-1.5 border border-[var(--color-border)] rounded hover:bg-[var(--color-hover-bg)] font-mono"
                >
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- Agent skills (extra abilities catalog) ----------

type Skill = {
  id: string
  label: string
  description: string
  access: string
  tier: 'standard' | 'pro'
  needsConnection: boolean
  available: boolean
}

function AgentSkills({
  workspaceId, agentId, initialEnabled, onChanged,
}: {
  workspaceId: string
  agentId: string
  initialEnabled: string[]
  onChanged: (next: string[]) => void
}) {
  const [catalog, setCatalog] = useState<Skill[] | null>(null)
  const [enabled, setEnabled] = useState<Set<string>>(new Set(initialEnabled))
  const [canEdit, setCanEdit] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The toggle handler must build each request from the latest known set, not a
  // stale render closure, or overlapping saves clobber each other.
  const enabledRef = useRef(enabled)
  // Monotonic write counter: only the most recent save is authoritative, so a
  // slow earlier response can't overwrite a newer toggle.
  const writeSeq = useRef(0)

  function applyEnabled(next: Set<string>) {
    enabledRef.current = next
    setEnabled(next)
  }

  // Keep our local enabled set in sync if the parent re-fetches the agent.
  useEffect(() => {
    applyEnabled(new Set(initialEnabled))
  }, [initialEnabled.join(',')])

  // Fetch the catalog + the user's workspace role in parallel.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/workspaces/${workspaceId}/skills`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setCatalog(d?.skills ?? []) })
      .catch(() => { if (!cancelled) setCatalog([]) })
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(meRes => {
      if (cancelled) return
      const uid = meRes?.user?.id
      if (!uid) { setCanEdit(false); return }
      fetch(`/api/workspaces/${workspaceId}/members`)
        .then(r => r.ok ? r.json() : null)
        .then(mr => {
          if (cancelled) return
          const mine = (mr?.members ?? []).find((m: { id: string; role: string }) => m.id === uid)
          setCanEdit(mine?.role === 'owner' || mine?.role === 'admin')
        })
        .catch(() => { if (!cancelled) setCanEdit(false) })
    })
    return () => { cancelled = true }
  }, [workspaceId])

  async function toggle(skillId: string, on: boolean) {
    // Build from the latest known set (ref), so rapid toggles compose instead
    // of each one starting from a stale snapshot.
    const next = new Set(enabledRef.current)
    if (on) next.add(skillId); else next.delete(skillId)
    const nextArr = Array.from(next)
    const seq = ++writeSeq.current
    // Optimistic
    applyEnabled(next)
    setSavingId(skillId); setError(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/skills`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled_skills: nextArr }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'network error' }))
    // A newer toggle superseded this one. Drop our stale result entirely:
    // propagating it (even just up via onChanged) would round-trip back through
    // the initialEnabled prop and the sync effect, stomping the newer toggle.
    // The latest write owns both the local state and the parent notification.
    if (seq !== writeSeq.current) return
    setSavingId(null)
    if (r.ok && r.agent?.enabled_skills) {
      // Use the sanitized server result as truth
      applyEnabled(new Set(r.agent.enabled_skills))
      onChanged(r.agent.enabled_skills)
    } else {
      // Revert just this skill from the latest known set.
      const reverted = new Set(enabledRef.current)
      if (on) reverted.delete(skillId); else reverted.add(skillId)
      applyEnabled(reverted)
      setError(r.error ?? 'Could not save skills')
    }
  }

  if (catalog === null) {
    return (
      <div className="border-t border-[var(--color-border)] pt-5">
        <div className="field-label mb-2">Skills</div>
        <div className="text-xs text-[var(--color-text-dim)]">Loading…</div>
      </div>
    )
  }

  if (catalog.length === 0) {
    return null
  }

  return (
    <div className="border-t border-[var(--color-border)] pt-5">
      <div className="field-label mb-1 flex items-center gap-2">
        Skills
        <span className="text-[11px] font-normal rounded-full px-1.5 py-0.5 bg-[var(--color-active-bg)] text-[var(--color-text-dim)]">
          {enabled.size} on
        </span>
      </div>
      <p className="text-sm text-[var(--color-text-dim)] mb-4 max-w-2xl">
        Turn on extra abilities. With nothing enabled, your agent already handles workspace
        documents, web search, and web fetch — these add focused tools and explicit guidance on top.
      </p>
      {canEdit && enabled.size === 0 && catalog.some(s => s.available) && (
        <p className="mb-4 -mt-2 text-xs text-[var(--color-accent)]">
          Nothing enabled yet — turn on a skill below to expand what this agent can do.
        </p>
      )}
      <div className="skills-grid">
        {catalog.map(s => {
          const isOn = enabled.has(s.id)
          const isDisabled = !s.available || !canEdit
          const saving = savingId === s.id
          return (
            <div
              key={s.id}
              className={`skill-card ${isOn ? 'on' : ''} ${!s.available ? 'unavailable' : ''}`}
            >
              <div className="skill-card-head">
                <span className="skill-title">{s.label}</span>
                {!s.available && <span className="skill-pill soon">Coming soon</span>}
                {s.tier === 'pro' && <span className="skill-pill pro">Pro</span>}
              </div>
              <p className="skill-desc">{s.description}</p>
              <div className="skill-access">
                <span className="skill-access-label">Access</span> {s.access}
              </div>
              <div className="skill-toggle-row">
                <label className={`skill-toggle ${isDisabled ? 'is-disabled' : ''} ${isOn ? 'is-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={isOn}
                    disabled={isDisabled || saving}
                    onChange={(e) => { void toggle(s.id, e.target.checked) }}
                  />
                  <span className="track"><span className="knob" /></span>
                  <span className="skill-toggle-label">
                    {!s.available
                      ? 'Coming soon'
                      : !canEdit
                        ? (isOn ? 'On' : 'Off')
                        : saving
                          ? 'Saving…'
                          : (isOn ? 'On' : 'Off')}
                  </span>
                </label>
              </div>
            </div>
          )
        })}
      </div>
      {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
      {!canEdit && (
        <div className="text-xs text-[var(--color-text-dim)] mt-3 font-mono">
          Members see this read-only — owner/admin to edit.
        </div>
      )}
    </div>
  )
}

// ---------- Move agent to another workspace ----------

function MoveAgent({
  workspaceId, agentId, agentName,
}: {
  workspaceId: string
  agentId: string
  agentName: string
}) {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; role: string }[]>([])
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/workspaces')
      .then(r => r.ok ? r.json() : null)
      .then(d => setWorkspaces(d?.workspaces ?? []))
      .catch(() => {})
  }, [])

  const eligible = workspaces.filter(w =>
    w.id !== workspaceId && (w.role === 'owner' || w.role === 'admin'),
  )

  async function move() {
    if (!target) return
    const dest = workspaces.find(w => w.id === target)
    if (!confirm(`Move "${agentName}" to "${dest?.name ?? 'that workspace'}"? Its room memberships here will be cleared — you'll re-add it to rooms in the destination.`)) return
    setBusy(true); setError(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dest_workspace_id: target }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'network error' }))
    setBusy(false)
    if (r.ok) {
      // Switch active workspace to the destination so the user can keep
      // working with the moved agent right away.
      try { localStorage.setItem('bw_active_workspace', target) } catch { /* ignore */ }
      window.location.href = '/'
    } else {
      setError(r.error ?? 'Could not move agent')
    }
  }

  if (eligible.length === 0) return null

  return (
    <div className="border-t border-[var(--color-border)] pt-5 mt-5">
      <div className="field-label">Move to another workspace</div>
      <p className="text-sm text-[var(--color-text-dim)] mb-3">
        Hand this agent off to another workspace where you're owner or admin. Its SOUL, model, hosting, and version history travel with it. Room memberships reset because those reference this workspace's rooms — you'll re-add it to rooms in the destination.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={target}
          onChange={e => setTarget(e.target.value)}
          className="input mono flex-1"
        >
          <option value="">Pick a destination workspace…</option>
          {eligible.map(w => (
            <option key={w.id} value={w.id}>
              {w.name} · {w.role}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void move()}
          disabled={!target || busy}
          className="bg-[var(--accent-chat)] text-[var(--bg-deep)] px-4 py-2 rounded text-sm font-medium hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Moving…' : '▶ Move'}
        </button>
      </div>
      {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
    </div>
  )
}

function BillingSection() {
  const [active, setActive] = useState(false)
  const [periodEnd, setPeriodEnd] = useState<string | null>(null)
  const [hasCustomer, setHasCustomer] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // Self-host: /api/billing/status returns { enabled: false } → hide the whole
  // section (no Stripe in standalone mode). null while unknown.
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/billing/status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d?.ok) return
        setEnabled(d.enabled === false ? false : true)
        setActive(!!d.active)
        setPeriodEnd(d.current_period_end)
        setHasCustomer(!!d.has_customer)
      })
      .finally(() => setLoaded(true))
  }, [])

  async function go(path: '/api/billing/checkout' | '/api/billing/portal') {
    setBusy(true)
    setError(null)
    const r = await fetch(path, { method: 'POST' }).then(r => r.json()).catch(() => null)
    setBusy(false)
    if (!r?.ok || !r.url) { setError(r?.error ?? 'Could not reach billing.'); return }
    window.location.href = r.url
  }

  if (!loaded) return null
  // Standalone / self-host: billing is disabled server-side, so omit the panel.
  if (enabled === false) return null

  return (
    <div className="border-t border-[var(--color-border)] pt-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">
        Billing
      </div>
      <p className="text-sm text-[var(--color-text-dim)] mb-3">
        {active
          ? `Standard plan is active${
              periodEnd ? ` — renews ${new Date(periodEnd).toLocaleDateString()}` : ''
            }.`
          : 'You’re on the free tier — one real agent with custom soul, skills, memory, rooms, and shared docs in your own workspace, and you can join shared workspaces you’re invited to. Upgrade to Standard for $15/mo for unlimited agents.'}
      </p>
      {!active && (
        <p className="text-xs text-[var(--color-text-dim)] mb-3">
          <strong className="text-[var(--color-text)]">Founding rate: $10/mo, locked for life</strong>{' '}
          while you stay subscribed — first ~100 members or 60 days, whichever
          comes first. Or pay annually: 10 months for 12.
        </p>
      )}
      {error && <div className="text-sm text-red-400 mb-2">{error}</div>}
      {active || hasCustomer ? (
        <button
          onClick={() => go('/api/billing/portal')}
          disabled={busy}
          className="inline-block bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-accent)] text-sm px-4 py-2 rounded transition disabled:opacity-50"
        >
          {busy ? '…' : 'Manage billing'}
        </button>
      ) : (
        <button
          onClick={() => go('/api/billing/checkout')}
          disabled={busy}
          className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '…' : 'Upgrade to Standard'}
        </button>
      )}
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">{label}</div>
      {children}
    </label>
  )
}

function AgentCreate({
  workspaceId,
  channels,
  onSaved,
  onCancel,
}: {
  workspaceId: string
  channels: Channel[]
  onSaved: (id: string) => void
  onCancel: () => void
}) {
  const models = useModels()
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('🤖')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [soul, setSoul] = useState('')
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsUpgrade, setNeedsUpgrade] = useState(false)
  const [pickedTemplate, setPickedTemplate] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  async function startUpgrade() {
    const r = await fetch('/api/billing/checkout', { method: 'POST' }).then(r => r.json()).catch(() => null)
    if (r?.ok && r.url) window.location.href = r.url
    else setError(r?.error ?? 'Could not reach billing.')
  }

  function applyTemplate(t: AgentTemplate) {
    setPickedTemplate(t.id)
    if (!name.trim()) setName(t.name)
    setAvatar(t.avatar_path)
    setSoul(t.soul_md)
  }

  async function surpriseMe() {
    setGenerating(true)
    setError(null)
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/agents/generate-soul`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hint: '' }),
      }).then(r => r.json())
      if (!r.ok) { setError(r.error ?? 'Generation failed'); return }
      setPickedTemplate('surprise')
      if (!name.trim()) setName(r.template.name)
      setAvatar(r.template.avatar || '🤖')
      setSoul(r.template.soul_md)
    } finally {
      setGenerating(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    setNeedsUpgrade(false)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        avatar,
        model,
        soul_md: soul,
        channel_ids: Array.from(selectedChannels),
      }),
    }).then(r => r.json())
    setSubmitting(false)
    if (!r.ok) {
      setError(r.error ?? 'Failed to create agent')
      if (r.code === 'upgrade_required') setNeedsUpgrade(true)
      return
    }
    onSaved(r.agent.id)
  }

  return (
    <form onSubmit={submit} className="max-w-2xl p-8 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-medium">New agent</h2>
        <button type="button" onClick={onCancel} className="text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)]">
          Cancel
        </button>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">
          Start from a template
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {AGENT_TEMPLATES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t)}
              title={t.blurb}
              className={`text-left p-2 border rounded text-xs hover:border-[var(--color-accent)] ${
                pickedTemplate === t.id ? 'border-[var(--color-accent)] bg-[var(--color-active-bg)]' : 'border-[var(--color-border)]'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <AgentAvatar avatar={t.avatar_path} size={18} />
                <span className="font-medium truncate">{t.name}</span>
              </div>
              <div className="text-[10px] text-[var(--color-text-dim)] mt-1 line-clamp-2">
                {t.blurb}
              </div>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-2">
          <button
            type="button"
            onClick={surpriseMe}
            disabled={generating}
            className={`text-xs px-3 py-1.5 rounded border ${
              pickedTemplate === 'surprise' ? 'border-[var(--color-accent)] bg-[var(--color-active-bg)]' : 'border-[var(--color-border)]'
            } hover:border-[var(--color-accent)] disabled:opacity-50`}
          >
            {generating ? 'Inventing…' : '✨ Surprise me'}
          </button>
          <button
            type="button"
            onClick={() => { setPickedTemplate(null); setSoul(''); setAvatar('🤖') }}
            className="text-xs px-3 py-1.5 rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            Start blank
          </button>
        </div>
      </div>

      <FormField label="Name">
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Rigatoni"
          className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
        />
      </FormField>
      <FormField label="Avatar">
        <AvatarPicker value={avatar} onChange={setAvatar} />
      </FormField>
      <FormField label="Model">
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
        >
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </FormField>
      <FormField label="SOUL (markdown)">
        <textarea
          value={soul}
          onChange={e => setSoul(e.target.value)}
          rows={12}
          placeholder={'# Name — Soul\n\n## Who I Am\n\n## How I Show Up\n\n...'}
          className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
        />
      </FormField>
      <FormField label="Add to rooms">
        <div className="space-y-1">
          {channels.length === 0 ? (
            <div className="text-xs text-[var(--color-text-dim)]">No rooms yet.</div>
          ) : channels.map(c => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedChannels.has(c.id)}
                onChange={() => {
                  const next = new Set(selectedChannels)
                  if (next.has(c.id)) next.delete(c.id)
                  else next.add(c.id)
                  setSelectedChannels(next)
                }}
                className="accent-[var(--color-accent)]"
              />
              <IconChannel /> {c.name}
            </label>
          ))}
        </div>
      </FormField>
      {error && <div className="text-sm text-red-400">{error}</div>}
      {needsUpgrade && (
        <button
          type="button"
          onClick={startUpgrade}
          className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90"
        >
          Upgrade to Standard
        </button>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create agent'}
        </button>
      </div>
    </form>
  )
}

// Per-agent encrypted secrets (Cosimo's backend, 2026-06-27). Owner/admin only;
// values are write-only — the API returns names + timestamps, never values.
type AgentSecret = { name: string; updated_at: string; scope?: 'workspace' | 'agent' }
const RESERVED_SECRETS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

function AgentSecrets({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const base = `/api/workspaces/${workspaceId}/agents/${agentId}/secrets`
  const [secrets, setSecrets] = useState<AgentSecret[] | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSecrets(null); setForbidden(false)
    let cancelled = false
    ;(async () => {
      const r = await fetch(base)
      if (cancelled) return
      if (r.status === 403) { setForbidden(true); setSecrets([]); return }
      const d = await r.json().catch(() => null)
      setSecrets(d?.ok ? (d.secrets ?? []) : [])
    })()
    return () => { cancelled = true }
  }, [base])

  const reserved = RESERVED_SECRETS.includes(name)
  const nameValid = /^[A-Z_][A-Z0-9_]*$/.test(name)
  const canSave = nameValid && !reserved && value.length > 0 && !busy
  const existing = secrets?.some(s => s.name === name) ?? false

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setBusy(true); setError(null)
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value }),
    })
    const d = await r.json().catch(() => null)
    setBusy(false)
    if (!r.ok || !d?.ok) { setError(d?.error || `Couldn't save secret (${r.status}).`); return }
    setSecrets(d.secrets ?? [])
    setName(''); setValue(''); setAdding(false)
  }

  async function remove(n: string) {
    if (!confirm(`Delete ${n}? This agent will immediately lose access to it.`)) return
    const r = await fetch(`${base}/${encodeURIComponent(n)}`, { method: 'DELETE' })
    const d = await r.json().catch(() => null)
    if (d?.ok) setSecrets(d.secrets ?? [])
  }

  return (
    <div className="border-t border-[var(--color-border)] pt-5">
      <div className="field-label mb-1">Secrets</div>
      <p className="text-sm text-[var(--color-text-dim)] mb-3">
        Everything this agent can actually see. <span className="text-[var(--color-text)]">Workspace</span> secrets are
        shared by every agent (manage them in Workspace settings); <span className="text-[var(--color-text)]">agent</span>{' '}
        secrets are set here and only for this agent — a same-named agent secret overrides the workspace one. Stored
        encrypted — your agent reads them as environment variables (e.g.{' '}
        <code className="font-mono text-[var(--color-text)]">$STRIPE_API_KEY</code>) in its shell and tools. They're never
        shown in chat and never written to the agent's machine.
      </p>

      {forbidden ? (
        <div className="text-xs text-[var(--color-text-dim)]">Only workspace owners and admins can manage agent secrets.</div>
      ) : secrets === null ? (
        <div className="text-xs text-[var(--color-text-dim)]">Loading…</div>
      ) : (
        <>
          {secrets.length > 0 && (
            <div className="flex flex-col gap-1.5 mb-3">
              {secrets.map(s => {
                const inherited = s.scope === 'workspace'
                return (
                  <div key={s.name} className="flex items-center gap-3 border border-[var(--color-border)] rounded px-3 py-2 bg-[var(--color-surface)]">
                    <span className="font-mono text-sm text-[var(--color-text)] flex-1 min-w-0 truncate">{s.name}</span>
                    <span
                      className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 flex-shrink-0 border ${inherited ? 'border-[var(--color-border)] text-[var(--color-text-dim)]' : 'border-[var(--color-accent)] text-[var(--color-accent)]'}`}
                      title={inherited ? 'Shared by every agent in this workspace' : 'Set only on this agent'}
                    >
                      {inherited ? 'workspace' : 'agent'}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-dim)] flex-shrink-0">updated {new Date(s.updated_at).toLocaleDateString()}</span>
                    {inherited ? (
                      <span className="text-[11px] text-[var(--color-text-dim)] flex-shrink-0 italic">managed in Workspace settings</span>
                    ) : (
                      <button type="button" onClick={() => void remove(s.name)} className="text-[var(--color-text-dim)] hover:text-[#e5484d] flex-shrink-0" aria-label={`Delete ${s.name}`} title="Delete secret">
                        <IconTrash size={14} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {adding ? (
            <form onSubmit={save} className="flex flex-col gap-2 border border-[var(--color-border)] rounded px-3 py-3 bg-[var(--color-surface)]">
              <div>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value.toUpperCase())}
                  placeholder="STRIPE_API_KEY"
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="text-[11px] mt-1 text-[var(--color-text-dim)]">
                  {reserved
                    ? <span className="text-[#e5484d]">Reserved — this is the agent's Claude credential and can't be overridden.</span>
                    : name && !nameValid
                      ? <span className="text-[#e5484d]">UPPER_SNAKE_CASE only — letters, numbers and underscores; can't start with a number.</span>
                      : existing
                        ? <span>Saving rotates the existing <span className="font-mono">{name}</span>.</span>
                        : 'UPPER_SNAKE_CASE — the agent reads it under this exact name.'}
                </div>
              </div>
              <input
                type="password"
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder="Value (paste the secret)"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                autoComplete="new-password"
              />
              {error && <div className="text-xs text-[#e5484d]">{error}</div>}
              <div className="flex items-center gap-2">
                <button type="submit" disabled={!canSave} className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save secret'}
                </button>
                <button type="button" onClick={() => { setAdding(false); setName(''); setValue(''); setError(null) }} className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-2 py-2 text-sm">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <button type="button" onClick={() => setAdding(true)} className="text-sm text-[var(--color-accent)] hover:opacity-80">
                + Add secret
              </button>
              {secrets.length === 0 && <span className="text-xs text-[var(--color-text-dim)] ml-2">No secrets yet.</span>}
            </>
          )}
        </>
      )}
    </div>
  )
}

// Workspace-level encrypted secrets — shared by every agent in the workspace.
// Owner/admin only; values are write-only (the API returns names + timestamps).
function WorkspaceSecrets({ workspaceId }: { workspaceId: string }) {
  const base = `/api/workspaces/${workspaceId}/secrets`
  const [secrets, setSecrets] = useState<AgentSecret[] | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSecrets(null); setForbidden(false)
    let cancelled = false
    ;(async () => {
      const r = await fetch(base)
      if (cancelled) return
      if (r.status === 403) { setForbidden(true); setSecrets([]); return }
      const d = await r.json().catch(() => null)
      setSecrets(d?.ok ? (d.secrets ?? []) : [])
    })()
    return () => { cancelled = true }
  }, [base])

  const reserved = RESERVED_SECRETS.includes(name)
  const nameValid = /^[A-Z_][A-Z0-9_]*$/.test(name)
  const canSave = nameValid && !reserved && value.length > 0 && !busy
  const existing = secrets?.some(s => s.name === name) ?? false

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setBusy(true); setError(null)
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value }),
    })
    const d = await r.json().catch(() => null)
    setBusy(false)
    if (!r.ok || !d?.ok) { setError(d?.error || `Couldn't save secret (${r.status}).`); return }
    setSecrets(d.secrets ?? [])
    setName(''); setValue(''); setAdding(false)
  }

  async function remove(n: string) {
    if (!confirm(`Delete ${n}? Every agent in this workspace will immediately lose access to it.`)) return
    const r = await fetch(`${base}/${encodeURIComponent(n)}`, { method: 'DELETE' })
    const d = await r.json().catch(() => null)
    if (d?.ok) setSecrets(d.secrets ?? [])
  }

  return (
    <div className="border-t border-[var(--color-border)] pt-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Workspace secrets</div>
      <p className="text-sm text-[var(--color-text-dim)] mb-3">
        Shared by every agent in this workspace. Set a credential once (e.g.{' '}
        <code className="font-mono text-[var(--color-text)]">$STRIPE_API_KEY</code>) and all your agents can read it as an
        environment variable. Stored encrypted — never shown in chat, never written to an agent's machine. To override
        for a single agent, set an agent-level secret of the same name in that agent's Advanced tab.
      </p>

      {forbidden ? (
        <div className="text-xs text-[var(--color-text-dim)]">Only workspace owners and admins can manage secrets.</div>
      ) : secrets === null ? (
        <div className="text-xs text-[var(--color-text-dim)]">Loading…</div>
      ) : (
        <>
          {secrets.length > 0 && (
            <div className="flex flex-col gap-1.5 mb-3">
              {secrets.map(s => (
                <div key={s.name} className="flex items-center gap-3 border border-[var(--color-border)] rounded px-3 py-2 bg-[var(--color-surface)]">
                  <span className="font-mono text-sm text-[var(--color-text)] flex-1 min-w-0 truncate">{s.name}</span>
                  <span className="text-[11px] text-[var(--color-text-dim)] flex-shrink-0">updated {new Date(s.updated_at).toLocaleDateString()}</span>
                  <button type="button" onClick={() => void remove(s.name)} className="text-[var(--color-text-dim)] hover:text-[#e5484d] flex-shrink-0" aria-label={`Delete ${s.name}`} title="Delete secret">
                    <IconTrash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {adding ? (
            <form onSubmit={save} className="flex flex-col gap-2 border border-[var(--color-border)] rounded px-3 py-3 bg-[var(--color-surface)]">
              <div>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value.toUpperCase())}
                  placeholder="STRIPE_API_KEY"
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="text-[11px] mt-1 text-[var(--color-text-dim)]">
                  {reserved
                    ? <span className="text-[#e5484d]">Reserved — this is the agent's Claude credential and can't be overridden.</span>
                    : name && !nameValid
                      ? <span className="text-[#e5484d]">UPPER_SNAKE_CASE only — letters, numbers and underscores; can't start with a number.</span>
                      : existing
                        ? <span>Saving rotates the existing <span className="font-mono">{name}</span>.</span>
                        : 'UPPER_SNAKE_CASE — agents read it under this exact name.'}
                </div>
              </div>
              <input
                type="password"
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder="Value (paste the secret)"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                autoComplete="new-password"
              />
              {error && <div className="text-xs text-[#e5484d]">{error}</div>}
              <div className="flex items-center gap-2">
                <button type="submit" disabled={!canSave} className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save secret'}
                </button>
                <button type="button" onClick={() => { setAdding(false); setName(''); setValue(''); setError(null) }} className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-2 py-2 text-sm">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <button type="button" onClick={() => setAdding(true)} className="text-sm text-[var(--color-accent)] hover:opacity-80">
                + Add secret
              </button>
              {secrets.length === 0 && <span className="text-xs text-[var(--color-text-dim)] ml-2">No workspace secrets yet.</span>}
            </>
          )}
        </>
      )}
    </div>
  )
}

// Derive the box IP from a Pro agent's external_url (strip scheme + port).
function boxIpFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0] || null
  }
}

// Custom domain + HTTPS for managed Pro agents (Cosimo backend, 2026-06-27).
function AgentDomain({ workspaceId, agentId, agent }: { workspaceId: string; agentId: string; agent: AgentDetail }) {
  const base = `/api/workspaces/${workspaceId}/agents/${agentId}/domain`
  const [domain, setDomain] = useState(agent.web_domain ?? '')
  const [savedDomain, setSavedDomain] = useState<string | null>(agent.web_domain ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const boxIp = boxIpFromUrl(agent.external_url)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const d = domain.trim().toLowerCase()
    if (!d || busy) return
    setBusy(true); setError(null); setOk(null)
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: d }),
    })
    const body = await r.json().catch(() => null)
    setBusy(false)
    if (!r.ok || !body?.ok) { setError(body?.error || `Couldn't set up the domain (${r.status}).`); return }
    setSavedDomain(d)
    setOk(body.https_url || `https://${d}/`)
  }

  const liveUrl = ok || (savedDomain ? `https://${savedDomain}/` : null)

  return (
    <div className="border-t border-[var(--color-border)] pt-5">
      <div className="field-label mb-1">Custom domain (optional)</div>
      <p className="text-sm text-[var(--color-text-dim)] mb-3">
        Your agent's site already works on its box IP — this is only if you want to serve it on
        your own domain with HTTPS (Let's Encrypt). A power-user upgrade, not a requirement.
      </p>

      {liveUrl && (
        <div className="mb-3 text-sm">
          Live at{' '}
          <a href={liveUrl} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline font-mono">
            {liveUrl}
          </a>
        </div>
      )}

      <div className="border border-amber-500/40 bg-amber-500/5 rounded px-3 py-2.5 text-sm mb-3">
        <div className="font-medium text-amber-300 mb-1">Before you save — set up DNS</div>
        <p className="text-[var(--color-text-dim)]">
          Add a DNS <span className="text-[var(--color-text)]">A record</span> for this domain pointing to{' '}
          <code className="font-mono text-[var(--color-text)]">{boxIp ?? '(your box IP)'}</code>, set to{' '}
          <span className="text-[var(--color-text)]">DNS-only / grey-cloud (NOT proxied)</span> — otherwise the
          certificate can't be issued.
        </p>
      </div>

      <form onSubmit={save} className="flex flex-col sm:flex-row gap-2">
        <input
          value={domain}
          onChange={e => setDomain(e.target.value)}
          placeholder="agent.yourdomain.com"
          className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={busy || !domain.trim()} className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50">
          {busy ? 'Setting up…' : 'Save'}
        </button>
      </form>
      {error && <div className="text-xs text-[#e5484d] mt-2">{error}</div>}
      {ok && <div className="text-xs text-green-400 mt-2">Domain configured with HTTPS.</div>}
    </div>
  )
}

// Rule-of-two safety tracker: self-declared risky capabilities + a computed
// status. The risky bits (spend, inbound email) are wired up by the subscriber
// and can't be auto-detected, so we ask — and the asking is the safety value.
function AgentSafety({ workspaceId, agentId, initial }: { workspaceId: string; agentId: string; initial?: SafetyProfile }) {
  const [profile, setProfile] = useState<SafetyProfile>(initial ?? {})
  const [saving, setSaving] = useState(false)
  const status = computeSafety(profile)

  async function toggle(key: keyof SafetyProfile) {
    const next: SafetyProfile = { ...profile, [key]: !profile[key] }
    if (!next[key]) delete next[key]
    setProfile(next)
    setSaving(true)
    try {
      await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/safety`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ safety_profile: next }),
      })
    } finally { setSaving(false) }
  }

  const tone = status.level === 'violation' ? { bg: 'rgba(239,68,68,.12)', bd: 'rgba(239,68,68,.4)', fg: '#f87171', dot: '🔴' }
    : status.level === 'caution' ? { bg: 'rgba(245,158,11,.12)', bd: 'rgba(245,158,11,.4)', fg: '#fbbf24', dot: '🟡' }
    : { bg: 'rgba(34,197,94,.10)', bd: 'rgba(34,197,94,.35)', fg: '#4ade80', dot: '🟢' }

  return (
    <section className="mt-6">
      <div className="field-label mb-1">Agent safety · rule of two</div>
      <p className="text-xs text-[var(--color-text-dim)] mb-3">
        Declare what you&apos;ve given this agent. Reading untrusted input, taking consequential
        actions, AND running without a human in the loop is all three risk axes at once — keep it
        to at most two.
      </p>

      <div style={{ background: tone.bg, border: `1px solid ${tone.bd}`, borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
        <div style={{ color: tone.fg, fontWeight: 700, fontSize: 14 }}>{tone.dot} {status.label} · {status.hotAxes}/3 axes hot</div>
        <div className="text-xs text-[var(--color-text-dim)]" style={{ marginTop: 4 }}>{status.detail}</div>
        {status.remediation && (
          <div className="text-xs" style={{ marginTop: 6, color: tone.fg }}>Fix: {status.remediation}</div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {SAFETY_ITEMS.map(item => {
          const on = !!profile[item.key]
          return (
            <button key={item.key} type="button" onClick={() => toggle(item.key)}
              className="text-left rounded-lg px-3 py-2 flex items-start gap-3"
              style={{ background: 'var(--surface2)', border: `1px solid ${on ? 'var(--ember-edge)' : 'var(--line)'}` }}>
              <span style={{ marginTop: 1 }}>{on ? '☑' : '☐'}</span>
              <span>
                <span className="text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-[var(--color-text-dim)]">{item.hint}</span>
              </span>
            </button>
          )
        })}
      </div>
      {saving && <div className="text-xs text-[var(--color-text-dim)] mt-2">Saving…</div>}
    </section>
  )
}

// Root privilege toggle + consent modal for managed Pro agents.
function AgentPrivilege({ workspaceId, agentId, agent }: { workspaceId: string; agentId: string; agent: AgentDetail }) {
  const base = `/api/workspaces/${workspaceId}/agents/${agentId}/privilege`
  const [mode, setMode] = useState<'standard' | 'root'>(agent.bridge_privilege ?? 'standard')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Consent modal state
  const [consent, setConsent] = useState<{ termsText?: string; needsConfirm?: boolean; sharedCount?: number } | null>(null)
  const [agreed, setAgreed] = useState(false)

  async function post(body: Record<string, unknown>): Promise<Response> {
    return fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function setStandard() {
    if (busy) return
    setBusy(true); setError(null)
    const r = await post({ mode: 'standard' })
    const d = await r.json().catch(() => null)
    setBusy(false)
    if (!r.ok || !d?.ok) { setError(d?.error || `Couldn't change privilege (${r.status}).`); return }
    setMode('standard')
  }

  async function setRoot() {
    if (busy) return
    setBusy(true); setError(null)
    const r = await post({ mode: 'root' })
    const d = await r.json().catch(() => null)
    setBusy(false)
    if (r.status === 409 && d) {
      // Needs terms acceptance and/or shared-box confirmation.
      setAgreed(false)
      setConsent({ termsText: d.termsText, needsConfirm: d.needsConfirm, sharedCount: d.sharedCount })
      return
    }
    if (!r.ok || !d?.ok) { setError(d?.error || `Couldn't switch to root (${r.status}).`); return }
    setMode('root')
  }

  async function confirmRoot() {
    if (busy || !consent) return
    setBusy(true); setError(null)
    const r = await post({ mode: 'root', accept_terms: true, confirm_shared: true })
    const d = await r.json().catch(() => null)
    setBusy(false)
    if (!r.ok || !d?.ok) { setError(d?.error || `Couldn't switch to root (${r.status}).`); return }
    setMode('root')
    setConsent(null)
  }

  return (
    <div className="border-t border-[var(--color-border)] pt-5">
      <div className="field-label mb-1">Privilege level</div>
      <p className="text-sm text-[var(--color-text-dim)] mb-3">
        Managed Pro agents run non-root by default (safer). You can grant this agent root on its box if it needs to
        install system packages or manage services. You can switch back any time.
      </p>

      <div className="inline-flex rounded border border-[var(--color-border)] overflow-hidden">
        <button
          type="button"
          disabled={busy || mode === 'standard'}
          onClick={() => void setStandard()}
          className={`px-4 py-2 text-sm transition ${mode === 'standard' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'} disabled:cursor-default`}
        >
          Standard
        </button>
        <button
          type="button"
          disabled={busy || mode === 'root'}
          onClick={() => void setRoot()}
          className={`px-4 py-2 text-sm transition border-l border-[var(--color-border)] ${mode === 'root' ? 'bg-[#e5484d] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'} disabled:cursor-default`}
        >
          Root
        </button>
      </div>
      <div className="text-[11px] mt-2 text-[var(--color-text-dim)]">
        Currently: <span className="text-[var(--color-text)]">{mode === 'root' ? 'Root (full control of the box)' : 'Standard (non-root)'}</span>
      </div>
      {error && <div className="text-xs text-[#e5484d] mt-2">{error}</div>}

      {consent && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4" onClick={() => !busy && setConsent(null)}>
          <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg max-w-lg w-full p-5 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-medium mb-3">Grant root access</h3>
            {consent.needsConfirm && (
              <div className="border border-[#e5484d]/40 bg-[#e5484d]/5 rounded px-3 py-2.5 text-sm mb-3">
                <div className="font-medium text-[#e5484d] mb-1">Shared box warning</div>
                <p className="text-[var(--color-text-dim)]">
                  This VPS hosts <span className="text-[var(--color-text)]">{consent.sharedCount}</span>{' '}
                  agent{consent.sharedCount === 1 ? '' : 's'}. Granting root to this agent gives it full control of the
                  whole box, including the other agent{consent.sharedCount === 1 ? '' : 's'} on it.
                </p>
              </div>
            )}
            {consent.termsText && (
              <div className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded px-3 py-2.5 text-sm text-[var(--color-text-dim)] whitespace-pre-wrap mb-3 max-h-60 overflow-y-auto">
                {consent.termsText}
              </div>
            )}
            <label className="flex items-start gap-2 text-sm mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={agreed}
                onChange={e => setAgreed(e.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>I understand and agree to grant root access to this agent.</span>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !agreed}
                onClick={() => void confirmRoot()}
                className="bg-[#e5484d] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Granting…' : 'Grant root'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConsent(null)}
                className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-2 py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AgentEdit({
  workspaceId,
  agentId,
  channels,
  onChanged,
  onDeleted,
}: {
  workspaceId: string
  agentId: string
  channels: Channel[]
  onChanged: () => void
  onDeleted: () => void
}) {
  const [agent, setAgent] = useState<AgentDetail | null>(null)
  const models = useModels()
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('')
  const [model, setModel] = useState('')
  const [soul, setSoul] = useState('')
  const [instructions, setInstructions] = useState('')
  const [memberChannels, setMemberChannels] = useState<Set<string>>(new Set())
  const [savingProfile, setSavingProfile] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [soulTab, setSoulTab] = useState<'edit' | 'preview'>('preview')
  // Second-level nav for the agent page: group sections into tabs so users
  // aren't scrolling a long page to reach skills / hosting / secrets.
  const [agentTab, setAgentTab] = useState<'profile' | 'skills' | 'hosting' | 'advanced'>('profile')
  const [entitled, setEntitled] = useState(true) // assume entitled until known, so comp'd/paid users never see a lock flash
  const [reRoling, setReRoling] = useState(false)
  const [roleOpen, setRoleOpen] = useState(false)
  const gutterRef = useRef<HTMLDivElement>(null)
  const versionsRef = useRef<HTMLDivElement>(null)

  function openVersionHistory() {
    setVersionsOpen(true)
    requestAnimationFrame(() => versionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const dirty =
    !!agent &&
    (name !== agent.name ||
      avatar !== (agent.avatar ?? '🤖') ||
      model !== agent.model ||
      soul !== agent.soul_md ||
      instructions !== agent.instructions)
  const nameDirty = !!agent && name !== agent.name
  const avatarDirty = !!agent && avatar !== (agent.avatar ?? '🤖')
  const modelDirty = !!agent && model !== agent.model
  const soulDirty = !!agent && soul !== agent.soul_md
  const instructionsDirty = !!agent && instructions !== agent.instructions

  async function loadVersions() {
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/versions`).then(r => r.json())
    setVersions(r.versions ?? [])
  }

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/agents/${agentId}`)
      .then(r => r.json())
      .then((r: { agent: AgentDetail }) => {
        setAgent(r.agent)
        setName(r.agent.name)
        setAvatar(r.agent.avatar ?? '🤖')
        setModel(r.agent.model)
        setSoul(r.agent.soul_md)
        setInstructions(r.agent.instructions ?? '')
        setMemberChannels(new Set(r.agent.channels.map(c => c.id)))
      })
    void loadVersions()
    setVersionsOpen(false)
    setExpandedVersion(null)
    setSoulTab('preview')
    setRoleOpen(false)
  }, [agentId, workspaceId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [b, m] = await Promise.all([
        fetch('/api/billing/status').then(r => r.json()).catch(() => null),
        fetch('/api/auth/me').then(r => r.json()).catch(() => null),
      ])
      if (!cancelled) setEntitled(!!b?.active || !!m?.user?.is_comp)
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty && !savingProfile) void saveProfile()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function saveProfile() {
    if (!agent) return
    setSavingProfile(true)
    setError(null)
    setSavedMsg(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, avatar, model, soul_md: soul, instructions }),
    }).then(r => r.json())
    setSavingProfile(false)
    if (!r.ok) { setError(r.error ?? 'Save failed'); return }
    setAgent(prev => (prev ? { ...prev, name, avatar, model, soul_md: soul, instructions } : prev))
    setSavedMsg('Saved')
    setTimeout(() => setSavedMsg(null), 2000)
    void loadVersions()
    onChanged()
  }

  async function startUpgrade() {
    const r = await fetch('/api/billing/checkout', { method: 'POST' }).then(r => r.json()).catch(() => null)
    if (r?.ok && r.url) window.location.href = r.url
    else setError(r?.error ?? 'Could not reach billing.')
  }

  async function reRole(template: AgentTemplate) {
    if (!agent || reRoling) return
    if (!confirm(`Change ${agent.name} into ${template.name}? This replaces the current name, avatar, and soul (the old soul is snapshotted as a version, so you can revert).`)) return
    setReRoling(true)
    setError(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: template.id }),
    }).then(r => r.json())
    setReRoling(false)
    if (!r.ok || !r.agent) { setError(r.error ?? 'Re-role failed'); return }
    setAgent(r.agent)
    setName(r.agent.name)
    setAvatar(r.agent.avatar ?? '🤖')
    setSoul(r.agent.soul_md)
    setRoleOpen(false)
    setSavedMsg(`Now a ${template.name}`)
    setTimeout(() => setSavedMsg(null), 2500)
    void loadVersions()
    onChanged()
  }

  function discardChanges() {
    if (!agent) return
    setName(agent.name)
    setAvatar(agent.avatar ?? '🤖')
    setModel(agent.model)
    setSoul(agent.soul_md)
    setInstructions(agent.instructions ?? '')
    setError(null)
  }

  async function restoreVersion(versionId: string) {
    if (!confirm('Restore this version? Your current SOUL will be replaced (and snapshotted, so you can re-revert).')) return
    const r = await fetch(
      `/api/workspaces/${workspaceId}/agents/${agentId}/versions/${versionId}/restore`,
      { method: 'POST' },
    ).then(r => r.json())
    if (!r.ok) return
    // Reload agent state and version list
    const detail = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}`).then(r => r.json())
    setAgent(detail.agent)
    setSoul(detail.agent.soul_md)
    void loadVersions()
    setSavedMsg('Restored')
    setTimeout(() => setSavedMsg(null), 2000)
    onChanged()
  }

  async function toggleChannel(channelId: string) {
    const isMember = memberChannels.has(channelId)
    const url = `/api/workspaces/${workspaceId}/channels/${channelId}/agents/${agentId}`
    await fetch(url, { method: isMember ? 'DELETE' : 'POST' })
    const next = new Set(memberChannels)
    if (isMember) next.delete(channelId); else next.add(channelId)
    setMemberChannels(next)
    onChanged()
  }

  async function deleteAgent() {
    if (!confirm(`Delete agent "${name}"? This cannot be undone.`)) return
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}`, { method: 'DELETE' }).then(r => r.json())
    if (r.ok) onDeleted()
  }

  if (!agent) return <div className="p-8 text-sm text-[var(--color-text-dim)]">Loading…</div>

  const isPro = agent.hosting === 'pro_droplet'
  const handle = agentHandle(name || agent.name)
  const soulLineCount = soul.length ? soul.split('\n').length : 1

  return (
    <div className="agent-edit-shell flex gap-8 p-8 items-start">
      <div className="flex-1 min-w-0 max-w-2xl space-y-6">
        <div className="agent-head flex items-start gap-4">
          <div className="avatar-ring flex-shrink-0">
            <AgentAvatar avatar={agent.avatar} size={52} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="name truncate">{name || agent.name}</span>
              {isPro && <span className="tier-badge">Pro</span>}
            </div>
            <div className="handle">{handle}</div>
            <div className="crumbs-row mt-2">
              <span>model {model}</span>
              <span className="dim">·</span>
              <span>hosting {agent.hosting}</span>
              <span className="dim">·</span>
              <span>rooms {memberChannels.size}</span>
              <span className="dim">·</span>
              <span>versions {versions.length}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-1 border-b border-[var(--color-border)]">
          {([['profile', 'Profile'], ['skills', 'Skills'], ['hosting', 'Hosting'], ['advanced', 'Advanced']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setAgentTab(id)}
              className={`px-3.5 py-2 text-sm font-medium border-b-2 -mb-px transition ${agentTab === id ? 'border-[var(--color-accent)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-dim)] hover:text-[var(--color-text)]'}`}
            >
              {label}{id === 'profile' && dirty && <span className="dirty-dot ml-1.5" />}
            </button>
          ))}
        </div>

        {agentTab === 'profile' && (<>
        <div>
          <div className="field-label">
            Name {nameDirty && <span className="dirty-dot" />}
          </div>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div>
          <div className="field-label">
            Model {modelDirty && <span className="dirty-dot" />}
          </div>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div>
          <div className="field-label">
            Soul {soulDirty && <span className="dirty-dot" />}
            <span className="hint">{entitled ? 'Every save creates a version snapshot' : 'Custom souls are a Standard feature'}</span>
          </div>
          {!entitled && (
            <div className="mb-2 flex items-center gap-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-dim)]">
              <span className="flex-1">Editing the soul directly needs Standard. On the free plan you can still switch roles above.</span>
              <button
                type="button"
                onClick={() => { void startUpgrade() }}
                className="bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90 whitespace-nowrap"
              >
                Upgrade
              </button>
            </div>
          )}
          <div className="soul-editor">
            <div className="soul-toolbar">
              <span className="file"><span className="dot" />{handle}.soul.md</span>
              <div className="ml-auto flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setSoulTab('edit')}
                  className={`tab ${soulTab === 'edit' ? 'active' : ''}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setSoulTab('preview')}
                  className={`tab ${soulTab === 'preview' ? 'active' : ''}`}
                >
                  Preview
                </button>
              </div>
            </div>
            {soulTab === 'edit' ? (
              <div className="soul-body">
                <div className="soul-gutter" ref={gutterRef}>
                  {Array.from({ length: soulLineCount }, (_, i) => (
                    <span key={i} className="line-num">{i + 1}</span>
                  ))}
                </div>
                <textarea
                  value={soul}
                  onChange={e => setSoul(e.target.value)}
                  onScroll={e => {
                    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
                  }}
                  spellCheck={false}
                  rows={18}
                  readOnly={!entitled}
                  className="soul-textarea"
                />
              </div>
            ) : (
              <div className="doc-page p-5 max-h-[480px] overflow-y-auto">
                {soul.trim()
                  ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{soul}</ReactMarkdown>
                  : <div className="text-sm text-[var(--color-text-dim)]">Nothing to preview yet.</div>}
              </div>
            )}
            <div className="soul-foot">
              <span>{soulLineCount} lines</span>
              <span className="dim">·</span>
              <span>{soul.length} chars</span>
              <span className="dim">·</span>
              <span>markdown</span>
            </div>
          </div>
          {entitled && (
            <p className="mt-2 text-xs text-[var(--color-text-dim)]">
              Every save is versioned —{' '}
              <button
                type="button"
                onClick={openVersionHistory}
                className="underline underline-offset-2 hover:text-[var(--color-text)]"
              >
                restore an earlier version
              </button>
              {versions.length > 0 && ` (${versions.length} saved)`}.
            </p>
          )}
        </div>

        <div>
          <div className="field-label">
            Instructions {instructionsDirty && <span className="dirty-dot" />}
            <span className="hint">Explicit directions this agent always follows — e.g. tone, formatting, do's and don'ts. Separate from its persona.</span>
          </div>
          <div className="soul-editor">
            <div className="soul-toolbar">
              <span className="file"><span className="dot" />{handle}.instructions.md</span>
            </div>
            <div className="soul-body soul-body--nogutter">
              <textarea
                value={instructions}
                onChange={e => setInstructions(e.target.value)}
                spellCheck={false}
                rows={10}
                readOnly={!entitled}
                className="soul-textarea"
                placeholder="e.g. Always reply in a concise, friendly tone. Use bullet points for lists. Never share internal config."
              />
            </div>
            <div className="soul-foot">
              <span>{instructions.length} chars</span>
              <span className="dim">·</span>
              <span>injected as # INSTRUCTIONS</span>
            </div>
          </div>
        </div>

        <div>
          <div className="field-label">
            Avatar {avatarDirty && <span className="dirty-dot" />}
          </div>
          <AvatarPicker
            value={avatar}
            onChange={setAvatar}
            onUploadFile={async (file) => {
              const r = await fetch(
                `/api/workspaces/${workspaceId}/agents/${agentId}/avatar`,
                { method: 'POST', headers: { 'Content-Type': file.type }, body: file },
              ).then(r => r.json())
              if (!r.ok) throw new Error('upload failed')
              return r.avatar as string
            }}
          />
        </div>

        <div>
          <button
            type="button"
            onClick={() => setRoleOpen(o => !o)}
            className="field-label w-full flex items-center cursor-pointer hover:text-[var(--color-text)] transition"
          >
            Change role
            <span className="hint">Re-cast this agent as a different archetype</span>
            <span className="ml-auto text-xs text-[var(--color-text-dim)]">{roleOpen ? '▾' : '▸'}</span>
          </button>
          {roleOpen && (
            <div className="mt-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {AGENT_TEMPLATES.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => reRole(t)}
                    disabled={reRoling}
                    title={t.blurb}
                    className="text-left p-2 border rounded text-xs border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50"
                  >
                    <div className="flex items-center gap-1.5">
                      <AgentAvatar avatar={t.avatar_path} size={18} />
                      <span className="font-medium truncate">{t.name}</span>
                    </div>
                    <div className="text-[10px] text-[var(--color-text-dim)] mt-1 line-clamp-2">
                      {t.blurb}
                    </div>
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-[var(--color-text-dim)] mt-2">
                {reRoling ? 'Re-roling…' : 'Picking a role replaces name, avatar, and soul. Available on every plan.'}
              </div>
            </div>
          )}
        </div>

        {error && <div className="text-sm text-red-400">{error}</div>}

        <div className={`save-bar ${dirty ? 'is-dirty' : ''}`}>
          <span className="state">
            <span className="dot" />
            {savedMsg ? savedMsg : dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <button
                type="button"
                onClick={discardChanges}
                className="text-xs px-3 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition"
              >
                Discard
              </button>
            )}
            <button
              onClick={saveProfile}
              disabled={savingProfile || !dirty}
              className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-40"
            >
              {savingProfile ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
        </>)}

        {agentTab === 'skills' && (<>
        <AgentSkills
          workspaceId={workspaceId}
          agentId={agentId}
          initialEnabled={agent.enabled_skills ?? []}
          onChanged={(next) => setAgent(prev => prev ? { ...prev, enabled_skills: next } : prev)}
        />

        <div className="border-t border-[var(--color-border)] pt-5">
          <div className="field-label mb-3">Rooms</div>
          {channels.length === 0 ? (
            <div className="text-xs text-[var(--color-text-dim)]">No rooms yet.</div>
          ) : (
            <div className="chip-row">
              {channels.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleChannel(c.id)}
                  className={`chip ${memberChannels.has(c.id) ? 'selected' : ''}`}
                >
                  <span className="hash">#</span>{c.name}
                </button>
              ))}
            </div>
          )}
        </div>
        </>)}

        {agentTab === 'hosting' && (<>
        <AgentHosting workspaceId={workspaceId} agent={agent} onChanged={() => { onChanged(); void (async () => { const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}`).then(r => r.json()); setAgent(r.agent) })() }} />

        <AgentCapabilities hosting={agent.hosting || 'standard'} />

        {isPro && <AgentDomain workspaceId={workspaceId} agentId={agentId} agent={agent} />}
        {isPro && <AgentPrivilege workspaceId={workspaceId} agentId={agentId} agent={agent} />}
        </>)}

        {agentTab === 'advanced' && (<>
        <AgentSafety workspaceId={workspaceId} agentId={agentId} initial={agent.safety_profile} />
        <AgentSecrets workspaceId={workspaceId} agentId={agentId} />

        <div ref={versionsRef} className="border-t border-[var(--color-border)] pt-5">
          <button
            type="button"
            onClick={() => setVersionsOpen(o => !o)}
            className="field-label hover:text-[var(--color-text)]"
          >
            <span>{versionsOpen ? '▾' : '▸'}</span>
            Version history ({versions.length})
          </button>
          {versionsOpen && (
            <div className="mt-4">
              {versions.length === 0 ? (
                <div className="text-xs text-[var(--color-text-dim)]">No versions yet.</div>
              ) : versions.map((v, i) => {
                const isCurrent = i === 0
                const expanded = expandedVersion === v.id
                return (
                  <div key={v.id} className={`version ${isCurrent ? 'current' : ''}`}>
                    <span className="node" />
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => setExpandedVersion(expanded ? null : v.id)}
                        className="text-left"
                      >
                        <span className="ts">{new Date(v.saved_at).toLocaleString()}</span>
                        <span className="who">{v.saved_by_name ?? 'unknown'}</span>
                        {isCurrent && <span className="current-tag ml-2">current</span>}
                      </button>
                      {expanded && (
                        <div className="version-diff">{v.soul_md || '(empty)'}</div>
                      )}
                    </div>
                    {!isCurrent && (
                      <button
                        type="button"
                        onClick={() => restoreVersion(v.id)}
                        className="restore"
                      >
                        restore
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <MoveAgent
          workspaceId={workspaceId}
          agentId={agentId}
          agentName={name || agent.name}
        />

        <div className="danger-zone">
          <div className="field-label" style={{ color: '#e5484d' }}>Danger zone</div>
          <p className="text-sm text-[var(--color-text-dim)] mb-3">
            Permanently delete this agent, its SOUL, and its version history. This cannot be undone.
          </p>
          <button type="button" onClick={deleteAgent} className="danger-btn">
            Delete agent
          </button>
        </div>
        </>)}
      </div>

      <aside className="agent-preview w-72 flex-shrink-0 sticky top-8">
        <div className="pv-label">Live preview</div>
        <div className="prev-msg">
          <span className="prev-avatar">
            <AgentAvatar avatar={avatar} size={36} />
            {isPro && <ProDot size={12} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="prev-head">
              <span className="prev-name">{name || agent.name}</span>
              <span className="prev-handle">@{handle}</span>
              <span className="prev-time">just now</span>
            </div>
            <p className="prev-body">
              Hey — I'm {name || agent.name}. Tell me what you're working on and I'll jump
              in. I can read and write your workspace docs, pull live results from the web,
              and keep our thread in context. Where should we start?
            </p>
            <div className="prev-foot">turn 1.4s · ✓ delivered</div>
          </div>
        </div>
      </aside>
    </div>
  )
}

// ---------- Capability disclosure ----------

function AgentCapabilities({ hosting }: { hosting: string }) {
  const isPro = hosting === 'pro_droplet'
  // Self-host has no Pro tier, so drop the "A Pro server adds" upsell below.
  const standalone = useStandalone()
  const standardCaps = [
    'Read & write workspace documents',
    'Search the web (live results, with citations)',
    'Fetch a specific page',
    'Room-scoped conversation memory',
  ]
  const proCaps = [
    'Shell access on a Pro server — the agent runs commands, not you',
    'Build and run web applications',
    'Scheduled tasks via cron',
    'Browser automation (operate live web apps on your behalf)',
    'Integrations (Gmail, Calendar, Discord, and more as we add them)',
    '24/7 background operation — keeps working when this tab is closed',
  ]
  return (
    <div className="border-t border-[var(--color-border)] pt-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-3">
        Capabilities
      </div>
      <div className="space-y-1.5 text-sm">
        {standardCaps.map(c => (
          <div key={c} className="flex items-center gap-2">
            <span className="text-[var(--color-accent)]">✓</span>
            <span>{c}</span>
          </div>
        ))}
        {isPro && proCaps.map(c => (
          <div key={c} className="flex items-center gap-2">
            <span className="text-[var(--color-accent)]">✓</span>
            <span>{c}</span>
          </div>
        ))}
      </div>
      {!isPro && standalone !== true && (
        <div className="mt-4 pt-3 border-t border-[var(--color-border)]/60 opacity-60">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">
            A Pro server adds
          </div>
          <div className="space-y-1.5 text-sm text-[var(--color-text-dim)]">
            {proCaps.map(c => (
              <div key={c} className="flex items-center gap-2">
                <span>○</span>
                <span>{c}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-[var(--color-text-dim)]">
            Pro is a server, not an agent — one Pro server runs up to 3 agents at one flat price, and add a fourth and you add a second server. Provisioned in seconds with one click in Hosting above, no technical skills required. You don't open a terminal; the agent does.
          </div>
        </div>
      )}
    </div>
  )
}

function ResetButton({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function go() {
    if (!confirm('Reset your workspace? Everything will be wiped and any Pro servers destroyed. You\'ll start over fresh.')) return
    if (!confirm('Really? This is irreversible.')) return
    setBusy(true)
    setErr(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    }).then(r => r.json())
    if (!r.ok) {
      setBusy(false)
      setErr(r.error ?? 'Reset failed')
      return
    }
    // Page reload so the client picks up the new workspace cleanly.
    window.location.reload()
  }
  return (
    <div>
      <button
        onClick={go}
        disabled={busy}
        className="inline-block border border-red-500/40 hover:border-red-400 hover:bg-red-500/10 text-red-400 text-sm px-4 py-2 rounded transition disabled:opacity-50"
      >
        {busy ? 'Resetting…' : 'Reset workspace'}
      </button>
      {err && <div className="text-xs text-red-400 mt-2">{err}</div>}
    </div>
  )
}

// Owner-only, irreversible workspace deletion. Type-the-name confirm because it
// also destroys Pro droplets and wipes everything. Hidden for non-owners; the
// backend enforces owner-only + the "can't delete your last workspace" guard.
function DeleteWorkspaceButton({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [isLast, setIsLast] = useState(false)
  const [wsName, setWsName] = useState('')
  useEffect(() => {
    fetch('/api/workspaces').then(r => r.json()).then(d => {
      const list: Array<{ id: string; name: string; role: string }> = d.workspaces ?? []
      const me = list.find(w => w.id === workspaceId)
      setIsOwner(me?.role === 'owner')
      setWsName(me?.name ?? '')
      setIsLast(list.filter(w => w.role === 'owner').length <= 1)
    }).catch(() => {})
  }, [workspaceId])

  if (!isOwner) return null

  async function go() {
    if (isLast) return
    const typed = window.prompt(
      `This permanently deletes "${wsName}" — all rooms, messages, documents, agents, and any Pro servers. It cannot be undone.\n\nType the workspace name to confirm:`,
    )
    if (typed == null) return
    if (typed.trim() !== wsName.trim()) { setErr('Name didn’t match — nothing was deleted.'); return }
    setBusy(true); setErr(null)
    const r = await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'network error' }))
    if (!r.ok) { setBusy(false); setErr(r.error ?? 'Delete failed'); return }
    window.location.reload()
  }

  return (
    <div>
      <button
        onClick={go}
        disabled={busy || isLast}
        className="inline-block border border-red-500/40 hover:border-red-400 hover:bg-red-500/10 text-red-400 text-sm px-4 py-2 rounded transition disabled:opacity-50"
      >
        {busy ? 'Deleting…' : 'Delete workspace'}
      </button>
      {isLast && <div className="text-xs text-[var(--color-text-dim)] mt-2">You can’t delete your only workspace.</div>}
      {err && <div className="text-xs text-red-400 mt-2">{err}</div>}
    </div>
  )
}

// ---------- Claude subscription OAuth (Pro tier) ----------

function ClaudeOauthPanel({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const standalone = useStandalone()
  const [status, setStatus] = useState<{ online: boolean; auth_mode?: string; error?: string } | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showInstructions, setShowInstructions] = useState(false)

  async function refresh() {
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/claude-oauth/status`).then(r => r.json())
    setStatus(r)
  }
  useEffect(() => { void refresh() }, [workspaceId, agentId])

  async function connect() {
    if (!token.trim()) return
    setBusy(true); setFeedback(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/claude-oauth/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
    }).then(r => r.json())
    setBusy(false)
    if (r.ok) {
      setFeedback({ kind: 'ok', text: 'Connected. Bridge restarting…' })
      setToken('')
      setTimeout(() => void refresh(), 4000)
    } else {
      setFeedback({ kind: 'err', text: r.error ?? 'connect failed' })
    }
  }

  async function disconnect() {
    if (!confirm(standalone ? 'Disconnect Claude subscription? The agent will fall back to the configured API key.' : 'Disconnect Claude subscription? The agent will fall back to the platform API key.')) return
    setBusy(true); setFeedback(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agentId}/claude-oauth/disconnect`, {
      method: 'POST',
    }).then(r => r.json())
    setBusy(false)
    if (r.ok) {
      setFeedback({ kind: 'ok', text: 'Disconnected. Bridge restarting…' })
      setTimeout(() => void refresh(), 4000)
    } else {
      setFeedback({ kind: 'err', text: r.error ?? 'disconnect failed' })
    }
  }

  const connected = status?.auth_mode === 'oauth'

  return (
    <div className="pt-3 border-t border-[var(--color-border)] space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-[var(--color-text)]">Claude subscription</div>
          <div className="text-xs text-[var(--color-text-dim)]">
            {connected
              ? 'LLM calls use your Claude Pro/Max subscription quota.'
              : (standalone
                  ? 'LLM calls use the API key configured for this server. Connect your Claude account to use your own Pro/Max subscription instead.'
                  : 'LLM calls use the platform API key. Connect your Claude account to use your own subscription instead.')}
          </div>
        </div>
        {connected ? (
          <span className="text-xs text-green-400 whitespace-nowrap">● Connected</span>
        ) : status?.online === false ? (
          <span className="text-xs text-[var(--color-text-dim)] whitespace-nowrap">— Bridge offline</span>
        ) : (
          <span className="text-xs text-[var(--color-text-dim)] whitespace-nowrap">Not connected</span>
        )}
      </div>
      {!connected && status?.online && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowInstructions(s => !s)}
            className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] underline"
          >
            {showInstructions ? 'Hide' : 'Show'} setup instructions
          </button>
          {showInstructions && (
            <ol className="text-xs text-[var(--color-text-dim)] list-decimal pl-5 space-y-1">
              <li>Install the Claude CLI locally: <code className="text-[var(--color-text)]">npm install -g @anthropic-ai/claude-code</code></li>
              <li>Generate a long-lived token: <code className="text-[var(--color-text)]">claude setup-token</code></li>
              <li>The CLI prints a token starting with <code>sk-ant-oat...</code>. Paste it below.</li>
            </ol>
          )}
          <div className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="sk-ant-oat-…"
              className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-[var(--color-accent)]"
            />
            <button
              onClick={connect}
              disabled={busy || !token.trim()}
              className="text-xs bg-[var(--color-accent)] text-white px-3 py-1 rounded disabled:opacity-40"
            >
              {busy ? '…' : 'Connect'}
            </button>
          </div>
        </div>
      )}
      {connected && (
        <button
          onClick={disconnect}
          disabled={busy}
          className="text-xs text-[var(--color-text-dim)] hover:text-red-400 disabled:opacity-50"
        >
          {busy ? '…' : 'Disconnect subscription'}
        </button>
      )}
      {feedback && (
        <div className={`text-xs ${feedback.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {feedback.text}
        </div>
      )}
    </div>
  )
}

// ---------- Per-agent hosting (Standard vs Pro) ----------

function CopyableCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={copy}
        className="absolute top-1.5 right-1.5 text-[11px] px-2 py-0.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <pre className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-2 pr-16 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap break-all">{code}</pre>
    </div>
  )
}

function AgentHosting({
  workspaceId,
  agent,
  onChanged,
}: {
  workspaceId: string
  agent: AgentDetail
  onChanged: () => void
}) {
  // Self-host: no Pro-tier VPS provisioning / hosting upgrades. Provisioning is
  // disabled server-side in standalone mode, so omit the whole hosting panel.
  const standalone = useStandalone()
  const [hosting, setHosting] = useState(agent.hosting || 'standard')
  const [url, setUrl] = useState(agent.external_url ?? '')
  const [privilege, setPrivilege] = useState<'standard' | 'root'>('standard')
  const [issuedToken, setIssuedToken] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [showProConfirm, setShowProConfirm] = useState(false)
  const [proProvider, setProProvider] = useState<'digitalocean' | 'hetzner'>('hetzner')
  const [me, setMe] = useState<{ is_comp?: boolean } | null>(null)
  const [dropletInfo, setDropletInfo] = useState<{
    id: number; ip: string | null; region: string; size: string; price_monthly: number; created_at: string; status: string
  } | null>(null)
  const [downgrading, setDowngrading] = useState(false)
  const [restarting, setRestarting] = useState(false)
  // Co-location: existing Pro servers in this workspace with a free agent slot.
  // Picking one adds this agent there as a sibling — no new VM, no extra charge.
  const [attachableServers, setAttachableServers] = useState<{
    id: string; provider: string; ip: string | null; agent_count: number; free_slots: number
  }[]>([])
  const [selectedProServerId, setSelectedProServerId] = useState<string | null>(null)

  const inboundUrl = window.location.origin + '/api/agent-webhook/messages'

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(d => setMe(d?.user ?? null))
  }, [])

  // Fetch attachable servers when this agent isn't already Pro, so the upgrade
  // panel can offer "add to an existing server" (free) alongside "new server".
  useEffect(() => {
    if (agent.hosting === 'pro_droplet') { setAttachableServers([]); return }
    fetch(`/api/workspaces/${workspaceId}/attachable-pro-servers`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setAttachableServers(d?.servers ?? []))
      .catch(() => {})
  }, [agent.hosting, workspaceId])

  // Fetch droplet info when this agent is Pro + online.
  useEffect(() => {
    if (agent.hosting === 'pro_droplet' && agent.status === 'online') {
      fetch(`/api/workspaces/${workspaceId}/agents/${agent.id}/pro-droplet`)
        .then(r => r.json())
        .then(r => setDropletInfo(r.droplet ?? null))
    } else {
      setDropletInfo(null)
    }
  }, [agent.id, agent.hosting, agent.status, workspaceId])

  // Auto-refresh on agents_updated broadcasts (provisioning/teardown finishes).
  useResilientWs('/ws', {
    onMessage: (payload) => {
      const p = payload as { type?: string; workspaceId?: string }
      if (p.type === 'agents_updated' && p.workspaceId === workspaceId) {
        onChanged()
      }
    },
  })

  async function upgradeToPro() {
    setShowProConfirm(false)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agent.id}/upgrade-pro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true, provider: proProvider, proServerId: selectedProServerId }),
    }).then(r => r.json())
    if (r.ok) {
      setSavedMsg(
        selectedProServerId
          ? 'Adding to your existing server…'
          : r.billing?.comp ? 'Provisioning your Pro server…' : 'Provisioning… (subscription mock)',
      )
      setTimeout(() => setSavedMsg(null), 4000)
      onChanged()
    } else {
      setSavedMsg(r.error ?? 'Upgrade failed')
    }
  }

  async function downgradeToStandard() {
    if (!confirm(`Downgrade ${agent.name} to Standard? Its dedicated server will be destroyed and any data on it will be lost.`)) return
    setDowngrading(true)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agent.id}/downgrade-pro`, {
      method: 'POST',
    }).then(r => r.json())
    setDowngrading(false)
    if (r.ok) {
      setSavedMsg('Downgraded to Standard — server destroyed')
      setTimeout(() => setSavedMsg(null), 3000)
      onChanged()
    } else {
      setSavedMsg(r.error ?? 'Downgrade failed')
    }
  }

  async function redeploy() {
    if (!confirm(`Redeploy ${agent.name}? The current server will be destroyed and a fresh one provisioned with the latest agent runtime. Conversation history is preserved; anything on the old server's filesystem is lost.`)) return
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agent.id}/redeploy-pro`, {
      method: 'POST',
    }).then(r => r.json())
    if (r.ok) {
      setSavedMsg('Redeploying — destroying current server, provisioning fresh one (~90s)')
      setTimeout(() => setSavedMsg(null), 5000)
      onChanged()
    } else {
      setSavedMsg(r.error ?? 'Redeploy failed')
    }
  }

  async function restart() {
    if (!confirm(`Restart ${agent.name}'s server? It will power-cycle and come back in ~60 seconds. The server, its IP, and its files are kept — only the running processes restart. Use this if the agent is unresponsive.`)) return
    setRestarting(true)
    setSavedMsg(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agent.id}/restart-pro`, {
      method: 'POST',
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'request failed' }))
    setRestarting(false)
    if (r.ok) {
      setSavedMsg('Restarting server — back online in ~60s')
      setTimeout(() => setSavedMsg(null), 5000)
      onChanged()
    } else {
      setSavedMsg(r.error ?? 'Restart failed')
    }
  }

  async function save() {
    setSaving(true)
    setSavedMsg(null)
    await fetch(`/api/workspaces/${workspaceId}/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosting, external_url: url }),
    })
    setSaving(false)
    setSavedMsg('Saved')
    setTimeout(() => setSavedMsg(null), 2000)
    onChanged()
  }

  async function generateToken() {
    if (!confirm('Generate a new token? The old one (if any) will stop working immediately.')) return
    const r = await fetch(`/api/workspaces/${workspaceId}/agents/${agent.id}/external/token`, {
      method: 'POST',
    }).then(r => r.json())
    if (r.ok) {
      setIssuedToken(r.token)
      onChanged()
    }
  }

  const isPro = agent.hosting === 'pro_droplet'
  // Attaching to an existing server (vs. provisioning a new VM) carries no extra
  // charge — the server is already paid for and just has a free slot.
  const isAttach = selectedProServerId !== null

  const proAddon = hosting === 'external'
    ? { price: 10, label: 'your own server (BYOVPS)', byo: true }
    : proProvider === 'digitalocean'
      ? { price: 35, label: 'managed server (global regions)', byo: false }
      : { price: 25, label: 'managed server', byo: false }

  // Self-host: hide the Pro hosting/provisioning panel entirely (all agents run
  // in-process as Standard). Only an explicit true suppresses — undefined (still
  // loading) keeps the cloud default so nothing flashes on a slow probe.
  if (standalone === true) return null

  return (
    <div className="border-t border-[var(--color-border)] pt-5">
      <FormField label="Hosting">
        {isPro ? (
          <div className="border border-[var(--color-accent)] rounded p-3 bg-[var(--color-surface)] text-sm space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-accent)]">★ Pro</span>
              {agent.status === 'provisioning' && (
                <span className="text-xs text-[var(--color-text-dim)] inline-flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse" />
                  Provisioning dedicated server…
                </span>
              )}
              {agent.status === 'online' && (
                <span className="text-xs text-green-400">● Online</span>
              )}
              {agent.status === 'error' && (
                <span className="text-xs text-red-400">⚠ Provisioning failed</span>
              )}
              {agent.status === 'offline' && (
                <span className="text-xs text-[var(--color-text-dim)]">○ Offline</span>
              )}
            </div>
            {agent.status === 'provisioning' && (
              <p className="text-xs text-[var(--color-text-dim)]">
                Spinning up the agent's VPS (typically ~60–90 seconds). You can leave this page; the status updates live.
              </p>
            )}
            {agent.status === 'online' && dropletInfo && (
              <div className="text-xs text-[var(--color-text-dim)] space-y-0.5">
                <div>Server: <span className="font-mono text-[var(--color-text)]">{dropletInfo.ip ?? 'pending IP'}</span> · {dropletInfo.region.toUpperCase()} · {dropletInfo.size}</div>
                <div>Running since {new Date(dropletInfo.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · $25/mo</div>
              </div>
            )}
            <p className="text-xs text-[var(--color-text-dim)]">
              The agent has shell access on this server (bash, file system, scheduled tasks) plus the Standard tools. The server is provisioned and managed for you — you never SSH in.
            </p>
            {agent.status === 'online' && (
              <ClaudeOauthPanel workspaceId={workspaceId} agentId={agent.id} />
            )}
            {(agent.status === 'error' || agent.status === 'offline') && (
              <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-2">
                <p className="text-sm text-[var(--color-text)]">
                  {agent.status === 'error'
                    ? 'Provisioning ran into a problem.'
                    : 'Agent not responding?'}
                </p>
                <p className="text-xs text-[var(--color-text-dim)]">
                  A restart power-cycles the server in place — same server, IP, and files —
                  and is usually back in ~60s. If that doesn't help, redeploy provisions a
                  fresh server with the latest agent runtime (conversation history is kept).
                </p>
                <div className="flex items-center gap-2 flex-wrap pt-0.5">
                  <button
                    onClick={restart}
                    disabled={restarting}
                    className="text-sm bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90 disabled:opacity-50"
                    title="Power-cycle the VM in place — keeps the server, IP, and files"
                  >
                    {restarting ? 'Restarting…' : '⟳ Restart agent'}
                  </button>
                  <button
                    onClick={redeploy}
                    className="text-sm border border-[var(--color-border)] px-3 py-1.5 rounded hover:bg-[var(--color-hover-bg)] hover:border-[var(--color-text-dim)]"
                    title="Tear down + reprovision with the latest agent runtime"
                  >
                    ↻ Redeploy
                  </button>
                  <button
                    onClick={downgradeToStandard}
                    disabled={downgrading}
                    className="ml-auto text-xs text-[var(--color-text-dim)] hover:text-red-400 disabled:opacity-50"
                  >
                    {downgrading ? 'Destroying server…' : 'Downgrade to Standard'}
                  </button>
                </div>
              </div>
            )}
            {agent.status === 'online' && (
              <div className="pt-2 border-t border-[var(--color-border)] flex items-center gap-2 flex-wrap">
                <button
                  onClick={restart}
                  disabled={restarting}
                  className="text-sm border border-[var(--color-border)] px-3 py-1.5 rounded hover:bg-[var(--color-hover-bg)] hover:border-[var(--color-text-dim)] disabled:opacity-50"
                  title="Power-cycle the VM in place — keeps the server, IP, and files"
                >
                  {restarting ? 'Restarting…' : '⟳ Restart'}
                </button>
                <button
                  onClick={redeploy}
                  className="text-sm border border-[var(--color-border)] px-3 py-1.5 rounded hover:bg-[var(--color-hover-bg)] hover:border-[var(--color-text-dim)]"
                  title="Tear down + reprovision with the latest agent runtime"
                >
                  ↻ Redeploy
                </button>
                <button
                  onClick={downgradeToStandard}
                  disabled={downgrading}
                  className="ml-auto text-xs text-[var(--color-text-dim)] hover:text-red-400 disabled:opacity-50"
                  title="Destroys the dedicated server and moves this agent to shared infrastructure"
                >
                  {downgrading ? 'Destroying server…' : 'Downgrade to Standard'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)]">
              <div className="text-[var(--color-text)] mb-1">Standard <span className="text-xs text-[var(--color-text-dim)]">(current)</span></div>
              <p className="text-xs text-[var(--color-text-dim)]">
                Runs on shared Brigata infrastructure. Curated tool set: documents,
                web search, image gen. No shell access.
              </p>
            </div>

            <div className="border border-[var(--color-border)] rounded p-3">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[var(--color-text)]">★ Pro server</span>
                <span className="text-xs text-[var(--color-text-dim)]">
                  +$25/mo, flat
                </span>
              </div>
              <p className="text-xs text-[var(--color-text-dim)] mb-3">
                A dedicated, fully managed server that runs up to 3 of your agents at one flat price — add a fourth and you add a second server. Shell access, scheduled tasks, file system, integrations — the works. We provision and manage it; you never open a terminal. Ready in ~90 seconds.
              </p>

              {attachableServers.length > 0 && (
                <div className="mb-3 space-y-1.5 border border-[var(--color-border)] rounded p-2.5 bg-[var(--color-bg)]">
                  <div className="text-xs text-[var(--color-text-dim)]">
                    You already have room on a Pro server — add this agent there for <strong className="text-[var(--color-text)]">no extra charge</strong> (each server runs up to 3 agents):
                  </div>
                  {attachableServers.map(s => (
                    <label key={s.id} className="flex items-start gap-2 text-sm py-0.5 cursor-pointer">
                      <input
                        type="radio"
                        name={`pro-target-${agent.id}`}
                        checked={selectedProServerId === s.id}
                        onChange={() => setSelectedProServerId(s.id)}
                        className="mt-0.5 accent-[var(--color-accent)]"
                      />
                      <span>
                        Existing server <span className="font-mono text-xs">{s.ip ?? '(provisioning)'}</span> — {s.free_slots} of 3 slot{s.free_slots === 1 ? '' : 's'} free · <strong className="text-green-400">no extra charge</strong>
                      </span>
                    </label>
                  ))}
                  <label className="flex items-start gap-2 text-sm py-0.5 cursor-pointer">
                    <input
                      type="radio"
                      name={`pro-target-${agent.id}`}
                      checked={selectedProServerId === null}
                      onChange={() => setSelectedProServerId(null)}
                      className="mt-0.5 accent-[var(--color-accent)]"
                    />
                    <span>New dedicated server — <strong>+$25/mo</strong></span>
                  </label>
                </div>
              )}

              <button
                onClick={() => setShowProConfirm(true)}
                className="text-sm bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90"
              >
                {isAttach ? 'Add to existing server' : 'Add a Pro server'}
              </button>

              <details className="mt-4 pt-3 border-t border-[var(--color-border)]">
                <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-text-dim)]">
                  Hosting — Advanced
                </summary>
                <p className="text-xs text-[var(--color-text-dim)] mt-3 mb-2">
                  Pick where this Pro server lives. Our managed server is the default and recommended; you can also choose global-region hosting or bring your own server.
                </p>
                <label className="flex items-start gap-2 text-sm py-1">
                  <input
                    type="radio"
                    name={`host-mode-${agent.id}`}
                    checked={hosting !== 'external' && proProvider === 'hetzner'}
                    onChange={() => { setProProvider('hetzner'); setHosting('standard') }}
                    className="mt-0.5 accent-[var(--color-accent)]"
                  />
                  <span><strong>Managed server</strong> — <strong>+$25/mo, flat</strong>. Recommended. <span className="text-xs text-[var(--color-text-dim)]">(default; 3 vCPU / 4 GB; EU &amp; US regions)</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm py-1">
                  <input
                    type="radio"
                    name={`host-mode-${agent.id}`}
                    checked={hosting === 'external'}
                    onChange={() => setHosting('external')}
                    className="mt-0.5 accent-[var(--color-accent)]"
                  />
                  <span>Bring your own server (<strong>BYOVPS</strong>) — <strong>+$10/mo</strong>. You stay the operator; no uptime SLA. <span className="text-xs text-[var(--color-text-dim)]">(any cloud; Contabo, Linode, OVH, a Pi, etc.)</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm py-1">
                  <input
                    type="radio"
                    name={`host-mode-${agent.id}`}
                    checked={hosting !== 'external' && proProvider === 'digitalocean'}
                    onChange={() => { setProProvider('digitalocean'); setHosting('standard') }}
                    className="mt-0.5 accent-[var(--color-accent)]"
                  />
                  <span><strong>Managed server — global regions</strong> — <strong>+$35/mo</strong>. <span className="text-xs text-[var(--color-text-dim)]">(2 vCPU / 4 GB; 13 regions worldwide — for hosting outside the EU/US)</span></span>
                </label>
              </details>
            </div>
          </div>
        )}
      </FormField>

      {showProConfirm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={() => setShowProConfirm(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-medium mb-3">{isAttach ? 'Add to existing server' : 'Add a Pro server'}</h3>
            <div className="text-sm space-y-2 mb-4">
              {isAttach ? (
                <p>You're adding <strong>{agent.name}</strong> to a Pro server you already run.</p>
              ) : (
                <p>You're moving <strong>{agent.name}</strong> onto a Pro server ({proAddon.label}).</p>
              )}
              <ul className="text-xs text-[var(--color-text-dim)] list-disc pl-5 space-y-1">
                {isAttach
                  ? <li>The agent joins your existing server — no new server, no extra charge</li>
                  : <li>A dedicated server is provisioned — it runs up to 3 of your agents</li>}
                <li>Agents on it get the full tool surface (shell, files, system admin)</li>
                <li>{isAttach ? 'Ready in about 60 seconds' : 'Provisioning takes about 60 seconds'}</li>
                {!isAttach && proAddon.byo && <li>You stay the operator of your server; no uptime SLA</li>}
              </ul>
              <div className="mt-3 border-t border-[var(--color-border)] pt-3">
                {isAttach ? (
                  <div className="text-green-400 text-sm">
                    No additional charge — this server is already part of your subscription.
                  </div>
                ) : me?.is_comp ? (
                  <div className="text-[var(--color-accent)] text-sm">
                    Your account is comped — no charge.
                  </div>
                ) : (
                  <div>
                    <div className="text-base text-[var(--color-text)]">+${proAddon.price}/mo, flat</div>
                    <div className="text-xs text-[var(--color-text-dim)]">
                      A separate Brigata charge on top of your $15 Standard seat, per server (runs up to 3 agents). Cancel anytime — downgrading destroys the server immediately. (Billing isn't connected yet — this is a preview confirmation.)
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowProConfirm(false)}
                className="text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={upgradeToPro}
                className="text-sm bg-[var(--color-accent)] text-white px-4 py-1.5 rounded hover:opacity-90"
              >
                {isAttach ? 'Add to server' : me?.is_comp ? 'Upgrade (comp)' : 'Confirm subscription'}
              </button>
            </div>
          </div>
        </div>
      )}

      {hosting === 'external' && !isPro && (
        <>
          <FormField label="Your server's URL">
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="http://203.0.113.42:4040"
              className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
            />
            <div className="text-xs text-[var(--color-text-dim)] mt-1">
              Paste the URL the install script printed when it finished —{' '}
              looks like <code className="font-mono">http://&lt;your-vps-ip&gt;:4040</code>.
              You can also find it by SSH'ing into your server and running{' '}
              <code className="font-mono">curl ifconfig.me</code>.
            </div>
          </FormField>

          <div className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)] text-sm space-y-2">
            <div className="font-medium">Bearer token</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Used for auth in both directions. Your server posts replies to{' '}
              <code className="font-mono">{inboundUrl}</code> with{' '}
              <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>.
            </div>
            {issuedToken ? (
              <div className="space-y-2">
                <CopyableCode code={issuedToken} />
                <div className="text-xs text-[var(--color-accent)]">
                  Copy this now — it won't be shown again. Store it on the server side.
                </div>
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-dim)]">
                {agent.external_token ? 'A token is set. Generating a new one will invalidate the existing one.' : 'No token yet.'}
              </div>
            )}
            <button
              type="button"
              onClick={generateToken}
              className="text-sm bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90"
            >
              {agent.external_token ? 'Rotate token' : 'Generate token'}
            </button>
          </div>

          <div className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)] text-sm space-y-2">
              <div className="font-medium">Install command</div>
              <div className="text-xs text-[var(--color-text-dim)]">
                Run this on a fresh Ubuntu 24.04 VPS (Hetzner, DigitalOcean,
                Linode, anywhere) as root. It installs Node.js, downloads the
                bridge, configures systemd + firewall, and starts the service.
                Takes ~60-90 seconds.
              </div>
              {!issuedToken && (
                <div className="text-xs text-[var(--color-accent)]">
                  Substitute your bridge token into <code>BRIDGE_TOKEN=</code> below.
                  If you saved it when you first generated it, reuse that one —
                  only click “Rotate token” if you’ve lost it (rotating
                  invalidates the old token and breaks an already-running bridge).
                </div>
              )}
              <div className="border border-[var(--color-border)] rounded p-2 bg-[var(--color-bg)] space-y-2 mt-2">
                <div className="text-xs font-medium text-[var(--color-text)]">Agent privilege on your server</div>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`privilege-${agent.id}`}
                    className="mt-0.5"
                    checked={privilege === 'standard'}
                    onChange={() => setPrivilege('standard')}
                  />
                  <span className="text-xs text-[var(--color-text-dim)]">
                    <span className="font-medium text-[var(--color-text)]">Standard (recommended)</span> — runs
                    as a dedicated non-root user. It can install packages and work in its own directory, but
                    can't read every file on the box or damage the system. To let it work on an existing
                    project, grant that folder to it (the installer prints how).
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`privilege-${agent.id}`}
                    className="mt-0.5"
                    checked={privilege === 'root'}
                    onChange={() => setPrivilege('root')}
                  />
                  <span className="text-xs text-[var(--color-text-dim)]">
                    <span className="font-medium text-[var(--color-text)]">Root (full access)</span> — runs as
                    root with unrestricted access to the whole server. Choose this only if you want the agent to
                    touch anything without per-folder grants — note a malicious instruction it reads would also
                    run as root.
                  </span>
                </label>
              </div>
              <div className="text-xs text-[var(--color-text)] mt-2">Pick ONE auth method:</div>
              <div className="text-xs text-[var(--color-text-dim)] mt-1 mb-1">
                <strong>Option A — Claude subscription (recommended)</strong>:
                runs on your Claude Pro/Max plan, no extra charges. Run{' '}
                <code>claude setup-token</code> on any machine with the Claude
                CLI; it'll print an <code>sk-ant-oat-...</code> token.
              </div>
              <CopyableCode code={`curl -fsSL https://studio.example.com/install.sh | \\
  BRIDGE_TOKEN=${issuedToken ?? '<your-bridge-token>'} \\
  BRIDGE_AGENT_NAME=${JSON.stringify(agent.name)} \\
  BRIDGE_PRIVILEGE=${privilege} \\
  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-... \\
  bash`} />
              <div className="text-xs text-[var(--color-text-dim)] mt-3 mb-1">
                <strong>Option B — Anthropic API key</strong>: bills against
                your Anthropic console credit. Generate one at{' '}
                <code>console.anthropic.com</code>; format is{' '}
                <code>sk-ant-api03-...</code>.
              </div>
              <CopyableCode code={`curl -fsSL https://studio.example.com/install.sh | \\
  BRIDGE_TOKEN=${issuedToken ?? '<your-bridge-token>'} \\
  BRIDGE_AGENT_NAME=${JSON.stringify(agent.name)} \\
  BRIDGE_PRIVILEGE=${privilege} \\
  ANTHROPIC_API_KEY=sk-ant-api03-... \\
  bash`} />
              <div className="text-xs text-[var(--color-text-dim)] mt-2">
                The installer auto-detects which kind of token you pasted (by
                the <code>sk-ant-oat-</code> vs <code>sk-ant-api03-</code>{' '}
                prefix), so swapping the variable name accidentally is fine.
              </div>
              <div className="text-xs text-[var(--color-text-dim)]">
                When the script finishes, it prints your webhook URL —{' '}
                <code>http://&lt;your-vps-ip&gt;:4040</code>. Paste that into{' '}
                "Bridge webhook URL" above and click "Save self-host config".
              </div>
            </div>
        </>
      )}

      {hosting === 'external' && !isPro && (
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={save}
            disabled={saving}
            className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save self-host config'}
          </button>
          {savedMsg && <span className="text-xs text-green-400">{savedMsg}</span>}
        </div>
      )}
      {savedMsg && hosting !== 'external' && (
        <div className="mt-3 text-xs text-green-400">{savedMsg}</div>
      )}
    </div>
  )
}

// ---------- Discord integration ----------

type DiscordIntegrationRow = {
  id: string
  type: 'discord'
  status: string
  config: {
    has_token: boolean
    application_id?: string
    bot_username?: string
    mappings: Array<{
      workspace_channel_id: string
      discord_channel_id: string
      discord_guild_id?: string
    }>
  }
}

type DiscordChannel = {
  guild_id: string
  guild_name: string
  channel_id: string
  channel_name: string
}

interface GitHubStatus {
  app_configured: boolean
  connected: boolean
  installation_id: number | null
  account_login: string | null
  repo_full_name: string | null
  branch: string | null
  base_path: string
  last_sync_at: string | null
  last_sync_status: 'ok' | 'error' | 'syncing' | null
  last_error: string | null
}

function GitHubIntegration({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<GitHubStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [repos, setRepos] = useState<Array<{ full_name: string; default_branch: string; private: boolean }>>([])
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [basePath, setBasePath] = useState('brigata-docs')
  const [editingRepo, setEditingRepo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function load() {
    setLoading(true)
    const [s, me] = await Promise.all([
      fetch(`/api/github/${workspaceId}`).then(r => r.json()).catch(() => null),
      fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
    setIsAdmin(!!me?.user?.is_admin)
    if (s?.ok) {
      setStatus(s)
      setRepo(s.repo_full_name ?? '')
      setBranch(s.branch ?? 'main')
      setBasePath(s.base_path ?? 'brigata-docs')
      setEditingRepo(s.connected && !s.repo_full_name)
    }
    setLoading(false)
  }
  useEffect(() => { void load() }, [workspaceId])

  // When connected but no repo chosen yet, load the repo list for the picker.
  useEffect(() => {
    if (status?.connected && (editingRepo || !status.repo_full_name)) {
      fetch(`/api/github/${workspaceId}/repos`).then(r => r.json()).then(r => {
        if (r?.ok) setRepos(r.repos)
      }).catch(() => {})
    }
  }, [status?.connected, editingRepo, status?.repo_full_name, workspaceId])

  async function setupApp() {
    const r = await fetch('/api/github/app/manifest').then(r => r.json()).catch(() => null)
    if (!r?.ok) { setMsg({ kind: 'err', text: r?.error || 'Could not start App setup' }); return }
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = r.action_url
    const input = document.createElement('input')
    input.type = 'hidden'; input.name = 'manifest'; input.value = JSON.stringify(r.manifest)
    form.appendChild(input)
    document.body.appendChild(form)
    form.submit()
  }

  async function saveRepo() {
    setBusy(true); setMsg(null)
    const r = await fetch(`/api/github/${workspaceId}/configure`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_full_name: repo, branch, base_path: basePath }),
    }).then(r => r.json()).catch(() => null)
    setBusy(false)
    if (r?.ok) {
      setMsg({ kind: 'ok', text: `Synced — pushed ${r.summary.pushed}, pulled ${r.summary.pulled}.` })
      setEditingRepo(false); void load()
    } else {
      setMsg({ kind: 'err', text: r?.summary?.error || r?.error || 'Configure failed' })
    }
  }

  async function syncNow() {
    setBusy(true); setMsg(null)
    const r = await fetch(`/api/github/${workspaceId}/sync`, { method: 'POST' }).then(r => r.json()).catch(() => null)
    setBusy(false)
    if (r?.ok) { setMsg({ kind: 'ok', text: `Synced — pushed ${r.summary.pushed}, pulled ${r.summary.pulled}.` }); void load() }
    else setMsg({ kind: 'err', text: r?.summary?.error || 'Sync failed' })
  }

  async function disconnect() {
    if (!confirm('Disconnect GitHub doc sync? Your repo files stay; the link is removed.')) return
    setBusy(true)
    await fetch(`/api/github/${workspaceId}`, { method: 'DELETE' })
    setBusy(false); setMsg(null); void load()
  }

  if (loading) return <div className="max-w-2xl p-8 text-sm text-[var(--color-text-dim)]">Loading…</div>

  const inputCls = 'w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]'
  const btnCls = 'bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50'

  return (
    <div className="max-w-2xl p-8 space-y-5">
      <div>
        <h2 className="text-xl font-medium">GitHub doc sync</h2>
        <p className="text-sm text-[var(--color-text-dim)] mt-1">
          Keep this workspace's documents in sync with a GitHub repo as plain Markdown — edit in Brigata
          or in Obsidian, Logseq, or any editor over Git, and changes flow both ways.
        </p>
      </div>
      {msg && <div className={`text-sm ${msg.kind === 'ok' ? 'text-emerald-500' : 'text-red-400'}`}>{msg.text}</div>}

      {!status?.app_configured ? (
        isAdmin ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-text-dim)]">
              One-time setup: create the Brigata GitHub App. GitHub hands the credentials straight back —
              nothing to copy by hand.
            </p>
            <button type="button" onClick={setupApp} className={btnCls}>Set up GitHub App</button>
          </div>
        ) : (
          <p className="text-sm text-[var(--color-text-dim)]">
            GitHub doc sync isn't set up for this platform yet. Ask an admin to create the GitHub App first.
          </p>
        )
      ) : !status.connected ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-text-dim)]">
            Connect the repo you want to sync. You choose exactly which repositories Brigata can access.
          </p>
          <a href={`/api/github/${workspaceId}/install`} className={`inline-block ${btnCls}`}>Connect a repository</a>
        </div>
      ) : (editingRepo || !status.repo_full_name) ? (
        <div className="space-y-4">
          <FormField label="Repository">
            <select value={repo} onChange={e => {
              setRepo(e.target.value)
              const m = repos.find(x => x.full_name === e.target.value)
              if (m) setBranch(m.default_branch)
            }} className={inputCls}>
              <option value="">Select a repository…</option>
              {repos.map(r => <option key={r.full_name} value={r.full_name}>{r.full_name}{r.private ? ' (private)' : ''}</option>)}
            </select>
            {status.account_login && repos.length === 0 && (
              <p className="mt-1 text-xs text-[var(--color-text-dim)]">No repositories granted. Adjust the App's repo access on GitHub, then reload.</p>
            )}
          </FormField>
          <FormField label="Branch">
            <input value={branch} onChange={e => setBranch(e.target.value)} className={inputCls} placeholder="main" />
          </FormField>
          <FormField label="Folder in repo">
            <input value={basePath} onChange={e => setBasePath(e.target.value)} className={`${inputCls} font-mono`} placeholder="brigata-docs" />
          </FormField>
          <div className="flex gap-2">
            <button type="button" disabled={busy || !repo} onClick={saveRepo} className={btnCls}>{busy ? 'Syncing…' : 'Save & sync'}</button>
            {status.repo_full_name && <button type="button" onClick={() => setEditingRepo(false)} className="px-4 py-2 rounded text-sm border border-[var(--color-border)]">Cancel</button>}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm space-y-1">
            <div><span className="text-[var(--color-text-dim)]">Repo:</span> <span className="font-mono">{status.repo_full_name}</span></div>
            <div><span className="text-[var(--color-text-dim)]">Branch:</span> <span className="font-mono">{status.branch}</span> · <span className="text-[var(--color-text-dim)]">Folder:</span> <span className="font-mono">{status.base_path}</span></div>
            <div>
              <span className="text-[var(--color-text-dim)]">Status:</span>{' '}
              {status.last_sync_status === 'error'
                ? <span className="text-red-400">error — {status.last_error}</span>
                : status.last_sync_at
                  ? <span className="text-emerald-500">synced {new Date(status.last_sync_at).toLocaleString()}</span>
                  : <span className="text-[var(--color-text-dim)]">not synced yet</span>}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={syncNow} className={btnCls}>{busy ? 'Syncing…' : 'Sync now'}</button>
            <button type="button" onClick={() => setEditingRepo(true)} className="px-4 py-2 rounded text-sm border border-[var(--color-border)]">Change repo</button>
            <button type="button" disabled={busy} onClick={disconnect} className="px-4 py-2 rounded text-sm border border-[var(--color-border)] text-red-400">Disconnect</button>
          </div>
        </div>
      )}
    </div>
  )
}

function DiscordIntegration({
  workspaceId,
  channels,
}: {
  workspaceId: string
  channels: Channel[]
}) {
  const [integration, setIntegration] = useState<DiscordIntegrationRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discordChannels, setDiscordChannels] = useState<DiscordChannel[]>([])

  async function loadIntegration() {
    setLoading(true)
    const r = await fetch(`/api/workspaces/${workspaceId}/integrations`).then(r => r.json())
    const discord = (r.integrations ?? []).find(
      (i: DiscordIntegrationRow) => i.type === 'discord',
    ) as DiscordIntegrationRow | undefined
    setIntegration(discord ?? null)
    setLoading(false)
    if (discord?.config?.has_token) {
      const ch = await fetch(
        `/api/workspaces/${workspaceId}/integrations/${discord.id}/discord-channels`,
      ).then(r => r.json())
      setDiscordChannels(ch.channels ?? [])
    } else {
      setDiscordChannels([])
    }
  }
  useEffect(() => { void loadIntegration() }, [workspaceId])

  async function connectBot(e: React.FormEvent) {
    e.preventDefault()
    if (!token.trim()) return
    setSubmitting(true)
    setError(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/integrations/discord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_token: token.trim() }),
    }).then(r => r.json())
    setSubmitting(false)
    if (!r.ok) { setError(r.error ?? 'Failed to connect'); return }
    setToken('')
    void loadIntegration()
  }

  async function saveMappings(newMappings: DiscordIntegrationRow['config']['mappings']) {
    if (!integration) return
    await fetch(
      `/api/workspaces/${workspaceId}/integrations/${integration.id}/mappings`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: newMappings }),
      },
    )
    void loadIntegration()
  }

  async function disconnect() {
    if (!integration) return
    if (!confirm('Disconnect Discord? Bridged channels will stop mirroring.')) return
    await fetch(
      `/api/workspaces/${workspaceId}/integrations/${integration.id}`,
      { method: 'DELETE' },
    )
    void loadIntegration()
  }

  if (loading) return <div className="p-8 text-sm text-[var(--color-text-dim)]">Loading…</div>

  if (!integration || !integration.config.has_token) {
    return (
      <form onSubmit={connectBot} className="max-w-2xl p-8 space-y-5">
        <h2 className="text-xl font-medium">Connect Discord</h2>
        <p className="text-sm text-[var(--color-text-dim)]">
          Mirror messages between this workspace and a Discord server. To set up:
        </p>
        <ol className="text-sm text-[var(--color-text-dim)] list-decimal pl-5 space-y-1">
          <li>Create a Discord application at <a className="text-[var(--color-accent)] underline" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">discord.com/developers/applications</a></li>
          <li>Add a Bot user, copy the bot token</li>
          <li>Enable the <strong>Message Content</strong> privileged intent on the bot</li>
          <li>Invite the bot to your Discord server (Settings → Installation → "Install Link")</li>
          <li>Paste the bot token below and pick which channels to bridge</li>
        </ol>
        <FormField label="Bot token">
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="e.g. MTAxxx..."
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
          />
        </FormField>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <button
          type="submit"
          disabled={submitting || !token.trim()}
          className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    )
  }

  const mappings = integration.config.mappings ?? []

  function setMapping(workspaceChannelId: string, discordChannelId: string | '') {
    let next = mappings.filter(m => m.workspace_channel_id !== workspaceChannelId)
    if (discordChannelId) {
      const channel = discordChannels.find(c => c.channel_id === discordChannelId)
      next = [
        ...next,
        {
          workspace_channel_id: workspaceChannelId,
          discord_channel_id: discordChannelId,
          discord_guild_id: channel?.guild_id,
        },
      ]
    }
    void saveMappings(next)
  }

  return (
    <div className="max-w-2xl p-8 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-medium">Discord</h2>
        <button
          onClick={disconnect}
          className="text-sm text-red-400 hover:text-red-300"
        >
          Disconnect
        </button>
      </div>
      <div className="text-sm text-[var(--color-text-dim)]">
        Connected as <span className="text-[var(--color-text)]">{integration.config.bot_username ?? 'bot'}</span>
        {' '}({integration.config.application_id ?? '—'})
        {' '}· Status: <span className="text-[var(--color-text)]">{integration.status}</span>
      </div>

      <div className="border-t border-[var(--color-border)] pt-5">
        <FormField label="Channel mappings">
          {discordChannels.length === 0 ? (
            <div className="text-xs text-[var(--color-text-dim)]">
              The bot isn't in any Discord servers yet. Invite it to your server, then refresh this page.
            </div>
          ) : (
            <div className="space-y-2">
              {channels.map(c => {
                const current = mappings.find(m => m.workspace_channel_id === c.id)
                return (
                  <div key={c.id} className="flex items-center gap-3 text-sm">
                    <div className="w-32 truncate text-[var(--color-text-dim)]">
                      <IconChannel /> {c.name}
                    </div>
                    <span className="text-[var(--color-text-dim)]">↔</span>
                    <select
                      value={current?.discord_channel_id ?? ''}
                      onChange={e => setMapping(c.id, e.target.value)}
                      className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                    >
                      <option value="">— not bridged —</option>
                      {discordChannels.map(d => (
                        <option key={d.channel_id} value={d.channel_id}>
                          {d.guild_name} / #{d.channel_name}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>
          )}
        </FormField>
      </div>

      <div className="border-t border-[var(--color-border)] pt-5">
        <FormField label="Replace bot token">
          <form onSubmit={connectBot} className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="paste a new bot token to replace"
              className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              disabled={submitting || !token.trim()}
              className="bg-[var(--color-accent)] text-white px-3 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? '…' : 'Replace'}
            </button>
          </form>
          {error && <div className="text-xs text-red-400 mt-1">{error}</div>}
        </FormField>
      </div>
    </div>
  )
}

// ---------- Usage (return on tokens) ----------

type UsageAgg = {
  turns: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens: number
  total_cost_usd: number
}
type UsageReport = {
  ok: boolean
  window_days: number
  totals: UsageAgg
  by_model: (UsageAgg & { model: string })[]
  by_agent: (UsageAgg & { agent_id: string | null; agent_name: string })[]
  daily: (UsageAgg & { day: string })[]
}

const fmtInt = (n: number) => n.toLocaleString('en-US')
const fmtCost = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtTokens = (n: number) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M'
    : n >= 1_000 ? (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K'
      : String(n)

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] p-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-dim)]">{label}</div>
      <div className="text-lg font-medium mt-0.5">{value}</div>
    </div>
  )
}

function UsageTable({
  title,
  caption,
  rows,
  total,
}: {
  title: string
  caption?: string
  rows: { key: string; label: string; total_tokens: number; total_cost_usd: number; turns: number }[]
  total: number
}) {
  if (rows.length === 0) return null
  return (
    <div className="mb-6">
      <div className="text-sm font-medium">{title}</div>
      {caption ? <div className="text-xs text-[var(--color-text-dim)] mb-2">{caption}</div> : <div className="mb-2" />}
      <div className="space-y-1.5">
        {rows.map(r => (
          <div key={r.key} className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm truncate">{r.label}</span>
              <span className="text-sm text-[var(--color-text-dim)] tabular-nums whitespace-nowrap">
                {fmtTokens(r.total_tokens)} tok · {fmtCost(r.total_cost_usd)}
              </span>
            </div>
            <div className="mt-1.5 h-1 rounded bg-[var(--color-border)] overflow-hidden">
              <div className="h-full bg-[var(--color-accent)]" style={{ width: `${total > 0 ? (r.total_tokens / total) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function UsagePanel({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/workspaces/${workspaceId}/usage?days=${days}`)
      .then(r => r.json())
      .then(r => {
        if (cancelled) return
        if (!r.ok) { setError('Could not load usage.'); setData(null) }
        else setData(r as UsageReport)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) { setError('Could not load usage.'); setLoading(false) } })
    return () => { cancelled = true }
  }, [workspaceId, days])

  const maxDaily = data && data.daily.length ? Math.max(1, ...data.daily.map(d => d.total_tokens)) : 1

  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <h1 className="text-lg font-medium">Usage</h1>
      <p className="text-sm text-[var(--color-text-dim)] mt-1 mb-1">
        Token consumption across your agents — see which models and which agents are spending your tokens.
      </p>
      <p className="text-xs text-[var(--color-text-dim)] mb-5">
        Token counts are exact. Cost is an estimate from standard API pricing; if your agents run on a Claude
        subscription, the marginal cost is covered by your plan. Standard-tier turns only — Pro agents aren’t metered here yet.
      </p>

      <div className="flex gap-1.5 mb-5">
        {[7, 30, 90].map(d => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={`px-3 py-1 rounded-md text-xs border transition ${days === d ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]'}`}
          >
            {d}d
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : error ? (
        <div className="text-sm text-red-400">{error}</div>
      ) : !data || data.totals.turns === 0 ? (
        <div className="text-sm text-[var(--color-text-dim)] border border-[var(--color-border)] rounded-lg p-4">
          No usage recorded in the last {days} days yet. Once your agents reply, their token consumption shows up here.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-6">
            <StatCard label="Total tokens" value={fmtTokens(data.totals.total_tokens)} />
            <StatCard label="Est. cost" value={fmtCost(data.totals.total_cost_usd)} />
            <StatCard label="Agent turns" value={fmtInt(data.totals.turns)} />
          </div>

          <UsageTable
            title="By model"
            caption="Watch for a heavy model doing light work."
            rows={data.by_model.map(m => ({ key: m.model, label: m.model, ...m }))}
            total={data.totals.total_tokens}
          />

          <UsageTable
            title="By agent"
            rows={data.by_agent.map(a => ({ key: a.agent_id ?? 'none', label: a.agent_name, ...a }))}
            total={data.totals.total_tokens}
          />

          {data.daily.length > 1 && (
            <div className="mt-2">
              <div className="text-sm font-medium mb-2">Daily tokens</div>
              <div className="flex items-end gap-1 h-24 border-b border-[var(--color-border)]">
                {data.daily.map(d => (
                  <div
                    key={d.day}
                    className="flex-1 bg-[var(--color-accent)] rounded-t opacity-80"
                    style={{ height: `${Math.max(2, (d.total_tokens / maxDaily) * 100)}%` }}
                    title={`${d.day}: ${fmtInt(d.total_tokens)} tokens · ${fmtCost(d.total_cost_usd)}`}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------- Matrix integration ----------

type MatrixIntegrationRow = {
  id: string
  type: 'matrix'
  status: string
  config: {
    has_token: boolean
    homeserver_url?: string
    bot_user_id?: string
    mappings: Array<{
      workspace_channel_id: string
      matrix_room_id: string
    }>
  }
}

type MatrixRoom = {
  room_id: string
  name: string
}

const PUBLIC_HOMESERVERS = new Set([
  'matrix.org',
  'matrix-client.matrix.org',
  'mozilla.org',
  'kde.org',
  'tchncs.de',
  'envs.net',
])
function isPublicHomeserverInput(url: string): boolean {
  const v = url.trim()
  if (!v) return false
  let host: string
  try {
    host = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).hostname
      .toLowerCase()
      .replace(/^www\./, '')
  } catch {
    return false
  }
  return PUBLIC_HOMESERVERS.has(host)
}

function MatrixIntegration({
  workspaceId,
  channels,
}: {
  workspaceId: string
  channels: Channel[]
}) {
  const [integration, setIntegration] = useState<MatrixIntegrationRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [homeserver, setHomeserver] = useState('')
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rooms, setRooms] = useState<MatrixRoom[]>([])

  async function loadIntegration() {
    setLoading(true)
    const r = await fetch(`/api/workspaces/${workspaceId}/integrations`).then(r => r.json())
    const matrix = (r.integrations ?? []).find(
      (i: MatrixIntegrationRow) => i.type === 'matrix',
    ) as MatrixIntegrationRow | undefined
    setIntegration(matrix ?? null)
    setLoading(false)
    if (matrix?.config?.homeserver_url) setHomeserver(matrix.config.homeserver_url)
    if (matrix?.config?.has_token) {
      const rr = await fetch(
        `/api/workspaces/${workspaceId}/integrations/${matrix.id}/matrix-rooms`,
      ).then(r => r.json())
      setRooms(rr.rooms ?? [])
    } else {
      setRooms([])
    }
  }
  useEffect(() => { void loadIntegration() }, [workspaceId])

  async function connectBot(e: React.FormEvent) {
    e.preventDefault()
    if (!homeserver.trim() || !token.trim()) return
    if (isPublicHomeserverInput(homeserver)) {
      setError('Brigata requires your own Matrix homeserver — public homeservers block bot accounts.')
      return
    }
    setSubmitting(true)
    setError(null)
    const r = await fetch(`/api/workspaces/${workspaceId}/integrations/matrix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeserver_url: homeserver.trim(), access_token: token.trim() }),
    }).then(r => r.json())
    setSubmitting(false)
    if (!r.ok) { setError(r.error ?? 'Failed to connect'); return }
    setToken('')
    void loadIntegration()
  }

  async function saveMappings(newMappings: MatrixIntegrationRow['config']['mappings']) {
    if (!integration) return
    await fetch(
      `/api/workspaces/${workspaceId}/integrations/${integration.id}/mappings`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: newMappings }),
      },
    )
    void loadIntegration()
  }

  async function disconnect() {
    if (!integration) return
    if (!confirm('Disconnect Matrix? Bridged channels will stop mirroring.')) return
    await fetch(
      `/api/workspaces/${workspaceId}/integrations/${integration.id}`,
      { method: 'DELETE' },
    )
    void loadIntegration()
  }

  if (loading) return <div className="p-8 text-sm text-[var(--color-text-dim)]">Loading…</div>

  if (!integration || !integration.config.has_token) {
    return (
      <form onSubmit={connectBot} className="max-w-2xl p-8 space-y-5">
        <h2 className="text-xl font-medium">Connect Matrix</h2>
        <p className="text-sm text-[var(--color-text-dim)]">
          Mirror messages between this workspace and a room on{' '}
          <strong>your own Matrix homeserver</strong>. Public homeservers like
          matrix.org block or rate-limit bot accounts, so Brigata requires a
          homeserver you control. To set up:
        </p>
        <ol className="text-sm text-[var(--color-text-dim)] list-decimal pl-5 space-y-1">
          <li>Run your own homeserver — <a className="text-[var(--color-accent)] underline" href="https://github.com/element-hq/synapse" target="_blank" rel="noreferrer">Synapse</a>, <a className="text-[var(--color-accent)] underline" href="https://conduit.rs" target="_blank" rel="noreferrer">Conduit</a>, or <a className="text-[var(--color-accent)] underline" href="https://github.com/element-hq/dendrite" target="_blank" rel="noreferrer">Dendrite</a> are common choices</li>
          <li>Create a Matrix account on it for your bot and copy that account's access token</li>
          <li>Invite the bot account to the room you want to bridge — it auto-joins</li>
          <li>Paste your homeserver URL + access token below, then pick which channels to bridge</li>
        </ol>
        <p className="text-xs text-[var(--color-text-dim)]">
          Note: v1 bridges <strong>unencrypted</strong> rooms only — turn off encryption on the room you test with. (On your own homeserver the messages never leave infrastructure you control, so this is a much smaller concern.)
        </p>
        <FormField label="Homeserver URL">
          <input
            type="text"
            value={homeserver}
            onChange={e => setHomeserver(e.target.value)}
            placeholder="https://matrix.your-domain.com"
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
          />
          {isPublicHomeserverInput(homeserver) && (
            <p className="mt-1 text-xs text-amber-500">
              That looks like a public homeserver. Brigata requires your own — bot accounts get throttled or banned on shared public servers.
            </p>
          )}
        </FormField>
        <FormField label="Access token">
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="e.g. syt_xxx..."
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
          />
        </FormField>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <button
          type="submit"
          disabled={submitting || !homeserver.trim() || !token.trim() || isPublicHomeserverInput(homeserver)}
          className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    )
  }

  const mappings = integration.config.mappings ?? []

  function setMapping(workspaceChannelId: string, matrixRoomId: string | '') {
    let next = mappings.filter(m => m.workspace_channel_id !== workspaceChannelId)
    if (matrixRoomId) {
      next = [
        ...next,
        {
          workspace_channel_id: workspaceChannelId,
          matrix_room_id: matrixRoomId,
        },
      ]
    }
    void saveMappings(next)
  }

  return (
    <div className="max-w-2xl p-8 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-medium">Matrix</h2>
        <button
          onClick={disconnect}
          className="text-sm text-red-400 hover:text-red-300"
        >
          Disconnect
        </button>
      </div>
      <div className="text-sm text-[var(--color-text-dim)]">
        Connected as <span className="text-[var(--color-text)]">{integration.config.bot_user_id ?? 'bot'}</span>
        {' '}· <span className="text-[var(--color-text)]">{integration.config.homeserver_url ?? '—'}</span>
        {' '}· Status: <span className="text-[var(--color-text)]">{integration.status}</span>
      </div>

      <div className="border-t border-[var(--color-border)] pt-5">
        <FormField label="Channel mappings">
          {rooms.length === 0 ? (
            <div className="text-xs text-[var(--color-text-dim)]">
              The bot isn't in any Matrix rooms yet. Invite it to a room, then refresh this page.
            </div>
          ) : (
            <div className="space-y-2">
              {channels.map(c => {
                const current = mappings.find(m => m.workspace_channel_id === c.id)
                return (
                  <div key={c.id} className="flex items-center gap-3 text-sm">
                    <div className="w-32 truncate text-[var(--color-text-dim)]">
                      <IconChannel /> {c.name}
                    </div>
                    <span className="text-[var(--color-text-dim)]">↔</span>
                    <select
                      value={current?.matrix_room_id ?? ''}
                      onChange={e => setMapping(c.id, e.target.value)}
                      className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                    >
                      <option value="">— not bridged —</option>
                      {rooms.map(rm => (
                        <option key={rm.room_id} value={rm.room_id}>
                          {rm.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>
          )}
        </FormField>
      </div>

      <div className="border-t border-[var(--color-border)] pt-5">
        <FormField label="Replace access token">
          <form onSubmit={connectBot} className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="paste a new access token to replace"
              className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              disabled={submitting || !token.trim()}
              className="bg-[var(--color-accent)] text-white px-3 py-2 rounded text-sm hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? '…' : 'Replace'}
            </button>
          </form>
          {error && <div className="text-xs text-red-400 mt-1">{error}</div>}
        </FormField>
      </div>
    </div>
  )
}
