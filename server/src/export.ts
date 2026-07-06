import { Router } from 'express'
import { db } from './db.js'

export const exportRouter = Router()

async function userInWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  return rows.length > 0
}

// Full workspace export as a single JSON document. Goal: every piece of user-owned
// data is recoverable from this file alone. Subscribers can download, store
// offline, or eventually re-import elsewhere.
//
// Future: provide an OpenClaw-compatible tarball for Pro-tier subscribers
// (sanitized openclaw.json + agents/<name>/{SOUL,MISSION,memory}.md).
exportRouter.get('/:workspaceId/export', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const wid = req.params.workspaceId

  const [ws, members, agents, agentVersions, channels, channelAgents, messages, documents, integrations] =
    await Promise.all([
      db.query(`SELECT id, name, plan, created_at FROM workspaces WHERE id = $1`, [wid]),
      db.query(
        `SELECT u.email, u.name, m.role, m.joined_at
         FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = $1`,
        [wid],
      ),
      db.query(
        `SELECT id, name, avatar, model, soul_md, mission_md, identity_md,
                hosting, status, created_at
         FROM agents WHERE workspace_id = $1 ORDER BY created_at`,
        [wid],
      ),
      db.query(
        `SELECT v.id, v.agent_id, v.soul_md, v.mission_md, v.identity_md, v.saved_at, u.email AS saved_by
         FROM agent_versions v
         LEFT JOIN users u ON u.id = v.saved_by_user_id
         WHERE v.agent_id IN (SELECT id FROM agents WHERE workspace_id = $1)
         ORDER BY v.saved_at`,
        [wid],
      ),
      db.query(
        `SELECT id, name, topic, created_at FROM channels WHERE workspace_id = $1 ORDER BY created_at`,
        [wid],
      ),
      db.query(
        `SELECT ca.channel_id, ca.agent_id, ca.added_at
         FROM channel_agents ca
         JOIN channels c ON c.id = ca.channel_id
         WHERE c.workspace_id = $1`,
        [wid],
      ),
      db.query(
        `SELECT m.id, m.channel_id, m.sender_kind, m.body, m.source, m.created_at,
                u.email AS user_email, a.name AS agent_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN agents a ON a.id = m.sender_agent_id
         WHERE m.channel_id IN (SELECT id FROM channels WHERE workspace_id = $1)
         ORDER BY m.created_at`,
        [wid],
      ),
      db.query(
        `SELECT id, title, body_md, state, owner_user_id, created_at, updated_at
         FROM documents WHERE workspace_id = $1 ORDER BY created_at`,
        [wid],
      ),
      db.query(
        `SELECT id, type, config, status, created_at FROM integrations WHERE workspace_id = $1`,
        [wid],
      ),
    ])

  const wsRow = ws.rows[0]
  if (!wsRow) return res.status(404).json({ ok: false })

  const bundle = {
    format: 'brigata-workspace-export/v1',
    exported_at: new Date().toISOString(),
    workspace: wsRow,
    members: members.rows,
    agents: agents.rows,
    agent_versions: agentVersions.rows,
    channels: channels.rows,
    channel_agents: channelAgents.rows,
    messages: messages.rows,
    documents: documents.rows,
    integrations: integrations.rows,
    notes_for_recipient: [
      'This file is a full export of your Brigata workspace.',
      'It contains everything you own: agent SOULs, channels, conversation history, documents, and settings.',
      'Re-import will be supported in a future release. Keep this file safe — it is your data, you can leave anytime.',
    ].join('\n'),
  }

  const slug = (wsRow.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="brigata-export-${slug}-${stamp}.json"`,
  )
  res.send(JSON.stringify(bundle, null, 2))
})
