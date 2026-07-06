// Tracks in-flight external-agent dispatches so a reply (arriving on a separate
// webhook request) can cancel the safety timeout, and a genuinely-dead bridge
// trips the timeout instead of leaving the "thinking" indicator stuck forever.
//
// Keyed by channelId:agentId — one outstanding dispatch per agent-per-channel is
// the right granularity (a newer dispatch supersedes an older pending one).
//
// `pending` is separate from `timers` on purpose: the timeout callback re-arms
// itself while a long turn is still alive (see agents.ts), so when a timer FIRES
// the dispatch is NOT yet settled. Only a real reply or an explicit give-up
// removes the key from `pending`. The callback consults isReplyPending() after
// its async liveness check so a reply that lands mid-check stops the re-arm
// instead of leaking a timer that re-shows the typing indicator.

const timers = new Map<string, NodeJS.Timeout>()
const pending = new Set<string>()

function key(channelId: string, agentId: string): string {
  return `${channelId}:${agentId}`
}

// Arm a one-shot timeout for an external dispatch. Replaces any existing timer
// for the same channel+agent. onTimeout fires only if no reply cancels it first.
// Marks the dispatch pending until it is explicitly settled (reply or give-up).
export function armReplyTimeout(
  channelId: string,
  agentId: string,
  ms: number,
  onTimeout: () => void,
): void {
  const k = key(channelId, agentId)
  const existing = timers.get(k)
  if (existing) clearTimeout(existing)
  pending.add(k)
  const t = setTimeout(() => {
    timers.delete(k) // timer is spent; `pending` stays until settled
    onTimeout()
  }, ms)
  timers.set(k, t)
}

// Settle a dispatch: cancel any live timer AND mark it no longer pending. Called
// when the reply arrives, when the dispatch fails up-front, or when the
// liveness re-arm gives up. Returns true if it was still pending.
export function cancelReplyTimeout(channelId: string, agentId: string): boolean {
  const k = key(channelId, agentId)
  const t = timers.get(k)
  if (t) {
    clearTimeout(t)
    timers.delete(k)
  }
  return pending.delete(k)
}

// True while a dispatch is still outstanding (armed and not yet replied/settled).
// The re-arming timeout callback checks this before scheduling its next check so
// a reply that arrived during the async liveness probe halts the loop.
export function isReplyPending(channelId: string, agentId: string): boolean {
  return pending.has(key(channelId, agentId))
}
