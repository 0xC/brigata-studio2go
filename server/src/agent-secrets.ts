// Layered agent secrets: named credentials injected into an agent's runtime env
// at turn time, encrypted at rest, NEVER returned to the browser or stored in chat.
// Two scopes (project_pro_capabilities):
//   • WORKSPACE-level (agent_id NULL) — shared by every agent in the workspace.
//   • AGENT-level (agent_id set) — scoped to one agent; overrides a workspace
//     secret of the same name (isolation for a low-trust agent / a key one agent
//     alone should hold).
import { Router } from 'express'
import { db } from './db.js'
import { encryptSecret, decryptSecret } from './secrets.js'

// Env-var name rule: uppercase/underscore, can't start with a digit. Keeps the
// injected names valid shell identifiers and blocks weird overrides.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/
export function isValidSecretName(name: string): boolean {
  return NAME_RE.test(name) && name.length <= 128
}

export type SecretScope = 'workspace' | 'agent'
export interface SecretRow { name: string; updated_at: string; scope: SecretScope }

// agentId null => workspace-level secret. The two scopes have different conflict
// targets (UNIQUE(agent_id,name) vs the partial index on (workspace_id,name)).
export async function setSecret(
  workspaceId: string, agentId: string | null, name: string, value: string,
): Promise<void> {
  if (!isValidSecretName(name)) throw new Error('secret name must be UPPER_SNAKE_CASE (a valid env var name)')
  if (!value) throw new Error('secret value required')
  const enc = encryptSecret(value)
  if (agentId) {
    await db.query(
      `INSERT INTO agent_secrets (workspace_id, agent_id, name, value_encrypted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, name) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = now()`,
      [workspaceId, agentId, name, enc])
  } else {
    await db.query(
      `INSERT INTO agent_secrets (workspace_id, agent_id, name, value_encrypted)
       VALUES ($1, NULL, $2, $3)
       ON CONFLICT (workspace_id, name) WHERE agent_id IS NULL
       DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = now()`,
      [workspaceId, name, enc])
  }
}

// Workspace-level secret names (names + timestamps only — never values).
export async function listWorkspaceSecrets(workspaceId: string): Promise<SecretRow[]> {
  const { rows } = await db.query<{ name: string; updated_at: string }>(
    `SELECT name, updated_at FROM agent_secrets
      WHERE workspace_id = $1 AND agent_id IS NULL ORDER BY name`, [workspaceId])
  return rows.map(r => ({ ...r, scope: 'workspace' as const }))
}

// EFFECTIVE secrets an agent sees: workspace-level + its own, with the agent's
// own overriding a workspace secret of the same name (reported as scope 'agent').
export async function listAgentEffectiveSecrets(workspaceId: string, agentId: string): Promise<SecretRow[]> {
  const { rows } = await db.query<{ name: string; updated_at: string; scope: SecretScope }>(
    `SELECT name, updated_at, scope FROM (
       SELECT name, updated_at,
              (CASE WHEN agent_id IS NULL THEN 'workspace' ELSE 'agent' END) AS scope,
              ROW_NUMBER() OVER (PARTITION BY name ORDER BY agent_id NULLS LAST) AS rn
         FROM agent_secrets
        WHERE workspace_id = $1 AND (agent_id = $2 OR agent_id IS NULL)
     ) t WHERE rn = 1 ORDER BY name`, [workspaceId, agentId])
  return rows
}

export async function deleteSecret(workspaceId: string, agentId: string | null, name: string): Promise<void> {
  if (agentId) {
    await db.query(`DELETE FROM agent_secrets WHERE agent_id = $1 AND name = $2`, [agentId, name])
  } else {
    await db.query(`DELETE FROM agent_secrets WHERE workspace_id = $1 AND agent_id IS NULL AND name = $2`,
      [workspaceId, name])
  }
}

// SERVER-ONLY: decrypted {NAME: value} map for injecting into the agent's runtime
// env at dispatch. Merges workspace-level + agent-level, AGENT WINS on name clash.
// Never expose over an API. Best-effort: an undecryptable row is skipped, not fatal.
export async function getSecretsForAgent(workspaceId: string, agentId: string): Promise<Record<string, string>> {
  // Order workspace-level first, then agent-level, so the agent-level assignment
  // below overwrites a workspace secret of the same name.
  const { rows } = await db.query<{ name: string; value_encrypted: string }>(
    `SELECT name, value_encrypted FROM agent_secrets
      WHERE workspace_id = $1 AND (agent_id IS NULL OR agent_id = $2)
      ORDER BY (agent_id IS NOT NULL)`, [workspaceId, agentId])
  const out: Record<string, string> = {}
  for (const r of rows) {
    try { out[r.name] = decryptSecret(r.value_encrypted) } catch { /* skip undecryptable */ }
  }
  return out
}

// ── Routes ──────────────────────────────────────────────────────────────────
// Mounted at /api/workspaces. Owner/admin only (stricter than connectors, which
// allow any member) — secrets are higher-stakes. Reads return NAMES ONLY.
export const agentSecretsRouter = Router()

async function isOwnerAdmin(userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2 AND role IN ('owner','admin')`,
    [userId, workspaceId])
  return rows.length > 0
}

// Same gate, plus the agent must belong to the workspace.
async function gateAgent(userId: string, workspaceId: string, agentId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM workspace_members m JOIN agents a ON a.workspace_id = m.workspace_id
      WHERE m.user_id = $1 AND m.workspace_id = $2 AND a.id = $3 AND m.role IN ('owner','admin')`,
    [userId, workspaceId, agentId])
  return rows.length > 0
}

// ── Workspace-level (shared across all the workspace's agents) ──
agentSecretsRouter.get('/:workspaceId/secrets', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await isOwnerAdmin(req.user.id, req.params.workspaceId)))
    return res.status(403).json({ ok: false, error: 'forbidden' })
  res.json({ ok: true, secrets: await listWorkspaceSecrets(req.params.workspaceId) })
})

agentSecretsRouter.post('/:workspaceId/secrets', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await isOwnerAdmin(req.user.id, req.params.workspaceId)))
    return res.status(403).json({ ok: false, error: 'forbidden' })
  const name = String(req.body?.name || '').trim()
  const value = String(req.body?.value || '')
  if (!isValidSecretName(name)) return res.status(400).json({ ok: false, error: 'name must be UPPER_SNAKE_CASE' })
  if (!value) return res.status(400).json({ ok: false, error: 'value required' })
  await setSecret(req.params.workspaceId, null, name, value)
  res.json({ ok: true, secrets: await listWorkspaceSecrets(req.params.workspaceId) })
})

agentSecretsRouter.delete('/:workspaceId/secrets/:name', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await isOwnerAdmin(req.user.id, req.params.workspaceId)))
    return res.status(403).json({ ok: false, error: 'forbidden' })
  await deleteSecret(req.params.workspaceId, null, req.params.name)
  res.json({ ok: true, secrets: await listWorkspaceSecrets(req.params.workspaceId) })
})

// ── Agent-level (override / isolation). GET returns EFFECTIVE secrets (workspace
// + agent) with a scope flag so the UI can show what the agent actually has. ──
agentSecretsRouter.get('/:workspaceId/agents/:agentId/secrets', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await gateAgent(req.user.id, req.params.workspaceId, req.params.agentId)))
    return res.status(403).json({ ok: false, error: 'forbidden' })
  res.json({ ok: true, secrets: await listAgentEffectiveSecrets(req.params.workspaceId, req.params.agentId) })
})

agentSecretsRouter.post('/:workspaceId/agents/:agentId/secrets', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await gateAgent(req.user.id, req.params.workspaceId, req.params.agentId)))
    return res.status(403).json({ ok: false, error: 'forbidden' })
  const name = String(req.body?.name || '').trim()
  const value = String(req.body?.value || '')
  if (!isValidSecretName(name)) return res.status(400).json({ ok: false, error: 'name must be UPPER_SNAKE_CASE' })
  if (!value) return res.status(400).json({ ok: false, error: 'value required' })
  await setSecret(req.params.workspaceId, req.params.agentId, name, value)
  res.json({ ok: true, secrets: await listAgentEffectiveSecrets(req.params.workspaceId, req.params.agentId) })
})

agentSecretsRouter.delete('/:workspaceId/agents/:agentId/secrets/:name', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  if (!(await gateAgent(req.user.id, req.params.workspaceId, req.params.agentId)))
    return res.status(403).json({ ok: false, error: 'forbidden' })
  await deleteSecret(req.params.workspaceId, req.params.agentId, req.params.name)
  res.json({ ok: true, secrets: await listAgentEffectiveSecrets(req.params.workspaceId, req.params.agentId) })
})
