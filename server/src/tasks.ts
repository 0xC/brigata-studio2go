// Agent Inbox / Task-handoff primitive — the concrete UX of the A2A pillar.
// This module is the DATA LAYER + lifecycle state machine + live events.
// Dispatch (actually running the assigned agent's turn on a task) is wired into
// the agent runner separately so this stays side-effect-free and testable.
// Scope: brigade/2026-06-06-cosimo-agent-inbox-task-handoff-scope.md
import { db } from './db.js'
import { broadcastToAll } from './realtime.js'

// Runaway/loop guard for agent->agent delegation chains (controlled-A2A pillar).
export const MAX_TASK_DEPTH = 5

export type TaskStatus =
  | 'queued' | 'delivered' | 'in_progress' | 'done' | 'failed' | 'declined' | 'cancelled'

export interface AgentTask {
  id: string
  workspace_id: string
  channel_id: string | null
  from_kind: 'user' | 'agent'
  from_user_id: string | null
  from_agent_id: string | null
  to_agent_id: string
  title: string
  body_md: string
  status: TaskStatus
  parent_task_id: string | null
  depth: number
  result_summary: string | null
  result_doc_id: string | null
  error_message: string | null
  created_at: string
  delivered_at: string | null
  started_at: string | null
  completed_at: string | null
  // Populated only by listWorkspaceTasks (LEFT JOIN users) for human senders, so
  // the Relay UI can show the real sender name/avatar instead of a "You" fallback
  // in shared workspaces. Null/undefined for agent senders and other queries.
  from_user_name?: string | null
  from_user_avatar_url?: string | null
}

const COLS = `id, workspace_id, channel_id, from_kind, from_user_id, from_agent_id, to_agent_id,
  title, body_md, status, parent_task_id, depth, result_summary, result_doc_id, error_message,
  created_at, delivered_at, started_at, completed_at`

// Every create/transition emits a live event so the assigner's UI updates the
// status chip in real time — this is what replaces the "sit and wonder" gap.
function emit(task: AgentTask) {
  broadcastToAll({ type: 'task_updated', workspaceId: task.workspace_id, task })
}

export interface CreateTaskInput {
  workspaceId: string
  channelId?: string | null
  fromKind: 'user' | 'agent'
  fromUserId?: string | null
  fromAgentId?: string | null
  toAgentId: string
  title: string
  bodyMd?: string
  parentTaskId?: string | null
}

export async function createTask(input: CreateTaskInput): Promise<AgentTask> {
  // Chain depth = parent depth + 1; refuse beyond MAX_TASK_DEPTH (runaway guard).
  let depth = 0
  if (input.parentTaskId) {
    const { rows } = await db.query<{ depth: number }>(
      `SELECT depth FROM agent_tasks WHERE id = $1`, [input.parentTaskId])
    depth = (rows[0]?.depth ?? 0) + 1
    if (depth > MAX_TASK_DEPTH) {
      throw new Error(`task chain too deep (>${MAX_TASK_DEPTH}) — refusing to avoid runaway delegation`)
    }
  }
  const { rows } = await db.query<AgentTask>(
    `INSERT INTO agent_tasks
       (workspace_id, channel_id, from_kind, from_user_id, from_agent_id, to_agent_id, title, body_md, parent_task_id, depth)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
    [input.workspaceId, input.channelId ?? null, input.fromKind, input.fromUserId ?? null,
     input.fromAgentId ?? null, input.toAgentId, input.title, input.bodyMd ?? '', input.parentTaskId ?? null, depth],
  )
  emit(rows[0])
  return rows[0]
}

// Generic transition: set status, stamp the matching timestamp, set extra fields, emit.
async function transition(
  taskId: string,
  status: TaskStatus,
  opts: { stamp?: 'delivered_at' | 'started_at' | 'completed_at'; fields?: Record<string, unknown> } = {},
): Promise<AgentTask | null> {
  const sets: string[] = ['status = $2']
  const params: unknown[] = [taskId, status]
  if (opts.stamp) sets.push(`${opts.stamp} = now()`)
  for (const [k, v] of Object.entries(opts.fields ?? {})) { params.push(v); sets.push(`${k} = $${params.length}`) }
  const { rows } = await db.query<AgentTask>(
    `UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLS}`, params)
  if (!rows[0]) return null
  emit(rows[0])
  return rows[0]
}

export const markDelivered = (id: string) => transition(id, 'delivered', { stamp: 'delivered_at' })
export const markInProgress = (id: string) => transition(id, 'in_progress', { stamp: 'started_at' })
export const markDone = (id: string, resultSummary: string, resultDocId?: string | null) =>
  transition(id, 'done', { stamp: 'completed_at', fields: { result_summary: resultSummary, result_doc_id: resultDocId ?? null } })
export const markFailed = (id: string, error: string) =>
  transition(id, 'failed', { stamp: 'completed_at', fields: { error_message: error } })
export const markDeclined = (id: string, reason: string) =>
  transition(id, 'declined', { stamp: 'completed_at', fields: { error_message: reason } })
export const markCancelled = (id: string) => transition(id, 'cancelled', { stamp: 'completed_at' })

export async function getTask(id: string, workspaceId: string): Promise<AgentTask | null> {
  const { rows } = await db.query<AgentTask>(
    `SELECT ${COLS} FROM agent_tasks WHERE id = $1 AND workspace_id = $2`, [id, workspaceId])
  return rows[0] ?? null
}

// An agent's inbox: queued + in-progress first, then recent. Workspace-scoped.
export async function listInbox(workspaceId: string, agentId: string): Promise<AgentTask[]> {
  const { rows } = await db.query<AgentTask>(
    `SELECT ${COLS} FROM agent_tasks WHERE workspace_id = $1 AND to_agent_id = $2
     ORDER BY (status='queued') DESC, (status='in_progress') DESC, created_at DESC LIMIT 200`,
    [workspaceId, agentId])
  return rows
}

// What a human assigned out, with live status — the "stop wondering" view.
export async function listSentByUser(workspaceId: string, userId: string): Promise<AgentTask[]> {
  const { rows } = await db.query<AgentTask>(
    `SELECT ${COLS} FROM agent_tasks WHERE workspace_id = $1 AND from_user_id = $2
     ORDER BY created_at DESC LIMIT 100`, [workspaceId, userId])
  return rows
}

// Complete a task from its recipient agent's reply (Pro/bridge path), guarded:
// only if the task is addressed to this agent and still open. Returns whether it
// completed one (so a normal chat reply with no task doesn't falsely complete).
export async function completeTaskFromAgent(taskId: string, agentId: string, resultSummary: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM agent_tasks WHERE id = $1 AND to_agent_id = $2 AND status IN ('delivered','in_progress')`,
    [taskId, agentId])
  if (!rows[0]) return false
  await markDone(taskId, resultSummary.slice(0, 4000))
  return true
}

// Resolve a recipient agent by name within a workspace — FUZZY so a human or
// agent doesn't need the exact display name. Exact match wins, then prefix, then
// substring; ties broken by shortest name. "Max Coder" → "Max Coder (DO)".
export async function resolveRecipientAgent(workspaceId: string, name: string): Promise<{ id: string; name: string } | null> {
  const n = name.trim()
  if (!n) return null
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM agents
     WHERE workspace_id = $1
       AND (lower(name) = lower($2) OR lower(name) LIKE lower($2) || '%' OR lower(name) LIKE '%' || lower($2) || '%')
     ORDER BY (lower(name) = lower($2)) DESC,
              (lower(name) LIKE lower($2) || '%') DESC,
              length(name) ASC
     LIMIT 1`,
    [workspaceId, n])
  return rows[0] ?? null
}

// All tasks in a workspace (human→agent AND agent→agent), newest active first —
// the observability surface: humans see ALL cross-agent coordination, not just
// what they personally assigned.
export async function listWorkspaceTasks(workspaceId: string): Promise<AgentTask[]> {
  const qcols = COLS.split(',').map(c => 't.' + c.trim()).join(', ')
  const { rows } = await db.query<AgentTask>(
    `SELECT ${qcols},
            u.name AS from_user_name, u.avatar_url AS from_user_avatar_url
     FROM agent_tasks t
     LEFT JOIN users u ON u.id = t.from_user_id
     WHERE t.workspace_id = $1
     ORDER BY (t.status IN ('queued','delivered','in_progress')) DESC, t.created_at DESC LIMIT 200`,
    [workspaceId])
  return rows
}

// Per-agent handoff counts for the Brigade/Overview pages: how many handoffs each
// agent PICKED UP AND RAN WITH (in_progress/done) + how many are still PENDING
// (queued/delivered = unread in the mailbox). Feeds the "Handoffs" count + inbox badge.
export async function handoffCountsByAgent(workspaceId: string): Promise<{ agent_id: string; picked_up: number; pending: number }[]> {
  const { rows } = await db.query<{ agent_id: string; picked_up: number; pending: number }>(
    `SELECT to_agent_id AS agent_id,
            count(*) FILTER (WHERE status IN ('in_progress','done'))::int AS picked_up,
            count(*) FILTER (WHERE status IN ('queued','delivered'))::int AS pending
     FROM agent_tasks WHERE workspace_id = $1 GROUP BY to_agent_id`, [workspaceId])
  return rows
}

// Dispatch helper: the next queued task for an agent (the runner pulls these).
export async function nextQueuedForAgent(agentId: string): Promise<AgentTask | null> {
  const { rows } = await db.query<AgentTask>(
    `SELECT ${COLS} FROM agent_tasks WHERE to_agent_id = $1 AND status = 'queued'
     ORDER BY created_at ASC LIMIT 1`, [agentId])
  return rows[0] ?? null
}
