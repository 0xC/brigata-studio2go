import { useEffect, useState, type ReactNode } from 'react'
import { IconChannel } from './lib/icons'
import { AgentAvatar } from './lib/avatar'

type Subscriber = {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  last_seen_at: string | null
  created_at: string
  workspace_count: number
  agent_count: number
  pro_agent_count: number
  message_count: number
  abuse_count: number
  is_comp: boolean
  tier: 'standard' | 'pro'
  monthly_cost_usd: number
  billing_status: 'comp' | 'mock-paid' | 'free'
}

type Allowed = { email: string; added_at: string; note: string | null; added_by_email: string | null }

type Status = {
  ok: boolean
  db: string
  counts: Record<string, number>
  last24h: { signups: number; messages: number }
  db_size: string
  server_time: string
  uptime_seconds: number
  memory_mb: number
}

type UserDetail = {
  user: Subscriber
  workspaces: { id: string; name: string; plan: string; created_at: string }[]
  agents: {
    id: string; name: string; avatar: string | null; model: string;
    hosting: string; status: string; workspace_name: string;
    droplet: { name: string; ip: string | null; region: string; size: string } | null;
    bridge_privilege: string | null; abuse_flags: string | null;
    bridge_load_per_core: number | null; bridge_mem_pct: number | null;
    bridge_egress_bps: number | null; bridge_metrics_at: string | null;
    abuse_event_count: number;
  }[]
  activity: { channel_name: string; count: string; last_at: string }[]
  abuse_events: { agent_id: string; signal: string; detail: string | null; created_at: string }[]
}

type AuditRow = {
  id: string
  action: string
  target: string | null
  payload: Record<string, unknown> | null
  created_at: string
  admin_email: string | null
}

type HealthLevel = 'ok' | 'warn' | 'critical'

type Health = {
  level: HealthLevel
  headline: string
  generated_at: string
  uptime_seconds: number
  memory: { total_mb: number; available_mb: number; used_pct: number; process_rss_mb: number; level: HealthLevel; peak_pct: number }
  swap: { total_mb: number; used_mb: number; level: HealthLevel; peak_pct: number }
  disk: { total_gb: number; free_gb: number; used_pct: number; level: HealthLevel; peak_pct: number }
  cpu: { cores: number; load1: number; load5: number; load15: number; load_per_core: number; level: HealthLevel; peak_pct: number }
  event_loop: { mean_ms: number; p99_ms: number; level: HealthLevel; peak_pct: number }
  turns: { current: number; peak: number }
  db: { online: boolean; size: string | null }
}

type Tab = 'health' | 'subscribers' | 'allowlist' | 'audit' | 'architecture'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function Admin({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('health')

  return (
    <div className="fixed inset-0 z-50 bg-[var(--color-bg)]">
      <div className="h-12 border-b border-[var(--color-border)] flex items-center px-4 gap-4 bg-[var(--color-surface)]">
        <span className="font-medium">Admin</span>
        {(['health', 'subscribers', 'allowlist', 'audit', 'architecture'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-3 py-1 rounded ${tab === t ? 'bg-[var(--color-active-bg)] text-[var(--color-text)]' : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'}`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={onClose} className="text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)]">
          ← back to studio
        </button>
      </div>
      <div className="h-[calc(100%-3rem)] overflow-y-auto p-6">
        {tab === 'health' && <HealthTab />}
        {tab === 'subscribers' && <Subscribers />}
        {tab === 'allowlist' && <Allowlist />}
        {tab === 'audit' && <Audit />}
        {tab === 'architecture' && <ArchitectureTab />}
      </div>
    </div>
  )
}

// Living architecture + security reference. Admin-only. Hand-maintained prose —
// it documents posture the code can't self-describe (threat model, known gaps,
// subscriber-facing answers). Update the "Last reviewed" date when you revise it.
// Deliberately contains NO real IPs/tokens/hostnames: this bundle is downloadable
// by anyone even though the tab is admin-gated, so secrets stay server-side.
function Sev({ level }: { level: 'ok' | 'low' | 'med' | 'high' }) {
  const map = {
    ok: 'bg-green-500/15 text-green-400',
    low: 'bg-green-500/15 text-green-400',
    med: 'bg-amber-500/15 text-amber-400',
    high: 'bg-red-500/15 text-red-400',
  } as const
  return <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${map[level]}`}>{level}</span>
}

function ArchCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-[var(--color-border)] rounded-md bg-[var(--color-surface)] p-4">
      <h3 className="text-sm font-semibold mb-3 text-[var(--color-text)]">{title}</h3>
      <div className="text-sm text-[var(--color-text-dim)] space-y-2 leading-relaxed">{children}</div>
    </section>
  )
}

function ArchitectureTab() {
  const th = 'text-left px-3 py-2 font-medium text-[var(--color-text-dim)]'
  const td = 'px-3 py-2 align-top border-t border-[var(--color-border)]'
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h2 className="text-lg font-medium">Architecture &amp; Security</h2>
        <p className="text-xs text-[var(--color-text-dim)] mt-1">
          Living reference for how Brigata is wired and where the security boundaries are. Last reviewed 2026-06-19.
        </p>
      </div>

      <ArchCard title="System map">
        <ul className="list-disc pl-5 space-y-1">
          <li><b className="text-[var(--color-text)]">Edge:</b> Cloudflare fronts the web app + API (TLS terminates at the edge; origin behind it).</li>
          <li><b className="text-[var(--color-text)]">Shared backend (one VPS):</b> Node/Express API, the Postgres database, the React app served as static files, and <b className="text-[var(--color-text)]">all Standard-tier agents running in-process</b>. This box is the blast-radius center — see Tenant isolation.</li>
          <li><b className="text-[var(--color-text)]">Pro agent VMs:</b> one cloud VM per Pro agent (DigitalOcean / Hetzner managed, or a subscriber's own VPS via the install script). Each runs the <b className="text-[var(--color-text)]">bridge</b> and talks back to the shared backend.</li>
          <li><b className="text-[var(--color-text)]">Channel connectors:</b> Discord, Matrix, and GitHub link a workspace to outside services. Their credentials are held by the backend (encrypted at rest), never on a Pro VM or in the browser — see External integrations.</li>
          <li><b className="text-[var(--color-text)]">Off-box durability:</b> the database, attachments, and an <b className="text-[var(--color-text)]">encrypted</b> copy of the backend <code>.env</code> are backed up to object storage; the host is snapshotted nightly.</li>
        </ul>
      </ArchCard>

      <ArchCard title="Where agents run">
        <table className="w-full text-sm">
          <thead><tr><th className={th}>Tier</th><th className={th}>Runs on</th><th className={th}>Credential</th><th className={th}>Isolation</th></tr></thead>
          <tbody>
            <tr>
              <td className={td}><b className="text-[var(--color-text)]">Standard</b></td>
              <td className={td}>In-process on the shared backend (a per-turn SDK subprocess).</td>
              <td className={td}>Workspace owner's own Anthropic token (BYO). Admin/comp accounts fall back to the operator's token.</td>
              <td className={td}>Logical only (shared OS/process). See gaps.</td>
            </tr>
            <tr>
              <td className={td}><b className="text-[var(--color-text)]">Pro</b></td>
              <td className={td}>Dedicated cloud VM running the bridge.</td>
              <td className={td}>Managed: the workspace owner's own Claude credential, baked at provision (admin/comp fall back to the operator token). BYOVPS: the subscriber's own key/OAuth token.</td>
              <td className={td}>Full OS/VM isolation per agent. Bridge runs as a non-root service user.</td>
            </tr>
            <tr>
              <td className={td}><b className="text-[var(--color-text)]">Demo / onboarding</b></td>
              <td className={td}>In-process on the shared backend (tokenless trial turns + the pre-auth idea engine).</td>
              <td className={td}>A <b className="text-[var(--color-text)]">separate, platform-funded</b> Anthropic key, Haiku only. Hard-capped (trial: 8 messages / 60k tokens per user; idea engine: per-IP rate limit, no input persisted).</td>
              <td className={td}>Same shared-process model as Standard; bounded spend, then a connect-your-own-Claude wall.</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs">The platform's own credential is used <b className="text-[var(--color-text)]">only</b> on this last row, and only within the caps above. Every other agent turn runs on the workspace owner's own key.</p>
      </ArchCard>

      <ArchCard title="Network & firewall — is the bridge firewalled?">
        <p>Yes, in every scenario. The bridge's control port (4040) is locked to the Studio's IP by host firewall (ufw): default-deny inbound, then a single allow rule for the Studio IP. This is true for <b className="text-[var(--color-text)]">both</b> managed droplets and the BYOVPS install script — the install script applies the same ufw rules.</p>
        <table className="w-full text-sm mt-2">
          <thead><tr><th className={th}>Port</th><th className={th}>Exposure</th><th className={th}>Why</th></tr></thead>
          <tbody>
            <tr><td className={td}>4040 (bridge)</td><td className={td}>Studio IP only</td><td className={td}>Only the backend dispatches turns to it.</td></tr>
            <tr><td className={td}>80 / 443</td><td className={td}>Open to internet</td><td className={td}>Agent-published sites are meant to be public.</td></tr>
            <tr><td className={td}>22 (SSH)</td><td className={td}>Open to internet</td><td className={td}>Standard sshd; key-based on managed VMs. Hardening candidate.</td></tr>
          </tbody>
        </table>
        <p className="mt-2"><b className="text-[var(--color-text)]">Updated 2026-06-14:</b> managed Pro bridges now serve HTTPS with a self-signed cert that the Studio generates at provision time and <b className="text-[var(--color-text)]">pins on every call</b> (no trust-on-first-use). The whole managed fleet has been re-provisioned onto this, so the bridge token no longer rides the wire in cleartext. Self-hosted BYOVPS bridges set up before this change may still be plain HTTP until re-provisioned; the firewall lock to the Studio IP still applies in all cases.</p>
      </ArchCard>

      <ArchCard title="Auth & secrets">
        <ul className="list-disc pl-5 space-y-1">
          <li>Users: session cookies; admin routes gated server-side (<code>requireAdmin</code>). This whole tab is admin-only.</li>
          <li>Bridge: every request needs a 32-byte random bearer token, compared in constant time; mismatches get 401.</li>
          <li>Platform secrets (DB URL, cloud API tokens, Stripe, platform Anthropic keys) live only in the backend's <code>.env</code> — never in this frontend bundle.</li>
          <li>Connector credentials (Discord/Matrix/GitHub) are stored <b className="text-[var(--color-text)]">encrypted at rest</b> (AES-256-GCM, key from <code>INTEGRATION_SECRET_KEY</code>) and stripped from any config sent to the browser — the client only ever sees a "has token" flag.</li>
          <li>SQL is parameterized throughout; tenant-scoped tools filter by workspace id. Admin and agent actions are written to a commit-style audit log.</li>
        </ul>
      </ArchCard>

      <ArchCard title="External integrations (connectors)">
        <p>Connecting a channel hands Brigata an outside credential. All of them live encrypted on the backend and are never exposed to a Pro VM or the browser.</p>
        <table className="w-full text-sm mt-2">
          <thead><tr><th className={th}>Connector</th><th className={th}>What we hold</th><th className={th}>Notes</th></tr></thead>
          <tbody>
            <tr><td className={td}>Discord</td><td className={td}>Bot token (encrypted).</td><td className={td}>Validated against Discord before it's stored.</td></tr>
            <tr><td className={td}>Matrix</td><td className={td}>Homeserver URL + access token (encrypted).</td><td className={td}>End-to-end-encrypted rooms supported: per-integration crypto keys + sync state persist on the backend disk. If crypto storage fails to init, it falls back to non-E2EE rather than dropping the connection.</td></tr>
            <tr><td className={td}>GitHub</td><td className={td}>A GitHub <b className="text-[var(--color-text)]">App</b>: client secret, signing key, webhook secret (all encrypted).</td><td className={td}>Calls use short-lived, installation-scoped tokens minted on demand — not a long-lived PAT. Repo access is limited to what the install grants.</td></tr>
          </tbody>
        </table>
      </ArchCard>

      <ArchCard title="Tenant isolation (the one that matters most)">
        <p>Standard agents share one OS, one Node process, one filesystem, and one set of env secrets. There is <b className="text-[var(--color-text)]">no OS-level wall between tenants</b>. What keeps workspace A out of workspace B is two software guarantees:</p>
        <ul className="list-disc pl-5 space-y-1 mt-1">
          <li>The agent's tool surface is an <b className="text-[var(--color-text)]">allowlist</b> — docs/web + workspace-scoped DB tools. No shell, no host filesystem, no arbitrary network tools.</li>
          <li>Every tool handler filters by the caller's workspace id.</li>
          <li><b className="text-[var(--color-text)]">Added 2026-06-14:</b> a fail-closed workspace-scope assertion backstops the per-handler filter — a tool call that can't prove its workspace scope is rejected rather than allowed.</li>
        </ul>
        <p className="mt-1">Implication: a bug that widened the tool surface (e.g. exposing shell) or dropped a workspace filter would be platform-wide, not single-tenant. The scope guard reduces that risk but does <b className="text-[var(--color-text)]">not</b> replace OS-level isolation. Pro agents don't share this risk — they're on their own VM. Treat the Standard tool allowlist as security-critical code.</p>
      </ArchCard>

      <ArchCard title="Known gaps / hardening backlog">
        <table className="w-full text-sm">
          <thead><tr><th className={th}>Gap</th><th className={th}></th></tr></thead>
          <tbody>
            <tr><td className={td}>Standard tenancy is logical, not OS-isolated — a bug that widened the tool allowlist or dropped a workspace filter would be platform-wide, not single-tenant. A fail-closed workspace-scope guard backstops this, but real OS-level isolation is still absent. The top open item.</td><td className={td}><Sev level="high" /></td></tr>
            <tr><td className={td}>Managed provisioning still embeds the bridge bearer token in cloud-init user_data, readable from the VM's metadata endpoint by anything on the box. The per-agent Anthropic credential it also writes is now the workspace owner's own rotatable token, not the platform key — so a compromised box no longer leaks a platform-wide secret.</td><td className={td}><Sev level="med" /></td></tr>
            <tr><td className={td}>Pre-auth LLM endpoints (the onboarding idea engine; tokenless demo turns) spend the platform's own credit before a user signs in. Bounded by a separate Haiku-only key, hard message/token caps, and per-IP rate limiting — but it remains an abuse/cost surface to watch.</td><td className={td}><Sev level="low" /></td></tr>
            <tr><td className={td}>BYOVPS bridges set up before the HTTPS change may still run plain HTTP until re-provisioned. The firewall lock to the Studio IP applies regardless, so the token never rides an open network.</td><td className={td}><Sev level="low" /></td></tr>
            <tr><td className={td}>OOM on the shared backend would drop all Standard tenants at once (availability, not confidentiality). Cushioned by swap plus a Standard concurrency cap (semaphore + queue with a polite at-capacity notice).</td><td className={td}><Sev level="low" /></td></tr>
            <tr><td className={td}>SSH (22) is open to the internet on agent VMs — key-based on managed boxes. A hardening candidate (restrict source / move port), not an active exposure.</td><td className={td}><Sev level="low" /></td></tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs"><b className="text-[var(--color-text)]">Recently hardened (2026-06-14):</b> managed bridges moved to a non-root service user and to HTTPS with a Studio-pinned cert (whole managed fleet re-provisioned); bridge token comparison is now constant-time; a fail-closed tenant-scope guard and a Standard concurrency cap were added.</p>
      </ArchCard>

      <ArchCard title="Subscriber FAQ (ready answers)">
        <p><b className="text-[var(--color-text)]">"Is my agent's server locked down?"</b> The bridge control port is firewalled to our backend only; nothing else on the internet can reach it, and that link is now encrypted (HTTPS with a pinned cert). The bridge runs as a non-root user. Public ports are just the website (80/443) and SSH.</p>
        <p><b className="text-[var(--color-text)]">"Can other customers' agents see my data?"</b> Pro agents run on their own isolated VM. Standard agents share infrastructure but are walled off in software — an agent can only touch its own workspace's data.</p>
        <p><b className="text-[var(--color-text)]">"Who can read my Anthropic key?"</b> On BYOVPS it stays on your server. On managed Pro it's on your VM. It's never exposed to other tenants or to the browser. Brigata's own key is used only for a short capped free trial and onboarding — never billed to you.</p>
        <p><b className="text-[var(--color-text)]">"What about the Discord / Matrix / GitHub tokens I connect?"</b> They're encrypted at rest on our backend and never sent to your browser or to an agent VM. GitHub uses short-lived, install-scoped tokens rather than a long-lived personal one, and Matrix supports end-to-end-encrypted rooms.</p>
        <p><b className="text-[var(--color-text)]">"Do you read my messages?"</b> Admin tooling shows counts and metadata only — never message content.</p>
      </ArchCard>
    </div>
  )
}

function Subscribers() {
  const [subs, setSubs] = useState<Subscriber[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const toggleLog = (id: string) => setExpandedLogs(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  useEffect(() => {
    fetch('/api/admin/subscribers').then(r => r.json()).then(r => setSubs(r.subscribers ?? []))
  }, [])
  useEffect(() => {
    if (!openId) { setDetail(null); return }
    fetch(`/api/admin/subscribers/${openId}`).then(r => r.json()).then(setDetail)
  }, [openId])
  return (
    <div className="max-w-6xl">
      <h2 className="text-lg font-medium mb-3">Subscribers ({subs.length})</h2>
      <div className="border border-[var(--color-border)] rounded-md overflow-hidden bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-elevated)] text-[var(--color-text-dim)] text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Tier</th>
              <th className="text-left px-3 py-2">Billing</th>
              <th className="text-right px-3 py-2">$/mo</th>
              <th className="text-right px-3 py-2">Agents</th>
              <th className="text-right px-3 py-2">Pro</th>
              <th className="text-right px-3 py-2">Msgs</th>
              <th className="text-left px-3 py-2">Last seen</th>
              <th className="text-left px-3 py-2">Joined</th>
            </tr>
          </thead>
          <tbody>
            {subs.map(s => (
              <tr
                key={s.id}
                onClick={() => setOpenId(s.id)}
                className="border-t border-[var(--color-border)] hover:bg-[var(--color-hover-bg)] cursor-pointer"
              >
                <td className="px-3 py-2 font-mono text-xs">
                  <div>{s.email}{s.abuse_count > 0 && <span className="ml-2 font-sans text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">⚠ {s.abuse_count} abuse</span>}</div>
                  {s.name && <div className="text-[var(--color-text-dim)] text-[10px]">{s.name}</div>}
                </td>
                <td className="px-3 py-2">
                  {s.tier === 'pro' ? (
                    <span className="text-[var(--color-accent)]">★ Pro</span>
                  ) : (
                    <span className="text-[var(--color-text-dim)]">Standard</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {s.billing_status === 'comp' && <span className="text-green-400">comp</span>}
                  {s.billing_status === 'mock-paid' && <span className="text-[var(--color-text-dim)]">mock-paid</span>}
                  {s.billing_status === 'free' && <span className="text-[var(--color-text-dim)]">free</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {s.monthly_cost_usd > 0 ? `$${s.monthly_cost_usd}` : <span className="text-[var(--color-text-dim)]">—</span>}
                </td>
                <td className="px-3 py-2 text-right">{s.agent_count}</td>
                <td className="px-3 py-2 text-right">{s.pro_agent_count > 0 ? s.pro_agent_count : <span className="text-[var(--color-text-dim)]">—</span>}</td>
                <td className="px-3 py-2 text-right">{s.message_count}</td>
                <td className="px-3 py-2 text-[var(--color-text-dim)] text-xs">{fmtDate(s.last_seen_at)}</td>
                <td className="px-3 py-2 text-[var(--color-text-dim)] text-xs">{fmtDate(s.created_at)}</td>
              </tr>
            ))}
            {subs.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-[var(--color-text-dim)]">No subscribers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {detail && (
        <div className="fixed inset-0 z-60 bg-black/60 flex items-center justify-center p-6" onClick={() => setOpenId(null)}>
          <div onClick={e => e.stopPropagation()} className="bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md shadow-elevated max-w-3xl w-full max-h-[80vh] overflow-y-auto p-6">
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <h3 className="text-lg font-medium">{detail.user.email}</h3>
                <div className="text-sm text-[var(--color-text-dim)]">{detail.user.name ?? '—'}</div>
              </div>
              <button onClick={() => setOpenId(null)} className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]">✕</button>
            </div>
            <Section title={`Workspaces (${detail.workspaces.length})`}>
              {detail.workspaces.map(w => (
                <div key={w.id} className="flex justify-between text-sm">
                  <span>{w.name}</span>
                  <span className="text-[var(--color-text-dim)]">{w.plan} · {fmtDate(w.created_at)}</span>
                </div>
              ))}
            </Section>
            <Section title={`Agents (${detail.agents.length})`}>
              {detail.agents.map(a => (
                <div key={a.id} className="text-sm border-b border-[var(--color-border)]/40 py-1 last:border-0">
                  <div className="flex justify-between">
                    <span className="inline-flex items-center gap-1.5"><AgentAvatar avatar={a.avatar} size={16} /> {a.name} <span className="text-[var(--color-text-dim)]">({a.workspace_name})</span></span>
                    <span className="text-[var(--color-text-dim)]">
                      {a.hosting === 'pro_droplet' ? <span className="text-[var(--color-accent)]">★ Pro</span> : a.hosting} · {a.model}
                    </span>
                  </div>
                  {a.droplet && (
                    <div className="text-xs text-[var(--color-text-dim)] mt-0.5 pl-6">
                      Server <span className="font-mono text-[var(--color-text)]">{a.droplet.name}</span> · {a.droplet.ip ?? 'no IP'} · {a.droplet.region.toUpperCase()} · {a.droplet.size}
                    </div>
                  )}
                  {(a.hosting === 'pro_droplet' || a.hosting === 'external') && (a.bridge_metrics_at || a.bridge_privilege === 'root' || a.abuse_flags) && (
                    <div className="text-xs mt-0.5 pl-6 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[var(--color-text-dim)]">
                      {a.bridge_privilege === 'root' && <span className="text-amber-400 font-medium">root</span>}
                      {a.bridge_load_per_core != null && <span>CPU/core {a.bridge_load_per_core.toFixed(2)}</span>}
                      {a.bridge_egress_bps != null && <span>egress {(a.bridge_egress_bps / 1e6).toFixed(2)} MB/s</span>}
                      {a.bridge_mem_pct != null && <span>mem {a.bridge_mem_pct}%</span>}
                      {a.abuse_flags && <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 font-medium">⚠ {a.abuse_flags}</span>}
                      {a.bridge_metrics_at && <span className="opacity-60">@ {fmtDate(a.bridge_metrics_at)}</span>}
                    </div>
                  )}
                  {a.abuse_event_count > 0 && (
                    <div className="text-xs mt-1 pl-6">
                      <button onClick={() => toggleLog(a.id)} className="text-red-400/90 hover:text-red-400 inline-flex items-center gap-1">
                        ⚠ {a.abuse_event_count} abuse alert{a.abuse_event_count === 1 ? '' : 's'}
                        <span className="text-[var(--color-text-dim)]">· {expandedLogs.has(a.id) ? 'hide log ▾' : 'view log ▸'}</span>
                      </button>
                      {expandedLogs.has(a.id) && (
                        <div className="mt-1 max-h-40 overflow-y-auto border-l border-[var(--color-border)] pl-2">
                          <div className="text-[var(--color-text-dim)] mb-0.5">Review only — never auto-acted; may be legitimate heavy use.{detail.abuse_events.filter(e => e.agent_id === a.id).length < a.abuse_event_count ? ` Showing latest ${detail.abuse_events.filter(e => e.agent_id === a.id).length}.` : ''}</div>
                          {detail.abuse_events.filter(e => e.agent_id === a.id).map((e, i) => (
                            <div key={i} className="text-red-400/90">⚠ {e.signal}{e.detail ? ` · ${e.detail}` : ''} · {fmtDate(e.created_at)}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </Section>
            <Section title="Activity by channel">
              {detail.activity.map(a => (
                <div key={a.channel_name} className="flex justify-between text-sm">
                  <span className="inline-flex items-center gap-1"><IconChannel size={12} /> {a.channel_name}</span>
                  <span className="text-[var(--color-text-dim)]">{a.count} msgs · last {fmtDate(a.last_at)}</span>
                </div>
              ))}
              <div className="text-xs text-[var(--color-text-dim)] mt-2 italic">
                Subscriber message content is not exposed in admin.
              </div>
            </Section>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Allowlist() {
  const [list, setList] = useState<Allowed[]>([])
  const [envFallback, setEnvFallback] = useState<string[] | null>(null)
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')

  async function load() {
    const r = await fetch('/api/admin/allowlist').then(r => r.json())
    setList(r.emails ?? [])
    setEnvFallback(r.envFallback ?? null)
  }
  useEffect(() => { void load() }, [])

  async function add() {
    if (!email.trim()) return
    const r = await fetch('/api/admin/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), note: note.trim() || null }),
    })
    if (!r.ok) { alert('Add failed'); return }
    setEmail(''); setNote(''); void load()
  }
  async function remove(em: string) {
    if (!confirm(`Remove ${em}?`)) return
    await fetch(`/api/admin/allowlist/${encodeURIComponent(em)}`, { method: 'DELETE' })
    void load()
  }
  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-medium mb-3">Allowlist</h2>
      {envFallback && (
        <div className="mb-4 text-xs text-[var(--color-text-dim)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
          Env-var ALLOWED_EMAILS bootstrap is still active ({envFallback.length} addresses).
          These addresses can sign in even if not in the database list below.
          Remove the env var once you've migrated everyone to the database.
        </div>
      )}
      <div className="flex gap-2 mb-4">
        <input
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="email@example.com"
          className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
        />
        <input
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="note (optional)"
          className="w-48 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
        />
        <button onClick={add} className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm">Add</button>
      </div>
      <div className="border border-[var(--color-border)] rounded-md overflow-hidden bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-elevated)] text-[var(--color-text-dim)] text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Note</th>
              <th className="text-left px-3 py-2">Added</th>
              <th className="text-left px-3 py-2">By</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {list.map(r => (
              <tr key={r.email} className="border-t border-[var(--color-border)]">
                <td className="px-3 py-2 font-mono text-xs">{r.email}</td>
                <td className="px-3 py-2">{r.note ?? '—'}</td>
                <td className="px-3 py-2 text-[var(--color-text-dim)] text-xs">{fmtDate(r.added_at)}</td>
                <td className="px-3 py-2 text-[var(--color-text-dim)] text-xs">{r.added_by_email ?? '—'}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => remove(r.email)} className="text-xs text-[var(--color-text-dim)] hover:text-red-400">remove</button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-[var(--color-text-dim)]">Database allowlist is empty.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function fmtUptime(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} h`
  return `${(sec / 86400).toFixed(1)} d`
}

const LEVEL_STYLE: Record<HealthLevel, { bar: string; text: string; dot: string; banner: string }> = {
  ok: { bar: 'bg-green-500', text: 'text-green-400', dot: 'bg-green-500', banner: 'border-green-500/40 bg-green-500/10' },
  warn: { bar: 'bg-amber-500', text: 'text-amber-400', dot: 'bg-amber-500', banner: 'border-amber-500/40 bg-amber-500/10' },
  critical: { bar: 'bg-red-500', text: 'text-red-400', dot: 'bg-red-500', banner: 'border-red-500/40 bg-red-500/10' },
}

function Gauge({ label, pct, level, detail, peakPct }: { label: string; pct: number; level: HealthLevel; detail: string; peakPct?: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const peak = peakPct == null ? null : Math.max(0, Math.min(100, peakPct))
  // Only mark the peak once it's meaningfully ahead of the live value, so the
  // line reads as a high-water mark from a past spike, not a redundant edge on
  // the current fill.
  const showPeak = peak != null && peak > clamped + 1
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs uppercase tracking-wide text-[var(--color-text-dim)]">{label}</span>
        <span className={`text-xs font-medium ${LEVEL_STYLE[level].text}`}>{detail}</span>
      </div>
      <div className="relative h-2 rounded-full bg-[var(--color-surface-elevated)] overflow-hidden">
        <div className={`h-full rounded-full ${LEVEL_STYLE[level].bar}`} style={{ width: `${clamped}%` }} />
        {showPeak && (
          <div
            className="absolute top-0 h-full w-0.5 bg-[var(--color-text)] opacity-80"
            style={{ left: `calc(${peak}% - 1px)` }}
            title={`peak ${Math.round(peak!)}% since boot`}
          />
        )}
      </div>
    </div>
  )
}

function HealthTab() {
  const [h, setH] = useState<Health | null>(null)
  const [stat, setStat] = useState<Status | null>(null)
  const [err, setErr] = useState(false)
  async function load() {
    try {
      const r = await fetch('/api/admin/health').then(r => r.json())
      if (r.ok) { setH(r.health); setErr(false) } else setErr(true)
    } catch { setErr(true) }
  }
  useEffect(() => {
    void load()
    // Totals/growth change slowly — fetch once, not on the 5s health cadence.
    fetch('/api/admin/status').then(r => r.json()).then(setStat).catch(() => {})
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [])
  if (err) return <div className="text-sm text-red-400">Failed to load health.</div>
  if (!h) return <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
  const s = LEVEL_STYLE[h.level]
  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Backend health</h2>
        <span className="text-xs text-[var(--color-text-dim)]">auto-refresh 5s · {fmtDate(h.generated_at)}</span>
      </div>

      <div className={`flex items-start gap-3 rounded-md border p-4 ${s.banner}`}>
        <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${s.dot} shrink-0`} />
        <div>
          <div className={`text-sm font-medium ${s.text}`}>
            {h.level === 'ok' ? 'Healthy' : h.level === 'warn' ? 'Watch' : 'Action needed'}
          </div>
          <div className="text-sm mt-0.5">{h.headline}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Gauge
          label="Memory"
          pct={h.memory.used_pct}
          peakPct={h.memory.peak_pct}
          level={h.memory.level}
          detail={`${h.memory.available_mb} MB free / ${h.memory.total_mb} MB`}
        />
        <Gauge
          label="Swap"
          pct={h.swap.total_mb > 0 ? (h.swap.used_mb / h.swap.total_mb) * 100 : 0}
          peakPct={h.swap.peak_pct}
          level={h.swap.level}
          detail={h.swap.total_mb > 0 ? `${h.swap.used_mb} / ${h.swap.total_mb} MB used` : 'none configured'}
        />
        <Gauge
          label="Disk"
          pct={h.disk.used_pct}
          peakPct={h.disk.peak_pct}
          level={h.disk.level}
          detail={`${h.disk.free_gb} GB free / ${h.disk.total_gb} GB`}
        />
        <Gauge
          label="CPU load"
          pct={h.cpu.load_per_core * 100}
          peakPct={h.cpu.peak_pct}
          level={h.cpu.level}
          detail={`${h.cpu.load1} on ${h.cpu.cores} cores`}
        />
        <Gauge
          label="Event-loop lag (p99)"
          pct={(h.event_loop.p99_ms / 250) * 100}
          peakPct={h.event_loop.peak_pct}
          level={h.event_loop.level}
          detail={`${h.event_loop.p99_ms} ms (mean ${h.event_loop.mean_ms})`}
        />
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1.5">Active turns</div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-medium">{h.turns.current}</span>
            <span className="text-xs text-[var(--color-text-dim)]">now · peak {h.turns.peak} since boot</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Process RSS" value={`${h.memory.process_rss_mb} MB`} />
        <Stat label="Uptime" value={fmtUptime(h.uptime_seconds)} />
        <Stat label="Database" value={h.db.online ? 'online' : 'OFFLINE'} />
        <Stat label="DB size" value={h.db.size ?? '—'} />
      </div>

      {stat && (
        <>
          <div>
            <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Totals</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {Object.entries(stat.counts).map(([k, v]) => <Stat key={k} label={k} value={String(v)} />)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Last 24 hours</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Stat label="New signups" value={String(stat.last24h.signups)} />
              <Stat label="User messages" value={String(stat.last24h.messages)} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)]">{label}</div>
      <div className="text-lg font-medium mt-1">{value}</div>
    </div>
  )
}

function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([])
  useEffect(() => {
    fetch('/api/admin/audit').then(r => r.json()).then(r => setRows(r.audit ?? []))
  }, [])
  return (
    <div className="max-w-4xl">
      <h2 className="text-lg font-medium mb-3">Audit log (latest 100)</h2>
      <div className="border border-[var(--color-border)] rounded-md overflow-hidden bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-elevated)] text-[var(--color-text-dim)] text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Admin</th>
              <th className="text-left px-3 py-2">Action</th>
              <th className="text-left px-3 py-2">Target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-t border-[var(--color-border)]">
                <td className="px-3 py-2 text-xs text-[var(--color-text-dim)]">{fmtDate(r.created_at)}</td>
                <td className="px-3 py-2 text-xs">{r.admin_email ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.target ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-[var(--color-text-dim)]">No audit entries yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
