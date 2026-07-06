// Caps concurrent in-process Standard-tier agent turns.
//
// Every Standard turn spawns a claude-agent-sdk subprocess (CPU + memory). With
// no cap, a burst of Standard traffic across tenants can exhaust the shared
// backend and degrade or OOM the box for everyone — a cross-tenant availability
// risk inherent to the shared-process model. We run at most
// STANDARD_MAX_CONCURRENCY turns at once and queue the rest (FIFO) up to
// STANDARD_MAX_QUEUE; past that we reject fast with CapacityError so the caller
// can post a friendly "busy, try again" instead of piling up unbounded latency.

const MAX = Math.max(1, Number(process.env.STANDARD_MAX_CONCURRENCY) || 4)
const MAX_QUEUE = Math.max(0, Number(process.env.STANDARD_MAX_QUEUE) || 50)

let active = 0
const waiters: Array<() => void> = []

export class CapacityError extends Error {
  constructor() {
    super('standard agent capacity reached')
    this.name = 'CapacityError'
  }
}

export function standardInFlight(): { active: number; queued: number; max: number } {
  return { active, queued: waiters.length, max: MAX }
}

async function acquire(): Promise<void> {
  if (active < MAX) {
    active++
    return
  }
  if (waiters.length >= MAX_QUEUE) throw new CapacityError()
  // Wait for a slot to be handed off. The releaser does NOT decrement active in
  // this case — the slot transfers directly to us — so we must not increment.
  await new Promise<void>((resolve) => waiters.push(resolve))
}

function release(): void {
  const next = waiters.shift()
  if (next) next() // hand the slot to the next waiter; active unchanged
  else active--
}

export async function withStandardSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await fn()
  } finally {
    release()
  }
}
