import { Router, type Request, type Response, type NextFunction } from 'express'
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { db } from './db.js'
import { ensureWorkspaceForUser } from './workspace.js'
import { isDemoEnabled, getDemoState, startDemo, markDemoConverted } from './demo.js'
import {
  isStandalone,
  sessionCookieDomain,
  STANDALONE_ADMIN_GOOGLE_SUB,
  STANDALONE_ADMIN_EMAIL,
  STANDALONE_ADMIN_NAME,
} from './standalone.js'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

const SESSION_COOKIE = 'bw_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

interface SessionUser {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  is_comp: boolean
  is_admin: boolean
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser
  }
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} not set`)
  return v
}

// Append-only auth audit. Best-effort: an audit write must never block or break
// a sign-in/logout, so failures are logged, not thrown. Captures metadata only
// (email + IP + user-agent), never tokens or message content.
async function recordAuthEvent(
  req: Request,
  event: 'login' | 'denied' | 'logout',
  fields: { userId?: string | null; email?: string | null; googleSub?: string | null },
): Promise<void> {
  try {
    const ip = (req.ip ?? '').slice(0, 64) || null
    const ua = (req.get('user-agent') ?? '').slice(0, 512) || null
    await db.query(
      `INSERT INTO auth_events (user_id, email, google_sub, event, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fields.userId ?? null, fields.email ?? null, fields.googleSub ?? null, event, ip, ua],
    )
  } catch (e) {
    console.error('[auth-audit] failed to record event:', (e as Error)?.message)
  }
}

export async function loadUserFromSession(req: Request, _res: Response, next: NextFunction) {
  const sid = req.cookies?.[SESSION_COOKIE]
  if (!sid) return next()
  try {
    const { rows } = await db.query<SessionUser & { expires_at: Date }>(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.is_comp, u.is_admin, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now()`,
      [sid],
    )
    if (rows[0]) req.user = rows[0]
  } catch {
    // swallow — treat as unauthenticated
  }
  next()
}

export const auth = Router()


function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}


// --- Standalone / self-host login ------------------------------------------
// Only active when STANDALONE_MODE is set. There is no Google OAuth in a
// self-host install; the single operator authenticates with a shared password
// (STANDALONE_ADMIN_PASSWORD) and gets a session for the synthetic admin user.
// Modeled on /test-login above, but this user IS an admin and there is no
// allowlist gate (self-host is single-tenant by design). Inert (404) unless
// both STANDALONE_MODE and STANDALONE_ADMIN_PASSWORD are set.
auth.post('/standalone-login', async (req, res) => {
  if (!isStandalone()) return res.status(404).json({ ok: false })
  const expected = process.env.STANDALONE_ADMIN_PASSWORD ?? ''
  // With no password configured, refuse rather than mint an unprotected session.
  if (!expected) return res.status(403).json({ ok: false, error: 'standalone login not configured' })

  const provided =
    typeof req.body?.password === 'string'
      ? req.body.password
      : typeof req.get('x-standalone-password') === 'string'
      ? (req.get('x-standalone-password') as string)
      : ''
  if (!provided || !secretMatches(provided, expected)) {
    return res.status(403).json({ ok: false })
  }

  // Upsert the single synthetic admin. is_admin=true (admin console reachable in
  // a single-tenant self-host) and is_comp=true so the owner is always entitled.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (google_sub, email, name, avatar_url, last_seen_at, is_comp, is_admin)
     VALUES ($1, $2, $3, NULL, now(), true, true)
     ON CONFLICT (google_sub) DO UPDATE
       SET last_seen_at = now()
     RETURNING id`,
    [STANDALONE_ADMIN_GOOGLE_SUB, STANDALONE_ADMIN_EMAIL, STANDALONE_ADMIN_NAME],
  )
  const userId = rows[0].id

  await ensureWorkspaceForUser(userId, STANDALONE_ADMIN_NAME)

  const sessionId = randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt],
  )
  void recordAuthEvent(req, 'login', { userId, email: STANDALONE_ADMIN_EMAIL, googleSub: STANDALONE_ADMIN_GOOGLE_SUB })

  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    // Self-host commonly runs over plain http://localhost, so a secure-only
    // cookie would never be stored. Only require secure when a cookie domain is
    // configured (i.e. served over TLS on a real hostname).
    secure: !!sessionCookieDomain(),
    expires: expiresAt,
    path: '/',
    // Host-only by default (SESSION_COOKIE_DOMAIN unset); env-configurable.
    domain: sessionCookieDomain(),
  })
  res.json({ ok: true })
})

auth.get('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { rows } = await db.query<{ anthropic_token: string | null }>(
    `SELECT anthropic_token FROM users WHERE id = $1`,
    [req.user.id],
  )
  const has_anthropic_token = !!rows[0]?.anthropic_token
  res.json({ ok: true, user: { ...req.user, has_anthropic_token } })
})

// Save the user's own Anthropic credential — either an OAuth subscription
// token (sk-ant-oat01-...) or an API key (sk-ant-api03-...). We do not return
// the value back; the UI only ever sees a boolean. Before storing, we make a
// real auth-only call to Anthropic so revoked/wrong-account tokens fail loud
// here instead of later when an agent tries to respond.
async function verifyAnthropicToken(token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const isOAuth = token.startsWith('sk-ant-oat')
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (isOAuth) {
    headers['Authorization'] = `Bearer ${token}`
    headers['anthropic-beta'] = 'oauth-2025-04-20'
  } else {
    headers['x-api-key'] = token
  }
  // Bound the verify call: without a timeout a slow/hung Anthropic response
  // leaves the user's only "Connect" button stuck on "Verifying…" forever with
  // no way to recover. 12s is well past a normal 1-token round-trip.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 12_000)
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: ac.signal,
    })
    if (r.ok) return { ok: true }
    if (r.status === 401) return { ok: false, error: 'Anthropic rejected the token (401). It may be revoked, expired, or from a different account. Generate a fresh one with `claude setup-token`, or use an API key.' }
    const body = await r.text().catch(() => '')
    return { ok: false, error: `Anthropic returned ${r.status}: ${body.slice(0, 200)}` }
  } catch (e) {
    if (ac.signal.aborted) {
      return { ok: false, error: 'Verifying the token timed out reaching Anthropic. Check your connection and try again.' }
    }
    return { ok: false, error: `Could not reach Anthropic to verify the token: ${(e as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}

auth.put('/me/anthropic-token', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  if (!token) return res.status(400).json({ ok: false, error: 'token required' })
  if (!/^sk-ant-(oat|api)\d+-/.test(token)) {
    return res.status(400).json({ ok: false, error: 'expected sk-ant-oat01-… (OAuth) or sk-ant-api03-… (API key)' })
  }
  const v = await verifyAnthropicToken(token)
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error })
  await db.query(`UPDATE users SET anthropic_token = $1 WHERE id = $2`, [token, req.user.id])
  // Funnel hook: if this user came in via the newbie demo, mark them converted.
  void markDemoConverted(req.user.id)
  res.json({ ok: true })
})

auth.delete('/me/anthropic-token', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  await db.query(`UPDATE users SET anthropic_token = NULL WHERE id = $1`, [req.user.id])
  res.json({ ok: true })
})

// --- Newbie demo mode ---------------------------------------------------------
// Inert unless DEMO_MODE_ENABLED + BRIGATA_DEMO_ANTHROPIC_KEY are set on the
// server. `enabled:false` lets the frontend hide the "try a demo" affordance.

auth.get('/demo/state', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!isDemoEnabled()) return res.json({ ok: true, enabled: false })
  // Comp'd beta users are exempt from the demo cap (they run the full Pro
  // experience on the platform token, see agents.ts respondAsAgent), so the demo
  // banner + "free demo's used up" card would be misleading. Report demo disabled
  // for them so the frontend hides it, even if they have a stale demo_credits row.
  if (req.user.is_comp) return res.json({ ok: true, enabled: false })
  const state = await getDemoState(req.user.id)
  res.json({ ok: true, enabled: true, demo: state })
})

auth.post('/demo/start', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!isDemoEnabled()) return res.status(403).json({ ok: false, error: 'demo not available' })
  // A user who already connected their own Claude doesn't need a demo.
  const { rows } = await db.query<{ anthropic_token: string | null }>(
    `SELECT anthropic_token FROM users WHERE id = $1`,
    [req.user.id],
  )
  if (rows[0]?.anthropic_token) {
    void markDemoConverted(req.user.id)
    return res.json({ ok: true, enabled: true, demo: await getDemoState(req.user.id), already_connected: true })
  }
  const state = await startDemo(req.user.id)
  res.json({ ok: true, enabled: true, demo: state })
})

auth.post('/logout', async (req, res) => {
  const sid = req.cookies?.[SESSION_COOKIE]
  if (sid) {
    await db.query(`DELETE FROM sessions WHERE id = $1`, [sid]).catch(() => {})
  }
  if (req.user) {
    void recordAuthEvent(req, 'logout', { userId: req.user.id, email: req.user.email })
  }
  res.clearCookie(SESSION_COOKIE)
  res.json({ ok: true })
})

// Self-service account deletion. Requires the caller to retype their own
// email as a confirmation token. Cascades: destroys any Pro-tier VPS for
// agents in the user's owned workspaces (best-effort), then deletes the
// workspaces (CASCADE removes channels/messages/documents/agents/members),
// then deletes the user (FKs now empty). Session cookie is cleared.
auth.delete('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm.trim().toLowerCase() : ''
  if (confirm !== req.user.email.toLowerCase()) {
    return res.status(400).json({ ok: false, error: 'confirmation does not match your email' })
  }

  const userId = req.user.id

  const { rows: ownedWs } = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE owner_user_id = $1`,
    [userId],
  )

  // Best-effort teardown of Pro-tier VPSs. We don't block account deletion on
  // a single provider failure — the user has asked us to remove their data and
  // we honor that even if an upstream API hiccups.
  const { rows: proAgents } = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE hosting = 'pro_droplet' AND workspace_id = ANY($1::uuid[])`,
    [ownedWs.map(w => w.id)],
  )
  if (proAgents.length > 0) {
    // Non-literal specifier so the standalone build (no Pro source) type-checks;
    // this branch only runs in the cloud build, where the module is present.
    const proProvisionerMod: string = './pro-provisioner.js'
    const { destroyPro } = await import(proProvisionerMod)
    for (const a of proAgents) {
      await destroyPro(a.id).catch((e: unknown) => console.error(`[delete-account] destroyPro(${a.id}) failed:`, e))
    }
  }

  // Now wipe data. workspaces ON DELETE CASCADE clears channels/messages/
  // documents/agents/workspace_members. We then delete remaining sessions and
  // the user row itself.
  for (const w of ownedWs) {
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [w.id])
  }
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId])
  await db.query(`DELETE FROM users WHERE id = $1`, [userId])

  res.clearCookie(SESSION_COOKIE)
  res.json({ ok: true })
})
