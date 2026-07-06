import type { Server as HttpServer, IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { db } from './db.js'
import { parse as parseCookie } from 'cookie'

const SESSION_COOKIE = 'bw_session'

interface SocketContext {
  userId: string
  subscriptions: Set<string> // channel ids
}

const sockets = new Map<WebSocket, SocketContext>()
const channelSubscribers = new Map<string, Set<WebSocket>>() // channelId -> sockets

export function broadcastToChannel(channelId: string, payload: unknown) {
  const subs = channelSubscribers.get(channelId)
  if (!subs) return
  // Inject channelId so multi-channel subscribers can route by channel without
  // every caller having to remember to include it in their payload.
  const wrapped = typeof payload === 'object' && payload !== null
    ? { channelId, ...(payload as Record<string, unknown>) }
    : payload
  const data = JSON.stringify(wrapped)
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

export function broadcastToAll(payload: unknown) {
  const data = JSON.stringify(payload)
  for (const ws of sockets.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

async function loadUserBySession(sid: string): Promise<{ id: string } | null> {
  try {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM sessions WHERE id = $1 AND expires_at > now()`,
      [sid],
    )
    return rows[0] ? { id: rows[0].user_id } : null
  } catch {
    return null
  }
}

async function userInChannel(userId: string, channelId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM channels c
     JOIN workspace_members m ON m.workspace_id = c.workspace_id
     WHERE c.id = $1 AND m.user_id = $2`,
    [channelId, userId],
  )
  return rows.length > 0
}

function subscribe(ws: WebSocket, channelId: string) {
  const ctx = sockets.get(ws)
  if (!ctx) return
  ctx.subscriptions.add(channelId)
  let subs = channelSubscribers.get(channelId)
  if (!subs) {
    subs = new Set()
    channelSubscribers.set(channelId, subs)
  }
  subs.add(ws)
}

function unsubscribeAll(ws: WebSocket) {
  const ctx = sockets.get(ws)
  if (!ctx) return
  for (const channelId of ctx.subscriptions) {
    const subs = channelSubscribers.get(channelId)
    if (subs) {
      subs.delete(ws)
      if (subs.size === 0) channelSubscribers.delete(channelId)
    }
  }
}

export function attachWebsocket(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const cookies = parseCookie(req.headers.cookie ?? '')
    const sid = cookies[SESSION_COOKIE]
    const user = sid ? await loadUserBySession(sid) : null
    if (!user) {
      ws.close(4401, 'unauthorized')
      return
    }

    sockets.set(ws, { userId: user.id, subscriptions: new Set() })
    ws.send(JSON.stringify({ type: 'hello' }))

    ws.on('message', async (raw) => {
      let msg: { type: string; channelId?: string }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'subscribe' && msg.channelId) {
        if (await userInChannel(user.id, msg.channelId)) {
          subscribe(ws, msg.channelId)
          ws.send(JSON.stringify({ type: 'subscribed', channelId: msg.channelId }))
        }
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      }
    })

    ws.on('close', () => {
      unsubscribeAll(ws)
      sockets.delete(ws)
    })
  })
}
