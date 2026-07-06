import { Router } from 'express'
import { db } from './db.js'

export const preferences = Router()

preferences.get('/', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { rows } = await db.query<{ preferences: Record<string, unknown> }>(
    `SELECT preferences FROM users WHERE id = $1`,
    [req.user.id],
  )
  res.json({ ok: true, preferences: rows[0]?.preferences ?? {} })
})

// Shallow merge: only top-level keys provided in the body are updated. To
// remove a key, send it with value null.
preferences.patch('/', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (typeof req.body !== 'object' || !req.body) {
    return res.status(400).json({ ok: false, error: 'body must be an object' })
  }
  const { rows } = await db.query<{ preferences: Record<string, unknown> }>(
    `UPDATE users SET preferences = preferences || $1::jsonb WHERE id = $2
     RETURNING preferences`,
    [JSON.stringify(req.body), req.user.id],
  )
  res.json({ ok: true, preferences: rows[0].preferences })
})
