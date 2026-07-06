import type Anthropic from '@anthropic-ai/sdk'
import { db } from './db.js'
import { broadcastToAll } from './realtime.js'
import { resolveBody, extractStateFromBody } from './checkbox.js'
import { isUuid, assertWorkspaceScope, DOC_ID_TOOLS } from './tool-guards.js'

export interface AgentToolContext {
  workspaceId: string
  agentId: string
  // The channel the agent is currently responding in. Documents are per-channel:
  // an agent sees its channel's docs (plus workspace-level ones) and new docs it
  // creates land in this channel. Optional for callers without a channel context.
  channelId?: string | null
}

export interface ToolResult {
  content: string
  is_error?: boolean
}


type ToolHandler = (input: unknown, ctx: AgentToolContext) => Promise<ToolResult>

export const tools: Anthropic.Tool[] = [
  {
    name: 'list_documents',
    description: 'List the documents in the current channel (plus any workspace-level docs). Returns id, title, folder (or null for "Inbox"), pinned flag, and last updated time. Documents can be organized into folders — pass a folder name when creating or editing to set/move it.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_document',
    description:
      'Read a document into YOUR context so you can answer questions about it, summarize it, or use it to inform your reply. Use this when YOU need the content — NOT when the user just wants to see the document themselves. If the user said "open", "show me", "pull up", or "bring up" a document, call `focus_document` instead so the document opens in their UI without you dumping the body into chat. Returns the title and the current markdown body, with task-list checkboxes already reflecting their up-to-date state (`- [x]` = checked, `- [ ]` = unchecked).',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to read' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'focus_document',
    description:
      'Open a document in the user\'s workspace UI. Use this when the user asks you to "open", "show me", "pull up", "bring up", or "display" a document — they want to look at it themselves, not have you paste it back to them. The document window appears in their view; you should NOT echo the contents in your reply. Returns only a short confirmation. If you need the body for your own reasoning, use `read_document` instead.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to open in the user\'s view' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'create_document',
    description: 'Create a new document in the current channel. Optionally set a folder to organize it. If folder is omitted, the document lands in "Inbox".',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body_md: { type: 'string', description: 'Initial markdown body' },
        folder: { type: 'string', description: 'Optional folder name (e.g. "Runbooks", "Research"). Created on-the-fly if it doesn\'t exist.' },
      },
      required: ['title', 'body_md'],
    },
  },
  {
    name: 'edit_document',
    description:
      'Replace the body of an existing document. The `- [x]` / `- [ ]` markers in the new body are taken as the up-to-date checkbox state. When revising, preserve the exact text of any task-list items you intend to leave with the same state — checkbox state is keyed by the trimmed text of each item, so changing the text resets it. Adding or removing items is fine. Optionally update the title or move to a different folder.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string' },
        title: { type: 'string' },
        body_md: { type: 'string' },
        folder: { type: 'string', description: 'Move the document to this folder. Pass "" (empty string) to move to Inbox.' },
      },
      required: ['document_id', 'body_md'],
    },
  },
  {
    name: 'append_to_document',
    description:
      'Append markdown to the END of an existing document WITHOUT resending the whole body. Strongly preferred over edit_document for large or growing documents — you only send the new content, which avoids the size/truncation limits of a full-body rewrite. Any `- [x]` / `- [ ]` markers in the appended text are added to the checkbox state.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string' },
        body_md: { type: 'string', description: 'Markdown to append to the end of the document.' },
      },
      required: ['document_id', 'body_md'],
    },
  },
  {
    name: 'delete_document',
    description:
      'Permanently delete a document. Only do this when the user has explicitly asked you to delete it — never on your own judgment. Confirm in your reply what you deleted.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string' },
      },
      required: ['document_id'],
    },
  },
]

const handlers: Record<string, ToolHandler> = {
  // Agent→agent handoff: delegate a task to another agent in this workspace.
  async hand_off_task(input, ctx) {
    const { to_agent, title, details } = input as { to_agent?: string; title?: string; details?: string }
    if (!to_agent || !title) return { content: 'to_agent and title are required', is_error: true }
    const { createTask, resolveRecipientAgent } = await import('./tasks.js')
    const recipient = await resolveRecipientAgent(ctx.workspaceId, to_agent)
    if (!recipient) return { content: `No agent matching "${to_agent}" in this workspace.`, is_error: true }
    if (recipient.id === ctx.agentId) return { content: 'Cannot hand off to yourself.', is_error: true }
    const { dispatchTask } = await import('./agents.js') // dynamic: avoids import cycle
    const task = await createTask({
      workspaceId: ctx.workspaceId, channelId: ctx.channelId ?? null, fromKind: 'agent',
      fromAgentId: ctx.agentId, toAgentId: recipient.id, title, bodyMd: details ?? '',
    })
    void dispatchTask(task.id).catch(() => {})
    return { content: `Handed off "${title}" to ${recipient.name} (task ${task.id}). They'll work it and reply in this channel.` }
  },

  async list_documents(_input, ctx) {
    // Scope to the agent's current channel (plus workspace-level docs with no
    // channel). Without a channel context, fall back to the full workspace list.
    if (ctx.channelId) {
      const { rows } = await db.query(
        `SELECT id, title, folder, pinned, updated_at FROM documents
         WHERE workspace_id = $1 AND (channel_id = $2 OR channel_id IS NULL)
         ORDER BY pinned DESC, folder NULLS FIRST, updated_at DESC`,
        [ctx.workspaceId, ctx.channelId],
      )
      return { content: JSON.stringify({ documents: rows }) }
    }
    const { rows } = await db.query(
      `SELECT id, title, folder, pinned, updated_at FROM documents
       WHERE workspace_id = $1 ORDER BY pinned DESC, folder NULLS FIRST, updated_at DESC`,
      [ctx.workspaceId],
    )
    return { content: JSON.stringify({ documents: rows }) }
  },

  async focus_document(input, ctx) {
    const { document_id } = input as { document_id: string }
    const { rows } = await db.query<{ title: string }>(
      `SELECT title FROM documents WHERE id = $1 AND workspace_id = $2`,
      [document_id, ctx.workspaceId],
    )
    if (!rows[0]) return { content: 'Document not found', is_error: true }
    broadcastToAll({ type: 'agent_document_focus', documentId: document_id })
    return { content: `Opened "${rows[0].title}" in the user's view. Do not paste the contents into chat — they can read it now.` }
  },

  async read_document(input, ctx) {
    const { document_id } = input as { document_id: string }
    const { rows } = await db.query(
      `SELECT id, title, body_md, state, updated_at
       FROM documents WHERE id = $1 AND workspace_id = $2`,
      [document_id, ctx.workspaceId],
    )
    if (!rows[0]) return { content: 'Document not found', is_error: true }
    const resolved = resolveBody(rows[0].body_md, rows[0].state ?? {})
    return {
      content: JSON.stringify({
        id: rows[0].id,
        title: rows[0].title,
        body_md: resolved,
        updated_at: rows[0].updated_at,
      }),
    }
  },

  async create_document(input, ctx) {
    const { title, body_md, folder } = input as { title: string; body_md: string; folder?: string }
    if (!title?.trim()) return { content: 'title required', is_error: true }
    const folderVal = typeof folder === 'string' && folder.trim() ? folder.trim() : null
    // New docs land in the channel the agent is working in (null = workspace-level).
    const { rows } = await db.query(
      `INSERT INTO documents (workspace_id, channel_id, title, body_md, folder, owner_user_id)
       VALUES ($1, $2, $3, $4, $5,
         (SELECT owner_user_id FROM workspaces WHERE id = $1))
       RETURNING id, title, folder, body_md, state, updated_at`,
      [ctx.workspaceId, ctx.channelId ?? null, title.trim(), body_md ?? '', folderVal],
    )
    broadcastToAll({ type: 'document_updated', documentId: rows[0].id })
    broadcastToAll({ type: 'agent_document_focus', documentId: rows[0].id })
    return { content: JSON.stringify(rows[0]) }
  },

  async delete_document(input, ctx) {
    const { document_id } = input as { document_id: string }
    const { rows } = await db.query<{ title: string }>(
      `DELETE FROM documents WHERE id = $1 AND workspace_id = $2 RETURNING title`,
      [document_id, ctx.workspaceId],
    )
    if (!rows[0]) return { content: 'Document not found (already deleted or wrong id)', is_error: true }
    broadcastToAll({ type: 'document_deleted', documentId: document_id })
    return { content: `Deleted document "${rows[0].title}".` }
  },

  async edit_document(input, ctx) {
    const { document_id, title, body_md, folder } = input as {
      document_id: string
      title?: string
      body_md: string
      folder?: string
    }
    // Load existing state so we can merge agent-supplied markers on top of it
    const existing = await db.query<{ state: Record<string, unknown> }>(
      `SELECT state FROM documents WHERE id = $1 AND workspace_id = $2`,
      [document_id, ctx.workspaceId],
    )
    if (!existing.rows[0]) return { content: 'Document not found', is_error: true }
    const fromMarkers = extractStateFromBody(body_md)
    const mergedState = { ...(existing.rows[0].state ?? {}), ...fromMarkers }

    const updates: string[] = ['body_md = $3', 'state = $4']
    const params: unknown[] = [document_id, ctx.workspaceId, body_md, JSON.stringify(mergedState)]
    let nextIdx = 5
    if (typeof title === 'string' && title.trim()) {
      updates.push(`title = $${nextIdx++}`)
      params.push(title.trim())
    }
    if (typeof folder === 'string') {
      updates.push(`folder = $${nextIdx++}`)
      params.push(folder.trim() ? folder.trim() : null)
    }
    updates.push('updated_at = now()')
    const { rows } = await db.query(
      `UPDATE documents SET ${updates.join(', ')}
       WHERE id = $1 AND workspace_id = $2
       RETURNING id, title, body_md, state, updated_at`,
      params,
    )
    if (!rows[0]) return { content: 'Document not found', is_error: true }
    broadcastToAll({ type: 'document_updated', documentId: rows[0].id })
    broadcastToAll({ type: 'agent_document_focus', documentId: rows[0].id })
    return {
      content: JSON.stringify({
        id: rows[0].id,
        title: rows[0].title,
        body_md: resolveBody(rows[0].body_md, rows[0].state ?? {}),
        updated_at: rows[0].updated_at,
      }),
    }
  },
  async append_to_document(input, ctx) {
    const { document_id, body_md } = input as { document_id: string; body_md: string }
    if (typeof body_md !== 'string' || !body_md) return { content: 'body_md required', is_error: true }
    const existing = await db.query<{ body_md: string; state: Record<string, unknown> }>(
      `SELECT body_md, state FROM documents WHERE id = $1 AND workspace_id = $2`,
      [document_id, ctx.workspaceId],
    )
    if (!existing.rows[0]) return { content: 'Document not found', is_error: true }
    const prev = existing.rows[0].body_md ?? ''
    const combined = prev ? prev.replace(/\s+$/, '') + '\n\n' + body_md : body_md
    // Re-derive checkbox state from the full combined body (keyed by item text).
    const mergedState = { ...(existing.rows[0].state ?? {}), ...extractStateFromBody(combined) }
    const { rows } = await db.query(
      `UPDATE documents SET body_md = $3, state = $4, updated_at = now()
       WHERE id = $1 AND workspace_id = $2
       RETURNING id, title, updated_at`,
      [document_id, ctx.workspaceId, combined, JSON.stringify(mergedState)],
    )
    if (!rows[0]) return { content: 'Document not found', is_error: true }
    broadcastToAll({ type: 'document_updated', documentId: rows[0].id })
    broadcastToAll({ type: 'agent_document_focus', documentId: rows[0].id })
    return { content: JSON.stringify({ id: rows[0].id, title: rows[0].title, appended_chars: body_md.length, updated_at: rows[0].updated_at }) }
  },
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: AgentToolContext,
): Promise<ToolResult> {
  const h = handlers[name]
  if (!h) return { content: `Unknown tool: ${name}`, is_error: true }
  try {
    assertWorkspaceScope(ctx.workspaceId)
    if (DOC_ID_TOOLS.has(name) && !isUuid((input as { document_id?: unknown })?.document_id)) {
      return { content: 'document_id must be a valid UUID', is_error: true }
    }
    return await h(input, ctx)
  } catch (e) {
    return { content: `Tool error: ${(e as Error).message}`, is_error: true }
  }
}
