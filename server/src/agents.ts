import Anthropic from '@anthropic-ai/sdk'
import { db } from './db.js'
import { broadcastToChannel } from './realtime.js'
import { tools as appTools, executeTool, type AgentToolContext } from './agent-tools.js'
import { loadAttachmentsForMessages, readAttachmentBytes } from './attachments.js'
import { forwardOutbound, forwardTyping } from './bridges.js'
import { recordUsage } from './usage.js'
import { markDelivered, markInProgress, markDone, markFailed, markDeclined } from './tasks.js'
import { markAgentActive, clearActive, recordAgentTurnActivity } from './activity.js'

type SdkUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
import { sendToExternalAgent, isExternalAgentAlive, type OutboundHistoryItem } from './external-agents.js'
import { armReplyTimeout, cancelReplyTimeout, isReplyPending } from './pending-replies.js'
import { withStandardSlot, CapacityError } from './concurrency.js'
import { buildStudioDirectives } from './studio-directives.js'
import { resolveSkills, BASE_TOOLS } from './skills.js'
import { getSecretsForAgent } from './agent-secrets.js'
import { DEFAULT_MODEL } from './models.js'
import {
  DEMO_MODEL,
  isDemoEnabled,
  demoKey,
  canConsumeDemo,
  consumeDemoMessage,
  getDemoState,
} from './demo.js'
import { isStandalone } from './standalone.js'

// Anthropic-hosted server tools — executed by Anthropic's infra, no local handler needed.
// Results are folded into the conversation automatically; the model uses them and replies.
const serverTools = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 },
] as unknown as Anthropic.Tool[]

const tools: Anthropic.Tool[] = [...appTools, ...serverTools]

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })

interface AgentRow {
  id: string
  workspace_id: string
  name: string
  avatar: string | null
  model: string
  soul_md: string
  mission_md: string
  identity_md: string
  instructions: string
  hosting: string
  external_url: string | null
  external_token: string | null
  external_tls_cert: string | null
  enabled_skills: unknown
}

// Match @mentions. Names are typically single words; we match \w+ which covers
// letters/digits/underscore. Case-insensitive by lowercasing both sides.
const MENTION_RE = /@(\w[\w-]*)/g

function parseMentions(body: string): Set<string> {
  const out = new Set<string>()
  for (const m of body.matchAll(MENTION_RE)) {
    out.add(m[1].toLowerCase())
  }
  return out
}

interface ChannelMessageRow {
  id: string
  sender_kind: 'user' | 'agent' | 'system'
  body: string
  sender_user_id: string | null
  reply_to_id: string | null
  user_name: string | null
  agent_name: string | null
}

async function loadAgentsForChannel(channelId: string): Promise<AgentRow[]> {
  const { rows } = await db.query<AgentRow>(
    `SELECT a.id, a.workspace_id, a.name, a.avatar, a.model,
            a.soul_md, a.mission_md, a.identity_md, a.instructions,
            a.hosting, a.external_url, a.external_token, a.external_tls_cert, a.enabled_skills
     FROM channel_agents ca
     JOIN agents a ON a.id = ca.agent_id
     WHERE ca.channel_id = $1`,
    [channelId],
  )
  return rows
}

// All agents in the channel's workspace, regardless of channel membership.
// Used so an @mention can summon any workspace agent, not just channel members.
async function loadWorkspaceAgentsForChannel(channelId: string): Promise<AgentRow[]> {
  const { rows } = await db.query<AgentRow>(
    `SELECT a.id, a.workspace_id, a.name, a.avatar, a.model,
            a.soul_md, a.mission_md, a.identity_md, a.instructions,
            a.hosting, a.external_url, a.external_token, a.external_tls_cert, a.enabled_skills
     FROM agents a
     JOIN channels c ON c.workspace_id = a.workspace_id
     WHERE c.id = $1`,
    [channelId],
  )
  return rows
}

async function loadRecentHistory(channelId: string, limit = 30): Promise<ChannelMessageRow[]> {
  const { rows } = await db.query<ChannelMessageRow>(
    `SELECT m.id, m.sender_kind, m.body, m.sender_user_id, m.reply_to_id,
            u.name AS user_name, a.name AS agent_name
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_user_id
     LEFT JOIN agents a ON a.id = m.sender_agent_id
     WHERE m.channel_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [channelId, limit],
  )
  return rows.reverse()
}

async function loadChannelContext(
  channelId: string,
): Promise<{ workspaceName: string; channelName: string; ownerTimezone: string | null } | null> {
  const { rows } = await db.query<{
    workspace_name: string
    channel_name: string
    owner_timezone: string | null
  }>(
    `SELECT w.name AS workspace_name, c.name AS channel_name,
            (u.preferences ->> 'timezone') AS owner_timezone
     FROM channels c
     JOIN workspaces w ON w.id = c.workspace_id
     LEFT JOIN users u ON u.id = w.owner_user_id
     WHERE c.id = $1`,
    [channelId],
  )
  if (!rows[0]) return null
  return {
    workspaceName: rows[0].workspace_name,
    channelName: rows[0].channel_name,
    ownerTimezone: rows[0].owner_timezone,
  }
}

function buildSystemPrompt(
  agent: AgentRow,
  ctx: { workspaceName: string; channelName: string; ownerTimezone: string | null; requesterRole?: 'owner' | 'admin' | 'member' | null },
): string {
  const parts: string[] = []
  parts.push(`You are ${agent.name}, an AI agent in the Brigata workspace.`)
  if (agent.soul_md.trim()) parts.push(`# SOUL\n${agent.soul_md.trim()}`)
  if (agent.mission_md.trim()) parts.push(`# MISSION\n${agent.mission_md.trim()}`)
  if (agent.identity_md.trim()) parts.push(`# IDENTITY\n${agent.identity_md.trim()}`)
  if (agent.instructions.trim()) parts.push(`# INSTRUCTIONS\n${agent.instructions.trim()}`)

  parts.push(`# Studio directives\n${buildStudioDirectives(ctx.ownerTimezone, ctx.requesterRole)}`)

  parts.push(
    [
      `# Runtime`,
      `- Model: ${agent.model}`,
      `- Workspace: ${ctx.workspaceName}`,
      `- Channel: #${ctx.channelName}`,
      `- Available tools: list_documents, read_document, create_document, edit_document, append_to_document, delete_document, web_search, web_fetch, hand_off_task`,
    ].join('\n'),
  )
  parts.push(
    [
      `You are conversing in a channel-based chat. Keep responses concise unless asked for depth.`,
      `Other speakers in the channel may be humans or other agents; their names are prefixed in the transcript.`,
      `Reply directly with your message text. Do not preface with your own name.`,
      `Use the document tools whenever a runbook, checklist, or notes-style document is relevant to the conversation. Documents can be organized into folders — list_documents returns each doc's folder, and create_document/edit_document accept a folder argument so you can keep things tidy.`,
      `When editing a document, preserve the exact text of unchanged task-list items so their checkbox state is retained. For large or growing documents, use append_to_document to add content instead of resending the whole body with edit_document.`,
      `Use web_search to look up current information you don't have, and web_fetch to read specific pages. Cite the source when you do.`,
      `You CAN delegate to other agents, RIGHT NOW, with no setup: when the user asks you to hand off / pass / assign work to another agent, immediately call the hand_off_task tool (recipient's exact name + a clear title and details). There is NO permission step, approval, or Settings toggle — you already have this capability fully enabled. NEVER claim you need permission, NEVER ask the user to grant or enable anything, and NEVER tell the user to message the other agent themselves. Just call hand_off_task. The recipient works it asynchronously and replies in this channel.`,
    ].join(' '),
  )
  const isPro = agent.hosting === 'pro_droplet'
  parts.push(
    [
      `# Tier (when asked about Pro)`,
      isPro
        ? `You are a **Pro** agent. You run on a dedicated VPS the platform provisioned for you. You have shell access on that VPS — so you can build and run web applications, schedule tasks, automate browsers, manage files, and use integrations (Gmail, Calendar, Discord, ...), in addition to the Standard tools (document read/write, web search, web fetch). You run 24/7 in the background.`
        : `You are a **Standard** agent. You run on Brigata's shared backend with these tools: read/write workspace documents, web search (with citations), web fetch, conversation memory. You do NOT have shell access on a VPS — that's a Pro tier capability.`,
      ``,
      `For context when answering: **Pro** agents (not the subscriber, the agent itself) get shell access on a dedicated VPS that the platform provisions in seconds. The subscriber never opens a terminal, configures a server, or installs anything — they click a toggle in Settings → Agents → Hosting and their Pro agent comes online. With shell access, a Pro agent can: build and run web applications, schedule tasks via cron, automate browsers, manage files, use integrations, and operate 24/7 in the background.`,
      ``,
      `When the user asks about Pro, be conversational and brief. Be specific that it's the *agent* that gets shell access (so it can do things like spin up a web app), not the subscriber. If you compare features, prefer a short bulleted list. Only use a markdown table if there's room — keep tables compact, no more than 2 columns ("Standard" and "Pro"), and use terse cells (3–4 words). Always emphasize that launching Pro is one click; no technical skills required. Do not pitch Pro unless asked.`,
    ].join('\n'),
  )

  const { promptSections } = resolveSkills(agent.enabled_skills)
  if (promptSections.length) {
    parts.push([`# Skills`, ...promptSections].join('\n\n'))
  }
  return parts.join('\n\n')
}

async function transcriptToMessages(
  history: ChannelMessageRow[],
  selfAgentName: string,
): Promise<Anthropic.MessageParam[]> {
  const attachmentsByMsg = await loadAttachmentsForMessages(history.map(m => m.id))
  const msgs: Anthropic.MessageParam[] = []
  for (const m of history) {
    const isSelf = m.sender_kind === 'agent' && m.agent_name === selfAgentName
    const atts = attachmentsByMsg.get(m.id) ?? []
    if (isSelf) {
      // Agents don't post attachments today; pass through text only.
      msgs.push({ role: 'assistant', content: m.body })
      continue
    }
    const speaker =
      m.sender_kind === 'agent' ? m.agent_name ?? 'agent' : m.user_name ?? 'user'
    if (atts.length === 0) {
      msgs.push({ role: 'user', content: `${speaker}: ${m.body}` })
      continue
    }
    // Build a multimodal user turn: text + image/document blocks for media,
    // plus an inlined fence for each text attachment so the agent can read it.
    const blocks: Anthropic.ContentBlockParam[] = []
    let preface = `${speaker}: ${m.body}`.trim()
    const textAtts = atts.filter(a => a.kind === 'text')
    for (const a of textAtts) {
      try {
        const buf = await readAttachmentBytes(a.storage_path)
        const content = buf.toString('utf8').slice(0, 200_000)
        preface += `\n\n<attachment filename="${a.filename}" mime="${a.mime_type}">\n${content}\n</attachment>`
      } catch {
        preface += `\n\n<attachment filename="${a.filename}" mime="${a.mime_type}" error="could not read"/>`
      }
    }
    blocks.push({ type: 'text', text: preface })
    for (const a of atts) {
      if (a.kind === 'image') {
        try {
          const buf = await readAttachmentBytes(a.storage_path)
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: a.mime_type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
              data: buf.toString('base64'),
            },
          })
        } catch { /* skip on read error */ }
      } else if (a.kind === 'pdf') {
        try {
          const buf = await readAttachmentBytes(a.storage_path)
          blocks.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: buf.toString('base64'),
            },
          } as Anthropic.ContentBlockParam)
        } catch { /* skip on read error */ }
      }
    }
    msgs.push({ role: 'user', content: blocks })
  }
  return msgs
}

async function postAgentErrorNotice(
  channelId: string,
  agent: AgentRow,
  errorMessage: string,
  opts: { plain?: boolean } = {},
): Promise<void> {
  // Make the error visible to the user as a regular agent message so they don't
  // sit confused next to a cleared typing indicator. Keep it short and friendly.
  // `plain` posts the message verbatim — for actionable notices (e.g. "connect
  // Claude") where the generic "I hit a snag, try again" wrapper would mislead
  // the user into pointlessly retrying instead of taking the stated action.
  const trimmed = errorMessage.length > 200 ? errorMessage.slice(0, 200) + '…' : errorMessage
  const body = opts.plain
    ? errorMessage
    : `_(I hit a snag and couldn't finish that turn. Try again or rephrase. — error: ${trimmed})_`
  const { rows } = await db.query(
    `INSERT INTO messages (channel_id, sender_kind, sender_agent_id, body, source)
     VALUES ($1, 'agent', $2, $3, 'native')
     RETURNING id, sender_kind, body, created_at`,
    [channelId, agent.id, body],
  )
  const msg = {
    ...rows[0],
    user_name: null,
    user_avatar: null,
    agent_name: agent.name,
    agent_avatar: agent.avatar,
    agent_hosting: agent.hosting,
    model: agent.model,
  }
  broadcastToChannel(channelId, { type: 'message', message: msg })
}

// Decide which agents (if any) should respond to the latest user message.
//   - any agent @mentioned by name → that subset responds (overrides
//     everything). Mentions are matched against ALL agents in the workspace,
//     not just channel members, so you can summon any agent by name.
//   - else, if only one agent is in the channel → it responds
//   - else → the most-recently-active agent in this channel responds (so the
//     channel feels alive even when the user doesn't @-mention). This matches
//     human chat instincts: whoever was last in the conversation answers.
// Ambient (non-mention) responses stay scoped to channel members; only the
// mention path reaches workspace-wide.
// Decide which agents (if any) should respond to the trigger message.
// Composition-aware (the group-chat UX spec):
//   - per-channel mode: off → never; mention → only on @mention; auto → below
//   - an explicit @mention always summons the named agent(s)
//   - auto + SHARED workspace (2+ human members) → mention-only: assume the humans
//     are having a discussion; an agent joins only when @mentioned OR directly
//     replied-to (reply icon) — both are explicit address. It catches up via the
//     recent history it's handed. Stops agents barging into human↔human talk.
//   - auto + solo workspace (1 human) → ambient (the one agent answers, or for
//     multiple the last agent speaker / first)
async function selectResponders(
  agents: AgentRow[],
  workspaceAgents: AgentRow[],
  last: ChannelMessageRow,
  channelId: string,
): Promise<AgentRow[]> {
  const mentions = parseMentions(last.body)
  const mentioned = mentions.size > 0
    ? workspaceAgents.filter(a => mentions.has(a.name.toLowerCase()))
    : []

  const { rows: chRows } = await db.query<{ agent_response_mode: string }>(
    `SELECT agent_response_mode FROM channels WHERE id = $1`,
    [channelId],
  )
  const mode = chRows[0]?.agent_response_mode ?? 'auto'

  if (mode === 'off') return []
  if (mentioned.length > 0) return mentioned   // explicit address always wins
  if (mode === 'mention') return []
  if (agents.length === 0) return []

  // auto mode: a SHARED workspace (2+ human members) defaults to strict
  // mention-only. We gate on MEMBERSHIP, not recent activity, so the rule is
  // predictable regardless of who happened to speak recently. (workspace_members
  // are humans — agents aren't members.) Mentions were already handled above, so
  // here a non-mention message in a shared workspace gets no responder.
  const { rows: memRows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM workspace_members wm
     JOIN channels c ON c.id = $1
     WHERE wm.workspace_id = c.workspace_id`,
    [channelId],
  )
  const humanMembers = Number(memRows[0]?.n ?? '0')
  if (humanMembers >= 2) {
    // A direct reply (the reply icon) to an agent's own message always summons
    // that agent — it's an explicit address, just like an @mention. Look it up
    // workspace-wide so a reply works even if the agent isn't a channel member.
    if (last.reply_to_id) {
      const { rows: parent } = await db.query<{ sender_agent_id: string | null }>(
        `SELECT sender_agent_id FROM messages WHERE id = $1`,
        [last.reply_to_id],
      )
      const parentAgentId = parent[0]?.sender_agent_id
      const replied = parentAgentId ? workspaceAgents.find(a => a.id === parentAgentId) : undefined
      if (replied) return [replied]
    }
    return []
  }

  // Solo workspace → ambient behavior.
  if (agents.length === 1) return agents
  const { rows } = await db.query<{ sender_agent_id: string }>(
    `SELECT sender_agent_id FROM messages
     WHERE channel_id = $1 AND sender_kind = 'agent' AND sender_agent_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [channelId],
  )
  const lastSpeakerId = rows[0]?.sender_agent_id
  const lastSpeaker = lastSpeakerId ? agents.find(a => a.id === lastSpeakerId) : undefined
  return lastSpeaker ? [lastSpeaker] : [agents[0]]
}

export async function maybeRespondAsAgents(channelId: string): Promise<void> {
  const agents = await loadAgentsForChannel(channelId)
  const workspaceAgents = await loadWorkspaceAgentsForChannel(channelId)
  // A mention can summon a non-member workspace agent, so we proceed as long as
  // the workspace has any agent at all — not just channel members.
  if (workspaceAgents.length === 0) return

  const ctx = await loadChannelContext(channelId)
  if (!ctx) return

  const history = await loadRecentHistory(channelId)
  const last = history[history.length - 1]
  if (!last || last.sender_kind === 'agent') return

  // Look up the requester's role so the agent can gate destructive actions
  // when invoked by a non-owner. Threaded into ctx and consumed by
  // buildStudioDirectives downstream.
  let requesterRole: 'owner' | 'admin' | 'member' | null = null
  if (last.sender_user_id) {
    const { rows } = await db.query<{ role: string }>(
      `SELECT m.role FROM workspace_members m
       JOIN channels c ON c.workspace_id = m.workspace_id
       WHERE c.id = $1 AND m.user_id = $2`,
      [channelId, last.sender_user_id],
    )
    const r = rows[0]?.role
    if (r === 'owner' || r === 'admin' || r === 'member') requesterRole = r
  }
  const ctxWithRole = { ...ctx, requesterRole }

  const responders = await selectResponders(agents, workspaceAgents, last, channelId)
  if (responders.length === 0) return

  for (const agent of responders) {
    broadcastToChannel(channelId, {
      type: 'agent_typing', channelId, agentId: agent.id, agentName: agent.name,
      avatar: agent.avatar, typing: true,
    })
    forwardTyping(channelId, true)
    markAgentActive(agent.id, channelId)
    const clearTyping = () => {
      clearActive(agent.id)
      broadcastToChannel(channelId, {
        type: 'agent_typing', channelId, agentId: agent.id, typing: false,
      })
      forwardTyping(channelId, false)
    }
    // Self-host has no external bridge / Pro droplets — always run in-process
    // (SDK) so a stray hosting='pro_droplet' agent can't attempt external
    // dispatch to a server that doesn't exist.
    if (!isStandalone() && (agent.hosting === 'pro_droplet' || agent.hosting === 'external')) {
      // Pro: typing clears when the bridge posts its reply back to the
      // /agent-webhook/messages endpoint, which cancels this timer. If no reply
      // ever arrives (bridge accepted the turn but died mid-flight), the timer
      // fires so the user isn't stuck staring at a "thinking" indicator forever.
      // NOTE: this timer is NOT cleared on dispatch-ack — only on a real reply
      // or on dispatch failure — which was the bug that left the dots spinning.
      //
      // Long turns are normal now that agents run shell commands / install
      // packages, so a fixed deadline produced false "offline" alarms while the
      // reply was still coming. Instead, every CHECK_MS we verify the bridge is
      // actually alive (heartbeat freshness or a /health probe). If it is, the
      // turn is just long: keep the typing indicator and re-arm. Only give up
      // (and notify) when the bridge is genuinely unreachable, or after a hard
      // ceiling so a wedged turn doesn't spin forever.
      const CHECK_MS = 90_000
      const MAX_WAIT_MS = 15 * 60_000
      const turnStartedAt = Date.now()
      const onCheck = async () => {
        if (!isReplyPending(channelId, agent.id)) return // reply already landed
        const alive = await isExternalAgentAlive(agent.id)
        if (!isReplyPending(channelId, agent.id)) return // reply landed during the probe
        const elapsed = Date.now() - turnStartedAt
        if (alive && elapsed < MAX_WAIT_MS) {
          broadcastToChannel(channelId, {
            type: 'agent_typing', channelId, agentId: agent.id, agentName: agent.name,
            avatar: agent.avatar, typing: true,
          })
          forwardTyping(channelId, true)
          armReplyTimeout(channelId, agent.id, CHECK_MS, () => void onCheck())
          return
        }
        cancelReplyTimeout(channelId, agent.id)
        clearTyping()
        void postAgentErrorNotice(
          channelId,
          agent,
          alive
            ? `${agent.name} is taking unusually long on this one — it may be stuck on a task. Try again, or check its server.`
            : `${agent.name} didn't respond and its server looks offline — try again shortly.`,
          { plain: true },
        ).catch(() => {})
      }
      armReplyTimeout(channelId, agent.id, CHECK_MS, () => void onCheck())
      void dispatchExternal(channelId, agent, history, ctxWithRole, last.id)
        .catch(async e => {
          // The dispatch itself failed (bridge unreachable / refused the turn).
          // Cancel the safety timer and notify immediately rather than waiting
          // out the full 90s — sendToExternalAgent has already marked it offline.
          cancelReplyTimeout(channelId, agent.id)
          const msg = (e as Error)?.message ?? String(e)
          console.error(`[external ${agent.name}] dispatch failed:`, msg)
          clearTyping()
          void recordAgentTurn(agent.id, 'error', msg)
          await postAgentErrorNotice(
            channelId,
            agent,
            `${agent.name} is offline right now — I couldn't reach its server. Try again shortly.`,
            { plain: true },
          ).catch(() => {})
        })
    } else {
      void respondAsAgent(channelId, agent, history, ctxWithRole)
        .catch(async e => {
          if (e instanceof CapacityError) {
            await postAgentErrorNotice(
              channelId,
              agent,
              `${agent.name} is at capacity right now — a lot of agents are working at once. Try again in a moment.`,
              { plain: true },
            ).catch(() => {})
            return
          }
          const msg = (e as Error)?.message ?? String(e)
          console.error(`[agent ${agent.name}] failed:`, msg)
          void recordAgentTurn(agent.id, 'error', msg)
          await postAgentErrorNotice(channelId, agent, msg).catch(() => {})
        })
        .finally(clearTyping)
    }
  }
}

async function dispatchExternal(
  channelId: string,
  agent: AgentRow,
  history: ChannelMessageRow[],
  ctx: { workspaceName: string; channelName: string },
  triggerId: string,
) {
  // Load attachments for the message-bearing history. Encode images/pdfs as
  // base64 inline so the bridge can pass them as SDK multimodal blocks; text
  // attachments arrive decoded for inlining into the prompt.
  const attachmentsByMsg = await loadAttachmentsForMessages(history.map(h => h.id))
  const items: OutboundHistoryItem[] = await Promise.all(history.map(async h => {
    const atts = attachmentsByMsg.get(h.id) ?? []
    const outAtts = await Promise.all(atts.map(async a => {
      const out: { kind: 'image' | 'pdf' | 'text' | 'other'; filename: string; mime_type: string; data?: string } = {
        kind: a.kind,
        filename: a.filename,
        mime_type: a.mime_type,
      }
      try {
        if (a.kind === 'image' || a.kind === 'pdf') {
          const buf = await readAttachmentBytes(a.storage_path)
          out.data = buf.toString('base64')
        } else if (a.kind === 'text') {
          const buf = await readAttachmentBytes(a.storage_path)
          out.data = buf.toString('utf8').slice(0, 200_000)
        }
      } catch (e) {
        console.error(`[dispatchExternal] could not read ${a.filename}:`, (e as Error).message)
      }
      return out
    }))
    return {
      sender_kind: h.sender_kind,
      sender_name: h.sender_kind === 'agent' ? (h.agent_name ?? 'agent') : (h.user_name ?? 'user'),
      body: h.body,
      created_at: new Date().toISOString(),
      ...(outAtts.length ? { attachments: outAtts } : {}),
    }
  }))
  await sendToExternalAgent(agent, channelId, ctx, items, triggerId)
}

// SDK-backed path: when STUDIO_CLAUDE_OAUTH_TOKEN is set, route Standard-tier
// agent dispatch through the agent SDK using the operator's Claude subscription
// instead of the platform API key. Document tools are wrapped as MCP; web
// search/fetch are inherited from Claude Code's built-in toolset.
interface SdkDispatchOpts {
  // When set, overrides the agent's configured model (demo turns pin Haiku).
  modelOverride?: string
  // Tag for usage_events attribution ('standard_sdk' default, 'demo' for demo turns).
  usageSource?: string
  // When set, restricts the turn to exactly these tools (demo = docs + web only),
  // ignoring the agent's enabled skills.
  toolOverride?: readonly string[]
  // Called once with the turn's token count after a successful demo turn so the
  // caller can meter the demo allotment + decide whether the cap is now reached.
  onUsage?: (totalTokens: number) => Promise<void>
  // Task-dispatch seam (Agent Inbox): when set, the turn runs on this prompt
  // instead of the channel transcript. Chat turns leave it undefined → identical
  // behavior. The agent's reply still posts to the channel (visible result).
  promptOverride?: string
  // Task-dispatch seam: called with the final reply text after a successful turn,
  // so the Task lifecycle can advance (in_progress → done) and capture the result.
  onComplete?: (finalText: string) => void | Promise<void>
}

async function respondAsAgentViaSDK(
  channelId: string,
  agent: AgentRow,
  history: ChannelMessageRow[],
  ctx: { workspaceName: string; channelName: string; ownerTimezone: string | null; requesterRole?: 'owner' | 'admin' | 'member' | null },
  credential: string,
  opts: SdkDispatchOpts = {},
): Promise<void> {
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  const system = buildSystemPrompt(agent, ctx)
  const toolCtx: AgentToolContext = { workspaceId: agent.workspace_id, agentId: agent.id, channelId }

  // Brigata document tools as an MCP server, mirroring the bridge's pattern.
  const brigataServer = createSdkMcpServer({
    name: 'brigata',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool('hand_off_task', 'Hand off a task to ANOTHER agent in this workspace. They work it asynchronously and reply in this channel. Use when a different agent is better suited. Give the recipient agent name exactly.',
        { to_agent: z.string(), title: z.string(), details: z.string().optional() },
        async (args) => {
          const r = await executeTool('hand_off_task', args, toolCtx)
          return { content: [{ type: 'text' as const, text: r.content }], isError: r.is_error }
        }),
      tool('list_documents', 'List documents in the current channel plus workspace-level docs (id, title, folder, pinned, updated_at).', {},
        async () => {
          const r = await executeTool('list_documents', {}, toolCtx)
          return { content: [{ type: 'text' as const, text: r.content }], isError: r.is_error }
        }),
      tool('read_document', 'Read a document into YOUR context for reasoning/summarizing. NOT for when the user just wants to see the document — use focus_document for that.',
        { document_id: z.string() },
        async (args) => {
          const r = await executeTool('read_document', args, toolCtx)
          return { content: [{ type: 'text' as const, text: r.content }], isError: r.is_error }
        }),
      tool('focus_document', 'Open a document in the user\'s UI when they say "open/show/pull up/bring up" a document. Returns only confirmation — do NOT paste the body into chat.',
        { document_id: z.string() },
        async (args) => {
          const r = await executeTool('focus_document', args, toolCtx)
          return { content: [{ type: 'text' as const, text: r.content }], isError: r.is_error }
        }),
      tool('create_document', 'Create a new document in the current channel; optionally set a folder.',
        { title: z.string(), body_md: z.string(), folder: z.string().optional() },
        async (args) => {
          const r = await executeTool('create_document', args, toolCtx)
          return { content: [{ type: 'text' as const, text: r.content }], isError: r.is_error }
        }),
      tool('edit_document', 'Replace body/title/folder of an existing document.',
        { document_id: z.string(), body_md: z.string(), title: z.string().optional(), folder: z.string().optional() },
        async (args) => {
          const r = await executeTool('edit_document', args, toolCtx)
          return { content: [{ type: 'text' as const, text: r.content }], isError: r.is_error }
        }),
      tool('append_to_document', 'Append markdown to the end of a document without resending the whole body; preferred for large/growing docs.',
        { document_id: z.string(), body_md: z.string() },
        async (args) => {
          const r = await executeTool('append_to_document', args, toolCtx)
          return { content: [{ type: 'text' as const, text: r.content }], isError: r.is_error }
        }),
      tool('delete_document', 'Permanently delete a document; only when the user explicitly asks.',
        { document_id: z.string() },
        async (args) => {
          const r = await executeTool('delete_document', args, toolCtx)
          return { content: [{ type: 'text' as const, text: r.content }], isError: r.is_error }
        }),
    ],
  })

  // Build the prompt. Standard tier doesn't pass binary attachments down to the
  // SDK directly yet (no fleet-level multimodal plumbing); the user-visible
  // body of the message is included, and image/pdf attachments are referenced
  // as `[attachment: …]` so the model knows they exist. Text attachments are
  // inlined.
  const attsByMsg = await loadAttachmentsForMessages(history.map(h => h.id))
  const lines: string[] = []
  lines.push(`# Conversation in #${ctx.channelName}`)
  for (const m of history) {
    const isSelf = m.sender_kind === 'agent' && m.agent_name === agent.name
    const speaker = isSelf ? `[YOU — ${agent.name}]` : (m.sender_kind === 'agent' ? `[${m.agent_name ?? 'agent'}]` : `[${m.user_name ?? 'user'}]`)
    let line = `${speaker}: ${m.body}`
    for (const a of attsByMsg.get(m.id) ?? []) {
      if (a.kind === 'text') {
        try {
          const buf = await readAttachmentBytes(a.storage_path)
          line += `\n\n<attachment filename="${a.filename}" mime="${a.mime_type}">\n${buf.toString('utf8').slice(0, 200_000)}\n</attachment>`
        } catch { /* skip on read error */ }
      } else {
        line += `\n[attachment: ${a.filename} (${a.mime_type}) — binary content not inlined for Standard tier]`
      }
    }
    lines.push(line)
  }
  lines.push('', `# Now`, `Provide your next response as ${agent.name}. Reply directly with your message text — do not preface with your own name. Be concise unless asked for depth. Use Brigata document tools (mcp__brigata__*) for any workspace-document work; use built-in WebSearch/WebFetch for web lookups (cite sources).`)
  const prompt = opts.promptOverride ?? lines.join('\n')

  // Route by credential prefix: OAuth subscription tokens go in CLAUDE_CODE_OAUTH_TOKEN,
  // API keys go in ANTHROPIC_API_KEY. Always clear the unused slot so the SDK
  // doesn't pick the wrong one (it prefers API key over OAuth when both are set).
  const sdkEnv: Record<string, string | undefined> = { ...process.env }
  if (credential.startsWith('sk-ant-oat')) {
    sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = credential
    delete sdkEnv.ANTHROPIC_API_KEY
  } else {
    sdkEnv.ANTHROPIC_API_KEY = credential
    delete sdkEnv.CLAUDE_CODE_OAUTH_TOKEN
  }
  // Inject the agent's stored secrets as env vars — encrypted at rest, decrypted
  // only here at turn time, never in the chat transcript. (Set after the credential
  // so a secret can't clobber the Anthropic token slots.)
  {
    const agentSecrets = await getSecretsForAgent(agent.workspace_id, agent.id)
    for (const [k, v] of Object.entries(agentSecrets)) {
      if (k !== 'ANTHROPIC_API_KEY' && k !== 'CLAUDE_CODE_OAUTH_TOKEN') sdkEnv[k] = v
    }
  }

  // BASE_TOOLS (today's exact set) plus any tools from the agent's enabled skills.
  // No skills enabled => identical to the previous hardcoded list. Demo turns
  // override this with a fixed docs+web allowlist regardless of enabled skills.
  const { tools: skillTools } = resolveSkills(agent.enabled_skills)
  const allowedTools = opts.toolOverride ? [...opts.toolOverride] : skillTools

  const turnModel = opts.modelOverride || agent.model || DEFAULT_MODEL
  const turnStart = Date.now()

  // Gate the actual model execution behind the shared-backend concurrency cap.
  // Acquiring a slot (or being rejected with CapacityError) happens here so a
  // queued turn keeps its typing indicator while it waits for a free slot.
  // The turn's outputs are returned from the closure rather than written to
  // outer `let`s: TS doesn't narrow vars assigned only inside a callback, so
  // mutating outer state here would leave `usage` typed as its `null` literal.
  const { finalText, usage, costUsd, numTurns, durationMs } = await withStandardSlot(async () => {
    let finalText = ''
    let usage: SdkUsage | null = null
    let costUsd = 0
    let numTurns: number | null = null
    let durationMs: number | null = null
    const q = query({
      prompt,
      options: {
        model: turnModel,
        mcpServers: { brigata: brigataServer },
        settingSources: [],
        env: sdkEnv as Record<string, string>,
        systemPrompt: system,
        allowedTools,
      },
    })
    for await (const msg of q) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          finalText = (msg as { result: string }).result
        } else {
          throw new Error(`SDK turn failed: ${msg.subtype}`)
        }
        const rm = msg as unknown as {
          usage?: SdkUsage
          total_cost_usd?: number
          num_turns?: number
          duration_ms?: number
        }
        if (rm.usage) {
          usage = rm.usage
          costUsd = rm.total_cost_usd ?? 0
          numTurns = rm.num_turns ?? null
          durationMs = rm.duration_ms ?? null
        }
      }
    }
    return { finalText, usage, costUsd, numTurns, durationMs }
  })
  if (!finalText) throw new Error('SDK turn produced no text')
  const turnMs = Date.now() - turnStart

  const { rows } = await db.query(
    `INSERT INTO messages (channel_id, sender_kind, sender_agent_id, body, source, turn_ms)
     VALUES ($1, 'agent', $2, $3, 'native', $4)
     RETURNING id, sender_kind, body, created_at, turn_ms`,
    [channelId, agent.id, finalText, turnMs],
  )
  const msg = {
    ...rows[0],
    user_name: null,
    user_avatar: null,
    agent_name: agent.name,
    agent_avatar: agent.avatar,
    agent_hosting: agent.hosting,
    model: agent.model,
  }
  broadcastToChannel(channelId, { type: 'message', message: msg })
  void recordAgentTurn(agent.id, 'ok')
  // Task-dispatch seam: advance the Task lifecycle with the result. Awaited so a
  // failure here surfaces to the dispatcher's try/catch (→ markFailed).
  if (opts.onComplete) await opts.onComplete(finalText)
  {
    const triggerUserId =
      [...history].reverse().find(h => h.sender_kind === 'user')?.sender_user_id ?? null
    void recordAgentTurnActivity({
      workspaceId: agent.workspace_id,
      channelId,
      agentId: agent.id,
      agentName: agent.name,
      replyText: finalText,
      durationMs: turnMs,
      triggerUserId,
    })
  }
  if (usage) {
    const triggerUserId =
      [...history].reverse().find(h => h.sender_kind === 'user')?.sender_user_id ?? null
    void recordUsage({
      workspaceId: agent.workspace_id,
      agentId: agent.id,
      channelId,
      userId: triggerUserId,
      model: turnModel,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      totalCostUsd: costUsd,
      numTurns,
      durationMs,
      source: opts.usageSource ?? 'standard_sdk',
    })
    if (opts.onUsage) {
      // Meter input + output + cache-creation against the demo token guard, but
      // NOT cache-read: the SDK re-reads a large cached prompt prefix every turn
      // (cheap at 0.1x, but ~30K raw tokens), which would trip the 60K secondary
      // guard after ~2 turns and defeat the locked 8-message primary cap.
      const meteredTokens =
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      void opts.onUsage(meteredTokens)
    }
  }
  void forwardOutbound(channelId, finalText, 'native', agent.name)
}

async function recordAgentTurn(
  agentId: string,
  status: 'ok' | 'error',
  errorMessage?: string,
): Promise<void> {
  try {
    await db.query(
      `UPDATE agents
          SET last_turn_at = now(),
              last_turn_status = $2,
              last_error_message = CASE WHEN $2 = 'error' THEN $3 ELSE NULL END
        WHERE id = $1`,
      [agentId, status, errorMessage ? errorMessage.slice(0, 500) : null],
    )
  } catch (e) {
    console.error('[agent-health] failed to record turn:', (e as Error)?.message)
  }
}

// ---- Agent Inbox: dispatch a queued Task to its recipient agent ----
// MVP: Standard (in-workspace) agents only — runs the recipient on the SAME SDK
// engine as chat (via the promptOverride/onComplete seam), advancing the Task
// lifecycle and posting the result into the task's channel. Pro/bridge delivery
// is a fast-follow. Call fire-and-forget after createTask.
export async function dispatchTask(taskId: string): Promise<void> {
  const { rows: trows } = await db.query<{
    id: string; workspace_id: string; channel_id: string | null; to_agent_id: string;
    title: string; body_md: string; status: string
  }>(
    `SELECT id, workspace_id, channel_id, to_agent_id, title, body_md, status
     FROM agent_tasks WHERE id = $1`, [taskId])
  const task = trows[0]
  if (!task || task.status !== 'queued') return // already handled / gone
  if (!task.channel_id) { await markFailed(task.id, 'task has no channel to run in'); return }

  const { rows: arows } = await db.query<AgentRow>(
    `SELECT a.id, a.workspace_id, a.name, a.avatar, a.model, a.soul_md, a.mission_md, a.identity_md, a.instructions,
            a.hosting, a.external_url, a.external_token, a.external_tls_cert, a.enabled_skills
     FROM agents a WHERE a.id = $1`, [task.to_agent_id])
  const agent = arows[0]
  if (!agent) { await markFailed(task.id, 'recipient agent not found'); return }

  const ctx = await loadChannelContext(task.channel_id)
  if (!ctx) { await markFailed(task.id, 'channel context unavailable'); return }

  const taskPrompt = [
    `You've been handed a task in #${ctx.channelName}.`,
    ``,
    `# Task: ${task.title}`,
    task.body_md || '(no further detail provided)',
    ``,
    `# Now`,
    `Complete this task as ${agent.name}. Do the work — use Brigata document tools (mcp__brigata__*) for any workspace docs, and WebSearch/WebFetch for web lookups (cite sources). Reply with your result: a concise summary of what you did and any output.`,
  ].join('\n')

  // Pro / external agents: deliver via the bridge. The turn runs on the agent's
  // own VM; its reply comes back to /agent-webhook/messages with ?task_id=…, which
  // completes the task. (Completion is async; the lifecycle shows "working" until.)
  if (agent.hosting === 'pro_droplet' || agent.hosting === 'external') {
    if (!agent.external_url || !agent.external_token) {
      await markFailed(task.id, 'Pro agent has no bridge URL/token (re-provision needed?)'); return
    }
    await markDelivered(task.id)
    await markInProgress(task.id)
    try {
      await sendToExternalAgent(
        agent, task.channel_id, ctx,
        [{ sender_kind: 'user', sender_name: 'Tasks', body: taskPrompt, created_at: new Date().toISOString() }],
        task.id, // trigger_message_id
        task.id, // taskId → reply_url ?task_id=… → webhook completes the task
      )
    } catch (e) {
      await markFailed(task.id, (e as Error)?.message?.slice(0, 500) || 'bridge dispatch failed')
    }
    return
  }

  // Standard (in-process) agents: run synchronously on the shared backend.
  // Same credential rule as chat dispatch: owner's BYO token, else studio token
  // for admin/comp owners, else no credential → decline (don't silently 401).
  const { rows: orows } = await db.query<{ anthropic_token: string | null; is_admin: boolean; is_comp: boolean }>(
    `SELECT u.anthropic_token, u.is_admin, u.is_comp
     FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE w.id = $1`, [task.workspace_id])
  const owner = orows[0]
  const credential = owner?.anthropic_token ||
    (isStandalone() ? (process.env.ANTHROPIC_API_KEY || null) : null) ||
    (owner?.is_admin || owner?.is_comp ? process.env.STUDIO_CLAUDE_OAUTH_TOKEN || null : null)
  if (!credential) { await markDeclined(task.id, 'workspace owner has no Claude credential connected'); return }

  await markDelivered(task.id)
  await markInProgress(task.id)
  try {
    await respondAsAgentViaSDK(task.channel_id, agent, [], ctx, credential, {
      promptOverride: taskPrompt,
      usageSource: 'task',
      onComplete: async (finalText) => { await markDone(task.id, finalText.slice(0, 4000)) },
    })
  } catch (e) {
    await markFailed(task.id, (e as Error)?.message?.slice(0, 500) || 'turn failed')
  }
}

async function respondAsAgent(
  channelId: string,
  agent: AgentRow,
  history: ChannelMessageRow[],
  ctx: { workspaceName: string; channelName: string; ownerTimezone: string | null; requesterRole?: 'owner' | 'admin' | 'member' | null },
): Promise<void> {
  // Multi-tenant credential resolution for Standard-tier dispatch:
  //   1. Workspace owner's user-level Anthropic credential (BYO).
  //   2. STUDIO_CLAUDE_OAUTH_TOKEN ONLY when the owner is an admin user — this
  //      keeps the operator's own agents working without an explicit token
  //      while preventing free rides for external accounts.
  //   3. If neither: surface a visible "owner must connect Claude" error
  //      instead of silently 401ing.
  const { rows: ownerRows } = await db.query<{ id: string; anthropic_token: string | null; is_admin: boolean; is_comp: boolean }>(
    `SELECT u.id, u.anthropic_token, u.is_admin, u.is_comp
     FROM workspaces w JOIN users u ON u.id = w.owner_user_id
     WHERE w.id = $1`,
    [agent.workspace_id],
  )
  const owner = ownerRows[0]
  // Comp'd beta users run the full Pro experience (agent's real model + full
  // tools, uncapped) on the platform-funded studio token — same path as admins —
  // so they never fall into the constrained 8-message demo. Public/non-comp users
  // still require their own credential or get the demo/connect wall below.
  const credential =
    owner?.anthropic_token ||
    // Self-host: the single admin's key comes from the install-time env, not the
    // Connect-Claude UI. Cloud path is unchanged (isStandalone() is false there).
    (isStandalone() ? (process.env.ANTHROPIC_API_KEY || null) : null) ||
    (owner?.is_admin || owner?.is_comp ? process.env.STUDIO_CLAUDE_OAUTH_TOKEN || null : null)

  if (credential) return respondAsAgentViaSDK(channelId, agent, history, ctx, credential)

  // No real Claude credential. Before surfacing the "connect Claude" wall, check
  // whether this owner is mid-demo: demo mode globally enabled, they've started a
  // demo, not converted, and under the cap. If so, run the turn on Brigata's
  // demo key (Haiku, docs+web only) and meter it against their allotment.
  if (owner && (await canConsumeDemo(owner.id))) {
    const key = demoKey()
    if (key) {
      return respondAsAgentViaSDK(channelId, agent, history, ctx, key, {
        modelOverride: DEMO_MODEL,
        usageSource: 'demo',
        toolOverride: BASE_TOOLS,
        onUsage: async (totalTokens) => {
          const after = await consumeDemoMessage(owner.id, totalTokens)
          if (after.capReached) {
            await postAgentErrorNotice(
              channelId,
              agent,
              `**Your free demo's used up** — connect your Claude to keep your crew working. Your costs and data stay yours.\n\nOpen **Settings → Connect Claude** and paste either an OAuth token (\`sk-ant-oat01-…\`, from \`claude setup-token\`) or an Anthropic API key (\`sk-ant-api03-…\`).`,
              { plain: true },
            )
          }
        },
      })
    }
  }

  // Demo enabled and this owner already used up their demo allotment: show the
  // "free demo's used up" conversion card instead of the generic connect wall.
  if (owner && isDemoEnabled()) {
    const ds = await getDemoState(owner.id)
    if (ds.started && !ds.converted && ds.capReached) {
      await postAgentErrorNotice(
        channelId,
        agent,
        `**Your free demo's used up** — connect your Claude to keep your crew working. Your costs and data stay yours.\n\nOpen **Settings → Connect Claude** and paste either an OAuth token (\`sk-ant-oat01-…\`, from \`claude setup-token\`) or an Anthropic API key (\`sk-ant-api03-…\`).`,
        { plain: true },
      )
      await recordAgentTurn(agent.id, 'error', 'Demo allotment used up')
      return
    }
  }

  await postAgentErrorNotice(
    channelId,
    agent,
    `**${agent.name} can't respond yet** — the workspace owner needs to connect a Claude account first.\n\nOpen **Settings → Connect Claude** and paste either an OAuth token (\`sk-ant-oat01-…\`, from \`claude setup-token\`) or an Anthropic API key (\`sk-ant-api03-…\`). Once it's connected, just send your message again.`,
    { plain: true },
  )
  await recordAgentTurn(agent.id, 'error', 'No Claude account connected')
  return

  const system = buildSystemPrompt(agent, ctx)
  const messages = await transcriptToMessages(history, agent.name)
  if (messages.length === 0) return

  const toolCtx: AgentToolContext = {
    workspaceId: agent.workspace_id,
    agentId: agent.id,
    channelId,
  }

  const MAX_ITERATIONS = 8
  let finalText = ''
  const conversation: Anthropic.MessageParam[] = [...messages]
  const citations: { url: string; title?: string }[] = []

  function collectCitations(blocks: Anthropic.ContentBlock[]) {
    for (const b of blocks) {
      if (b.type !== 'text') continue
      const cs = (b as unknown as { citations?: { url?: string; title?: string }[] }).citations
      if (!cs) continue
      for (const c of cs) {
        if (c.url && !citations.some(x => x.url === c.url)) {
          citations.push({ url: c.url, title: c.title })
        }
      }
    }
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: agent.model || DEFAULT_MODEL,
      max_tokens: 4096,
      system,
      tools,
      messages: conversation,
    })

    collectCitations(response.content)

    const textParts = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
    const toolUses = response.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      finalText = textParts.join('\n').trim()
      if (citations.length > 0) {
        finalText +=
          '\n\n**Sources:**\n' +
          citations
            .map(c => `- [${c.title?.trim() || c.url}](${c.url})`)
            .join('\n')
      }
      break
    }

    // Record the assistant turn (with both text and tool_use blocks) verbatim
    conversation.push({ role: 'assistant', content: response.content })

    // Execute tools, build a user turn with tool_result blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const use of toolUses) {
      const result = await executeTool(use.name, use.input, toolCtx)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: result.content,
        is_error: result.is_error,
      })
    }
    conversation.push({ role: 'user', content: toolResults })
  }

  if (!finalText) {
    throw new Error('exhausted iteration budget without producing a reply')
  }

  const { rows } = await db.query(
    `INSERT INTO messages (channel_id, sender_kind, sender_agent_id, body, source)
     VALUES ($1, 'agent', $2, $3, 'native')
     RETURNING id, sender_kind, body, created_at`,
    [channelId, agent.id, finalText],
  )
  const msg = {
    ...rows[0],
    user_name: null,
    user_avatar: null,
    agent_name: agent.name,
    agent_avatar: agent.avatar,
    agent_hosting: agent.hosting,
    model: agent.model,
  }
  broadcastToChannel(channelId, { type: 'message', message: msg })
  void forwardOutbound(channelId, finalText, 'native', agent.name)
}
