// Self-host ("standalone") mode detection for the frontend. In the default
// cloud build /api/standalone-status returns { standalone: false } and every
// consumer keeps its normal behavior, so this is purely additive.
//
// The result is fetched once on load and cached in-module so multiple callers
// (App shell, Settings) share a single request. Components read it via the
// useStandalone() hook.
import { useEffect, useState } from 'react'

let cached: boolean | undefined
let inflight: Promise<boolean> | null = null

export function fetchStandalone(): Promise<boolean> {
  if (cached !== undefined) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = fetch('/api/standalone-status')
    .then(r => (r.ok ? r.json() : { standalone: false }))
    .then((d: { standalone?: boolean }) => {
      cached = !!d?.standalone
      return cached
    })
    .catch(() => {
      cached = false
      return false
    })
  return inflight
}

// Returns: undefined while loading, then true/false. Components can render the
// cloud default while undefined so nothing flashes.
export function useStandalone(): boolean | undefined {
  const [val, setVal] = useState<boolean | undefined>(cached)
  useEffect(() => {
    let alive = true
    fetchStandalone().then(v => { if (alive) setVal(v) })
    return () => { alive = false }
  }, [])
  return val
}
