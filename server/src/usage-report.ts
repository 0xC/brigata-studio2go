// Read-only usage reporting for subscribers ("return on tokens"). Aggregates the
// per-turn rows captured in usage_events into workspace-scoped rollups: totals,
// a by-model breakdown, a by-agent breakdown, and a daily series. Token counts
// are exact; total_cost_usd is the model's API-priced estimate (notional for
// OAuth-subscription credentials), so the UI labels cost as an estimate.
import { Router } from 'express'
import { db } from './db.js'

export const usageReport = Router()

async function userInWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  return rows.length > 0
}

interface AggRow {
  turns: string
  input_tokens: string
  output_tokens: string
  cache_creation_tokens: string
  cache_read_tokens: string
  total_tokens: string
  total_cost_usd: string
}

const TOKEN_SUMS = `
  COUNT(*)                                  AS turns,
  COALESCE(SUM(input_tokens), 0)            AS input_tokens,
  COALESCE(SUM(output_tokens), 0)           AS output_tokens,
  COALESCE(SUM(cache_creation_tokens), 0)   AS cache_creation_tokens,
  COALESCE(SUM(cache_read_tokens), 0)       AS cache_read_tokens,
  COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens,
  COALESCE(SUM(total_cost_usd), 0)::float8  AS total_cost_usd`

function coerceAgg(r: AggRow) {
  return {
    turns: Number(r.turns),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    cache_creation_tokens: Number(r.cache_creation_tokens),
    cache_read_tokens: Number(r.cache_read_tokens),
    total_tokens: Number(r.total_tokens),
    total_cost_usd: Number(r.total_cost_usd),
  }
}

usageReport.get('/:workspaceId/usage', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const wid = req.params.workspaceId
  const days = Math.min(365, Math.max(1, parseInt(String(req.query.days ?? '30'), 10) || 30))
  const since = `now() - ($2::int * interval '1 day')`

  try {
    const [totals, byModel, byAgent, daily] = await Promise.all([
      db.query<AggRow>(
        `SELECT ${TOKEN_SUMS} FROM usage_events
         WHERE workspace_id = $1 AND created_at >= ${since}`,
        [wid, days],
      ),
      db.query<AggRow & { model: string }>(
        `SELECT model, ${TOKEN_SUMS} FROM usage_events
         WHERE workspace_id = $1 AND created_at >= ${since}
         GROUP BY model ORDER BY total_tokens DESC`,
        [wid, days],
      ),
      db.query<AggRow & { agent_id: string | null; agent_name: string | null }>(
        `SELECT ue.agent_id, a.name AS agent_name, ${TOKEN_SUMS} FROM usage_events ue
         LEFT JOIN agents a ON a.id = ue.agent_id
         WHERE ue.workspace_id = $1 AND ue.created_at >= ${since}
         GROUP BY ue.agent_id, a.name ORDER BY total_tokens DESC`,
        [wid, days],
      ),
      db.query<AggRow & { day: string }>(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, ${TOKEN_SUMS}
         FROM usage_events
         WHERE workspace_id = $1 AND created_at >= ${since}
         GROUP BY 1 ORDER BY 1`,
        [wid, days],
      ),
    ])

    res.json({
      ok: true,
      window_days: days,
      totals: coerceAgg(totals.rows[0]),
      by_model: byModel.rows.map(r => ({ model: r.model, ...coerceAgg(r) })),
      by_agent: byAgent.rows.map(r => ({
        agent_id: r.agent_id,
        agent_name: r.agent_name ?? (r.agent_id ? 'Unknown agent' : 'Deleted agent'),
        ...coerceAgg(r),
      })),
      daily: daily.rows.map(r => ({ day: r.day, ...coerceAgg(r) })),
    })
  } catch (e) {
    console.error('[usage-report] query failed:', (e as Error)?.message)
    res.status(500).json({ ok: false, error: 'usage query failed' })
  }
})
