import { Router } from 'express'
import { db } from './db.js'
import { broadcastToAll } from './realtime.js'
import { resolveBody } from './checkbox.js'
import { pushDocument } from './github-sync.js'

// Mirror a document to its GitHub repo if the workspace has doc-sync connected.
// Fire-and-forget: a sync hiccup must never fail the user's save.
function syncToGithub(workspaceId: string, documentId: string): void {
  pushDocument(workspaceId, documentId).catch(e => console.error('[github-sync] push', documentId, e))
}

export const documents = Router()

async function userInWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  return rows.length > 0
}

// Resolve a requested channel_id to one that actually belongs to the workspace.
// Returns the validated id, or null (= workspace-level doc) if absent/invalid.
async function resolveChannelId(workspaceId: string, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !raw) return null
  const { rows } = await db.query(
    `SELECT 1 FROM channels WHERE id = $1 AND workspace_id = $2`,
    [raw, workspaceId],
  )
  return rows.length > 0 ? raw : null
}

documents.get('/:workspaceId/documents', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  // Optional ?channel_id= filter scopes the list to one channel's docs.
  const channelFilter = typeof req.query.channel_id === 'string' ? req.query.channel_id : null
  const params: unknown[] = [req.params.workspaceId]
  let where = `workspace_id = $1`
  if (channelFilter) {
    params.push(channelFilter)
    where += ` AND channel_id = $2`
  }
  const { rows } = await db.query(
    `SELECT id, title, folder, channel_id, pinned, updated_at FROM documents
     WHERE ${where}
     ORDER BY pinned DESC, updated_at DESC`,
    params,
  )
  res.json({ ok: true, documents: rows })
})

documents.post('/:workspaceId/documents', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  if (!title) return res.status(400).json({ ok: false, error: 'title required' })
  const body_md = typeof req.body?.body_md === 'string' ? req.body.body_md : ''
  const folder = typeof req.body?.folder === 'string' && req.body.folder.trim()
    ? req.body.folder.trim()
    : null
  const channelId = await resolveChannelId(req.params.workspaceId, req.body?.channel_id)
  const { rows } = await db.query(
    `INSERT INTO documents (workspace_id, channel_id, title, body_md, folder, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, body_md, state, folder, channel_id, pinned, updated_at`,
    [req.params.workspaceId, channelId, title, body_md, folder, req.user.id],
  )
  broadcastToAll({ type: 'document_updated', documentId: rows[0].id })
  syncToGithub(req.params.workspaceId, rows[0].id)
  res.json({ ok: true, document: rows[0] })
})

documents.get('/:workspaceId/documents/:documentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rows } = await db.query(
    `SELECT id, title, body_md, state, folder, channel_id, pinned, updated_at
     FROM documents WHERE id = $1 AND workspace_id = $2`,
    [req.params.documentId, req.params.workspaceId],
  )
  if (!rows[0]) return res.status(404).json({ ok: false })
  res.json({ ok: true, document: rows[0] })
})

// Update body and/or title — full replace of body_md. State is *not* clobbered here;
// the front-end keeps state intact across body edits because state is keyed by element id.
documents.patch('/:workspaceId/documents/:documentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const updates: string[] = []
  const params: unknown[] = []
  let i = 1
  if (typeof req.body?.title === 'string') {
    updates.push(`title = $${i++}`)
    params.push(req.body.title.trim())
  }
  if (typeof req.body?.body_md === 'string') {
    updates.push(`body_md = $${i++}`)
    params.push(req.body.body_md)
  }
  if ('folder' in (req.body ?? {})) {
    updates.push(`folder = $${i++}`)
    const f = req.body.folder
    params.push(typeof f === 'string' && f.trim() ? f.trim() : null)
  }
  // Move a doc between channels (or to workspace-level with null).
  if ('channel_id' in (req.body ?? {})) {
    updates.push(`channel_id = $${i++}`)
    params.push(await resolveChannelId(req.params.workspaceId, req.body.channel_id))
  }
  if (typeof req.body?.pinned === 'boolean') {
    updates.push(`pinned = $${i++}`)
    params.push(req.body.pinned)
  }
  if (updates.length === 0) return res.status(400).json({ ok: false, error: 'nothing to update' })
  updates.push(`updated_at = now()`)
  params.push(req.params.documentId, req.params.workspaceId)

  const { rows } = await db.query(
    `UPDATE documents SET ${updates.join(', ')}
     WHERE id = $${i++} AND workspace_id = $${i}
     RETURNING id, title, body_md, state, folder, channel_id, pinned, updated_at`,
    params,
  )
  if (!rows[0]) return res.status(404).json({ ok: false })
  broadcastToAll({ type: 'document_updated', documentId: rows[0].id })
  syncToGithub(req.params.workspaceId, rows[0].id)
  res.json({ ok: true, document: rows[0] })
})

// Toggle / set a single state value (e.g., a checkbox keyed by stable element id).
documents.put('/:workspaceId/documents/:documentId/state/:key', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const value = req.body?.value
  if (value === undefined) return res.status(400).json({ ok: false, error: 'value required' })

  const { rows } = await db.query(
    `UPDATE documents
     SET state = jsonb_set(state, ARRAY[$3]::text[], $4::jsonb, true),
         updated_at = now()
     WHERE id = $1 AND workspace_id = $2
     RETURNING id, state, updated_at`,
    [req.params.documentId, req.params.workspaceId, req.params.key, JSON.stringify(value)],
  )
  if (!rows[0]) return res.status(404).json({ ok: false })
  broadcastToAll({ type: 'document_updated', documentId: rows[0].id })
  res.json({ ok: true, document: rows[0] })
})

// Download as plain markdown with current checkbox state baked in.
documents.get('/:workspaceId/documents/:documentId/download', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rows } = await db.query(
    `SELECT title, body_md, state FROM documents WHERE id = $1 AND workspace_id = $2`,
    [req.params.documentId, req.params.workspaceId],
  )
  if (!rows[0]) return res.status(404).json({ ok: false })
  const resolved = resolveBody(rows[0].body_md, rows[0].state ?? {})
  const slug = (rows[0].title as string)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${slug || 'document'}.md"`)
  res.send(resolved)
})

documents.delete('/:workspaceId/documents/:documentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const { rowCount } = await db.query(
    `DELETE FROM documents WHERE id = $1 AND workspace_id = $2`,
    [req.params.documentId, req.params.workspaceId],
  )
  if (rowCount === 0) return res.status(404).json({ ok: false })
  broadcastToAll({ type: 'document_deleted', documentId: req.params.documentId })
  res.json({ ok: true })
})
