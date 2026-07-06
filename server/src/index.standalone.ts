// =============================================================================
// Brigata Studio — STANDALONE / self-host entrypoint
// =============================================================================
// This is the composition root for the single-tenant, self-hosted build. It
// wires ONLY the core runtime: auth (password login), workspaces, channels,
// messages, documents, agents (in-process SDK), skills, memory, tasks, and the
// websocket. It deliberately omits every cloud-only subsystem — Pro/VPS
// provisioning, Stripe billing, GitHub sync, Discord/Matrix connectors, bridge
// dispatch, health polling, and the platform abuse monitor — none of which are
// imported here, so their source is never pulled into this build. That is what
// lets the public "Studio to Go" package ship without any of the cloud moat.
//
// The multi-tenant cloud build uses server/src/index.ts instead; the two share
// every core module unchanged (this is a build MODE, not a fork).
//
// Unlike the cloud deploy (which sits behind nginx), this entrypoint also serves
// the built frontend (app/dist) and the SPA fallback itself, so a fresh install
// is reachable at http://HOST:PORT with no reverse proxy required.

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { createServer } from 'http'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { healthCheck, db } from './db.js'
import { auth, loadUserFromSession } from './auth.js'
import { workspaces } from './workspace.js'
import { messages } from './messages.js'
import { documents } from './documents.js'
import { admin } from './admin.js'
import { exportRouter } from './export.js'
import { usageReport } from './usage-report.js'
import { tasksRouter } from './tasks-routes.js'
import { agentSecretsRouter } from './agent-secrets.js'
import { preferences } from './preferences.js'
import { attachments } from './attachments.js'
import { adminConsole } from './admin-console.js'
import { activity } from './activity.js'
import { attachWebsocket } from './realtime.js'
import { MODELS, DEFAULT_MODEL } from './models.js'
import { isStandalone } from './standalone.js'
import {
  ensureWorkspaceForUser,
  ensureFallbackAgent,
} from './workspace.js'
import {
  STANDALONE_ADMIN_GOOGLE_SUB,
  STANDALONE_ADMIN_EMAIL,
  STANDALONE_ADMIN_NAME,
} from './standalone.js'

const PORT = Number(process.env.PORT ?? 3030)
const BIND_HOST = process.env.BIND_HOST ?? '127.0.0.1'

// Fail fast and loud if someone runs this entrypoint without the flag — every
// call site still guards on isStandalone(), but the whole point of this binary
// is self-host mode, so an unset flag is almost certainly a misconfiguration.
if (!isStandalone()) {
  console.warn(
    '[standalone] WARNING: STANDALONE_MODE is not set but you launched the ' +
      'standalone entrypoint. Set STANDALONE_MODE=1 in your .env. Continuing anyway.',
  )
}

// Same resilience backstop as the cloud entrypoint: contain a stray async throw
// so one bad request can't take the whole server down.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] (contained, server stays up):', reason)
})

const app = express()
app.set('trust proxy', 1)
app.use(cors())
// Avatars live in one committed dir (server/avatars), served directly.
app.use('/avatars', express.static(fileURLToPath(new URL('../avatars', import.meta.url)), { maxAge: '1h' }))
app.use(express.json())
app.use(cookieParser())
app.use(loadUserFromSession)

app.get('/api/health', async (_req, res) => {
  const dbh = await healthCheck()
  res.json({
    ok: dbh.ok,
    service: 'brigata-workspace',
    mode: 'standalone',
    db: dbh.ok ? 'online' : 'offline',
    ts: new Date().toISOString(),
  })
})

// Catalog of selectable models (frontend pickers read this instead of hardcoding).
app.get('/api/models', (_req, res) => {
  res.json({ ok: true, models: MODELS, default: DEFAULT_MODEL })
})

// Bootstrap flag the frontend reads on load to render the password login screen
// (self-host) instead of the Google OAuth screen (cloud). Always true here.
app.get('/api/standalone-status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ ok: true, standalone: true })
})

// ---- Core API routers (no cloud subsystems) --------------------------------
app.use('/api/auth', auth)
app.use('/api/workspaces', workspaces)
app.use('/api/workspaces', messages)
app.use('/api/workspaces', documents)
app.use('/api/workspaces', admin)
app.use('/api/workspaces', exportRouter)
app.use('/api/workspaces', usageReport)
app.use('/api/workspaces', tasksRouter)
app.use('/api/workspaces', agentSecretsRouter)
app.use('/api/workspaces', activity)
app.use('/api/preferences', preferences)
app.use('/api/workspaces', attachments)
app.use('/api/admin', adminConsole)

// ---- Serve the built frontend (SPA) ----------------------------------------
// app/dist sits two levels up from the compiled server (server/dist/*.js).
const APP_DIST = fileURLToPath(new URL('../../app/dist', import.meta.url))
if (existsSync(APP_DIST)) {
  app.use(express.static(APP_DIST))
  // SPA fallback: anything that isn't an API/avatars/websocket route serves the
  // app shell so client-side routing works on hard refresh.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/avatars')) return next()
    res.sendFile(fileURLToPath(new URL('../../app/dist/index.html', import.meta.url)))
  })
} else {
  console.warn(`[standalone] frontend build not found at ${APP_DIST} — API only. Run the app build.`)
}

const server = createServer(app)
attachWebsocket(server)

// First-boot seed: with no existing workspace, create the single admin + one
// workspace (with #common channel) + one Standard in-process agent. Idempotent —
// a no-op once a workspace exists, so restarts never duplicate anything. Reuses
// the exact helpers the cloud sign-in path uses.
async function seedStandaloneIfEmpty(): Promise<void> {
  try {
    const { rows: ws } = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM workspaces`)
    if (Number(ws[0]?.n ?? '0') > 0) return

    const { rows: userRows } = await db.query<{ id: string }>(
      `INSERT INTO users (google_sub, email, name, avatar_url, last_seen_at, is_comp, is_admin)
       VALUES ($1, $2, $3, NULL, now(), true, true)
       ON CONFLICT (google_sub) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [STANDALONE_ADMIN_GOOGLE_SUB, STANDALONE_ADMIN_EMAIL, STANDALONE_ADMIN_NAME],
    )
    const userId = userRows[0].id

    await ensureWorkspaceForUser(userId, STANDALONE_ADMIN_NAME)

    const { rows: wsRow } = await db.query<{ id: string }>(
      `SELECT w.id FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = $1 LIMIT 1`,
      [userId],
    )
    if (wsRow[0]) await ensureFallbackAgent(wsRow[0].id, STANDALONE_ADMIN_NAME)

    console.log('[standalone] seeded initial workspace/agent')
  } catch (e) {
    console.error('[standalone] seed failed:', (e as Error)?.message)
  }
}

server.listen(PORT, BIND_HOST, () => {
  console.log(`[brigata-workspace] STANDALONE listening on http://${BIND_HOST}:${PORT}`)
  console.log('[standalone] cloud features disabled: Google OAuth (password login instead), Stripe billing, Pro VPS provisioning, external/bridge dispatch, channel connectors')
  void seedStandaloneIfEmpty()
})
