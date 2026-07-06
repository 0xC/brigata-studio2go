import express, { type Request, type Response } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from './db.js'

export const attachments = express.Router()

async function userInWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  return rows.length > 0
}

const STORAGE_DIR = process.env.ATTACHMENT_STORAGE_DIR
  ? path.resolve(process.env.ATTACHMENT_STORAGE_DIR)
  : path.resolve(process.cwd(), 'uploads')

const MAX_BYTES = 25 * 1024 * 1024 // 25MB hard limit
const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/x-log', 'text/x-yaml',
  'application/json', 'application/yaml', 'application/x-yaml',
  'application/javascript', 'application/typescript', 'application/xml',
])
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const PDF_MIMES = new Set(['application/pdf'])

function classify(mime: string, filename: string): 'text' | 'image' | 'pdf' | 'other' {
  if (IMAGE_MIMES.has(mime)) return 'image'
  if (PDF_MIMES.has(mime)) return 'pdf'
  if (TEXT_MIMES.has(mime) || mime.startsWith('text/')) return 'text'
  // Fall through: many code/text files arrive as octet-stream — sniff by extension.
  const ext = path.extname(filename).toLowerCase()
  if (['.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.log', '.ts', '.tsx',
       '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
       '.hpp', '.css', '.html', '.xml', '.sql', '.sh', '.bash', '.zsh',
       '.toml', '.ini', '.env', '.conf'].includes(ext)) return 'text'
  return 'other'
}

async function ensureWorkspaceDir(workspaceId: string): Promise<string> {
  const dir = path.join(STORAGE_DIR, workspaceId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// POST upload: raw body, filename via X-Filename header, MIME via Content-Type.
// Single file per request; clients upload sequentially before send.
attachments.post(
  '/:workspaceId/attachments',
  express.raw({ type: '*/*', limit: MAX_BYTES }),
  async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ ok: false })
    if (!(await userInWorkspace(req.user.id, String(req.params.workspaceId)))) {
      return res.status(403).json({ ok: false })
    }
    const filenameRaw = req.header('x-filename') ?? 'attachment'
    const filename = path.basename(decodeURIComponent(filenameRaw)).slice(0, 200)
    const mime = (req.header('content-type') ?? 'application/octet-stream').split(';')[0].trim()
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty body' })
    }
    if (body.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'file too large' })
    }
    const kind = classify(mime, filename)

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO attachments
         (workspace_id, kind, filename, mime_type, size_bytes, storage_path, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, '', $6)
       RETURNING id`,
      [String(req.params.workspaceId), kind, filename, mime, body.length, req.user.id],
    )
    const id = rows[0].id
    const wsDir = await ensureWorkspaceDir(String(req.params.workspaceId))
    const storagePath = path.join(wsDir, id)
    await fs.writeFile(storagePath, body)
    await db.query(
      `UPDATE attachments SET storage_path = $1 WHERE id = $2`,
      [storagePath, id],
    )
    res.json({
      ok: true,
      attachment: { id, kind, filename, mime_type: mime, size_bytes: body.length },
    })
  },
)

attachments.get(
  '/:workspaceId/attachments/:id',
  async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ ok: false })
    if (!(await userInWorkspace(req.user.id, String(req.params.workspaceId)))) {
      return res.status(403).json({ ok: false })
    }
    const { rows } = await db.query(
      `SELECT id, kind, filename, mime_type, size_bytes, created_at
       FROM attachments WHERE id = $1 AND workspace_id = $2`,
      [String(req.params.id), String(req.params.workspaceId)],
    )
    if (!rows[0]) return res.status(404).json({ ok: false })
    res.json({ ok: true, attachment: rows[0] })
  },
)

attachments.get(
  '/:workspaceId/attachments/:id/download',
  async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ ok: false })
    if (!(await userInWorkspace(req.user.id, String(req.params.workspaceId)))) {
      return res.status(403).json({ ok: false })
    }
    const { rows } = await db.query<{
      filename: string; mime_type: string; storage_path: string
    }>(
      `SELECT filename, mime_type, storage_path
       FROM attachments WHERE id = $1 AND workspace_id = $2`,
      [String(req.params.id), String(req.params.workspaceId)],
    )
    if (!rows[0]) return res.status(404).json({ ok: false })
    res.setHeader('Content-Type', rows[0].mime_type)
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(rows[0].filename)}"`,
    )
    res.sendFile(rows[0].storage_path)
  },
)

attachments.delete(
  '/:workspaceId/attachments/:id',
  async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ ok: false })
    if (!(await userInWorkspace(req.user.id, String(req.params.workspaceId)))) {
      return res.status(403).json({ ok: false })
    }
    const { rows } = await db.query<{ storage_path: string; message_id: string | null }>(
      `DELETE FROM attachments
       WHERE id = $1 AND workspace_id = $2 AND message_id IS NULL
       RETURNING storage_path, message_id`,
      [String(req.params.id), String(req.params.workspaceId)],
    )
    if (!rows[0]) {
      // Either doesn't exist or already attached to a message (immutable).
      return res.status(404).json({ ok: false })
    }
    await fs.unlink(rows[0].storage_path).catch(() => {})
    res.json({ ok: true })
  },
)

// Internal helper used by messages.ts to claim attachments for a new message.
export async function claimAttachmentsForMessage(
  workspaceId: string,
  messageId: string,
  attachmentIds: string[],
): Promise<void> {
  if (attachmentIds.length === 0) return
  await db.query(
    `UPDATE attachments SET message_id = $1
     WHERE workspace_id = $2 AND message_id IS NULL AND id = ANY($3::uuid[])`,
    [messageId, workspaceId, attachmentIds],
  )
}

// Internal helper used by agents.ts to load attachments for a set of messages.
export interface AttachmentRow {
  id: string
  message_id: string
  kind: 'text' | 'image' | 'pdf' | 'other'
  filename: string
  mime_type: string
  size_bytes: number
  storage_path: string
}
export async function loadAttachmentsForMessages(
  messageIds: string[],
): Promise<Map<string, AttachmentRow[]>> {
  if (messageIds.length === 0) return new Map()
  const { rows } = await db.query<AttachmentRow>(
    `SELECT id, message_id, kind, filename, mime_type, size_bytes, storage_path
     FROM attachments WHERE message_id = ANY($1::uuid[])
     ORDER BY created_at ASC`,
    [messageIds],
  )
  const map = new Map<string, AttachmentRow[]>()
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, [])
    map.get(r.message_id)!.push(r)
  }
  return map
}

export async function readAttachmentBytes(p: string): Promise<Buffer> {
  return fs.readFile(p)
}
