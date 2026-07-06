import { Router, type Request, type Response, type NextFunction } from 'express'
import { db } from './db.js'
import { collectHealth } from './health.js'

export const adminConsole = Router()

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)

function isAdmin(req: Request): boolean {
  if (!req.user) return false
  if (ADMIN_EMAILS.length === 0) return false
  return ADMIN_EMAILS.includes((req.user.email ?? '').toLowerCase())
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdmin(req)) { res.status(403).json({ ok: false, error: 'admin only' }); return }
  next()
}

async function audit(
  adminUserId: string | undefined,
  action: string,
  target: string | null,
  payload: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, target, payload)
     VALUES ($1, $2, $3, $4)`,
    [adminUserId ?? null, action, target, payload ? JSON.stringify(payload) : null],
  ).catch(() => {})
}

// ---------- Quick "am I admin" check for the client ----------
adminConsole.get('/me', (req, res) => {
  res.json({ ok: true, isAdmin: isAdmin(req) })
})

// ---------- Subscribers (users) ----------
adminConsole.get('/subscribers', requireAdmin, async (_req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.avatar_url, u.last_seen_at, u.created_at,
            COALESCE(u.is_comp, FALSE) AS is_comp,
            (SELECT COUNT(*) FROM workspaces WHERE owner_user_id = u.id)::int AS workspace_count,
            (SELECT COUNT(*) FROM agents a
                JOIN workspaces w ON w.id = a.workspace_id
                WHERE w.owner_user_id = u.id)::int AS agent_count,
            (SELECT COUNT(*) FROM agents a
                JOIN workspaces w ON w.id = a.workspace_id
                WHERE w.owner_user_id = u.id AND a.hosting = 'pro_droplet')::int AS pro_agent_count,
            (SELECT COUNT(*) FROM messages m
                JOIN channels c ON c.id = m.channel_id
                JOIN workspaces w ON w.id = c.workspace_id
                WHERE w.owner_user_id = u.id AND m.sender_kind = 'user')::int AS message_count,
            (SELECT COUNT(*) FROM agents a
                JOIN workspaces w ON w.id = a.workspace_id
                WHERE w.owner_user_id = u.id AND a.abuse_flags IS NOT NULL)::int AS abuse_count
     FROM users u
     ORDER BY u.last_seen_at DESC NULLS LAST`,
  )
  // Derive tier + estimated monthly. Real subscription/billing isn't wired
  // yet; for now Pro tier is presence of any pro_droplet agent, monthly cost
  // is $24 per such droplet. is_comp flips the charged status.
  const PRO_DROPLET_COST = 24
  const enriched = rows.map(r => {
    const proCount = Number((r as { pro_agent_count: number }).pro_agent_count)
    return {
      ...r,
      tier: proCount > 0 ? 'pro' : 'standard',
      monthly_cost_usd: proCount * PRO_DROPLET_COST,
      billing_status: (r as { is_comp: boolean }).is_comp ? 'comp' : (proCount > 0 ? 'mock-paid' : 'free'),
    }
  })
  res.json({ ok: true, subscribers: enriched })
})

adminConsole.get('/subscribers/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params
  const u = await db.query(
    `SELECT id, email, name, avatar_url, last_seen_at, created_at
     FROM users WHERE id = $1`,
    [userId],
  )
  if (!u.rows[0]) { res.status(404).json({ ok: false }); return }
  const workspaces = await db.query(
    `SELECT id, name, plan, created_at FROM workspaces WHERE owner_user_id = $1`,
    [userId],
  )
  const agentsResp = await db.query<{
    id: string; name: string; avatar: string | null; model: string;
    hosting: string; status: string; workspace_name: string;
    bridge_privilege: string | null; abuse_flags: string | null;
    bridge_load_per_core: number | null; bridge_mem_pct: number | null;
    bridge_egress_bps: number | null; bridge_metrics_at: Date | string | null;
    abuse_event_count: number;
  }>(
    `SELECT a.id, a.name, a.avatar, a.model, a.hosting, a.status, w.name AS workspace_name,
            a.bridge_privilege, a.abuse_flags,
            a.bridge_load_per_core, a.bridge_mem_pct, a.bridge_egress_bps, a.bridge_metrics_at,
            (SELECT count(*) FROM abuse_events e WHERE e.agent_id = a.id)::int AS abuse_event_count
     FROM agents a
     JOIN workspaces w ON w.id = a.workspace_id
     WHERE w.owner_user_id = $1
     ORDER BY a.created_at DESC`,
    [userId],
  )
  // Enrich Pro agents with their droplet name + IP + region by querying DO once.
  const proAgents = agentsResp.rows.filter(a => a.hosting === 'pro_droplet')
  const dropletByAgent: Record<string, { name: string; ip: string | null; region: string; size: string } | null> = {}
  if (proAgents.length > 0 && process.env.DO_API_TOKEN) {
    try {
      const r = await fetch('https://api.digitalocean.com/v2/droplets?per_page=200', {
        headers: { Authorization: `Bearer ${process.env.DO_API_TOKEN}` },
      })
      if (r.ok) {
        const j = await r.json() as {
          droplets: {
            name: string; tags: string[];
            networks: { v4: { ip_address: string; type: string }[] };
            region: { slug: string };
            size_slug: string;
          }[]
        }
        for (const a of proAgents) {
          const tag = `agent-${a.id}`
          const d = j.droplets.find(d => d.tags.includes(tag))
          dropletByAgent[a.id] = d ? {
            name: d.name,
            ip: d.networks.v4.find(n => n.type === 'public')?.ip_address ?? null,
            region: d.region.slug,
            size: d.size_slug,
          } : null
        }
      }
    } catch { /* ignore DO failures, just return without droplet enrichment */ }
  }
  const agents = { rows: agentsResp.rows.map(a => ({ ...a, droplet: dropletByAgent[a.id] ?? null })) }
  // Privacy: do NOT return message bodies. Aggregate counts only.
  const activity = await db.query<{ channel_name: string; count: string; last_at: string }>(
    `SELECT c.name AS channel_name,
            COUNT(*)::text AS count,
            MAX(m.created_at) AS last_at
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE w.owner_user_id = $1
     GROUP BY c.name
     ORDER BY MAX(m.created_at) DESC NULLS LAST
     LIMIT 25`,
    [userId],
  )
  // Abuse alert history (durable record; the live flag clears when the spike ends).
  const abuseEvents = await db.query<{ agent_id: string; signal: string; detail: string | null; created_at: string }>(
    `SELECT e.agent_id, e.signal, e.detail, e.created_at
       FROM abuse_events e JOIN agents a ON a.id = e.agent_id
       JOIN workspaces w ON w.id = a.workspace_id
      WHERE w.owner_user_id = $1
      ORDER BY e.created_at DESC LIMIT 30`,
    [userId],
  )
  res.json({
    ok: true,
    user: u.rows[0],
    workspaces: workspaces.rows,
    agents: agents.rows,
    activity: activity.rows,
    abuse_events: abuseEvents.rows,
  })
})

// ---------- Allowlist (DB-backed) ----------
adminConsole.get('/allowlist', requireAdmin, async (_req, res) => {
  const { rows } = await db.query(
    `SELECT email, added_at, note,
            (SELECT email FROM users WHERE id = ae.added_by_user_id) AS added_by_email
     FROM allowed_emails ae
     ORDER BY added_at DESC`,
  )
  res.json({ ok: true, emails: rows, envFallback: ADMIN_EMAILS.length === 0 ? null : ADMIN_EMAILS })
})

adminConsole.post('/allowlist', requireAdmin, async (req, res) => {
  const email = (req.body?.email ?? '').toString().trim().toLowerCase()
  const note = typeof req.body?.note === 'string' ? req.body.note : null
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'invalid email' }); return
  }
  await db.query(
    `INSERT INTO allowed_emails (email, added_by_user_id, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET note = COALESCE(EXCLUDED.note, allowed_emails.note)`,
    [email, req.user?.id ?? null, note],
  )
  await audit(req.user?.id, 'allowlist.add', email, { note })
  res.json({ ok: true })
})

adminConsole.delete('/allowlist/:email', requireAdmin, async (req, res) => {
  const email = decodeURIComponent(String(req.params.email)).toLowerCase()
  const { rowCount } = await db.query(
    `DELETE FROM allowed_emails WHERE email = $1`,
    [email],
  )
  if (rowCount === 0) { res.status(404).json({ ok: false }); return }
  await audit(req.user?.id, 'allowlist.remove', email, null)
  res.json({ ok: true })
})

// ---------- System status ----------
adminConsole.get('/status', requireAdmin, async (_req, res) => {
  const dbConn = await db.query(`SELECT 1 AS ok`).then(() => true).catch(() => false)
  const [
    userCount, workspaceCount, agentCount, messageCount, docCount, attachmentCount,
    last24hSignups, last24hMessages, totalSize,
  ] = await Promise.all([
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM users`),
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM workspaces`),
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM agents`),
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM messages`),
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM documents`),
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM attachments`),
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM users WHERE created_at > now() - interval '24 hours'`),
    db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM messages WHERE created_at > now() - interval '24 hours'`),
    db.query<{ s: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`),
  ])
  res.json({
    ok: true,
    db: dbConn ? 'online' : 'offline',
    counts: {
      users: Number(userCount.rows[0].c),
      workspaces: Number(workspaceCount.rows[0].c),
      agents: Number(agentCount.rows[0].c),
      messages: Number(messageCount.rows[0].c),
      documents: Number(docCount.rows[0].c),
      attachments: Number(attachmentCount.rows[0].c),
    },
    last24h: {
      signups: Number(last24hSignups.rows[0].c),
      messages: Number(last24hMessages.rows[0].c),
    },
    db_size: totalSize.rows[0].s,
    server_time: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  })
})

// ---------- Health (at-a-glance backend story) ----------
adminConsole.get('/health', requireAdmin, async (_req, res) => {
  try {
    const snapshot = await collectHealth()
    res.json({ ok: true, health: snapshot })
  } catch (e) {
    console.error('[admin-health] collect failed:', (e as Error)?.message)
    res.status(500).json({ ok: false, error: 'health collection failed' })
  }
})

// ---------- Audit log ----------
adminConsole.get('/audit', requireAdmin, async (_req, res) => {
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.target, a.payload, a.created_at,
            u.email AS admin_email
     FROM admin_audit_log a
     LEFT JOIN users u ON u.id = a.admin_user_id
     ORDER BY a.created_at DESC LIMIT 100`,
  )
  res.json({ ok: true, audit: rows })
})

// Helper for auth.ts: check if an email is in the DB allowlist.
export async function isEmailInDbAllowlist(email: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM allowed_emails WHERE email = $1 LIMIT 1`,
    [email.toLowerCase()],
  )
  return rows.length > 0
}
