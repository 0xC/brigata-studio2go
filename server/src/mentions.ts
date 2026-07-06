// Human @mentions in shared spaces.
//
// Today @mentions only summon agents (see agents.ts). This module resolves the
// SAME @token syntax against the workspace's HUMAN members and records a mention
// row per (message, mentioned human) so we can surface it in-app and, if it stays
// unseen, email a "what you missed" digest (mention-digest.ts).
//
// Matching: messages mention people by a single token — `@chris`. We match that
// token against each member's display name, on the first word (lowercased) OR the
// whole name with spaces stripped ("chrishager"). A bare first name that several
// members share mentions all of them; that's the honest v1 behaviour until we add
// an autocomplete picker that disambiguates at compose time.
import { db } from './db.js'

const MENTION_RE = /@(\w[\w-]*)/g

export function parseMentionTokens(body: string): Set<string> {
  const out = new Set<string>()
  for (const m of body.matchAll(MENTION_RE)) out.add(m[1].toLowerCase())
  return out
}

// Candidate @-handles a member answers to, derived from their display name.
function handlesFor(name: string): string[] {
  const n = name.trim().toLowerCase()
  if (!n) return []
  const first = n.split(/\s+/)[0]
  const squashed = n.replace(/\s+/g, '')
  return squashed === first ? [first] : [first, squashed]
}

export interface ResolvedMention {
  userId: string
  name: string
}

// Resolve the @tokens in `body` to human members of the workspace, excluding the
// sender (no self-mentions). Returns one entry per distinct matched user.
export async function resolveHumanMentions(
  workspaceId: string,
  body: string,
  excludeUserId: string | null,
): Promise<ResolvedMention[]> {
  const tokens = parseMentionTokens(body)
  if (tokens.size === 0) return []

  const { rows } = await db.query<{ user_id: string; name: string }>(
    `SELECT wm.user_id, COALESCE(wm.display_name, u.name, u.email) AS name
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1`,
    [workspaceId],
  )

  const matched = new Map<string, ResolvedMention>()
  for (const r of rows) {
    if (excludeUserId && r.user_id === excludeUserId) continue
    if (!r.name) continue
    if (handlesFor(r.name).some(h => tokens.has(h))) {
      matched.set(r.user_id, { userId: r.user_id, name: r.name })
    }
  }
  return [...matched.values()]
}

// Resolve + persist mentions for a freshly-stored message. Idempotent per
// (message, user) via the table's UNIQUE constraint. Returns the mentioned users
// so the caller can include them in the realtime broadcast.
export async function recordHumanMentions(opts: {
  workspaceId: string
  channelId: string
  messageId: string
  body: string
  senderUserId: string | null
}): Promise<ResolvedMention[]> {
  const mentions = await resolveHumanMentions(opts.workspaceId, opts.body, opts.senderUserId)
  for (const m of mentions) {
    await db.query(
      `INSERT INTO message_mentions
         (message_id, channel_id, workspace_id, mentioned_user_id, mentioned_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, mentioned_user_id) DO NOTHING`,
      [opts.messageId, opts.channelId, opts.workspaceId, m.userId, opts.senderUserId],
    )
  }
  return mentions
}

// Mentioned-user-ids per message, for hydrating a channel's history so past
// mentions render highlighted (not just live ones).
export async function loadMentionsForMessages(messageIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (messageIds.length === 0) return out
  const { rows } = await db.query<{ message_id: string; mentioned_user_id: string }>(
    `SELECT message_id, mentioned_user_id FROM message_mentions WHERE message_id = ANY($1)`,
    [messageIds],
  )
  for (const r of rows) {
    const list = out.get(r.message_id) ?? []
    list.push(r.mentioned_user_id)
    out.set(r.message_id, list)
  }
  return out
}

// Mark a user's mentions in a channel as seen — called when they open the channel
// (the /seen endpoint). Only stamps the ones still unseen so created-once stays put.
export async function markMentionsSeen(channelId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE message_mentions
        SET seen_at = now()
      WHERE channel_id = $1 AND mentioned_user_id = $2 AND seen_at IS NULL`,
    [channelId, userId],
  )
}

// Unseen-mention counts per channel for a user (used to badge channels where the
// user was specifically addressed, distinct from the plain unread count).
export async function unseenMentionCounts(
  workspaceId: string,
  userId: string,
): Promise<Record<string, number>> {
  const { rows } = await db.query<{ channel_id: string; n: string }>(
    `SELECT mm.channel_id, COUNT(*)::int AS n
       FROM message_mentions mm
      WHERE mm.workspace_id = $1 AND mm.mentioned_user_id = $2 AND mm.seen_at IS NULL
      GROUP BY mm.channel_id`,
    [workspaceId, userId],
  )
  const out: Record<string, number> = {}
  for (const r of rows) {
    const n = Number(r.n)
    if (n > 0) out[r.channel_id] = n
  }
  return out
}
