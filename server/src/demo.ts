// Newbie demo mode: a platform-funded "try a quick demo first" onboarding path.
// A tokenless user runs a capped number of agent turns on Brigata's own Anthropic
// key (pinned to Haiku) so they can watch an agent take real action before
// connecting their own Claude. Everything here is INERT unless both
// DEMO_MODE_ENABLED is truthy AND BRIGATA_DEMO_ANTHROPIC_KEY is set — so deploying
// this code changes nothing until the operator flips the flag and adds the key.
import { db } from './db.js'

export const DEMO_MODEL = 'claude-haiku-4-5'
export const DEMO_MAX_MESSAGES = 8
export const DEMO_MAX_TOKENS = 60_000

export interface DemoState {
  started: boolean
  messagesUsed: number
  tokensUsed: number
  converted: boolean
  capReached: boolean
  messagesRemaining: number
}

// The demo runs only when explicitly enabled AND a dedicated key is present. The
// key is read fresh each call so the operator can rotate/add it via .env + restart
// without code changes.
export function isDemoEnabled(): boolean {
  const flag = (process.env.DEMO_MODE_ENABLED || '').toLowerCase()
  const enabled = flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes'
  return enabled && !!process.env.BRIGATA_DEMO_ANTHROPIC_KEY
}

export function demoKey(): string | null {
  return process.env.BRIGATA_DEMO_ANTHROPIC_KEY || null
}

function capReached(messagesUsed: number, tokensUsed: number): boolean {
  return messagesUsed >= DEMO_MAX_MESSAGES || tokensUsed >= DEMO_MAX_TOKENS
}

// Returns the demo allotment for a user. If they've never started a demo, started
// is false and the rest are zeroed.
export async function getDemoState(userId: string): Promise<DemoState> {
  const { rows } = await db.query<{
    messages_used: number
    tokens_used: string
    converted: boolean
  }>(
    `SELECT messages_used, tokens_used, converted FROM demo_credits WHERE user_id = $1`,
    [userId],
  )
  const r = rows[0]
  if (!r) {
    return {
      started: false,
      messagesUsed: 0,
      tokensUsed: 0,
      converted: false,
      capReached: false,
      messagesRemaining: DEMO_MAX_MESSAGES,
    }
  }
  const messagesUsed = r.messages_used
  const tokensUsed = Number(r.tokens_used)
  return {
    started: true,
    messagesUsed,
    tokensUsed,
    converted: r.converted,
    capReached: capReached(messagesUsed, tokensUsed),
    messagesRemaining: Math.max(0, DEMO_MAX_MESSAGES - messagesUsed),
  }
}

// Idempotently starts (or returns the existing) demo allotment for a user.
export async function startDemo(userId: string): Promise<DemoState> {
  await db.query(
    `INSERT INTO demo_credits (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  )
  return getDemoState(userId)
}

// True when this user may consume another demo turn right now: enabled globally,
// they've started a demo, not yet converted, and under the cap.
export async function canConsumeDemo(userId: string): Promise<boolean> {
  if (!isDemoEnabled()) return false
  const s = await getDemoState(userId)
  return s.started && !s.converted && !s.capReached
}

// Records one consumed demo turn. Increments the message counter and adds the
// turn's token spend. Returns the post-increment state so the caller can decide
// whether the cap is now reached.
export async function consumeDemoMessage(userId: string, tokens: number): Promise<DemoState> {
  await db.query(
    `UPDATE demo_credits
        SET messages_used = messages_used + 1,
            tokens_used   = tokens_used + $2
      WHERE user_id = $1`,
    [userId, Math.max(0, Math.round(tokens)) || 0],
  )
  return getDemoState(userId)
}

// Funnel hook: flip converted=true when the user connects their own Claude
// credential. Idempotent and a no-op for users who never ran a demo.
export async function markDemoConverted(userId: string): Promise<void> {
  try {
    await db.query(
      `UPDATE demo_credits
          SET converted = true,
              converted_at = COALESCE(converted_at, now())
        WHERE user_id = $1 AND converted = false`,
      [userId],
    )
  } catch (e) {
    console.error('[demo] failed to mark converted:', (e as Error)?.message)
  }
}
