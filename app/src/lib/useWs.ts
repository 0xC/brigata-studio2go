import { useEffect, useRef, useState } from 'react'

interface Options {
  onMessage?: (data: unknown) => void
  onOpen?: (ws: WebSocket) => void
  heartbeatMs?: number
  reconnectDelayMs?: number
}

// Resilient WebSocket: heartbeats to keep the connection alive through proxies,
// auto-reconnect with capped backoff. `wsRef.current` is the latest live socket.
export function useResilientWs(path: string, opts: Options = {}) {
  const { onMessage, onOpen, heartbeatMs = 25_000, reconnectDelayMs = 1000 } = opts
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const onMessageRef = useRef(onMessage)
  const onOpenRef = useRef(onOpen)
  onMessageRef.current = onMessage
  onOpenRef.current = onOpen

  useEffect(() => {
    let stopped = false
    let attempt = 0
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      if (stopped) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}${path}`)
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        setConnected(true)
        onOpenRef.current?.(ws)
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'ping' })) } catch {}
          }
        }, heartbeatMs)
      }

      ws.onmessage = (ev) => {
        try { onMessageRef.current?.(JSON.parse(ev.data)) } catch {}
      }

      const cleanupAndReconnect = () => {
        setConnected(false)
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
        if (stopped) return
        const delay = Math.min(reconnectDelayMs * 2 ** attempt, 30_000)
        attempt++
        reconnectTimer = setTimeout(connect, delay)
      }

      ws.onclose = cleanupAndReconnect
      ws.onerror = () => { try { ws.close() } catch {} }
    }

    connect()

    return () => {
      stopped = true
      if (pingTimer) clearInterval(pingTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { wsRef.current?.close() } catch {}
    }
  }, [path, heartbeatMs, reconnectDelayMs])

  return { wsRef, connected }
}
