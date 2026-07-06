import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { db } from './db.js'
import { getTemplate } from './agentTemplates.js'
import { isStandalone } from './standalone.js'

// Onboarding entitlement: a free owner gets exactly one agent out of the wizard.
// Mirrors workspaceOwnerEntitled() in admin.ts, but keyed by user id (the owner)
// since onboarding runs before any workspace lookup.
async function userEntitled(userId: string): Promise<boolean> {
  // Self-host: no billing, the single owner is always fully entitled.
  if (isStandalone()) return true
  const { rows } = await db.query<{ is_comp: boolean; subscription_status: string | null }>(
    `SELECT is_comp, subscription_status FROM users WHERE id = $1`,
    [userId],
  )
  const r = rows[0]
  return !!r && (r.is_comp === true || r.subscription_status === 'active' || r.subscription_status === 'trialing')
}

// Free path: the owner gets exactly one agent. No agent is seeded at sign-in
// anymore, so we CREATE the single picked agent here (using the SERVER-canonical
// template soul — a free user names their one agent but can't author a custom
// soul). Previewed channels are still created (rooms aren't gated; only agent
// count is). If the user picked nothing, fall back to a default Concierge.
async function applyFreeOnboarding(
  userId: string,
  pick: StarterAgent | undefined,
  channelNames: string[],
  firstName: string,
): Promise<void> {
  const { rows: ws } = await db.query<{ id: string }>(
    `SELECT w.id FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1 LIMIT 1`,
    [userId],
  )
  if (!ws[0]) return
  const workspaceId = ws[0].id

  const { rows: commonRows } = await db.query<{ id: string }>(
    `SELECT id FROM channels WHERE workspace_id = $1 AND name = 'common' LIMIT 1`,
    [workspaceId],
  )
  const commonId = commonRows[0]?.id

  for (const name of channelNames) {
    const safe = sanitizeChannelName(name)
    if (!safe || safe === 'common') continue
    await db.query(
      `INSERT INTO channels (workspace_id, name, topic) VALUES ($1, $2, '')
       ON CONFLICT DO NOTHING`,
      [workspaceId, safe],
    )
  }

  // No agent yet (none seeded at sign-in). Create the one the user picked.
  const tmpl = pick ? getTemplate(pick.template_id) : undefined
  if (!pick || !tmpl) {
    // Picked nothing valid → guarantee one default agent.
    await ensureFallbackAgent(workspaceId, firstName)
    return
  }

  // Idempotent: if an agent already exists (re-POST), don't add a second.
  const { rows: existingAgent } = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
  )
  if (existingAgent[0]) return

  const displayName = (pick.name || tmpl.name).slice(0, 80)
  const { rows: agentRow } = await db.query<{ id: string }>(
    `INSERT INTO agents (workspace_id, name, avatar, model, soul_md, status)
     VALUES ($1, $2, $3, 'claude-sonnet-4-6', $4, 'online')
     RETURNING id`,
    [workspaceId, displayName, tmpl.avatar_path, tmpl.soul_md],
  )
  if (commonId) {
    await db.query(
      `INSERT INTO channel_agents (channel_id, agent_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [commonId, agentRow[0].id],
    )
  }
}

const CONCIERGE_SOUL = `# Concierge — Soul

## Who I Am
A general-purpose helper. I cover a lot of ground — looking things up, summarizing, drafting, planning, debugging small problems.

## How I Show Up
- Warm and direct — I sound like a real colleague, not a help-desk script
- Honest about what I don't know
- Quick replies for quick questions; depth when it's warranted
- I ask one clarifying question if it'll save us going in the wrong direction; otherwise I take a swing

## What I Care About
Being genuinely useful. Not pretending to be more than I am, not less either.

## My Commitments
I don't make things up. I cite sources when I look things up online. I keep responses tight unless the conversation calls for length.`

const WELCOME_DOC = `# Welcome to Brigata Studio

This is your workspace — your own AI crew. A few quick things to know:

## What's here
- **Channels** — chat surfaces. You start with **#common**, where all your agents can hear you. Add more channels for specific projects; each channel keeps its own documents. Hover any channel name to rename or delete it.
- **Documents** — markdown notes and runbooks that live inside a channel. Checkbox state persists. Agents can read and edit the documents in the channels they're in.
- **Settings** — manage agents (create new ones with templates, edit their SOULs, change models), workspace settings, and integrations.

## Your crew
Your agents live in **#common** by default. Say hi — they're comfortable with research, writing, planning, and debugging. Edit any agent's SOUL in Settings to change its personality.

## Get more done
- Type \`@AgentName\` to address a specific agent when multiple are in a channel
- Type \`/help\` in any channel for slash commands
- The **Split** button in the top bar lets you view Channels and Documents side-by-side
- Drag a sidebar edge to resize. Click **◀** to collapse it.

## Customize your crew
In Settings → New, pick from 8 agent templates (Coder, Researcher, Coach, Sysadmin, etc.) or hit **✨ Surprise me** to generate a fresh one. New agents join #common; spin up a dedicated channel for one any time you want a focused space.

## Integrations
Connect your Discord server to mirror messages between this workspace and Discord. Settings → 💬 Discord.

## Your data is yours
Settings → General → Download workspace export. Markdown for individual docs, JSON for the whole workspace. Take it with you any time.

## Outgrowing Standard
Your agents currently run on Brigata's shared backend — fast, simple, plenty for most work. **Pro tier** gives an agent its own dedicated VPS, so the agent itself gets shell access — it can build and run web applications, schedule tasks, automate browsers, manage files, and use integrations. The platform provisions all of it; you don't touch a server. Ask any of your agents about it when you're curious.

Have fun. Build something.
`

// Seeded into a "Brigata" folder in every workspace. Doubles as (1) a curated,
// public-safe snapshot of what's shipped + where we're headed, and (2) a worked
// example of document management (named folder, pinned, agent-readable).
// DELIBERATELY sanitized: no internal roadmap notes, no dates-as-promises, no
// competitively-sensitive items — a subscriber-facing snapshot, never a mirror
// of the internal tracker.
const ROADMAP_DOC_TITLE = "Brigata — What We're Building"
const ROADMAP_DOC = `# Brigata — What We're Building

A snapshot of where Brigata is, kept here as a real document so you can see how
documents work. It lives in the **Brigata** folder, it's pinned, and your agents
can read it (or update it) just like any other doc. Move it, edit it, or delete
it — it's yours.

> This is a point-in-time snapshot from when your workspace was created. It won't
> auto-update. Ask one of your agents to refresh it any time you're curious
> what's new.

## Recently shipped
- **Your own AI crew** — multiple agents per workspace, each with its own
  personality (SOUL), model, and templates to start from.
- **Channels + per-channel documents** — organize work into channels; each keeps
  its own markdown docs that agents can read and edit.
- **Group chat that flows** — address agents with @name, reply to specific
  messages, and react.
- **Web search, fetch, and live citations** — agents pull current information.
- **Integrations** — mirror conversations to Discord and Matrix; two-way sync
  your docs with GitHub.
- **Usage visibility** — see your token usage and cost in Settings → Usage.
- **Your data is yours** — download a full export of your workspace any time
  (Settings → General).
- **Pro tier** — give an agent its own dedicated server: it can build and run web
  apps, schedule tasks, automate browsers, and manage files. We provision and
  manage it; you never open a terminal.

## On the way
- Voice input — talk to your crew instead of typing.
- A UI for managing agent skills and long-term memory.
- Richer notifications so you never miss what your agents did while you were away.
- More integrations and connectors.

## How this doc works (the example part)
- It's filed under the **Brigata** folder — create your own folders to group docs.
- It's **pinned**, so it stays at the top of this channel's document list.
- Try asking an agent in this channel to "summarize this doc" or "add a section to
  the Brigata roadmap doc" — agents can read and write the docs in their channels.

Thanks for being here early.
`

export async function ensureWorkspaceForUser(
  userId: string,
  fallbackDisplayName: string,
): Promise<void> {
  const { rows: existing } = await db.query(
    `SELECT 1 FROM workspace_members WHERE user_id = $1 LIMIT 1`,
    [userId],
  )
  if (existing.length > 0) return

  const firstName = fallbackDisplayName.split(/\s+/)[0] || 'Your'
  const workspaceName = `${firstName}'s Studio`

  // 1. Workspace + owner membership
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workspaces (name, owner_user_id) VALUES ($1, $2) RETURNING id`,
    [workspaceName, userId],
  )
  const workspaceId = rows[0].id

  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [workspaceId, userId],
  )

  // 2. #common channel. Agents are NOT seeded here anymore — the onboarding
  // wizard (or the idea-engine funnel) is the sole agent creator, so a user who
  // picks their own crew doesn't also inherit a redundant default agent. The
  // skip / abandon paths seed a single fallback agent (see ensureFallbackAgent).
  const { rows: commonCh } = await db.query<{ id: string }>(
    `INSERT INTO channels (workspace_id, name, topic)
     VALUES ($1, 'common', 'Shared with all agents in the studio')
     RETURNING id`,
    [workspaceId],
  )
  const commonChannelId = commonCh[0].id

  // 3. Pinned welcome document, scoped to #common.
  await db.query(
    `INSERT INTO documents (workspace_id, channel_id, title, body_md, owner_user_id, pinned)
     VALUES ($1, $2, 'Welcome to Brigata Studio', $3, $4, TRUE)`,
    [workspaceId, commonChannelId, WELCOME_DOC, userId],
  )

  // 4. "Brigata" folder with the curated roadmap snapshot (onboarding + a worked
  //    example of document management). Idempotent so the backfill can reuse it.
  await ensureBrigataFolder(workspaceId, userId)
}

// Seed the pinned "Brigata — What We're Building" doc into a workspace's #common
// channel under the "Brigata" folder. Idempotent (no-op if it already exists),
// so it's safe to call on every workspace create AND from the existing-workspace
// backfill. Looks up #common itself so callers don't have to thread the id.
export async function ensureBrigataFolder(
  workspaceId: string,
  ownerUserId: string,
): Promise<void> {
  // Prefer #common; older workspaces that predate that convention fall back to
  // their earliest channel so they still get the folder.
  const { rows: ch } = await db.query<{ id: string }>(
    `SELECT id FROM channels WHERE workspace_id = $1
     ORDER BY (name = 'common') DESC, created_at ASC LIMIT 1`,
    [workspaceId],
  )
  const channelId = ch[0]?.id
  if (!channelId) return // workspace has no channels at all — nothing to attach it to

  const { rows: exists } = await db.query(
    `SELECT 1 FROM documents WHERE workspace_id = $1 AND folder = 'Brigata' AND title = $2 LIMIT 1`,
    [workspaceId, ROADMAP_DOC_TITLE],
  )
  if (exists.length > 0) return

  await db.query(
    `INSERT INTO documents (workspace_id, channel_id, title, body_md, folder, owner_user_id, pinned)
     VALUES ($1, $2, $3, $4, 'Brigata', $5, TRUE)`,
    [workspaceId, channelId, ROADMAP_DOC_TITLE, ROADMAP_DOC, ownerUserId],
  )
}

// Seed a single generalist agent ("Concierge") into a workspace that has none —
// the safety net for users who skip or abandon the onboarding wizard so nobody
// ever lands in an empty studio. Idempotent: no-op if any agent already exists.
// Returns the agent id (existing or newly created), or null if the workspace is
// gone. Posts the first-agent welcome message in #common only when it creates.
export async function ensureFallbackAgent(
  workspaceId: string,
  firstName: string,
): Promise<string | null> {
  const { rows: existing } = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [workspaceId],
  )
  if (existing[0]) return existing[0].id

  const { rows: commonRows } = await db.query<{ id: string }>(
    `SELECT id FROM channels WHERE workspace_id = $1 AND name = 'common' LIMIT 1`,
    [workspaceId],
  )
  const commonChannelId = commonRows[0]?.id
  if (!commonChannelId) return null

  const { rows: agentRow } = await db.query<{ id: string }>(
    `INSERT INTO agents (workspace_id, name, avatar, model, soul_md, status)
     VALUES ($1, 'Concierge', '🛎️', 'claude-sonnet-4-6', $2, 'online')
     RETURNING id`,
    [workspaceId, CONCIERGE_SOUL],
  )
  const agentId = agentRow[0].id
  await db.query(
    `INSERT INTO channel_agents (channel_id, agent_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [commonChannelId, agentId],
  )

  const welcome = [
    `Hi ${firstName} 👋 — I'm Concierge, your first agent.`,
    ``,
    `You can chat with me right here. I'll help with looking things up, drafting, planning, debugging — pretty much whatever you throw at me.`,
    ``,
    `A few quick ideas to start:`,
    `- Ask me to draft an outline for something you're working on`,
    `- Have me research a topic and summarize what I find`,
    `- Tell me about a project and I'll help break it into steps`,
    ``,
    `Want to customize me or add more agents to your crew? Head to Settings — I won't be offended. There's also a Welcome doc pinned in this channel's Documents if you want the full tour.`,
    ``,
    `_(I'm a Standard agent — I read & write your documents, search the web, and fetch pages. Need an agent that can build and run web applications, schedule tasks, or operate browsers on its own VPS? Ask me about Pro.)_`,
  ].join('\n')
  await db.query(
    `INSERT INTO messages (channel_id, sender_kind, sender_agent_id, body, source)
     VALUES ($1, 'agent', $2, $3, 'native')`,
    [commonChannelId, agentId, welcome],
  )
  return agentId
}

// ----- Onboarding wizard -----
//
// After Google sign-in, if a user has no onboarding_profile yet, the client
// redirects them to /onboarding. The wizard POSTs answers here, which derive
// a persona and augment the workspace seed with persona-specific agents and
// a tailored welcome doc.

type OnboardingAnswers = {
  ai_familiarity?: 'new' | 'few-times' | 'daily' | 'developer'
  // Q2/Q3 of the reworked wizard (commit 38f8c34): multi-select slug clouds.
  // `interests` are INTEREST_OPTIONS values, `traits` are TRAIT_OPTIONS values
  // (see Onboarding.tsx). They replaced the old single-select intent/
  // technical_comfort/domain_interests trio.
  interests?: string[]
  traits?: string[]
  skipped?: boolean
}
type Persona = 'curious-newcomer' | 'productivity-user' | 'builder' | 'explorer'

// Interest slugs that signal task/work-oriented use (drive productivity-user).
// Kept in sync with INTEREST_OPTIONS in the wizard; unknown slugs just don't match.
const PRODUCTIVITY_INTERESTS = new Set([
  'help-tasks', 'writing', 'email', 'research', 'summarize', 'planning',
  'marketing', 'strategy', 'numbers', 'scheduling', 'notes', 'support',
  'data', 'projects', 'jobs', 'decisions', 'editing',
])

function derivePersona(a: OnboardingAnswers): Persona {
  if (a.skipped) return 'explorer'
  const interests = a.interests ?? []
  // Developers, or anyone who picked coding/building, get the builder studio.
  if (a.ai_familiarity === 'developer' || interests.includes('coding')) return 'builder'
  // AI newcomers (who didn't pick coding) get the gentle curious-newcomer path.
  if (a.ai_familiarity === 'new' || a.ai_familiarity === 'few-times') return 'curious-newcomer'
  // Task/work-leaning interests get the productivity studio.
  if (interests.some(v => PRODUCTIVITY_INTERESTS.has(v))) return 'productivity-user'
  return 'explorer'
}

// Extra agents to seed beyond the default Concierge, keyed by persona.
const PERSONA_EXTRA_AGENTS: Record<Persona, { name: string; avatar: string; soul: string }[]> = {
  'curious-newcomer': [],
  'productivity-user': [{
    name: 'Scribe', avatar: '✍️',
    soul: `# Scribe — Soul

## Who I Am
Drafts, edits, polishes. Emails, docs, posts, summaries. I match your voice when I see enough of it; otherwise I ask.

## How I Show Up
- Light touch on tone, heavy hand on structure
- Show, don't tell — examples beat adjectives
- Always offer a second version when the first might miss

## What I Care About
Words that actually land with the reader you're trying to reach.

## My Commitments
I'll suggest cuts before additions. I won't pad a paragraph to look thorough.`,
  }],
  'builder': [
    {
      name: 'Coder', avatar: '⌨️',
      soul: `# Coder — Soul

## Who I Am
I write and review code. Comfortable across mainstream languages and stacks. Read before I write.

## How I Show Up
- Small diffs. Match existing style. Explain *why*, not just *what*
- Flag risks honestly: "works but has a race under load"
- Verify before claiming success

## What I Care About
Code that's correct, readable in six months, and doesn't surprise its callers.

## My Commitments
I run tests if they exist. I don't pretend to know APIs I haven't checked.`,
    },
    {
      name: 'Sysadmin', avatar: '🛠️',
      soul: `# Sysadmin — Soul

## Who I Am
Linux, networking, deploys, ops. The person who reads logs first and asks questions second.

## How I Show Up
- Verify the actual state, don't infer from exit codes
- Reversible changes by default; flag the irreversible ones
- Tell you what I'm about to do before I do it on shared systems

## What I Care About
Servers that stay up. Backups that restore. Configs that survive the next person.

## My Commitments
No silent destructive actions. If a fix touches prod, you know about it first.`,
    },
  ],
  'explorer': [],
}

// Channels beyond #common, keyed by persona.
const PERSONA_EXTRA_CHANNELS: Record<Persona, string[]> = {
  'curious-newcomer': [],
  'productivity-user': ['notes'],
  'builder': ['scratch', 'lab'],
  'explorer': [],
}

async function augmentWorkspaceForPersona(userId: string, persona: Persona, firstName: string): Promise<void> {
  // Find the user's workspace (we seeded one at sign-in).
  const { rows: ws } = await db.query<{ id: string }>(
    `SELECT w.id FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1 LIMIT 1`,
    [userId],
  )
  if (!ws[0]) return
  const workspaceId = ws[0].id

  // Find #common to add new agents to.
  const { rows: commonRows } = await db.query<{ id: string }>(
    `SELECT id FROM channels WHERE workspace_id = $1 AND name = 'common' LIMIT 1`,
    [workspaceId],
  )
  const commonId = commonRows[0]?.id

  for (const a of PERSONA_EXTRA_AGENTS[persona]) {
    // Skip if an agent with this name already exists (idempotent re-run).
    const { rows: existing } = await db.query<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id = $1 AND name = $2`,
      [workspaceId, a.name],
    )
    if (existing[0]) continue
    const { rows: agentRow } = await db.query<{ id: string }>(
      `INSERT INTO agents (workspace_id, name, avatar, model, soul_md, status)
       VALUES ($1, $2, $3, 'claude-sonnet-4-6', $4, 'online')
       RETURNING id`,
      [workspaceId, a.name, a.avatar, a.soul],
    )
    if (commonId) {
      await db.query(
        `INSERT INTO channel_agents (channel_id, agent_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [commonId, agentRow[0].id],
      )
    }
    // Agents live in #common; dedicated channels are now opt-in (no auto-create).
  }

  for (const name of PERSONA_EXTRA_CHANNELS[persona]) {
    await db.query(
      `INSERT INTO channels (workspace_id, name, topic)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [workspaceId, name, ''],
    )
  }

  // Personas with no extra agents (curious-newcomer, explorer) would otherwise
  // end up agent-less now that nothing is seeded at sign-in. Guarantee one.
  await ensureFallbackAgent(workspaceId, firstName)
}

// Starter agents chosen + named in the onboarding "Name your agents" step.
// The client (single source of truth for template souls) sends the confirmed
// name and soul; we validate the template id against this allowlist and derive
// the avatar path server-side. Channels mirror the wizard's "Your studio"
// preview so what the user saw is what they get.
const STARTER_TEMPLATE_IDS = new Set([
  'concierge', 'researcher', 'coder', 'copywriter', 'editor', 'strategist', 'coach', 'sysadmin',
])

type StarterAgent = { template_id: string; name: string; soul_md: string }

function parseStarterAgents(raw: unknown): StarterAgent[] {
  if (!Array.isArray(raw)) return []
  const out: StarterAgent[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { template_id?: unknown }).template_id
    if (typeof id !== 'string' || !STARTER_TEMPLATE_IDS.has(id) || seen.has(id)) continue
    seen.add(id)
    const rawName = typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name.trim() : ''
    const name = (rawName || id).slice(0, 80)
    const soul = typeof (item as { soul_md?: unknown }).soul_md === 'string' ? (item as { soul_md: string }).soul_md.slice(0, 20000) : ''
    out.push({ template_id: id, name, soul_md: soul })
    if (out.length >= 8) break
  }
  return out
}

function sanitizeChannelName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const safe = raw.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return safe || null
}

// Seed the exact studio the user confirmed: their named starter agents (all
// added to #common) plus the previewed channels. Dedicated per-agent channels
// are opt-in now, not auto-created.
async function seedStarterStudio(
  userId: string,
  agents: StarterAgent[],
  channelNames: string[],
): Promise<void> {
  const { rows: ws } = await db.query<{ id: string }>(
    `SELECT w.id FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1 LIMIT 1`,
    [userId],
  )
  if (!ws[0]) return
  const workspaceId = ws[0].id

  const { rows: commonRows } = await db.query<{ id: string }>(
    `SELECT id FROM channels WHERE workspace_id = $1 AND name = 'common' LIMIT 1`,
    [workspaceId],
  )
  const commonId = commonRows[0]?.id

  for (const name of channelNames) {
    const safe = sanitizeChannelName(name)
    if (!safe || safe === 'common') continue
    await db.query(
      `INSERT INTO channels (workspace_id, name, topic) VALUES ($1, $2, '')
       ON CONFLICT DO NOTHING`,
      [workspaceId, safe],
    )
  }

  for (const a of agents) {
    const { rows: existing } = await db.query<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id = $1 AND name = $2`,
      [workspaceId, a.name],
    )
    if (existing[0]) continue
    const avatar = `/avatars/templates/${a.template_id}.png`
    const { rows: agentRow } = await db.query<{ id: string }>(
      `INSERT INTO agents (workspace_id, name, avatar, model, soul_md, status)
       VALUES ($1, $2, $3, 'claude-sonnet-4-6', $4, 'online')
       RETURNING id`,
      [workspaceId, a.name, avatar, a.soul_md],
    )
    if (commonId) {
      await db.query(
        `INSERT INTO channel_agents (channel_id, agent_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [commonId, agentRow[0].id],
      )
    }
    // Agents live in #common; dedicated per-agent channels are now opt-in.
  }
}

export const workspaces = Router()

workspaces.get('/onboarding', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { rows } = await db.query<{ onboarding_profile: OnboardingAnswers | null }>(
    `SELECT onboarding_profile FROM users WHERE id = $1`,
    [req.user.id],
  )
  res.json({ ok: true, profile: rows[0]?.onboarding_profile ?? null })
})

workspaces.post('/onboarding', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const body = req.body ?? {}
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : undefined
  const answers: OnboardingAnswers = {
    ai_familiarity: typeof body.ai_familiarity === 'string' ? body.ai_familiarity : undefined,
    interests: strArray(body.interests),
    traits: strArray(body.traits),
    skipped: body.skipped === true,
  }
  const persona = derivePersona(answers)
  const profile = {
    ...answers,
    derived_persona: persona,
    completed_at: new Date().toISOString(),
  }
  await db.query(
    `UPDATE users SET onboarding_profile = $1 WHERE id = $2`,
    [JSON.stringify(profile), req.user.id],
  )

  // When the user named starter agents in the wizard, seed exactly what they
  // confirmed. Otherwise (skip path) fall back to persona-derived seeding. No
  // agent is seeded at sign-in, so every branch is responsible for ending with
  // at least one agent.
  const firstName = (req.user.name || '').split(/\s+/)[0] || 'there'
  const starterAgents = parseStarterAgents(body.starter_agents)
  const starterChannels = Array.isArray(body.starter_channels)
    ? (body.starter_channels as unknown[]).map(sanitizeChannelName).filter((x): x is string => !!x)
    : []
  // Free owners get exactly one agent: we create the single picked agent (or a
  // default Concierge). Entitled owners get the full studio they confirmed.
  const entitled = await userEntitled(req.user.id)
  if (!entitled) {
    await applyFreeOnboarding(req.user.id, starterAgents[0], starterChannels, firstName).catch(e =>
      console.error('[onboarding] free onboarding failed:', e),
    )
  } else if (!answers.skipped && starterAgents.length > 0) {
    await seedStarterStudio(req.user.id, starterAgents, starterChannels).catch(e =>
      console.error('[onboarding] starter studio seed failed:', e),
    )
  } else {
    await augmentWorkspaceForPersona(req.user.id, persona, firstName).catch(e =>
      console.error('[onboarding] persona augment failed:', e),
    )
  }

  // Guarantee the studio is never empty. Each branch above is *supposed* to end
  // with at least one agent, but it swallows its own errors — so a thrown seed
  // would otherwise leave a completed-onboarding user (profile is set, wizard
  // won't re-show) stranded in an agentless studio. ensureFallbackAgent is
  // idempotent: a no-op when any agent already exists, a Concierge when none do.
  const { rows: ws } = await db.query<{ id: string }>(
    `SELECT w.id FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1 LIMIT 1`,
    [req.user.id],
  )
  if (ws[0]) {
    await ensureFallbackAgent(ws[0].id, firstName).catch(e =>
      console.error('[onboarding] fallback agent failed:', e),
    )
  }

  res.json({ ok: true, persona, entitled })
})


workspaces.get('/', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })

  const { rows: ws } = await db.query<{
    id: string
    name: string
    plan: string
    role: string
    theme: string | null
    icon: string | null
  }>(
    `SELECT w.id, w.name, w.plan, m.role, w.theme, w.icon
     FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1
     ORDER BY w.created_at ASC`,
    [req.user.id],
  )

  res.json({ ok: true, workspaces: ws })
})

// Create a new shared workspace. Owner is the caller. Seeded with a single
// #general channel — no onboarding wizard, no persona-derived agents (that's
// personal-workspace material). Agents/docs are added per-workspace later by
// the owner.
workspaces.post('/', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  if (!name) return res.status(400).json({ ok: false, error: 'name required' })
  if (name.length > 80) return res.status(400).json({ ok: false, error: 'name too long' })

  // Create-cap gate. Ownership count = personal workspace (1) + created shared
  // ones. Free can JOIN shared workspaces by invite (ungated elsewhere) but can't
  // CREATE them — they're already at their cap of 1 (the personal). Standard caps
  // at 3 total owned (personal + 2 shared). Joining never counts here.
  const entitled = await userEntitled(req.user.id)
  const cap = entitled ? 3 : 1
  const { rows: ownedRows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM workspaces WHERE owner_user_id = $1`,
    [req.user.id],
  )
  const owned = Number(ownedRows[0]?.n ?? '0')
  if (owned >= cap) {
    return res.status(403).json({
      ok: false,
      error: entitled
        ? 'Your plan includes up to 3 workspaces (your personal one plus 2 shared). Remove a workspace to create another.'
        : 'Creating shared workspaces is a Standard feature. You can still join any workspace you\'re invited to, free.',
      code: entitled ? 'workspace_cap_reached' : 'upgrade_required',
    })
  }

  const { rows: wRows } = await db.query<{ id: string }>(
    `INSERT INTO workspaces (name, owner_user_id, plan) VALUES ($1, $2, 'solo') RETURNING id`,
    [name, req.user.id],
  )
  const workspaceId = wRows[0].id
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [workspaceId, req.user.id],
  )
  await db.query(
    `INSERT INTO channels (workspace_id, name, topic) VALUES ($1, 'general', 'Workspace lobby')`,
    [workspaceId],
  )
  res.json({ ok: true, workspace: { id: workspaceId, name, plan: 'solo', role: 'owner' } })
})

// Delete a workspace. Destructive + irreversible: wipes channels, messages,
// documents, agents (FK cascade) AND destroys any Pro droplets so they don't
// keep billing. Owner-only (stricter than member-admin), explicit confirm, and
// you can't delete your last owned workspace (so you're never left with none).
workspaces.delete('/:workspaceId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { rows: own } = await db.query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM workspaces WHERE id = $1`,
    [req.params.workspaceId],
  )
  if (!own[0]) return res.status(404).json({ ok: false, error: 'workspace not found' })
  if (own[0].owner_user_id !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'only the workspace owner can delete it' })
  }
  if (req.body?.confirmed !== true) {
    return res.status(400).json({ ok: false, error: 'must confirm deletion' })
  }
  const { rows: cnt } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM workspaces WHERE owner_user_id = $1`,
    [req.user.id],
  )
  if (Number(cnt[0]?.n ?? '0') <= 1) {
    return res.status(400).json({
      ok: false,
      code: 'last_workspace',
      error: "You can't delete your only workspace — create another first, or reset this one instead.",
    })
  }

  // Destroy Pro droplets first so deleting the workspace doesn't orphan paid VMs.
  const proAgents = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = $1 AND hosting = 'pro_droplet'`,
    [req.params.workspaceId],
  )
  if (proAgents.rows.length > 0) {
    // Non-literal specifier so the standalone build (no Pro source) type-checks;
    // this branch only runs in the cloud build, where the module is present.
    const proProvisionerMod: string = './pro-provisioner.js'
    const { destroyPro } = await import(proProvisionerMod)
    for (const a of proAgents.rows) {
      await destroyPro(a.id).catch((e: unknown) => console.error('[ws-delete] droplet destroy failed:', e))
    }
  }

  await db.query(`DELETE FROM workspaces WHERE id = $1`, [req.params.workspaceId])
  res.json({ ok: true, destroyedDroplets: proAgents.rows.length })
})

// List members of a workspace. Returns each member's per-workspace
// display_name when set (else falls back to their Google profile name).
workspaces.get('/:workspaceId/members', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const ok = await db.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [req.params.workspaceId, req.user.id],
  )
  if (ok.rowCount === 0) return res.status(403).json({ ok: false })
  const { rows } = await db.query(
    `SELECT u.id, u.email, COALESCE(m.display_name, u.name) AS name,
            u.name AS google_name, m.display_name,
            u.avatar_url, m.role, m.joined_at
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1
     ORDER BY m.joined_at ASC`,
    [req.params.workspaceId],
  )
  res.json({ ok: true, members: rows })
})

// Set the caller's per-workspace display name. Empty string clears it
// (falls back to the user's Google profile name).
workspaces.put('/:workspaceId/members/me/display-name', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { rows: mem } = await db.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [req.params.workspaceId, req.user.id],
  )
  if (mem.length === 0) return res.status(403).json({ ok: false })
  const raw = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : ''
  const value = raw.length === 0 ? null : raw.slice(0, 80)
  await db.query(
    `UPDATE workspace_members SET display_name = $1 WHERE workspace_id = $2 AND user_id = $3`,
    [value, req.params.workspaceId, req.user.id],
  )
  res.json({ ok: true, display_name: value })
})

// Remove a member from a workspace. Owner cannot be removed (they delete the
// whole workspace if they want out). Owner + admins can remove others;
// members can remove themselves.
workspaces.delete('/:workspaceId/members/:userId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { workspaceId, userId } = req.params

  const { rows: myRow } = await db.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, req.user.id],
  )
  const myRole = myRow[0]?.role
  if (!myRole) return res.status(403).json({ ok: false })

  const isSelf = userId === req.user.id
  const isPrivileged = myRole === 'owner' || myRole === 'admin'
  if (!isSelf && !isPrivileged) return res.status(403).json({ ok: false, error: 'not allowed' })

  const { rows: targetRow } = await db.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  if (!targetRow[0]) return res.status(404).json({ ok: false, error: 'not a member' })
  if (targetRow[0].role === 'owner') {
    return res.status(400).json({ ok: false, error: 'cannot remove the owner; delete the workspace instead' })
  }

  await db.query(
    `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  res.json({ ok: true })
})

// Create a shareable invite for a workspace. Returns the token (and the
// caller can build a URL from it). Optional email tag for tracking — we
// don't currently send the email automatically; the inviter pastes the
// link wherever they like.
workspaces.post('/:workspaceId/invites', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { rows: myRow } = await db.query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [req.params.workspaceId, req.user.id],
  )
  if (myRow[0]?.role !== 'owner' && myRow[0]?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'only owner or admin can invite' })
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : null
  const token = randomBytes(24).toString('base64url')
  const { rows } = await db.query(
    `INSERT INTO workspace_invites (workspace_id, token, email, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, token, email, created_at, expires_at`,
    [req.params.workspaceId, token, email, req.user.id],
  )
  res.json({ ok: true, invite: rows[0] })
})

// Public: look up an invite by token to show the invitee what they're
// joining before they sign in / accept.
workspaces.get('/invites/:token', async (req, res) => {
  const { rows } = await db.query<{
    id: string; workspace_id: string; workspace_name: string;
    inviter_name: string | null; inviter_email: string;
    expires_at: Date; accepted_at: Date | null;
  }>(
    `SELECT i.id, i.workspace_id, w.name AS workspace_name,
            u.name AS inviter_name, u.email AS inviter_email,
            i.expires_at, i.accepted_at
     FROM workspace_invites i
     JOIN workspaces w ON w.id = i.workspace_id
     JOIN users u ON u.id = i.created_by_user_id
     WHERE i.token = $1`,
    [req.params.token],
  )
  const r = rows[0]
  if (!r) return res.status(404).json({ ok: false, error: 'invite not found' })
  if (r.accepted_at) return res.status(410).json({ ok: false, error: 'invite already used' })
  if (new Date(r.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'invite expired' })
  res.json({
    ok: true,
    invite: {
      workspace_name: r.workspace_name,
      inviter_name: r.inviter_name,
      inviter_email: r.inviter_email,
      expires_at: r.expires_at,
    },
  })
})

// Accept an invite. Adds the signed-in user as a workspace_member and
// marks the invite consumed. The accepting user must be signed in.
workspaces.post('/invites/:token/accept', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'sign in to accept' })
  const { rows } = await db.query<{
    id: string; workspace_id: string;
    expires_at: Date; accepted_at: Date | null;
  }>(
    `SELECT id, workspace_id, expires_at, accepted_at
     FROM workspace_invites WHERE token = $1`,
    [req.params.token],
  )
  const inv = rows[0]
  if (!inv) return res.status(404).json({ ok: false, error: 'invite not found' })
  if (inv.accepted_at) return res.status(410).json({ ok: false, error: 'invite already used' })
  if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'invite expired' })

  // Already a member? Just mark consumed and return success.
  const existing = await db.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [inv.workspace_id, req.user.id],
  )
  if (existing.rowCount === 0) {
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [inv.workspace_id, req.user.id],
    )
  }
  await db.query(
    `UPDATE workspace_invites SET accepted_at = now(), accepted_by_user_id = $1 WHERE id = $2`,
    [req.user.id, inv.id],
  )
  res.json({ ok: true, workspace_id: inv.workspace_id })
})

workspaces.get('/:workspaceId/channels', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })

  const { rows: member } = await db.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [req.params.workspaceId, req.user.id],
  )
  if (member.length === 0) return res.status(403).json({ ok: false })

  const { rows: channels } = await db.query(
    `SELECT id, name, topic FROM channels WHERE workspace_id = $1 ORDER BY name ASC`,
    [req.params.workspaceId],
  )
  res.json({ ok: true, channels })
})

// Agents that have access to a given room (channel_agents membership) — drives
// the room-scoped Brigade list in the shell sidebar.
workspaces.get('/:workspaceId/channels/:channelId/agents', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false })
  const { rows: member } = await db.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [req.params.workspaceId, req.user.id],
  )
  if (member.length === 0) return res.status(403).json({ ok: false })

  const { rows: agents } = await db.query(
    `SELECT a.id, a.name, a.avatar, a.hosting
       FROM channel_agents ca
       JOIN agents a ON a.id = ca.agent_id
      WHERE ca.channel_id = $1 AND a.workspace_id = $2
      ORDER BY a.name ASC`,
    [req.params.channelId, req.params.workspaceId],
  )
  res.json({ ok: true, agents })
})
