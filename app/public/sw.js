/*
 * Brigata Studio — minimal service worker (PWA v1).
 * Goals: installability + an offline app-shell. Deliberately conservative:
 *  - NEVER intercepts /api or /ws (auth + realtime must always hit the network).
 *  - Navigations are network-first (online users always get the freshest
 *    index.html, hence the freshest hashed asset refs), falling back to a
 *    cached shell only when offline.
 *  - Static assets use stale-while-revalidate; Vite's hashed filenames make
 *    cached copies safe to serve while a fresh copy updates in the background.
 * Bump VERSION to invalidate all caches on the next activation.
 */
const VERSION = 'v2'
const SHELL_CACHE = `brigata-shell-${VERSION}`
const ASSET_CACHE = `brigata-assets-${VERSION}`
const SHELL_URL = '/index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.add(SHELL_URL)).catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // let the browser handle cross-origin (fonts, etc.)
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return // never touch API/realtime

  // App-shell navigations: network-first, cached shell as the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL_CACHE).then((c) => c.put(SHELL_URL, copy)).catch(() => {})
          return res
        })
        .catch(() =>
          caches.match(SHELL_URL).then((r) => r || caches.match('/')),
        ),
    )
    return
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.open(ASSET_CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              cache.put(req, res.clone())
            }
            return res
          })
          .catch(() => cached)
        return cached || network
      }),
    ),
  )
})
