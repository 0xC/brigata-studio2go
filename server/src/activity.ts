// Agent coordination visibility: an append-only activity log ("commit history"
// for the brigade) plus a live-presence snapshot ("traffic lights"). Both are
// content-free — summaries and context are metadata only, never message bodies,
// so this stays safe to surface to the workspace owner.
//
// Capture is best-effort and mirrors usage.ts: recording activity must never
// break or block an agent's reply, so every write is wrapped and failures are
// logged, not thrown.
import { Router } from 'express'
import { db } from './db.js'
import { broadcastToAll } from './realtime.js'

// ---------------------------------------------------------------------------
// Live presence ("traffic lights")
// ---------------------------------------------------------------------------
// pending-replies.ts only tracks Pro/external agents, so we keep our own map
// that covers BOTH Standard and Pro turns. An agent is "active" between
// markAgentActive (turn start) and clearActive (turn finish / failure). A
// read-time TTL guards against a missed clearActive leaving a light stuck green.
const PRESENCE_TTL_MS = 20 * 60_000

interface Presence {
  channelId: string | null
  since: number
}
const presence = new Map<string, Presence>()

// High-water mark of simultaneous in-flight turns since process start. Standard
// turns run in-process (each spawns an SDK subprocess holding the model context),
// so peak concurrency — not agent count — is what drives memory/CPU pressure on
// the shared backend. The health dashboard reads this to answer "how close are
// we to needing a bigger box."
let peakConcurrentTurns = 0

export function markAgentActive(agentId: string, channelId: string | null): void {
  presence.set(agentId, { channelId, since: Date.now() })
  const live = liveAgentIds().size
  if (live > peakConcurrentTurns) peakConcurrentTurns = live
}

// Snapshot of current vs all-time-since-boot peak concurrent turns. Used by the
// admin health endpoint; TTL-pruned so a missed clearActive can't inflate it.
export function turnConcurrency(): { current: number; peak: number } {
  return { current: liveAgentIds().size, peak: peakConcurrentTurns }
}

// Returns the cleared presence (so callers can compute a turn duration) or null.
export function clearActive(agentId: string): Presence | null {
  const p = presence.get(agentId)
  presence.delete(agentId)
  return p ?? null
}

function liveAgentIds(): Map<string, Presence> {
  const now = Date.now()
  for (const [id, p] of presence) {
    if (now - p.since > PRESENCE_TTL_MS) presence.delete(id)
  }
  return presence
}

// ---------------------------------------------------------------------------
// Activity log capture
// ---------------------------------------------------------------------------
export interface ActivityCapture {
  workspaceId: string
  channelId?: string | null
  actorKind: 'agent' | 'human' | 'system'
  agentId?: string | null
  userId?: string | null
  action: 'turn' | 'handoff' | string
  summary?: string | null
  targetAgentId?: string | null
  durationMs?: number | null
  status?: 'ok' | 'error'
  context?: Record<string, unknown> | null
}

export async function recordActivity(a: ActivityCapture): Promise<void> {
  try {
    const { rows } = await db.query<{ id: string; created_at: string }>(
      `INSERT INTO agent_activity
         (workspace_id, channel_id, actor_kind, agent_id, user_id,
          action, summary, target_agent_id, duration_ms, status, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, created_at`,
      [
        a.workspaceId,
        a.channelId ?? null,
        a.actorKind,
        a.agentId ?? null,
        a.userId ?? null,
        a.action,
        a.summary ?? null,
        a.targetAgentId ?? null,
        a.durationMs ?? null,
        a.status ?? 'ok',
        a.context ? JSON.stringify(a.context) : null,
      ],
    )
    const row = rows[0]
    if (row) {
      broadcastToAll({
        type: 'activity_appended',
        workspaceId: a.workspaceId,
        activity: {
          id: row.id,
          channel_id: a.channelId ?? null,
          actor_kind: a.actorKind,
          agent_id: a.agentId ?? null,
          action: a.action,
          summary: a.summary ?? null,
          target_agent_id: a.targetAgentId ?? null,
          duration_ms: a.durationMs ?? null,
          status: a.status ?? 'ok',
          created_at: row.created_at,
        },
      })
    }
  } catch (e) {
    console.error('[activity] failed to record activity:', (e as Error)?.message)
  }
}

// Match @mentions so a turn whose reply @-mentions another agent records a
// handoff edge (e.g. Nico → Mara). Mirrors parseMentions in agents.ts but kept
// local to avoid a circular import.
const MENTION_RE = /@(\w[\w-]*)/g
function mentionedNames(body: string): Set<string> {
  const out = new Set<string>()
  for (const m of body.matchAll(MENTION_RE)) out.add(m[1].toLowerCase())
  return out
}

// Records a completed agent turn plus any handoff(s) it triggered. Called from
// both the Standard (agents.ts) and Pro (external-agents.ts) finish paths.
export async function recordAgentTurnActivity(opts: {
  workspaceId: string
  channelId: string
  agentId: string
  agentName: string
  replyText: string
  durationMs: number | null
  triggerUserId?: string | null
}): Promise<void> {
  await recordActivity({
    workspaceId: opts.workspaceId,
    channelId: opts.channelId,
    actorKind: 'agent',
    agentId: opts.agentId,
    action: 'turn',
    summary: `${opts.agentName} responded`,
    durationMs: opts.durationMs,
    context: opts.triggerUserId ? { trigger_user_id: opts.triggerUserId } : null,
  })

  const mentions = mentionedNames(opts.replyText)
  if (mentions.size === 0) return
  try {
    const { rows } = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM agents
       WHERE workspace_id = $1 AND lower(name) = ANY($2::text[]) AND id <> $3`,
      [opts.workspaceId, [...mentions], opts.agentId],
    )
    for (const target of rows) {
      await recordActivity({
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        actorKind: 'agent',
        agentId: opts.agentId,
        action: 'handoff',
        summary: `${opts.agentName} → ${target.name}`,
        targetAgentId: target.id,
      })
    }
  } catch (e) {
    console.error('[activity] handoff detection failed:', (e as Error)?.message)
  }
}

// ---------------------------------------------------------------------------
// Read endpoints (membership-gated)
// ---------------------------------------------------------------------------
export const activity = Router()

async function userInWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  return rows.length > 0
}

// Paginated activity log (newest first). Cursor = created_at of the last row
// seen (ISO string); pass ?before=<created_at> to page back.
activity.get('/:workspaceId/activity', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const wid = req.params.workspaceId
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50))
  const before = typeof req.query.before === 'string' ? req.query.before : null
  try {
    const params: unknown[] = [wid]
    let where = `a.workspace_id = $1`
    if (before) {
      params.push(before)
      where += ` AND a.created_at < $${params.length}`
    }
    params.push(limit)
    const { rows } = await db.query(
      `SELECT a.id, a.channel_id, c.name AS channel_name,
              a.actor_kind, a.agent_id, ag.name AS agent_name, ag.avatar AS agent_avatar,
              a.user_id, a.action, a.summary,
              a.target_agent_id, tg.name AS target_agent_name,
              a.duration_ms, a.status, a.context, a.created_at
         FROM agent_activity a
         LEFT JOIN channels c ON c.id = a.channel_id
         LEFT JOIN agents ag ON ag.id = a.agent_id
         LEFT JOIN agents tg ON tg.id = a.target_agent_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}`,
      params,
    )
    const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at : null
    res.json({ ok: true, activity: rows, next_cursor: nextCursor })
  } catch (e) {
    console.error('[activity] log query failed:', (e as Error)?.message)
    res.status(500).json({ ok: false })
  }
})

// Live presence snapshot ("traffic lights"): every workspace agent plus whether
// it is currently mid-turn (and in which channel / since when). Path avoids the
// `/agents/:agentId` route in admin.ts, which would otherwise capture "live".
activity.get('/:workspaceId/agents-live', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const wid = req.params.workspaceId
  try {
    const { rows } = await db.query<{ id: string; name: string; avatar: string | null }>(
      `SELECT id, name, avatar FROM agents WHERE workspace_id = $1 ORDER BY created_at ASC`,
      [wid],
    )
    const live = liveAgentIds()
    const agents = rows.map(a => {
      const p = live.get(a.id)
      return {
        id: a.id,
        name: a.name,
        avatar: a.avatar,
        active: !!p,
        channel_id: p?.channelId ?? null,
        active_since: p ? new Date(p.since).toISOString() : null,
      }
    })
    res.json({ ok: true, agents })
  } catch (e) {
    console.error('[activity] live query failed:', (e as Error)?.message)
    res.status(500).json({ ok: false })
  }
})
