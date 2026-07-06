import { Router } from 'express'
import { db } from './db.js'
import { broadcastToChannel } from './realtime.js'
import { maybeRespondAsAgents } from './agents.js'
import { forwardOutbound } from './bridges.js'
import { claimAttachmentsForMessage, loadAttachmentsForMessages } from './attachments.js'
import { recordHumanMentions, markMentionsSeen, loadMentionsForMessages, unseenMentionCounts } from './mentions.js'

export const messages = Router()

async function userInWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  return rows.length > 0
}

async function channelInWorkspace(channelId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM channels WHERE id = $1 AND workspace_id = $2`,
    [channelId, workspaceId],
  )
  return rows.length > 0
}

interface ReplyPreview { id: string; sender_kind: string; sender_label: string; excerpt: string }

// Denormalized reply previews (author + snippet) for a set of parent message ids.
async function loadReplyPreviews(parentIds: string[]): Promise<Map<string, ReplyPreview>> {
  const ids = [...new Set(parentIds.filter(Boolean))]
  const map = new Map<string, ReplyPreview>()
  if (ids.length === 0) return map
  const { rows } = await db.query<ReplyPreview>(
    `SELECT m.id, m.sender_kind,
            COALESCE(wm.display_name, u.name, a.name, 'Unknown') AS sender_label,
            left(m.body, 140) AS excerpt
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_user_id
     LEFT JOIN channels c ON c.id = m.channel_id
     LEFT JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = m.sender_user_id
     LEFT JOIN agents a ON a.id = m.sender_agent_id
     WHERE m.id = ANY($1)`,
    [ids],
  )
  for (const r of rows) map.set(r.id, r)
  return map
}

interface ReactionAgg { emoji: string; count: number; mine: boolean }

// Reactions aggregated per message ({emoji, count, mine}), for the given viewer.
async function loadReactions(messageIds: string[], userId: string): Promise<Map<string, ReactionAgg[]>> {
  const ids = [...new Set(messageIds.filter(Boolean))]
  const map = new Map<string, ReactionAgg[]>()
  if (ids.length === 0) return map
  const { rows } = await db.query<{ message_id: string; emoji: string; count: number; mine: boolean }>(
    `SELECT message_id, emoji, COUNT(*)::int AS count, bool_or(user_id = $2) AS mine
     FROM message_reactions
     WHERE message_id = ANY($1)
     GROUP BY message_id, emoji
     ORDER BY min(created_at)`,
    [ids, userId],
  )
  for (const r of rows) {
    const list = map.get(r.message_id) ?? []
    list.push({ emoji: r.emoji, count: r.count, mine: r.mine })
    map.set(r.message_id, list)
  }
  return map
}

// Per-user unread counts across channels in a workspace.
messages.get('/:workspaceId/unread', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { workspaceId } = req.params
  if (!(await userInWorkspace(req.user.id, workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rows } = await db.query<{ channel_id: string; unread: string }>(
    `SELECT c.id AS channel_id,
            COUNT(m.id) FILTER (
              WHERE m.created_at > COALESCE(cv.last_seen_at, '1970-01-01'::timestamptz)
                AND (m.sender_user_id IS NULL OR m.sender_user_id <> $1)
            ) AS unread
     FROM channels c
     LEFT JOIN channel_views cv ON cv.channel_id = c.id AND cv.user_id = $1
     LEFT JOIN messages m ON m.channel_id = c.id
     WHERE c.workspace_id = $2
     GROUP BY c.id, cv.last_seen_at`,
    [req.user.id, workspaceId],
  )
  const unread: Record<string, number> = {}
  for (const r of rows) {
    const n = Number(r.unread)
    if (n > 0) unread[r.channel_id] = n
  }
  // Per-channel unseen @mention counts (distinct from plain unread — a mention is
  // a direct address and gets a stronger badge in the UI).
  const mentions = await unseenMentionCounts(workspaceId, req.user.id)
  res.json({ ok: true, unread, mentions })
})

// Mark a channel as seen (called when the user opens it).
messages.post('/:workspaceId/channels/:channelId/seen', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { workspaceId, channelId } = req.params
  if (!(await userInWorkspace(req.user.id, workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  if (!(await channelInWorkspace(channelId, workspaceId))) {
    return res.status(404).json({ ok: false })
  }
  await db.query(
    `INSERT INTO channel_views (channel_id, user_id, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (channel_id, user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
    [channelId, req.user.id],
  )
  // Opening the channel clears any pending @mentions for this user there.
  await markMentionsSeen(channelId, req.user.id)
  res.json({ ok: true })
})

messages.get('/:workspaceId/channels/:channelId/messages', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { workspaceId, channelId } = req.params
  if (!(await userInWorkspace(req.user.id, workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  if (!(await channelInWorkspace(channelId, workspaceId))) {
    return res.status(404).json({ ok: false })
  }
  const { rows } = await db.query<{ id: string; reply_to_id: string | null; [k: string]: unknown }>(
    `SELECT m.id, m.sender_kind, m.body, m.created_at, m.turn_ms, m.reply_to_id, m.sender_user_id,
            COALESCE(wm.display_name, u.name) AS user_name, u.avatar_url AS user_avatar,
            a.name AS agent_name, a.avatar AS agent_avatar, a.hosting AS agent_hosting, a.model AS model
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_user_id
     LEFT JOIN channels c ON c.id = m.channel_id
     LEFT JOIN workspace_members wm
       ON wm.workspace_id = c.workspace_id AND wm.user_id = m.sender_user_id
     LEFT JOIN agents a ON a.id = m.sender_agent_id
     WHERE m.channel_id = $1
     ORDER BY m.created_at ASC
     LIMIT 200`,
    [channelId],
  )
  const attachmentsByMsg = await loadAttachmentsForMessages(rows.map(r => r.id))
  const replyPreviews = await loadReplyPreviews(rows.map(r => r.reply_to_id).filter((x): x is string => !!x))
  const reactionsByMsg = await loadReactions(rows.map(r => r.id), req.user.id)
  const mentionsByMsg = await loadMentionsForMessages(rows.map(r => r.id))
  const withExtras = rows.map(r => ({
    ...r,
    attachments: (attachmentsByMsg.get(r.id) ?? []).map(a => ({
      id: a.id, kind: a.kind, filename: a.filename,
      mime_type: a.mime_type, size_bytes: a.size_bytes,
    })),
    reply_to: r.reply_to_id ? replyPreviews.get(r.reply_to_id) ?? null : null,
    reactions: reactionsByMsg.get(r.id) ?? [],
    mentioned_user_ids: mentionsByMsg.get(r.id) ?? [],
  }))
  res.json({ ok: true, messages: withExtras })
})

messages.post('/:workspaceId/channels/:channelId/messages', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { workspaceId, channelId } = req.params
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : ''
  const attachmentIds: string[] = Array.isArray(req.body?.attachment_ids)
    ? req.body.attachment_ids.filter((x: unknown): x is string => typeof x === 'string')
    : []
  if (!body && attachmentIds.length === 0) {
    return res.status(400).json({ ok: false, error: 'empty message' })
  }
  if (body.length > 8000) return res.status(400).json({ ok: false, error: 'too long' })
  if (!(await userInWorkspace(req.user.id, workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  if (!(await channelInWorkspace(channelId, workspaceId))) {
    return res.status(404).json({ ok: false })
  }

  // Reply target: must be a message in THIS channel (don't allow cross-channel
  // or arbitrary references). Silently null out an invalid ref rather than error.
  let replyToId: string | null = typeof req.body?.reply_to_id === 'string' ? req.body.reply_to_id : null
  if (replyToId) {
    const { rows: parent } = await db.query(
      `SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2`,
      [replyToId, channelId],
    )
    if (parent.length === 0) replyToId = null
  }

  const { rows } = await db.query(
    `INSERT INTO messages (channel_id, sender_kind, sender_user_id, body, source, reply_to_id)
     VALUES ($1, 'user', $2, $3, 'native', $4)
     RETURNING id, sender_kind, body, created_at, reply_to_id, sender_user_id`,
    [channelId, req.user.id, body, replyToId],
  )
  const messageId: string = rows[0].id
  await claimAttachmentsForMessage(workspaceId, messageId, attachmentIds)

  // Resolve the sender's per-workspace display name; fall back to their
  // Google profile name when unset.
  const { rows: memberRows } = await db.query<{ display_name: string | null }>(
    `SELECT display_name FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, req.user.id],
  )
  const senderName = memberRows[0]?.display_name?.trim() || req.user.name

  // Record @mentions of human members so they get surfaced/notified. Resolved
  // against this workspace's members (not agents — agents are handled separately).
  const humanMentions = await recordHumanMentions({
    workspaceId, channelId, messageId, body, senderUserId: req.user.id,
  })

  const attachments = await loadAttachmentsForMessages([messageId])
  const replyPreview = replyToId ? (await loadReplyPreviews([replyToId])).get(replyToId) ?? null : null
  const msg = {
    ...rows[0],
    user_name: senderName,
    user_avatar: req.user.avatar_url,
    agent_name: null,
    agent_avatar: null,
    attachments: (attachments.get(messageId) ?? []).map(a => ({
      id: a.id, kind: a.kind, filename: a.filename,
      mime_type: a.mime_type, size_bytes: a.size_bytes,
    })),
    reply_to: replyPreview,
    reactions: [],
    mentioned_user_ids: humanMentions.map(m => m.userId),
  }

  broadcastToChannel(channelId, { type: 'message', message: msg })

  // Mirror to Discord if this channel is bridged
  void forwardOutbound(channelId, body, 'native', req.user.name ?? req.user.email)

  // Fire-and-forget: any agents in this channel respond
  void maybeRespondAsAgents(channelId)

  res.json({ ok: true, message: msg })
})

// Toggle a reaction (emoji) on a message for the current user. Idempotent per
// (message, user, emoji): present → remove, absent → add. Broadcasts the updated
// aggregate so every client in the channel updates live.
messages.post('/:workspaceId/channels/:channelId/messages/:messageId/reactions', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { workspaceId, channelId, messageId } = req.params
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji.trim() : ''
  if (!emoji || emoji.length > 16) return res.status(400).json({ ok: false, error: 'emoji required' })
  if (!(await userInWorkspace(req.user.id, workspaceId))) return res.status(403).json({ ok: false })
  if (!(await channelInWorkspace(channelId, workspaceId))) return res.status(404).json({ ok: false })
  const { rows: m } = await db.query(
    `SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2`,
    [messageId, channelId],
  )
  if (m.length === 0) return res.status(404).json({ ok: false })

  const del = await db.query(
    `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
    [messageId, req.user.id, emoji],
  )
  if (del.rowCount === 0) {
    await db.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [messageId, req.user.id, emoji],
    )
  }

  const reactions = (await loadReactions([messageId], req.user.id)).get(messageId) ?? []
  // Broadcast emoji+count; each client keeps its own `mine` (viewer-specific).
  broadcastToChannel(channelId, { type: 'message_reactions', messageId, reactions })
  res.json({ ok: true, reactions })
})

// Edit a user's own message. Only the sender can edit, and only user-kind messages.
messages.patch('/:workspaceId/channels/:channelId/messages/:messageId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { workspaceId, channelId, messageId } = req.params
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : ''
  if (!body) return res.status(400).json({ ok: false, error: 'empty body' })
  if (body.length > 8000) return res.status(400).json({ ok: false, error: 'too long' })
  if (!(await userInWorkspace(req.user.id, workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const existing = await db.query<{ body: string }>(
    `SELECT body FROM messages
     WHERE id = $1 AND channel_id = $2 AND sender_kind = 'user' AND sender_user_id = $3`,
    [messageId, channelId, req.user.id],
  )
  if (!existing.rows[0]) return res.status(404).json({ ok: false })
  const oldBody = existing.rows[0].body
  await db.query(`UPDATE messages SET body = $1 WHERE id = $2`, [body, messageId])
  broadcastToChannel(channelId, { type: 'message_edited', messageId, body })

  // If the edit added a new @mention that wasn't in the old body, give agents a fresh chance to respond.
  const oldMentions = new Set<string>(
    (oldBody.match(/@[\w-]+/g) ?? []).map((s: string) => s.toLowerCase()),
  )
  const newMentions: string[] = (body.match(/@[\w-]+/g) ?? []).map((s: string) => s.toLowerCase())
  if (newMentions.some((m: string) => !oldMentions.has(m))) {
    void maybeRespondAsAgents(channelId)
  }
  res.json({ ok: true })
})

// Delete a user's own message (and any attached files via FK cascade).
messages.delete('/:workspaceId/channels/:channelId/messages/:messageId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { workspaceId, channelId, messageId } = req.params
  if (!(await userInWorkspace(req.user.id, workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rowCount } = await db.query(
    `DELETE FROM messages
     WHERE id = $1 AND channel_id = $2 AND sender_kind = 'user' AND sender_user_id = $3`,
    [messageId, channelId, req.user.id],
  )
  if (rowCount === 0) return res.status(404).json({ ok: false })
  broadcastToChannel(channelId, { type: 'message_deleted', messageId })
  res.json({ ok: true })
})
