// REST surface for the Agent Inbox / Task primitive (Phase 1c).
// Create a task (and fire dispatch), list an agent's inbox, list what a user
// assigned out (with live status), fetch one task. Workspace-membership gated.
import { Router } from 'express'
import { db } from './db.js'
import { createTask, listInbox, listSentByUser, listWorkspaceTasks, handoffCountsByAgent, getTask } from './tasks.js'
import { dispatchTask } from './agents.js'

export const tasksRouter = Router()

async function userInWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  )
  return rows.length > 0
}

// POST /api/workspaces/:workspaceId/tasks — hand a task to an agent, then dispatch.
tasksRouter.post('/:workspaceId/tasks', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const toAgentId = typeof req.body?.to_agent_id === 'string' ? req.body.to_agent_id : ''
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  const bodyMd = typeof req.body?.body_md === 'string' ? req.body.body_md : ''
  const channelId = typeof req.body?.channel_id === 'string' ? req.body.channel_id : null
  if (!toAgentId || !title) return res.status(400).json({ ok: false, error: 'to_agent_id + title required' })

  // The recipient agent must belong to this workspace (tenant scope).
  const { rows: a } = await db.query(
    `SELECT 1 FROM agents WHERE id = $1 AND workspace_id = $2`, [toAgentId, req.params.workspaceId])
  if (a.length === 0) return res.status(404).json({ ok: false, error: 'agent not in workspace' })
  // If a channel is given it must be in-workspace too.
  if (channelId) {
    const { rows: c } = await db.query(
      `SELECT 1 FROM channels WHERE id = $1 AND workspace_id = $2`, [channelId, req.params.workspaceId])
    if (c.length === 0) return res.status(404).json({ ok: false, error: 'channel not in workspace' })
  }

  const task = await createTask({
    workspaceId: req.params.workspaceId,
    channelId,
    fromKind: 'user',
    fromUserId: req.user.id,
    toAgentId,
    title,
    bodyMd,
  })
  // Fire dispatch in the background — the lifecycle + live events report progress.
  void dispatchTask(task.id).catch(e => console.error('[tasks] dispatch failed:', (e as Error)?.message))
  res.json({ ok: true, task })
})

// GET /api/workspaces/:workspaceId/tasks — ALL tasks in the workspace (human→agent
// AND agent→agent). The observability surface: humans see all cross-agent work.
tasksRouter.get('/:workspaceId/tasks', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  res.json({ ok: true, tasks: await listWorkspaceTasks(req.params.workspaceId) })
})

// GET /api/workspaces/:workspaceId/handoff-counts — per-agent handoff counts for
// the Brigade/Overview "Handoffs" numbers + mailbox unread badges.
tasksRouter.get('/:workspaceId/handoff-counts', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  res.json({ ok: true, counts: await handoffCountsByAgent(req.params.workspaceId) })
})

// GET /api/workspaces/:workspaceId/tasks/sent — what this user assigned out (+ live status).
tasksRouter.get('/:workspaceId/tasks/sent', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  res.json({ ok: true, tasks: await listSentByUser(req.params.workspaceId, req.user.id) })
})

// GET /api/workspaces/:workspaceId/agents/:agentId/inbox — an agent's task inbox.
tasksRouter.get('/:workspaceId/agents/:agentId/inbox', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  res.json({ ok: true, tasks: await listInbox(req.params.workspaceId, req.params.agentId) })
})

// GET /api/workspaces/:workspaceId/tasks/:taskId — one task.
tasksRouter.get('/:workspaceId/tasks/:taskId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await userInWorkspace(req.user.id, req.params.workspaceId))) {
    return res.status(403).json({ ok: false })
  }
  const task = await getTask(req.params.taskId, req.params.workspaceId)
  if (!task) return res.status(404).json({ ok: false })
  res.json({ ok: true, task })
})
