// Token + cost capture for agent model-turns. Best-effort: recording usage must
// never break or block an agent's reply, so every write is wrapped and failures
// are logged, not thrown.
import { db } from './db.js'

export interface UsageCapture {
  workspaceId: string
  agentId: string | null
  channelId: string | null
  userId: string | null
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalCostUsd: number
  numTurns?: number | null
  durationMs?: number | null
  status?: 'ok' | 'error'
  source?: string
}

export async function recordUsage(u: UsageCapture): Promise<void> {
  try {
    await db.query(
      `INSERT INTO usage_events
         (workspace_id, agent_id, channel_id, user_id, model,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          total_cost_usd, num_turns, duration_ms, status, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        u.workspaceId, u.agentId, u.channelId, u.userId, u.model,
        Math.round(u.inputTokens) || 0,
        Math.round(u.outputTokens) || 0,
        Math.round(u.cacheCreationTokens) || 0,
        Math.round(u.cacheReadTokens) || 0,
        u.totalCostUsd || 0,
        u.numTurns ?? null,
        u.durationMs ?? null,
        u.status ?? 'ok',
        u.source ?? 'standard_sdk',
      ],
    )
  } catch (e) {
    console.error('[usage] failed to record usage:', (e as Error)?.message)
  }
}
