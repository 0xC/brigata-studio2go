import express, { Router } from 'express'
import { randomBytes } from 'crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from './db.js'
import { broadcastToAll } from './realtime.js'
import { bridgeFetch } from './bridge-tls.js'
import { getTemplate } from './agentTemplates.js'
import { SKILL_CATALOG, sanitizeEnabledIds, normalizeEnabled } from './skills.js'
import { getExpectedBridgeRev } from './bridge-rev.js'
import { PRO_VPS_AGENT_CAP } from './pro-constants.js'
import { isKnownModel, DEFAULT_MODEL } from './models.js'
import { isStandalone } from './standalone.js'

// Cloud-only provisioning modules are imported dynamically through these
// non-literal specifiers so a standalone/self-host build type-checks and bundles
// WITHOUT the Pro provisioning source on disk. The routes that use them are all
// guarded by isStandalone() (a self-host install has no Pro agents), so the
// runtime import never fires there; the indirection only hides the modules from
// the compiler's static resolver. Do not inline these back to string literals.
const PRO_PROVISIONER_MOD: string = './pro-provisioner.js'

export const admin = Router()

// Owner-facing runtime panel for bridge-backed agents. Built from the runtime
// facts the health poller scraped from the bridge's /health (migration 026).
// Returns null for in-process (Standard) agents, which have no bridge. public_ip
// is privacy-gated: included only when the caller is the workspace owner/admin
// (and the bridge actually reported one) — never leaked to ordinary members.
interface AgentRuntimeRow {
  status: string
  hosting: string | null
  bridge_rev: string | null
  bridge_model: string | null
  bridge_auth_mode: string | null
  bridge_sdk_installed: boolean | null
  bridge_public_ip: string | null
  bridge_health_at: Date | string | null
}

function buildAgentRuntime(row: AgentRuntimeRow, expectedRev: string | null, canSeeIp: boolean) {
  if (row.hosting !== 'pro_droplet' && row.hosting !== 'external') return null
  const rev = row.bridge_rev ?? null
  const runtime: Record<string, unknown> = {
    online: row.status === 'online',
    rev,
    expected_rev: expectedRev,
    update_available: !!rev && !!expectedRev && rev !== expectedRev,
    model: row.bridge_model ?? null,
    auth_mode: row.bridge_auth_mode ?? null,
    sdk_installed: row.bridge_sdk_installed ?? null,
    checked_at: row.bridge_health_at ?? null,
  }
  if (canSeeIp && row.bridge_public_ip) runtime.public_ip = row.bridge_public_ip
  return runtime
}

const RUNTIME_COLS =
  'bridge_rev, bridge_model, bridge_auth_mode, bridge_sdk_installed, bridge_public_ip, bridge_health_at'

// ---------- Agent avatar upload (custom image escape hatch) ----------
// Templates are static PNGs under the client's public/. Custom uploads are
// stored server-side and served back via a versioned URL so a re-upload
// cache-busts. agent.avatar holds either an emoji, a /avatars/templates/* path,
// or one of these /api/.../avatar?v=… URLs.
const AVATAR_DIR = process.env.AVATAR_STORAGE_DIR
  ? path.resolve(process.env.AVATAR_STORAGE_DIR)
  : path.resolve(process.cwd(), 'uploads', 'avatars')
const AVATAR_MAX_BYTES = 5 * 1024 * 1024 // 5MB
const AVATAR_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

async function userInWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  return rows.length > 0
}

// Stricter: only owner or admin can mutate things that affect everyone in the
// workspace (agent SOUL/MISSION edits, agent creation/deletion, channel CRUD,
// etc.). Members can read and participate; they can't change the workspace's
// shape.
async function userOwnsOrAdmins(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  const role = rows[0]?.role
  return role === 'owner' || role === 'admin'
}

// Free plan includes this many agents per workspace. Subscribed (or comp'd)
// owners are unmetered. The seeded Concierge counts toward the limit, so a free
// workspace can re-role its one agent but can't add a second.
const FREE_AGENT_LIMIT = 1

// A workspace's entitlement is its OWNER's billing state: comp'd (beta) or on
// an active/trialing Standard subscription. Free owners are gated on agent
// count and on custom-soul authoring.
async function workspaceOwnerEntitled(workspaceId: string): Promise<boolean> {
  // Self-host: no billing, the single owner is always fully entitled.
  if (isStandalone()) return true
  const { rows } = await db.query<{ is_comp: boolean; subscription_status: string | null }>(
    `SELECT u.is_comp, u.subscription_status
       FROM workspaces w JOIN users u ON u.id = w.owner_user_id
      WHERE w.id = $1`,
    [workspaceId],
  )
  const r = rows[0]
  if (!r) return false
  return (
    r.is_comp === true ||
    r.subscription_status === 'active' ||
    r.subscription_status === 'trialing'
  )
}

async function checkAgentQuota(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await workspaceOwnerEntitled(workspaceId)) return { ok: true }
  const { rows } = await db.query<{ agent_count: string }>(
    `SELECT count(*) AS agent_count FROM agents WHERE workspace_id = $1`,
    [workspaceId],
  )
  if (Number(rows[0]?.agent_count ?? 0) >= FREE_AGENT_LIMIT) {
    return {
      ok: false,
      error:
        'The free plan includes 1 agent. Upgrade to Standard to add more — or re-role your existing agent from its settings.',
    }
  }
  return { ok: true }
}

// ---------- Workspace ----------

const WORKSPACE_THEMES = new Set(['graphite', 'ember', 'atelier'])
// Icon cap is measured in Unicode code points (not UTF-16 units) so a
// multi-codepoint ZWJ emoji (e.g. a 7-codepoint family) still fits.
const WORKSPACE_ICON_MAX_CODEPOINTS = 8

admin.patch('/:workspaceId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }

  const sets: string[] = []
  const params: unknown[] = []

  if ('name' in (req.body ?? {})) {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name) return res.status(400).json({ ok: false, error: 'name required' })
    if (name.length > 80) return res.status(400).json({ ok: false, error: 'name too long' })
    params.push(name)
    sets.push(`name = $${params.length}`)
  }

  if ('theme' in (req.body ?? {})) {
    const theme = req.body.theme
    if (theme === null) {
      params.push(null)
      sets.push(`theme = $${params.length}`)
    } else if (typeof theme === 'string' && WORKSPACE_THEMES.has(theme)) {
      params.push(theme)
      sets.push(`theme = $${params.length}`)
    } else {
      return res.status(400).json({ ok: false, error: 'invalid theme' })
    }
  }

  if ('icon' in (req.body ?? {})) {
    const icon = req.body.icon
    if (icon === null || icon === '') {
      params.push(null)
      sets.push(`icon = $${params.length}`)
    } else if (typeof icon === 'string') {
      if ([...icon].length > WORKSPACE_ICON_MAX_CODEPOINTS) {
        return res.status(400).json({ ok: false, error: 'icon too long' })
      }
      params.push(icon)
      sets.push(`icon = $${params.length}`)
    } else {
      return res.status(400).json({ ok: false, error: 'invalid icon' })
    }
  }

  if (sets.length === 0) return res.status(400).json({ ok: false, error: 'nothing to update' })

  params.push(req.params.workspaceId)
  const { rows } = await db.query(
    `UPDATE workspaces SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, name, plan, theme, icon`,
    params,
  )
  if (!rows[0]) return res.status(404).json({ ok: false })
  res.json({ ok: true, workspace: rows[0] })
})

// ---------- Channels ----------

admin.post('/:workspaceId/channels', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const name = (req.body?.name ?? '').toString().trim().toLowerCase().replace(/\s+/g, '-')
  if (!name || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
    return res.status(400).json({ ok: false, error: 'invalid channel name' })
  }
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : null
  try {
    const { rows } = await db.query(
      `INSERT INTO channels (workspace_id, name, topic) VALUES ($1, $2, $3)
       RETURNING id, name, topic`,
      [req.params.workspaceId, name, topic],
    )
    // If the workspace has exactly one agent, auto-include it in the new
    // channel. With a single agent there's no ambiguity about who should be
    // in it, and forcing the user to flip a toggle is just friction.
    await db.query(
      `INSERT INTO channel_agents (channel_id, agent_id)
       SELECT $1, a.id FROM agents a
       WHERE a.workspace_id = $2
         AND (SELECT COUNT(*) FROM agents WHERE workspace_id = $2) = 1
       ON CONFLICT DO NOTHING`,
      [rows[0].id, req.params.workspaceId],
    )
    broadcastToAll({ type: 'channels_updated', workspaceId: req.params.workspaceId })
    res.json({ ok: true, channel: rows[0] })
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return res.status(409).json({ ok: false, error: 'channel name taken' })
    }
    throw e
  }
})

admin.patch('/:workspaceId/channels/:channelId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const updates: string[] = []
  const params: unknown[] = []
  let i = 1
  if (typeof req.body?.name === 'string') {
    const name = req.body.name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
      return res.status(400).json({ ok: false, error: 'invalid channel name' })
    }
    updates.push(`name = $${i++}`)
    params.push(name)
  }
  if ('topic' in (req.body ?? {})) {
    updates.push(`topic = $${i++}`)
    const t = req.body.topic
    params.push(typeof t === 'string' && t.trim() ? t.trim() : null)
  }
  // Per-channel agent response mode (group-chat UX). Folded into this handler so
  // it doesn't shadow the rename/topic route (a duplicate PATCH path did exactly
  // that and silently broke renames).
  if (typeof req.body?.agent_response_mode === 'string') {
    const m = req.body.agent_response_mode
    if (!['auto', 'mention', 'off'].includes(m)) {
      return res.status(400).json({ ok: false, error: 'agent_response_mode must be auto|mention|off' })
    }
    updates.push(`agent_response_mode = $${i++}`)
    params.push(m)
  }
  if (updates.length === 0) return res.status(400).json({ ok: false, error: 'nothing to update' })
  params.push(req.params.channelId, req.params.workspaceId)
  try {
    const { rows } = await db.query(
      `UPDATE channels SET ${updates.join(', ')}
       WHERE id = $${i++} AND workspace_id = $${i}
       RETURNING id, name, topic, agent_response_mode`,
      params,
    )
    if (!rows[0]) return res.status(404).json({ ok: false })
    broadcastToAll({ type: 'channels_updated', workspaceId: req.params.workspaceId })
    res.json({ ok: true, channel: rows[0] })
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return res.status(409).json({ ok: false, error: 'channel name taken' })
    }
    throw e
  }
})

admin.delete('/:workspaceId/channels/:channelId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rowCount } = await db.query(
    `DELETE FROM channels WHERE id = $1 AND workspace_id = $2`,
    [req.params.channelId, req.params.workspaceId],
  )
  if (rowCount === 0) return res.status(404).json({ ok: false })
  broadcastToAll({ type: 'channels_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true })
})

// ---------- Agents ----------

admin.get('/:workspaceId/agents', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  // Members can list agents — needed for the brigade dock + @-mention.
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  // Safety net: agents are no longer seeded at sign-in (the onboarding wizard
  // is the sole creator). If onboarding seeding ever failed or was bypassed,
  // the owner would land on an empty studio — guarantee one fallback agent.
  // Owner-only + idempotent (no-op if any agent exists).
  const { rows: ownRows } = await db.query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM workspaces WHERE id = $1`,
    [req.params.workspaceId],
  )
  if (ownRows[0]?.owner_user_id === req.user.id) {
    const { rows: cnt } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agents WHERE workspace_id = $1`,
      [req.params.workspaceId],
    )
    if (cnt[0]?.n === '0') {
      const { ensureFallbackAgent } = await import('./workspace.js')
      const firstName = (req.user.name || '').split(/\s+/)[0] || 'there'
      await ensureFallbackAgent(req.params.workspaceId, firstName).catch(e =>
        console.error('[agents] fallback seed failed:', e),
      )
    }
  }
  const { rows } = await db.query(
    `SELECT id, name, avatar, model, status, hosting, created_at, safety_profile,
            last_turn_at, last_turn_status, last_error_message, ${RUNTIME_COLS} FROM agents
     WHERE workspace_id = $1 ORDER BY created_at ASC`,
    [req.params.workspaceId],
  )
  const [expectedRev, canSeeIp] = await Promise.all([
    getExpectedBridgeRev(),
    userOwnsOrAdmins(req.user.id, req.params.workspaceId),
  ])
  const agents = rows.map((r) => ({
    ...r,
    runtime: buildAgentRuntime(r as unknown as AgentRuntimeRow, expectedRev, canSeeIp),
  }))
  res.json({ ok: true, agents })
})

admin.get('/:workspaceId/agents/:agentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  // Members can view an agent's details (incl. SOUL/MISSION) so they understand
  // who they're talking to. Mutations below stay owner/admin-only.
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rows } = await db.query(
    `SELECT id, name, avatar, model, soul_md, mission_md, identity_md, instructions, status, created_at,
            hosting, external_url, external_token, enabled_skills, safety_profile, ${RUNTIME_COLS}
     FROM agents WHERE id = $1 AND workspace_id = $2`,
    [req.params.agentId, req.params.workspaceId],
  )
  if (!rows[0]) return res.status(404).json({ ok: false })

  const { rows: channels } = await db.query(
    `SELECT c.id, c.name FROM channels c
     JOIN channel_agents ca ON ca.channel_id = c.id
     WHERE ca.agent_id = $1 AND c.workspace_id = $2
     ORDER BY c.name`,
    [req.params.agentId, req.params.workspaceId],
  )

  const [expectedRev, canSeeIp] = await Promise.all([
    getExpectedBridgeRev(),
    userOwnsOrAdmins(req.user.id, req.params.workspaceId),
  ])
  const runtime = buildAgentRuntime(rows[0] as unknown as AgentRuntimeRow, expectedRev, canSeeIp)

  // external_url exposes the bridge VPS IP and external_token is its bearer
  // secret — both are infra credentials, not member-facing. Members can read an
  // agent's persona/skills, but only the owner/admin gets the hosting endpoint
  // and token. (The brigade card renders external_url, so without this any member
  // could read every Pro/BYOVPS agent's IP.)
  const agent = { ...rows[0], channels, runtime }
  if (!canSeeIp) {
    agent.external_url = null
    agent.external_token = null
  }

  res.json({ ok: true, agent })
})

admin.post('/:workspaceId/agents', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const quota = await checkAgentQuota(req.params.workspaceId)
  if (!quota.ok) return res.status(402).json({ ok: false, error: quota.error, code: 'upgrade_required' })
  const name = (req.body?.name ?? '').toString().trim()
  if (!name) return res.status(400).json({ ok: false, error: 'name required' })
  const avatar = typeof req.body?.avatar === 'string' ? req.body.avatar : null
  const model = req.body?.model === undefined ? DEFAULT_MODEL : req.body.model
  if (!isKnownModel(model)) return res.status(400).json({ ok: false, error: 'unknown model' })
  const soul_md = typeof req.body?.soul_md === 'string' ? req.body.soul_md : ''
  const channelIds: string[] = Array.isArray(req.body?.channel_ids) ? req.body.channel_ids : []

  const { rows } = await db.query(
    `INSERT INTO agents (workspace_id, name, avatar, model, soul_md, status)
     VALUES ($1, $2, $3, $4, $5, 'online')
     RETURNING id, name, avatar, model, status`,
    [req.params.workspaceId, name, avatar, model, soul_md],
  )
  const agentId = rows[0].id

  // Initial version snapshot
  await db.query(
    `INSERT INTO agent_versions (agent_id, soul_md, mission_md, identity_md, saved_by_user_id)
     VALUES ($1, $2, '', '', $3)`,
    [agentId, soul_md, req.user.id],
  )

  // Channel memberships from the form
  for (const cid of channelIds) {
    await db
      .query(
        `INSERT INTO channel_agents (channel_id, agent_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [cid, agentId],
      )
      .catch(() => {})
  }

  // Every agent automatically joins #common (the shared workspace channel).
  await db.query(
    `INSERT INTO channel_agents (channel_id, agent_id)
     SELECT c.id, $1 FROM channels c
     WHERE c.workspace_id = $2 AND c.name = 'common'
     ON CONFLICT DO NOTHING`,
    [agentId, req.params.workspaceId],
  )

  // Create a per-agent channel (slugged from the agent's name) — the agent's
  // own dedicated space. Only this agent is in it by default.
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  if (slug) {
    try {
      const { rows: ch } = await db.query<{ id: string }>(
        `INSERT INTO channels (workspace_id, name, topic)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, name) DO NOTHING
         RETURNING id`,
        [req.params.workspaceId, slug, `${name}'s dedicated space`],
      )
      if (ch[0]) {
        await db.query(
          `INSERT INTO channel_agents (channel_id, agent_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [ch[0].id, agentId],
        )
      }
    } catch {
      // If the channel name conflicts with a non-agent channel, silently skip.
    }
  }

  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true, agent: rows[0] })
})

// Move an agent to a different workspace. The caller must be owner or admin
// of BOTH workspaces (so they can't yank an agent out of a workspace they
// don't control or dump one into a workspace they don't belong to). The
// agent's `channel_agents` rows are cleared since they reference channels
// in the source workspace; messages stay where they are (they reference the
// agent by id, which still resolves).
admin.post('/:workspaceId/agents/:agentId/move', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const dest = typeof req.body?.dest_workspace_id === 'string' ? req.body.dest_workspace_id : ''
  if (!dest) return res.status(400).json({ ok: false, error: 'dest_workspace_id required' })
  if (dest === req.params.workspaceId) return res.status(400).json({ ok: false, error: 'agent already in that workspace' })

  const { rows: src } = await db.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [req.params.workspaceId, req.user.id],
  )
  const { rows: dst } = await db.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [dest, req.user.id],
  )
  const srcOk = src[0]?.role === 'owner' || src[0]?.role === 'admin'
  const dstOk = dst[0]?.role === 'owner' || dst[0]?.role === 'admin'
  if (!srcOk || !dstOk) return res.status(403).json({ ok: false, error: 'must be owner or admin of both workspaces' })

  const { rows: present } = await db.query(
    `SELECT 1 FROM agents WHERE id = $1 AND workspace_id = $2`,
    [req.params.agentId, req.params.workspaceId],
  )
  if (present.length === 0) return res.status(404).json({ ok: false, error: 'agent not in this workspace' })

  await db.query(
    `UPDATE agents SET workspace_id = $1 WHERE id = $2`,
    [dest, req.params.agentId],
  )
  await db.query(`DELETE FROM channel_agents WHERE agent_id = $1`, [req.params.agentId])
  // Auto-add to the destination workspace's #general channel so the agent is
  // reachable immediately. Without this, the agent lives in the workspace but
  // can't be dispatched until the user manually wires up channel membership.
  await db.query(
    `INSERT INTO channel_agents (channel_id, agent_id)
     SELECT id, $1 FROM channels WHERE workspace_id = $2 AND name = 'general'
     ON CONFLICT DO NOTHING`,
    [req.params.agentId, dest],
  )
  res.json({ ok: true, workspace_id: dest })
})

admin.patch('/:workspaceId/agents/:agentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }

  // Read current SOUL/etc so we can snapshot if it changes
  const { rows: existing } = await db.query(
    `SELECT soul_md, mission_md, identity_md, hosting FROM agents WHERE id = $1 AND workspace_id = $2`,
    [req.params.agentId, req.params.workspaceId],
  )
  if (!existing[0]) return res.status(404).json({ ok: false })

  // Custom-soul authoring (editing soul/mission/identity to arbitrary text) is a
  // Standard-tier capability. Free owners can still rename, swap avatar/model,
  // and re-role via the canonical-preset endpoint below — they just can't write
  // a bespoke soul here.
  const soulFields = ['soul_md', 'mission_md', 'identity_md'] as const
  const writingCustomSoul = soulFields.some(
    f => typeof req.body?.[f] === 'string' && req.body[f] !== existing[0][f],
  )
  if (writingCustomSoul && !(await workspaceOwnerEntitled(req.params.workspaceId))) {
    return res.status(402).json({
      ok: false,
      code: 'upgrade_required',
      error: 'Custom souls are a Standard feature. Upgrade to write your own, or pick a preset role.',
    })
  }

  if (typeof req.body?.model === 'string' && !isKnownModel(req.body.model)) {
    return res.status(400).json({ ok: false, error: 'unknown model' })
  }

  const updates: string[] = []
  const params: unknown[] = []
  let i = 1
  const fields = ['name', 'avatar', 'model', 'soul_md', 'mission_md', 'identity_md', 'instructions', 'hosting', 'external_url'] as const
  for (const f of fields) {
    if (typeof req.body?.[f] === 'string') {
      updates.push(`${f} = $${i++}`)
      params.push(req.body[f])
    }
  }
  if (updates.length === 0) return res.status(400).json({ ok: false, error: 'nothing to update' })
  params.push(req.params.agentId, req.params.workspaceId)

  const { rows } = await db.query(
    `UPDATE agents SET ${updates.join(', ')}
     WHERE id = $${i++} AND workspace_id = $${i}
     RETURNING id, name, avatar, model, soul_md, mission_md, identity_md, instructions, status`,
    params,
  )

  // If SOUL changed, snapshot the version
  const soulChanged =
    typeof req.body?.soul_md === 'string' && req.body.soul_md !== existing[0].soul_md
  const missionChanged =
    typeof req.body?.mission_md === 'string' && req.body.mission_md !== existing[0].mission_md
  const identityChanged =
    typeof req.body?.identity_md === 'string' && req.body.identity_md !== existing[0].identity_md
  if (soulChanged || missionChanged || identityChanged) {
    await db.query(
      `INSERT INTO agent_versions (agent_id, soul_md, mission_md, identity_md, saved_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.params.agentId,
        rows[0].soul_md,
        rows[0].mission_md,
        rows[0].identity_md,
        req.user.id,
      ],
    )
  }

  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })

  // Bridge-backed agents bake their soul/mission/identity onto the VPS at
  // provision time; the per-turn dispatch doesn't re-send it. So a persona edit
  // here is saved + versioned but won't change live behavior until the bridge is
  // redeployed. Signal that to the UI so it can prompt "Redeploy to apply"
  // (in-process Standard agents reload from the DB each turn — no redeploy needed).
  // 'managed' (pro_droplet) → one-click POST .../redeploy-pro re-bakes the soul.
  // 'self' (external/BYOVPS) → no server-side redeploy; user updates the soul on
  // their own bridge. null → nothing to do (Standard, or no persona change).
  const personaChanged = soulChanged || missionChanged || identityChanged
  const redeployMode: 'managed' | 'self' | null =
    !personaChanged ? null
    : existing[0].hosting === 'pro_droplet' ? 'managed'
    : existing[0].hosting === 'external' ? 'self'
    : null

  res.json({ ok: true, agent: rows[0], redeploy_required: redeployMode !== null, redeploy_mode: redeployMode })
})

// Curated skills catalog for the Settings → Agent → Skills tab. Static/code-defined;
// gated on workspace membership only (no secrets here, just the card metadata).
admin.get('/:workspaceId/skills', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const skills = SKILL_CATALOG.map(s => ({
    id: s.id,
    label: s.label,
    description: s.description,
    access: s.access,
    tier: s.tier,
    needsConnection: s.needsConnection,
    available: s.available,
  }))
  res.json({ ok: true, skills })
})

// Toggle which catalog skills are enabled for an agent. Owner/admin only (it
// changes the agent's capabilities for everyone in the workspace). Unknown ids are
// dropped; the stored value is always a clean, catalog-validated id list.
admin.put('/:workspaceId/agents/:agentId/skills', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  if (!Array.isArray(req.body?.enabled_skills)) {
    return res.status(400).json({ ok: false, error: 'enabled_skills must be an array' })
  }
  const ids = sanitizeEnabledIds(req.body.enabled_skills)
  const { rows } = await db.query(
    `UPDATE agents SET enabled_skills = $1::jsonb
     WHERE id = $2 AND workspace_id = $3
     RETURNING id, enabled_skills`,
    [JSON.stringify(ids), req.params.agentId, req.params.workspaceId],
  )
  if (!rows[0]) return res.status(404).json({ ok: false })
  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true, agent: { id: rows[0].id, enabled_skills: normalizeEnabled(rows[0].enabled_skills) } })
})

// Self-declared safety profile for the rule-of-two tracker. Only the known
// boolean keys are accepted; the status itself is computed client-side.
admin.put('/:workspaceId/agents/:agentId/safety', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const KEYS = ['untrusted_input', 'consequential', 'autonomous'] as const
  const p = (req.body?.safety_profile ?? {}) as Record<string, unknown>
  const clean: Record<string, boolean> = {}
  for (const k of KEYS) if (p[k] === true) clean[k] = true
  const { rows } = await db.query(
    `UPDATE agents SET safety_profile = $1::jsonb
     WHERE id = $2 AND workspace_id = $3
     RETURNING id, safety_profile`,
    [JSON.stringify(clean), req.params.agentId, req.params.workspaceId],
  )
  if (!rows[0]) return res.status(404).json({ ok: false })
  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true, agent: { id: rows[0].id, safety_profile: rows[0].safety_profile } })
})

// Re-role: swap an agent into a canonical preset (coach/researcher/coder/…).
// Available to all tiers — this is how a free user makes their one agent useful
// without authoring a custom soul. The soul text is taken from the SERVER-side
// template, never from the client, so the preset path can't be used to smuggle
// in custom souls past the free-tier gate.
admin.post('/:workspaceId/agents/:agentId/role', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const templateId = typeof req.body?.template_id === 'string' ? req.body.template_id : ''
  const tpl = getTemplate(templateId)
  if (!tpl) return res.status(400).json({ ok: false, error: 'unknown role' })

  const { rows: existing } = await db.query<{ soul_md: string }>(
    `SELECT soul_md FROM agents WHERE id = $1 AND workspace_id = $2`,
    [req.params.agentId, req.params.workspaceId],
  )
  if (!existing[0]) return res.status(404).json({ ok: false })

  const { rows } = await db.query(
    `UPDATE agents SET name = $1, avatar = $2, soul_md = $3
       WHERE id = $4 AND workspace_id = $5
       RETURNING id, name, avatar, model, soul_md, mission_md, identity_md, instructions, status`,
    [tpl.name, tpl.avatar_path, tpl.soul_md, req.params.agentId, req.params.workspaceId],
  )

  if (tpl.soul_md !== existing[0].soul_md) {
    await db.query(
      `INSERT INTO agent_versions (agent_id, soul_md, mission_md, identity_md, saved_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.agentId, rows[0].soul_md, rows[0].mission_md, rows[0].identity_md, req.user.id],
    )
  }

  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true, agent: rows[0] })
})

// Upload a custom avatar image for an agent. Raw body, MIME via Content-Type.
admin.post(
  '/:workspaceId/agents/:agentId/avatar',
  express.raw({ type: 'image/*', limit: AVATAR_MAX_BYTES }),
  async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false })
    if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
      return res.status(403).json({ ok: false })
    }
    const mime = (req.header('content-type') ?? '').split(';')[0].trim()
    const ext = AVATAR_EXT[mime]
    if (!ext) return res.status(415).json({ ok: false, error: 'unsupported image type' })
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty body' })
    }
    if (body.length > AVATAR_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'file too large' })
    }
    const { rows: ag } = await db.query(
      `SELECT 1 FROM agents WHERE id = $1 AND workspace_id = $2`,
      [req.params.agentId, req.params.workspaceId],
    )
    if (!ag[0]) return res.status(404).json({ ok: false })

    await fs.mkdir(AVATAR_DIR, { recursive: true })
    // One stored file per agent; drop any stale other-extension copies.
    for (const e of Object.values(AVATAR_EXT)) {
      if (e !== ext) {
        await fs.unlink(path.join(AVATAR_DIR, `${req.params.agentId}.${e}`)).catch(() => {})
      }
    }
    await fs.writeFile(path.join(AVATAR_DIR, `${req.params.agentId}.${ext}`), body)

    const url = `/api/workspaces/${req.params.workspaceId}/agents/${req.params.agentId}/avatar?v=${Date.now()}`
    await db.query(
      `UPDATE agents SET avatar = $1 WHERE id = $2 AND workspace_id = $3`,
      [url, req.params.agentId, req.params.workspaceId],
    )
    broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
    res.json({ ok: true, avatar: url })
  },
)

// Serve a previously uploaded avatar. Immutable cache — the URL is versioned.
admin.get('/:workspaceId/agents/:agentId/avatar', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  for (const [mime, ext] of Object.entries(AVATAR_EXT)) {
    const p = path.join(AVATAR_DIR, `${req.params.agentId}.${ext}`)
    try {
      await fs.access(p)
      res.setHeader('Content-Type', mime)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      return res.sendFile(p)
    } catch {
      // try next extension
    }
  }
  return res.status(404).json({ ok: false })
})

admin.delete('/:workspaceId/agents/:agentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rowCount } = await db.query(
    `DELETE FROM agents WHERE id = $1 AND workspace_id = $2`,
    [req.params.agentId, req.params.workspaceId],
  )
  if (rowCount === 0) return res.status(404).json({ ok: false })
  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true })
})

// ---------- Surprise me: generate a fresh agent SOUL ----------

admin.post('/:workspaceId/agents/generate-soul', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  if (!(await workspaceOwnerEntitled(req.params.workspaceId))) {
    return res.status(402).json({
      ok: false,
      code: 'upgrade_required',
      error: 'AI-generated souls are a Standard feature. Upgrade to use “Surprise me”, or pick a preset role.',
    })
  }
  const hint = typeof req.body?.hint === 'string' ? req.body.hint.trim().slice(0, 200) : ''
  const prompt = [
    `Invent a fresh, distinctive AI agent persona.`,
    hint ? `Optional theme/hint: "${hint}".` : `Pick any interesting angle — useful, niche, surprising, but not silly.`,
    `Output JSON only, no markdown fences, with this exact shape:`,
    `{ "name": "<single word, no spaces>", "avatar": "<single emoji>", "soul_md": "<the SOUL markdown>" }`,
    ``,
    `SOUL guidelines:`,
    `- ~150-250 words`,
    `- Sections: ## Who I Am, ## How I Show Up (bullet list), ## What I Care About, ## My Commitments`,
    `- Direct, warm voice. No corporate filler.`,
    `- Concrete behaviors over abstract values ("I cite sources" beats "I value accuracy").`,
    `- The persona describes the AGENT itself — their voice, instincts, working style. Do not reference any particular product, company, workspace, project, or platform name. The agent's value is who they are, not where they happen to be deployed.`,
  ].join('\n')

  const { studioComplete } = await import('./studio-llm.js')
  const text = await studioComplete({ prompt })

  // Strip any accidental code fences and parse
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (typeof parsed?.name !== 'string' || typeof parsed?.soul_md !== 'string') {
      return res.status(502).json({ ok: false, error: 'malformed generation' })
    }
    res.json({
      ok: true,
      template: {
        name: String(parsed.name).slice(0, 40),
        avatar: typeof parsed.avatar === 'string' ? parsed.avatar.slice(0, 4) : '🤖',
        soul_md: String(parsed.soul_md),
      },
    })
  } catch {
    res.status(502).json({ ok: false, error: 'generator returned non-JSON', raw: text.slice(0, 400) })
  }
})

// ---------- Pro tier upgrade ----------

// Pricing surface — single source of truth (Pricing & Features v1, ratified
// 2026-06-15). Model: a $15/mo Standard seat (the billable platform-access unit)
// plus a FLAT per-VPS Pro add-on. A Pro VPS holds up to PRO_VPS_AGENT_CAP agents
// at one flat price regardless of how many (1–3) run on it; a 4th agent needs a
// second VPS. This supersedes the old per-agent Pro Solo/Crew/Brigade tiers.
export const STANDARD_SEAT_USD = 15
export const FOUNDING_SEAT_USD = 10
export const ANNUAL_MONTHS_CHARGED = 10 // "pay 10 months, get 12"
// Single source of truth lives in pro-colocation.ts; re-exported here so existing
// importers of admin.ts keep working.
export { PRO_VPS_AGENT_CAP }


// Workspace-level plan limits. The gating axis is Free vs. Standard; Pro is an
// orthogonal per-agent/per-VPS add-on. `workspaces_total` counts every workspace
// the user OWNS (their personal one + any shared ones they created); joining a
// workspace by invite is always free and doesn't count.
export const PLAN_LIMITS = {
  free: { standard_agents: FREE_AGENT_LIMIT, workspaces_total: 1 },
  standard: { standard_agents: null as number | null, workspaces_total: 3 }, // null = unlimited
} as const



// ---------- Pro droplet info + downgrade ----------

admin.get('/:workspaceId/agents/:agentId/pro-droplet', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  if (isStandalone()) return res.json({ ok: true, droplet: null })
  const { getProDropletInfo } = await import(PRO_PROVISIONER_MOD)
  // Contain any failure here: an unguarded throw in droplet-info was crashing the
  // whole backend (unhandled rejection), which made unrelated pages like agent
  // settings hang on "Loading…". Degrade to droplet: null instead.
  let info = null
  try {
    info = await getProDropletInfo(req.params.agentId)
  } catch (e) {
    console.error('[pro-droplet] info fetch failed:', (e as Error)?.message)
  }
  res.json({ ok: true, droplet: info })
})


// Reset workspace: nuke all of the calling user's workspace data (channels,
// messages, agents, documents, attachments) AND tear down any Pro droplets
// they own. Then re-seed a fresh workspace via ensureWorkspaceForUser so they
// experience the new-subscriber onboarding from scratch.
admin.post('/:workspaceId/reset', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  if (req.body?.confirmed !== true) {
    return res.status(400).json({ ok: false, error: 'must confirm reset' })
  }

  // Destroy any Pro droplets first (per agent).
  const proAgents = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = $1 AND hosting = 'pro_droplet'`,
    [req.params.workspaceId],
  )
  // Standalone has no Pro droplets; only load the provisioner when there are any
  // to tear down (its source isn't shipped in the self-host build).
  if (proAgents.rows.length) {
    const { destroyPro } = await import(PRO_PROVISIONER_MOD)
    for (const a of proAgents.rows) {
      await destroyPro(a.id).catch((e: unknown) => console.error('[reset] server destroy failed:', e))
    }
  }

  // Drop the workspace; FKs cascade to channels/messages/agents/docs/etc.
  await db.query(`DELETE FROM workspaces WHERE id = $1`, [req.params.workspaceId])

  // Re-seed.
  const { ensureWorkspaceForUser } = await import('./workspace.js')
  await ensureWorkspaceForUser(req.user.id, req.user.name ?? req.user.email)

  broadcastToAll({ type: 'workspace_reset', userId: req.user.id })
  res.json({ ok: true, destroyedDroplets: proAgents.rows.length })
})


// ---------- External agent token (Pro tier) ----------

// Rotate (or initially create) the bearer token used between the workspace and
// the agent's remote OpenClaw droplet. The returned token is shown ONCE; the
// subscriber stores it on the droplet side.
admin.post('/:workspaceId/agents/:agentId/external/token', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const token = 'bw_' + randomBytes(32).toString('hex')
  const { rows } = await db.query(
    `UPDATE agents SET external_token = $1
     WHERE id = $2 AND workspace_id = $3
     RETURNING id`,
    [token, req.params.agentId, req.params.workspaceId],
  )
  if (!rows[0]) return res.status(404).json({ ok: false })
  res.json({ ok: true, token })
})

// ---------- Pro agent Claude subscription (OAuth) ----------

// GET the current OAuth status of a Pro agent's bridge. Returns:
//   - { ok: true, auth_mode: 'oauth' | 'api_key', online: true }
//   - { ok: true, online: false, error: '...' } if the bridge isn't reachable
admin.get('/:workspaceId/agents/:agentId/claude-oauth/status', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rows } = await db.query<{ external_url: string | null; external_token: string | null; external_tls_cert: string | null }>(
    `SELECT external_url, external_token, external_tls_cert FROM agents
     WHERE id = $1 AND workspace_id = $2`,
    [req.params.agentId, req.params.workspaceId],
  )
  if (!rows[0]?.external_url || !rows[0]?.external_token) {
    return res.json({ ok: true, online: false, error: 'agent has no Pro droplet' })
  }
  try {
    const r = await bridgeFetch(rows[0].external_url.replace(/\/$/, '') + '/health', {
      timeoutMs: 5000,
      certPem: rows[0].external_tls_cert,
    })
    if (!r.ok) return res.json({ ok: true, online: false, error: `bridge returned ${r.status}` })
    const j = await r.json() as { auth_mode?: string }
    res.json({ ok: true, online: true, auth_mode: j.auth_mode ?? 'api_key' })
  } catch (e) {
    res.json({ ok: true, online: false, error: (e as Error).message })
  }
})

// Connect a Pro agent to the user's Claude subscription by POSTing the
// OAuth token to the bridge's /setup/oauth endpoint. The bridge persists it
// to /opt/bridge/.env and exits so systemd restarts with the new env.
admin.post('/:workspaceId/agents/:agentId/claude-oauth/connect', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  if (!token) return res.status(400).json({ ok: false, error: 'token required' })

  const { rows } = await db.query<{ external_url: string | null; external_token: string | null; external_tls_cert: string | null }>(
    `SELECT external_url, external_token, external_tls_cert FROM agents
     WHERE id = $1 AND workspace_id = $2 AND hosting = 'pro_droplet'`,
    [req.params.agentId, req.params.workspaceId],
  )
  if (!rows[0]?.external_url || !rows[0]?.external_token) {
    return res.status(400).json({ ok: false, error: 'agent is not a Pro droplet' })
  }
  try {
    const r = await bridgeFetch(rows[0].external_url.replace(/\/$/, '') + '/setup/oauth', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${rows[0].external_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
      timeoutMs: 10_000,
      certPem: rows[0].external_tls_cert,
    })
    const j = await r.json() as { ok: boolean; error?: string }
    if (!r.ok || !j.ok) {
      return res.status(400).json({ ok: false, error: j.error ?? `bridge returned ${r.status}` })
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
})

admin.post('/:workspaceId/agents/:agentId/claude-oauth/disconnect', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rows } = await db.query<{ external_url: string | null; external_token: string | null; external_tls_cert: string | null }>(
    `SELECT external_url, external_token, external_tls_cert FROM agents
     WHERE id = $1 AND workspace_id = $2 AND hosting = 'pro_droplet'`,
    [req.params.agentId, req.params.workspaceId],
  )
  if (!rows[0]?.external_url || !rows[0]?.external_token) {
    return res.status(400).json({ ok: false, error: 'agent is not a Pro droplet' })
  }
  try {
    const r = await bridgeFetch(rows[0].external_url.replace(/\/$/, '') + '/setup/oauth/clear', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${rows[0].external_token}` },
      timeoutMs: 10_000,
      certPem: rows[0].external_tls_cert,
    })
    const j = await r.json() as { ok: boolean; error?: string }
    if (!r.ok || !j.ok) {
      return res.status(400).json({ ok: false, error: j.error ?? `bridge returned ${r.status}` })
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
})

// ---------- Agent versions ----------

admin.get('/:workspaceId/agents/:agentId/versions', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rows } = await db.query(
    `SELECT v.id, v.saved_at, v.soul_md, u.name AS saved_by_name
     FROM agent_versions v
     LEFT JOIN users u ON u.id = v.saved_by_user_id
     WHERE v.agent_id = $1
     ORDER BY v.saved_at DESC
     LIMIT 50`,
    [req.params.agentId],
  )
  res.json({ ok: true, versions: rows })
})

admin.post('/:workspaceId/agents/:agentId/versions/:versionId/restore', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rows: v } = await db.query(
    `SELECT soul_md, mission_md, identity_md FROM agent_versions
     WHERE id = $1 AND agent_id = $2`,
    [req.params.versionId, req.params.agentId],
  )
  if (!v[0]) return res.status(404).json({ ok: false })

  await db.query(
    `UPDATE agents SET soul_md = $1, mission_md = $2, identity_md = $3
     WHERE id = $4 AND workspace_id = $5`,
    [v[0].soul_md, v[0].mission_md, v[0].identity_md, req.params.agentId, req.params.workspaceId],
  )
  // Record restore as a new version snapshot
  await db.query(
    `INSERT INTO agent_versions (agent_id, soul_md, mission_md, identity_md, saved_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.params.agentId, v[0].soul_md, v[0].mission_md, v[0].identity_md, req.user.id],
  )

  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true })
})

// ---------- Channel-agent membership ----------

admin.post('/:workspaceId/channels/:channelId/agents/:agentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  await db.query(
    `INSERT INTO channel_agents (channel_id, agent_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [req.params.channelId, req.params.agentId],
  )
  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true })
})

admin.delete('/:workspaceId/channels/:channelId/agents/:agentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userOwnsOrAdmins(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  await db.query(
    `DELETE FROM channel_agents WHERE channel_id = $1 AND agent_id = $2`,
    [req.params.channelId, req.params.agentId],
  )
  broadcastToAll({ type: 'agents_updated', workspaceId: req.params.workspaceId })
  res.json({ ok: true })
})
