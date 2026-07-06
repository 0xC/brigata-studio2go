// Alt UI: dashboard/cards layout.
//
// Hits the same /api/* endpoints as the chat-driven app/, just renders very
// differently. Each agent is a tile on the home screen; clicking opens a
// focused conversation drawer over the dashboard.

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Me } from './App'
import { isByovps } from './agentHosting'

type Workspace = { id: string; name: string; plan: string; role: string }
type AgentSummary = {
  id: string
  name: string
  avatar: string | null
  model: string
  status: string
  hosting?: string | null
}
type Channel = { id: string; name: string; topic: string | null }
type DocSummary = {
  id: string
  title: string
  folder: string | null
  pinned: boolean
  updated_at: string
}
type Message = {
  id: string
  sender_kind: 'user' | 'agent' | 'system'
  body: string
  created_at: string
  user_name: string | null
  agent_name: string | null
  agent_avatar: string | null
}

function timeAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

export function Dashboard({ me, onLogout }: { me: NonNullable<Me>; onLogout: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [openAgent, setOpenAgent] = useState<AgentSummary | null>(null)
  const [openChannel, setOpenChannel] = useState<Channel | null>(null)
  const [openDoc, setOpenDoc] = useState<DocSummary | null>(null)

  const workspaceId = workspaces[0]?.id

  useEffect(() => {
    fetch('/api/workspaces').then(r => r.json()).then(d => setWorkspaces(d.workspaces ?? []))
  }, [])
  useEffect(() => {
    if (!workspaceId) return
    fetch(`/api/workspaces/${workspaceId}/agents`).then(r => r.json()).then(d => setAgents(d.agents ?? []))
    fetch(`/api/workspaces/${workspaceId}/channels`).then(r => r.json()).then(d => setChannels(d.channels ?? []))
    fetch(`/api/workspaces/${workspaceId}/documents`).then(r => r.json()).then(d => setDocs(d.documents ?? []))
  }, [workspaceId])

  return (
    <div className="min-h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="border-b border-[var(--color-border)] px-6 py-3 flex items-center justify-between bg-[var(--color-surface)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-[var(--color-accent)] flex items-center justify-center text-white font-bold">B</div>
          <div>
            <div className="text-sm font-medium">{workspaces[0]?.name ?? 'Loading…'}</div>
            <div className="text-xs text-[var(--color-text-dim)]">Dashboard preview · alt UI</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--color-text-dim)]">{me.email}</span>
          <button onClick={onLogout} className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)]">Sign out</button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-8">
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-medium">Your agents</h2>
            <span className="text-xs text-[var(--color-text-dim)]">{agents.length} total</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agents.map(a => (
              <button
                key={a.id}
                onClick={() => setOpenAgent(a)}
                className="text-left bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-4 hover:border-[var(--color-accent)] hover:bg-[var(--color-hover-bg)] transition"
              >
                <div className="flex items-start gap-3 mb-2">
                  <div className="w-10 h-10 rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] flex items-center justify-center text-base flex-shrink-0">
                    {a.avatar ?? '🤖'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="font-medium truncate">{a.name}</div>
                      {a.hosting === 'pro_droplet' && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 border border-[var(--color-accent)] text-[var(--color-accent)] rounded">Pro</span>}
                      {isByovps(a.hosting) && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 border border-[#6cb6ff] text-[#6cb6ff] rounded">BYOVPS</span>}
                    </div>
                    <div className="text-xs text-[var(--color-text-dim)] truncate">{a.model}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${a.status === 'online' ? 'bg-green-500' : a.status === 'error' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                  <span className="text-[var(--color-text-dim)] capitalize">{a.status}</span>
                </div>
              </button>
            ))}
            <button className="text-left bg-transparent border border-dashed border-[var(--color-border)] rounded-lg p-4 hover:border-[var(--color-accent)] hover:bg-[var(--color-hover-bg)] transition text-[var(--color-text-dim)]">
              <div className="text-2xl mb-2">＋</div>
              <div className="font-medium">Add an agent</div>
              <div className="text-xs">Pick a template or generate one with Surprise me</div>
            </button>
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-medium">Channels</h2>
            <span className="text-xs text-[var(--color-text-dim)]">{channels.length} total</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {channels.map(c => (
              <button
                key={c.id}
                onClick={() => setOpenChannel(c)}
                className="text-left bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm hover:border-[var(--color-accent)] hover:bg-[var(--color-hover-bg)]"
              >
                <div className="font-medium truncate">{c.name}</div>
                {c.topic && <div className="text-xs text-[var(--color-text-dim)] truncate">{c.topic}</div>}
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-medium">Recent documents</h2>
            <span className="text-xs text-[var(--color-text-dim)]">{docs.length} total</span>
          </div>
          <div className="space-y-1.5">
            {docs.slice(0, 6).map(d => (
              <button
                key={d.id}
                onClick={() => setOpenDoc(d)}
                className="w-full flex items-center justify-between bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm hover:border-[var(--color-accent)] hover:bg-[var(--color-hover-bg)] text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {d.pinned && <span className="text-[var(--color-accent)]">★</span>}
                  <span className="truncate">{d.title}</span>
                  {d.folder && <span className="text-xs text-[var(--color-text-dim)]">· {d.folder}</span>}
                </div>
                <span className="text-xs text-[var(--color-text-dim)] flex-shrink-0 ml-3">{timeAgo(d.updated_at)}</span>
              </button>
            ))}
            {docs.length === 0 && (
              <div className="text-sm text-[var(--color-text-dim)] italic">No documents yet.</div>
            )}
          </div>
        </section>
      </main>

      {openAgent && workspaceId && (
        <AgentDrawer
          me={me}
          agent={openAgent}
          workspaceId={workspaceId}
          channels={channels}
          onClose={() => setOpenAgent(null)}
        />
      )}
      {openChannel && workspaceId && (
        <ChannelDrawer
          me={me}
          channel={openChannel}
          workspaceId={workspaceId}
          agents={agents}
          onClose={() => setOpenChannel(null)}
        />
      )}
      {openDoc && workspaceId && (
        <DocDrawer
          doc={openDoc}
          workspaceId={workspaceId}
          onClose={() => setOpenDoc(null)}
        />
      )}
    </div>
  )
}

// Channel-wide conversation drawer. Same composer + message list as the
// agent drawer, but isn't tied to a specific agent — multi-agent channels
// dispatch through Studio's normal selection rules.
function ChannelDrawer({
  me, channel, workspaceId, agents, onClose,
}: {
  me: NonNullable<Me>
  channel: Channel
  workspaceId: string
  agents: AgentSummary[]
  onClose: () => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/channels/${channel.id}/messages`)
      .then(r => r.json()).then(d => setMessages(d.messages ?? []))
  }, [workspaceId, channel.id])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  async function send() {
    if (!draft.trim()) return
    setSending(true)
    const body = draft
    setDraft('')
    const r = await fetch(`/api/workspaces/${workspaceId}/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }).then(r => r.json())
    if (r.ok && r.message) setMessages(prev => [...prev, r.message])
    setSending(false)
    const start = Date.now()
    const baseLen = messages.length + 1
    const poll = setInterval(async () => {
      if (Date.now() - start > 90_000) { clearInterval(poll); return }
      const fresh = await fetch(`/api/workspaces/${workspaceId}/channels/${channel.id}/messages`).then(r => r.json())
      if (fresh.messages?.length > baseLen) {
        setMessages(fresh.messages)
        clearInterval(poll)
      }
    }, 2000)
  }

  const senderName = (m: Message) =>
    m.sender_kind === 'agent' ? (m.agent_name ?? 'agent') : (m.user_name ?? me.name ?? 'you')

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex justify-end" onClick={onClose}>
      <aside
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-2xl bg-[var(--color-bg)] border-l border-[var(--color-border)] flex flex-col h-full"
      >
        <header className="border-b border-[var(--color-border)] px-5 py-3 flex items-center justify-between bg-[var(--color-surface)]">
          <div className="min-w-0">
            <div className="font-medium truncate">#{channel.name}</div>
            <div className="text-xs text-[var(--color-text-dim)] truncate">
              {channel.topic || `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} in this workspace`}
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] text-xl px-2">×</button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-3">
          {messages.length === 0 ? (
            <div className="text-center text-sm text-[var(--color-text-dim)] py-10">
              No messages yet. Start the conversation.
            </div>
          ) : messages.map(m => (
            <div key={m.id} className="flex gap-2">
              <div className="w-7 h-7 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center text-xs flex-shrink-0">
                {m.sender_kind === 'agent' ? (m.agent_avatar ?? '🤖') : (m.user_name?.[0] ?? '?')}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-[var(--color-text-dim)]">{senderName(m)}</div>
                <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
              </div>
            </div>
          ))}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); void send() }}
          className="border-t border-[var(--color-border)] p-3 flex items-end gap-2 bg-[var(--color-surface)]"
        >
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
            }}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder={`Message #${channel.name}…`}
            className="flex-1 resize-none bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-40"
          >
            {sending ? '…' : 'Send'}
          </button>
        </form>
      </aside>
    </div>
  )
}

// Document viewer drawer. Read-only markdown render for v1; edit will come
// later if we like the direction.
function DocDrawer({
  doc, workspaceId, onClose,
}: {
  doc: DocSummary
  workspaceId: string
  onClose: () => void
}) {
  const [body, setBody] = useState<string>('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/documents/${doc.id}`)
      .then(r => r.json())
      .then(d => { setBody(d.document?.body_md ?? ''); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [workspaceId, doc.id])

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex justify-end" onClick={onClose}>
      <aside
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-3xl bg-[var(--color-bg)] border-l border-[var(--color-border)] flex flex-col h-full"
      >
        <header className="border-b border-[var(--color-border)] px-5 py-3 flex items-center justify-between bg-[var(--color-surface)]">
          <div className="min-w-0">
            <div className="font-medium truncate">{doc.title}</div>
            <div className="text-xs text-[var(--color-text-dim)] truncate">
              {doc.folder ? `${doc.folder} · ` : ''}updated {timeAgo(doc.updated_at)}
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] text-xl px-2">×</button>
        </header>
        <div className="flex-1 overflow-y-auto p-6 prose prose-invert max-w-none text-sm">
          {!loaded ? (
            <div className="text-[var(--color-text-dim)]">Loading…</div>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          )}
        </div>
      </aside>
    </div>
  )
}

// Click-into-card drawer. Single conversation surface — focused, no rail.
function AgentDrawer({
  me, agent, workspaceId, channels, onClose,
}: {
  me: NonNullable<Me>
  agent: AgentSummary
  workspaceId: string
  channels: Channel[]
  onClose: () => void
}) {
  // Find the agent's dedicated channel; fall back to #common.
  const dedicated = channels.find(c => c.name.toLowerCase() === agent.name.toLowerCase())
  const common = channels.find(c => c.name === 'common')
  const channelId = dedicated?.id ?? common?.id ?? channels[0]?.id
  const channelName = dedicated?.name ?? common?.name ?? channels[0]?.name ?? '?'

  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!channelId) return
    fetch(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`)
      .then(r => r.json())
      .then(d => setMessages(d.messages ?? []))
  }, [workspaceId, channelId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  async function send() {
    if (!draft.trim() || !channelId) return
    setSending(true)
    const body = draft
    setDraft('')
    const r = await fetch(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }).then(r => r.json())
    if (r.ok && r.message) setMessages(prev => [...prev, r.message])
    setSending(false)
    // Poll for the agent's reply (no WS in this prototype; simpler to read).
    const start = Date.now()
    const poll = setInterval(async () => {
      if (Date.now() - start > 90_000) { clearInterval(poll); return }
      const fresh = await fetch(`/api/workspaces/${workspaceId}/channels/${channelId}/messages`).then(r => r.json())
      if (fresh.messages?.length > messages.length + 1) {
        setMessages(fresh.messages)
        clearInterval(poll)
      }
    }, 2000)
  }

  const senderName = (m: Message) =>
    m.sender_kind === 'agent' ? (m.agent_name ?? 'agent') : (m.user_name ?? me.name ?? 'you')

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex justify-end" onClick={onClose}>
      <aside
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-2xl bg-[var(--color-bg)] border-l border-[var(--color-border)] flex flex-col h-full"
      >
        <header className="border-b border-[var(--color-border)] px-5 py-3 flex items-center justify-between bg-[var(--color-surface)]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] flex items-center justify-center flex-shrink-0">
              {agent.avatar ?? '🤖'}
            </div>
            <div className="min-w-0">
              <div className="font-medium truncate">{agent.name}</div>
              <div className="text-xs text-[var(--color-text-dim)] truncate">in #{channelName}</div>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] text-xl px-2">×</button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-3">
          {messages.length === 0 ? (
            <div className="text-center text-sm text-[var(--color-text-dim)] py-10">
              No messages yet. Say hi.
            </div>
          ) : messages.map(m => (
            <div key={m.id} className="flex gap-2">
              <div className="w-7 h-7 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center text-xs flex-shrink-0">
                {m.sender_kind === 'agent' ? (m.agent_avatar ?? '🤖') : (m.user_name?.[0] ?? '?')}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-[var(--color-text-dim)]">{senderName(m)}</div>
                <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
              </div>
            </div>
          ))}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); void send() }}
          className="border-t border-[var(--color-border)] p-3 flex items-end gap-2 bg-[var(--color-surface)]"
        >
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
            }}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder={`Message ${agent.name}…`}
            className="flex-1 resize-none bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            className="bg-[var(--color-accent)] text-white px-4 py-2 rounded text-sm hover:opacity-90 disabled:opacity-40"
          >
            {sending ? '…' : 'Send'}
          </button>
        </form>
      </aside>
    </div>
  )
}
