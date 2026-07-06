// Server-backed user preferences (layout, theme, rail sizes, etc).
// LocalStorage acts as a fast-paint cache so first paint isn't blocked on the
// network. Writes are debounced + flushed to the server; the server is the
// source of truth across browsers.

import { useEffect, useState } from 'react'

type Prefs = Record<string, unknown>

const CACHE_KEY = 'bw_prefs_cache'
const FLUSH_MS = 500

function readCache(): Prefs {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') }
  catch { return {} }
}
function writeCache(p: Prefs) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(p)) } catch {}
}

// In-memory current value + subscribers — module-level so all callers share.
let current: Prefs = readCache()
const subscribers = new Set<(p: Prefs) => void>()
let pending: Prefs = {}
let flushTimer: ReturnType<typeof setTimeout> | null = null
let serverLoaded = false

function notify() {
  for (const s of subscribers) s(current)
}

async function flush() {
  flushTimer = null
  const patch = pending
  pending = {}
  if (Object.keys(patch).length === 0) return
  try {
    const res = await fetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) {
      const d = await res.json()
      if (d.ok && d.preferences) {
        current = d.preferences
        writeCache(current)
        notify()
      }
    }
  } catch {}
}

async function loadFromServer() {
  try {
    const res = await fetch('/api/preferences')
    if (!res.ok) return
    const d = await res.json()
    if (d.ok && d.preferences) {
      // Server wins on load — overwrite the cache.
      current = d.preferences
      writeCache(current)
      serverLoaded = true
      notify()
    }
  } catch {}
}

void loadFromServer()

export function getPref<T = unknown>(key: string, fallback?: T): T {
  const v = current[key]
  return (v === undefined ? fallback : v) as T
}

export function setPref(key: string, value: unknown) {
  if (current[key] === value) return
  current = { ...current, [key]: value }
  writeCache(current)
  pending = { ...pending, [key]: value }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { void flush() }, FLUSH_MS)
  notify()
}

export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => (current[key] === undefined ? fallback : current[key] as T))
  useEffect(() => {
    function onChange(p: Prefs) {
      const next = p[key]
      setValue((next === undefined ? fallback : next) as T)
    }
    subscribers.add(onChange)
    return () => { subscribers.delete(onChange) }
    // intentionally don't re-subscribe on `fallback` changes; treat fallback as initial only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return [value, (v: T) => setPref(key, v)]
}

export function preferencesLoaded(): boolean { return serverLoaded }
