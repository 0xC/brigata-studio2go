import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { visit } from 'unist-util-visit'
import remarkGfm from 'remark-gfm'
import type { Me } from './App'
import { Documents } from './Documents'
import { Command } from './Command'
import { Settings, type SettingsTarget } from './Settings'
import { Brigade } from './Brigade'
import { Admin } from './Admin'
import { CommandCenterDemo } from './CommandCenterDemo'
import { useResilientWs } from './lib/useWs'
import { useRailState, RailResizeHandle } from './lib/rail'
import { RailFooter } from './RailFooter'
import { usePref } from './lib/prefs'
import { IconPencil, IconTrash, IconPaperclip, IconChannel, IconSplit, IconDocument, IconBrigade, IconDashboard, IconGear, IconFocus, IconRelay } from './lib/icons'
import { SafetyBadge } from './SafetyBadge'
import { type SafetyProfile } from './agentSafety'
import { isImageAvatar, AgentAvatar } from './lib/avatar'
import { isWorkspaceIcon, workspaceIconSrc } from './workspaceIcons'
import { isByovps } from './agentHosting'

type WorkspaceRow = { id: string; name: string; plan: string; role: string; theme?: string | null; icon?: string | null }
type Channel = { id: string; name: string; topic: string | null }
type Member = { id: string; name: string | null; email: string; avatar_url?: string | null }
type MentionCandidate = { key: string; token: string; label: string; kind: 'agent' | 'human'; avatar: string | null }

// @-handles a display name answers to: first word, and the whole name de-spaced.
// Mirrors handlesFor() in server/src/mentions.ts so the pill matches what the
// server actually records.
function mentionHandlesFor(name: string): string[] {
  const n = name.trim().toLowerCase()
  if (!n) return []
  const first = n.split(/\s+/)[0]
  const squashed = n.replace(/\s+/g, '')
  return squashed === first ? [first] : [first, squashed]
}

// remark plugin: pill any @token that matches a known member/agent handle so a
// real mention is visibly highlighted in the body (for everyone, incl. the
// sender). Unknown @tokens are left as plain text. Renders via mdast `data.hName`
// → a <span class="cc-at"> that mdast-util-to-hast emits for us.
function remarkMentions(handles: Set<string>) {
  return (tree: unknown) => {
    // Collect edits during traversal, then apply AFTER (reverse order so earlier
    // indices stay valid). Mutating mid-visit and returning an index is the
    // unist-util-visit foot-gun that blanks the app; this avoids it entirely and
    // never re-walks the inserted "@name" nodes.
    const edits: { parent: { children: unknown[] }; index: number; out: unknown[] }[] = []
    visit(tree as never, 'text', (node: { value: string }, index: number | null, parent: { children: unknown[] } | null) => {
      if (!parent || index == null) return
      const value = node.value
      const re = /(^|[\s(])@([A-Za-z0-9][\w-]*)/g
      const out: unknown[] = []
      let last = 0
      let m: RegExpExecArray | null
      let changed = false
      while ((m = re.exec(value)) !== null) {
        if (!handles.has(m[2].toLowerCase())) continue
        const at = m.index + m[1].length
        if (at > last) out.push({ type: 'text', value: value.slice(last, at) })
        out.push({ type: 'mention', data: { hName: 'span', hProperties: { className: 'cc-at' } }, children: [{ type: 'text', value: '@' + m[2] }] })
        last = at + 1 + m[2].length
        changed = true
      }
      if (!changed) return
      if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
      edits.push({ parent, index, out })
    })
    for (let i = edits.length - 1; i >= 0; i--) {
      edits[i].parent.children.splice(edits[i].index, 1, ...edits[i].out)
    }
  }
}
type AttachmentMeta = {
  id: string
  kind: 'text' | 'image' | 'pdf' | 'other'
  filename: string
  mime_type: string
  size_bytes: number
}
type Message = {
  id: string
  sender_kind: 'user' | 'agent' | 'system'
  body: string
  created_at: string
  sender_user_id?: string | null
  user_name: string | null
  user_avatar: string | null
  agent_name: string | null
  agent_avatar: string | null
  agent_hosting?: string | null
  model?: string | null
  turn_ms?: number | null
  attachments?: AttachmentMeta[]
  // Reply + reactions (backend lands separately; all optional so the UI
  // degrades gracefully until the server serves them — see brigade spec).
  reply_to_id?: string | null
  reply_to?: { id: string; sender_kind: 'user' | 'agent'; sender_label: string; excerpt: string } | null
  reactions?: { emoji: string; count: number; mine: boolean }[]
  // Human members @-mentioned in this message (resolved server-side). Used to
  // highlight the message for whoever was addressed.
  mentioned_user_ids?: string[]
}

// Quick-react palette shown in the per-message reaction popover.
const REACTION_EMOJIS = ['👍', '❤️', '😄', '🎉', '🤔', '✅']

const LARGE_PASTE_CHARS = 2000

// Slash-command palette for the composer autocomplete (typing "/" pops the list).
const SLASH_COMMANDS: { cmd: string; arg?: string; desc: string }[] = [
  { cmd: '/help', desc: 'Show the full command list' },
  { cmd: '/new', arg: '<title>', desc: 'Create a document in this room' },
  { cmd: '/topic', arg: '[text]', desc: 'Set or clear the room topic' },
  { cmd: '/rename', arg: '<name>', desc: 'Rename the current room' },
  { cmd: '/me', arg: '<action>', desc: 'Post an action in italics' },
  { cmd: '/shrug', arg: '[text]', desc: '¯\\_(ツ)_/¯' },
]

// Command-center (preview redesign) rail destinations.
type CcSection = 'channels' | 'brigade' | 'documents' | 'overview' | 'settings'

const THEME_IDS = ['graphite', 'ember', 'atelier']
const LEGACY_THEMES: Record<string, string> = {
  dark: 'graphite', dracula: 'graphite', nord: 'graphite',
  'solarized-dark': 'graphite', 'catppuccin-mocha': 'graphite',
  light: 'atelier', 'solarized-light': 'atelier',
}
function normalizeTheme(theme: string): string {
  if (THEME_IDS.includes(theme)) return theme
  return LEGACY_THEMES[theme] ?? 'graphite'
}

// Accent + label per theme, for the workspace switcher swatches/labels.
const THEME_META: Record<string, { label: string; accent: string }> = {
  graphite: { label: 'Charcoal', accent: '#a78bfa' },
  ember: { label: 'Ember', accent: '#ff7a5c' },
  atelier: { label: 'Atelier', accent: '#1a5fb4' },
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatTurnMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

function ProStarBadge({ size = 14 }: { size?: number }) {
  return (
    <span
      title="Pro agent"
      aria-label="Pro agent"
      className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[var(--color-bg)] flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        width={size - 2}
        height={size - 2}
        fill="var(--color-accent)"
        stroke="var(--color-accent)"
        strokeWidth="1"
        strokeLinejoin="round"
      >
        <polygon points="12,2 14.9,8.6 22,9.3 16.5,14 18.2,21 12,17.3 5.8,21 7.5,14 2,9.3 9.1,8.6" />
      </svg>
    </span>
  )
}

function ByovpsBadge({ size = 14 }: { size?: number }) {
  return (
    <span
      title="BYOVPS — self-hosted agent"
      aria-label="BYOVPS — self-hosted agent"
      className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[var(--color-bg)] flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span
        className="rounded-full"
        style={{ width: size - 6, height: size - 6, background: '#6cb6ff', boxShadow: '0 0 0 1px rgba(108,182,255,0.5)' }}
      />
    </span>
  )
}

// First non-heading sentence of an agent's soul_md, capped — the In-focus blurb.
function ccBlurb(soul: string): string {
  if (!soul) return ''
  const line = soul.split('\n').map(l => l.trim()).find(l => l && !/^#{1,6}\s/.test(l) && !/^[-*>]/.test(l)) ?? ''
  const sentence = line.split(/(?<=[.!?])\s/)[0] || line
  return sentence.length > 150 ? sentence.slice(0, 147).trimEnd() + '…' : sentence
}

// The /help slash-command panel. Extracted so both the legacy layout and the
// command-center redesign can render it.
function SlashHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" style={{ position: 'fixed', inset: 0, zIndex: 80 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium">Help</h3>
          <button onClick={onClose} className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]">✕</button>
        </div>

        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Slash commands</div>
        <dl className="space-y-2 text-sm mb-5">
          <div><dt className="font-mono text-[var(--color-accent)]">/help</dt><dd className="text-[var(--color-text-dim)]">Show this list.</dd></div>
          <div><dt className="font-mono text-[var(--color-accent)]">/new &lt;title&gt;</dt><dd className="text-[var(--color-text-dim)]">Create a document in this room and open it.</dd></div>
          <div><dt className="font-mono text-[var(--color-accent)]">/topic [text]</dt><dd className="text-[var(--color-text-dim)]">Set or clear the room topic.</dd></div>
          <div><dt className="font-mono text-[var(--color-accent)]">/rename &lt;name&gt;</dt><dd className="text-[var(--color-text-dim)]">Rename the current room.</dd></div>
          <div><dt className="font-mono text-[var(--color-accent)]">/me &lt;action&gt;</dt><dd className="text-[var(--color-text-dim)]">Post an action in italics (e.g. <span className="font-mono">/me ships it</span>).</dd></div>
          <div><dt className="font-mono text-[var(--color-accent)]">/shrug [text]</dt><dd className="text-[var(--color-text-dim)]">¯\_(ツ)_/¯</dd></div>
        </dl>

        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Composing</div>
        <ul className="space-y-1 text-sm mb-5 text-[var(--color-text-dim)]">
          <li>Type <span className="font-mono text-[var(--color-text)]">@</span> to mention an agent (pick from the popup).</li>
          <li>📎 attaches files. Drag-and-drop works too. Pasting a large block of text auto-attaches it.</li>
          <li>Images and PDFs are visible to your agents. Hover your own messages to edit or delete.</li>
        </ul>

        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Tips</div>
        <ul className="space-y-1 text-sm mb-5 text-[var(--color-text-dim)]">
          <li><span className="font-mono text-[var(--color-text)]">Enter</span> sends · <span className="font-mono text-[var(--color-text)]">Shift+Enter</span> adds a new line.</li>
          <li>@mention <em>several</em> agents in one message to get them working together in the room.</li>
          <li>Open a document to <span className="text-[var(--color-text)]">edit, print, or download</span> it; drag docs into folders to keep things tidy.</li>
          <li>Each room has its own documents — see the <span className="text-[var(--color-text)]">Docs</span> list in the sidebar.</li>
        </ul>

        <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-2">Agent capabilities</div>
        <div className="text-sm mb-1">Standard agents can:</div>
        <ul className="space-y-1 text-sm text-[var(--color-text-dim)] mb-3 pl-4">
          <li>• Read &amp; write workspace documents</li>
          <li>• Search the web with citations</li>
          <li>• Fetch specific pages</li>
          <li>• Hold conversation context within a room</li>
        </ul>
        <div className="text-xs text-[var(--color-text-dim)] italic">
          A Pro server gives agents shell access — they can build &amp; run web apps, schedule tasks, automate browsers, and use integrations. Pro is a server, not an agent: one Pro server runs up to 3 agents at one flat price, and add a fourth and you add a second server. The platform sets it up in one click; you don't touch a terminal. See Settings → your agent → Capabilities for the full picture.
        </div>
      </div>
    </div>
  )
}

export function Workspace({ me, onLogout }: { me: NonNullable<Me>; onLogout: () => void }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null)
  // Doc counts per channel (id -> count) for the channel-header docs affordance.
  const [docCountByChannel, setDocCountByChannel] = useState<Record<string, number>>({})
  // Per-channel doc list, for the docs section below the channels list in the rail.
  const [docsByChannel, setDocsByChannel] = useState<Record<string, { id: string; title: string; pinned: boolean }[]>>({})
  // Inline doc viewer: a doc opens in the channel pane itself (single window you
  // flip between chat and doc), instead of switching to the separate Docs panel.
  const [inlineDocId, setInlineDocId] = useState<string | null>(null)
  const [inlineDoc, setInlineDoc] = useState<{ id: string; title: string; body_md: string } | null>(null)
  const [inlineDocEditing, setInlineDocEditing] = useState(false)
  const [inlineDraftBody, setInlineDraftBody] = useState('')
  // Lets the channel header jump the Documents panel to a given channel's scope.
  const [docScopeChannel, setDocScopeChannel] = useState<string | null>(null)
  const [docScopeNonce, setDocScopeNonce] = useState(0)
  // Lets an inline doc chip open one specific doc in the Documents panel.
  const [docOpenId, setDocOpenId] = useState<string | null>(null)
  const [docOpenNonce, setDocOpenNonce] = useState(0)
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMeta[]>([])
  const [uploadingCount, setUploadingCount] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // Reply target (shown as a chip above the composer) + which message's
  // reaction picker is open.
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null)
  // Per-channel unseen @mention counts (distinct from plain unread — a direct
  // address gets a stronger "@" badge).
  const [mentionsByChannel, setMentionsByChannel] = useState<Record<string, number>>({})
  const [typingAgents, setTypingAgents] = useState<Map<string, { name: string; avatar: string | null }>>(new Map())
  const [unreadByChannel, setUnreadByChannel] = useState<Record<string, number>>({})
  type PanelKind = 'command' | 'brigade' | 'channels' | 'documents' | 'settings'
  // Tab order + display labels. Content/daily-driver tabs lead; agent
  // management + the overview dashboard trail; Settings stays last. 'command'
  // surfaces as "Overview" (it's a status dashboard, not a command palette).
  const PANEL_ORDER: PanelKind[] = ['channels', 'documents', 'brigade', 'command', 'settings']
  const PANEL_LABELS: Record<PanelKind, string> = {
    channels: 'Rooms',
    documents: 'Documents',
    brigade: 'Brigade',
    command: 'Overview',
    settings: 'Settings',
  }

  const [leftPanel, setLeftPanel] = usePref<PanelKind>('leftPanel', 'channels')
  const [rightPanel, setRightPanel] = usePref<PanelKind | null>('rightPanel', 'documents')
  const [splitRatio, setSplitRatio] = usePref<number>('splitRatio', 0.5)
  const [lastActivePane, setLastActivePane] = useState<'left' | 'right'>('left')
  // Backwards-compat alias so the existing scroll/render helpers using `tab` keep working.
  const tab = leftPanel
  const [showNewChannel, setShowNewChannel] = useState(false)
  const [newChannelName, setNewChannelName] = useState('')
  const [renamingChannelId, setRenamingChannelId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [agents, setAgents] = useState<{ id: string; name: string; avatar: string | null; hosting?: string | null; safety_profile?: SafetyProfile }[]>([])
  const [members, setMembers] = useState<Member[]>([])
  // Handles (member first-names + agent names) used to pill real @mentions in
  // message bodies. Rebuilt when the roster changes.
  const mentionHandles = useMemo(() => {
    const s = new Set<string>()
    for (const mem of members) for (const h of mentionHandlesFor(mem.name ?? mem.email)) s.add(h)
    for (const a of agents) for (const h of mentionHandlesFor(a.name)) s.add(h)
    return s
  }, [members, agents])
  // Each array element must be a unified *attacher* (plugin), which unified calls
  // to get the transformer. remarkMentions(handles) IS the transformer, so wrap it
  // in an attacher — putting the transformer directly in the array makes unified
  // call it as an attacher with tree=undefined and crashes at parse/freeze.
  const mentionPlugins = useMemo(() => [remarkGfm, () => remarkMentions(mentionHandles)], [mentionHandles])
  // Agents with access to the currently-selected room (for the room-scoped Brigade
  // list). null = not yet loaded / fell back; we render the full `agents` list then.
  const [roomAgents, setRoomAgents] = useState<{ id: string; name: string; avatar: string | null; hosting?: string | null }[] | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashHelpOpen, setSlashHelpOpen] = useState(false)
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  // Newbie demo allotment, loaded only when the user has no Claude token. null =
  // not loaded / no demo. Refreshed after each send so the "messages left"
  // count and the cap-reached state stay current.
  const [demo, setDemo] = useState<{ messagesRemaining: number; capReached: boolean; converted: boolean } | null>(null)
  const draftInputRef = useRef<HTMLTextAreaElement>(null)
  // Auto-grow the composer textarea to fit its content (wrapped lines included),
  // capped — beyond the cap it scrolls. Recomputes on every draft change (typing,
  // history recall, clear-after-send).
  useEffect(() => {
    const el = draftInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [draft])
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Shell-style prompt history. promptHistoryRef[0] is the most recent sent
  // message. historyIndexRef is null when composing fresh, else the index into
  // the history array. scratchDraftRef holds whatever was being typed before
  // the user started arrow-navigating.
  const promptHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number | null>(null)
  const scratchDraftRef = useRef<string>('')
  // Multi-workspace state (deploy 2). Active workspace persists across reloads.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(() => {
    try { return localStorage.getItem('bw_active_workspace') } catch { return null }
  })
  const [wsSwitcherOpen, setWsSwitcherOpen] = useState(false)
  const [wsSwitcherMode, setWsSwitcherMode] = useState<'menu' | 'create' | 'accept'>('menu')
  const [wsCreateName, setWsCreateName] = useState('')
  const [wsAcceptToken, setWsAcceptToken] = useState('')
  const [wsActionBusy, setWsActionBusy] = useState(false)
  const [wsActionError, setWsActionError] = useState<string | null>(null)
  useEffect(() => {
    if (activeWorkspaceId) {
      try { localStorage.setItem('bw_active_workspace', activeWorkspaceId) } catch { /* ignore */ }
    }
  }, [activeWorkspaceId])
  useEffect(() => {
    if (!wsSwitcherOpen) return
    // Use mousedown, NOT click: a menu item's onClick (e.g. "New workspace")
    // switches the dropdown to a different mode, which unmounts the clicked
    // element. On the later bubbled `click`, that target is already detached, so
    // `closest('.sb-ws')` returns null and we'd wrongly treat it as an outside
    // click and close the dropdown — making the create/accept forms unreachable.
    // mousedown fires before React re-renders, while the target is still in-tree.
    function onMouseDown(e: MouseEvent) {
      const t = e.target as HTMLElement
      if (!t.closest('.sb-ws') && !t.closest('.cc-ws-wrap')) closeSwitcher()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [wsSwitcherOpen])
  useEffect(() => {
    try {
      const stored = localStorage.getItem('bw_prompt_history')
      if (stored) promptHistoryRef.current = JSON.parse(stored)
    } catch { /* ignore */ }
  }, [])
  // Load demo allotment when the user has no Claude connected. Re-fetched as
  // messages arrive (an agent reply consumes a demo turn). No-ops when demo mode
  // is disabled server-side (enabled:false) or the user never started one.
  useEffect(() => {
    if (me.has_anthropic_token) { setDemo(null); return }
    let cancelled = false
    fetch('/api/auth/demo/state')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return
        if (d?.enabled && d?.demo?.started) setDemo(d.demo)
        else setDemo(null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [me.has_anthropic_token, messages.length])
  function recordPrompt(p: string) {
    const trimmed = p.trim()
    if (!trimmed) return
    const cur = promptHistoryRef.current
    // De-dupe consecutive identical sends.
    if (cur[0] === trimmed) return
    const next = [trimmed, ...cur].slice(0, 100)
    promptHistoryRef.current = next
    historyIndexRef.current = null
    scratchDraftRef.current = ''
    try { localStorage.setItem('bw_prompt_history', JSON.stringify(next)) } catch { /* ignore */ }
  }
  const [railOpen, setRailOpen] = useState(false)
  const [theme, setTheme] = usePref<string>('theme', 'graphite')
  const [profileOpen, setProfileOpen] = useState(false)
  // Persist the admin-console modal across refresh too (it's a modal, not a rail
  // section, so the section-persistence above doesn't cover it). Only restore it
  // for admins. Direct localStorage, same as the section.
  const [adminOpen, setAdminOpenState] = useState<boolean>(() => {
    try { return me.is_admin === true && localStorage.getItem('bw_admin_open') === '1' } catch { return false }
  })
  const setAdminOpen = (open: boolean) => {
    try { localStorage.setItem('bw_admin_open', open ? '1' : '0') } catch { /* ignore */ }
    setAdminOpenState(open)
  }

  // ── Command-center (preview redesign) data ───────────────────────────────
  // Handoffs (Relay feed + in-stream + derived presence) and per-agent 30d
  // usage (In-focus stats). Loaded only when the redesign shell is active.
  type CCTask = {
    id: string; from_kind: string; from_agent_id: string | null; to_agent_id: string
    title: string | null; body_md: string | null; status: string; result_summary: string | null; created_at: string
  }
  const [ccTasks, setCcTasks] = useState<CCTask[]>([])
  const [ccHandoffs, setCcHandoffs] = useState<Record<string, number>>({})
  const [ccUsage, setCcUsage] = useState<Record<string, { turns: number; cost: number }>>({})
  const [ccBios, setCcBios] = useState<Record<string, string>>({}) // agent_id -> persona blurb
  // effect lives below, after currentWorkspace is declared

  // Normalize retired theme values (community themes, old dark/light) to the
  // three Brigata themes so legacy server-stored prefs still resolve.
  // personalTheme is the user's own pref; appliedTheme is what's actually shown.
  // A workspace's theme seeds appliedTheme when you switch into it, but the
  // profile switcher (setTheme) always overrides it immediately so it's never
  // dead — the workspace theme just re-asserts when you switch back in.
  const personalTheme = normalizeTheme(theme)
  const [appliedTheme, setAppliedTheme] = useState(personalTheme)

  const THEMES: { id: string; label: string; isDark: boolean; swatch: [string, string] }[] = [
    { id: 'graphite', label: 'Charcoal', isDark: true, swatch: ['#17171b', '#a78bfa'] },
    { id: 'ember', label: 'Ember', isDark: true, swatch: ['#14100c', '#ff7a5c'] },
    { id: 'atelier', label: 'Atelier', isDark: false, swatch: ['#f0eadc', '#1a5fb4'] },
  ]

  // Prevent both panels showing the same kind.
  useEffect(() => {
    if (rightPanel === leftPanel) setRightPanel(null)
  }, [leftPanel, rightPanel])

  // Split is desktop-only. On mobile, treat rightPanel as if it weren't set.
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  const effectiveRight: PanelKind | null = isDesktop ? rightPanel : null

  // Channels-view rail (resize/collapse). Documents/Settings own their own.
  const channelsRail = useRailState('bw_channels_rail')

  function panelClasses(kind: PanelKind) {
    const shown = kind === leftPanel || kind === effectiveRight
    // overflow-clip (not -hidden): a pane must never become its own scroll port.
    // overflow-hidden still allows *programmatic* scrolling, so when a control
    // inside a taller-than-the-pane view (e.g. toggling an agent skill deep in
    // Settings) takes focus, the browser scrolls the focused element into view by
    // scrolling the pane itself — with no scrollbar to recover, the content is
    // stuck off-screen until refresh. overflow-clip clips identically but is not
    // a scroll container, so it can never be scrolled. Inner areas still scroll.
    return `${shown ? 'flex' : 'hidden'} flex-col min-w-0 min-h-0 overflow-clip`
  }
  function panelStyle(kind: PanelKind): React.CSSProperties {
    if (kind === leftPanel) {
      return { order: 0, flexBasis: effectiveRight ? `${splitRatio * 100}%` : '100%', flexGrow: 0, flexShrink: 1 }
    }
    if (kind === effectiveRight) {
      return { order: 2, flexBasis: `${(1 - splitRatio) * 100}%`, flexGrow: 0, flexShrink: 1 }
    }
    return {}
  }

  // Track which pane the user last interacted with so tab clicks target it.
  function recordPaneActivity(kind: PanelKind) {
    if (kind === leftPanel) setLastActivePane('left')
    else if (kind === effectiveRight) setLastActivePane('right')
  }

  // Route a tab click to the most recently active pane. If the target panel
  // is already on the other pane, swap them instead of duplicating.
  function selectPanel(k: PanelKind) {
    if (lastActivePane === 'right' && effectiveRight) {
      if (k === leftPanel && rightPanel) {
        setLeftPanel(rightPanel)
        setRightPanel(k)
      } else {
        setRightPanel(k)
      }
    } else {
      if (k === rightPanel) {
        setRightPanel(leftPanel)
        setLeftPanel(k)
      } else {
        setLeftPanel(k)
      }
    }
  }

  // Split controls (docked toolbar). Open a second pane (defaults to Documents,
  // or Channels when Documents is already primary), swap the two panes, or close.
  function openSplit() {
    setRightPanel(leftPanel === 'documents' ? 'channels' : 'documents')
    setLastActivePane('right') // focus the new pane so the next tab click fills it
  }
  function swapPanes() {
    if (!rightPanel) return
    const l = leftPanel
    setLeftPanel(rightPanel)
    setRightPanel(l)
  }
  function closeSplit() {
    setRightPanel(null)
    setLastActivePane('left')
  }

  // Bumped to deep-link Settings straight to Connect Claude (from the no-token banner).
  const [openClaudeNonce, setOpenClaudeNonce] = useState(0)
  function goConnectClaude() {
    setOpenClaudeNonce(n => n + 1)
    selectPanel('settings')
  }

  // Deep-link from the Brigade roster into a Settings section (agent editor,
  // new-agent form, or plan/workspace). Nonce makes repeat targets re-fire.
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null)
  const [settingsTargetNonce, setSettingsTargetNonce] = useState(0)
  // Which rail destination is active in the command-center (preview) layout.
  // Persist the current section across refresh in DIRECT, synchronous localStorage
  // (not the server-backed usePref, whose async loadFromServer overwrites the cache
  // on load and was clobbering the restored section back to the default). Mirrors
  // the reliable per-workspace room-remember below.
  const [ccSection, setCcSectionState] = useState<CcSection>(() => {
    try { const v = localStorage.getItem('bw_cc_section'); if (v) return v as CcSection } catch { /* ignore */ }
    return 'channels'
  })
  const setCcSection = (s: CcSection) => {
    try { localStorage.setItem('bw_cc_section', s) } catch { /* ignore */ }
    setCcSectionState(s)
  }
  // Mobile: the rooms/brigade column collapses into a slide-in drawer.
  const [ccDrawerOpen, setCcDrawerOpen] = useState(false)
  // Composer slash-command autocomplete: highlighted row.
  const [slashIndex, setSlashIndex] = useState(0)
  function openInSettings(target: SettingsTarget) {
    setSettingsTarget(target)
    setSettingsTargetNonce(n => n + 1)
    selectPanel('settings')
    setCcSection('settings')
  }

  function openDocsForChannel(channelId: string | null) {
    setDocScopeChannel(channelId)
    setDocScopeNonce(n => n + 1)
    selectPanel('documents')
    setCcSection('documents')
  }

  // Open one specific doc (from the inline in-channel strip): scope to its
  // channel AND request that exact doc in the Documents panel.
  function openDoc(channelId: string | null, docId: string) {
    setDocScopeChannel(channelId)
    setDocScopeNonce(n => n + 1)
    setDocOpenId(docId)
    setDocOpenNonce(n => n + 1)
    selectPanel('documents')
    setCcSection('documents')
  }

  // Create a new doc that belongs to a channel, from the rail, and open it inline.
  async function createDocInChannel(channelId: string) {
    if (!currentWorkspace) return
    const r = await fetch(`/api/workspaces/${currentWorkspace.id}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Untitled', body_md: '', channel_id: channelId }),
    }).then(r => r.json()).catch(() => null)
    refreshDocCounts.current()
    if (r?.document?.id) { setInlineDocId(r.document.id); setInlineDocEditing(true) }
  }

  function startEditInline() {
    if (!inlineDoc) return
    setInlineDraftBody(inlineDoc.body_md)
    setInlineDocEditing(true)
  }

  async function saveInlineDoc() {
    if (!inlineDoc || !currentWorkspace) return
    const r = await fetch(`/api/workspaces/${currentWorkspace.id}/documents/${inlineDoc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body_md: inlineDraftBody }),
    }).then(r => r.json()).catch(() => null)
    if (r?.document) setInlineDoc(r.document)
    setInlineDocEditing(false)
    refreshDocCounts.current()
  }

  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const justSwitchedChannelRef = useRef(false)
  // Whether the user was pinned near the bottom *before* the latest render.
  // Updated on every scroll so the post-render [messages] effect can decide
  // whether to follow new content without re-measuring geometry that the new
  // (often tall) reply has already inflated. Defaults true so the first reply
  // in a fresh channel scrolls.
  const wasNearBottomRef = useRef(true)
  const activeChannelIdRef = useRef<string | null>(null)
  activeChannelIdRef.current = activeChannelId
  // False until the socket's first open; lets onOpen tell a fresh connect from a
  // reconnect so we only pay the recovery refetch on the latter.
  const wsReconnectRef = useRef(false)

  // --- Browser notifications (quick win: covers the tab-open / backgrounded
  // case; closed-app Web Push + email digest are the larger follow-on). --------
  // Ask permission once, on the first user gesture (browsers require a gesture).
  useEffect(() => {
    if (!('Notification' in window) || Notification.permission !== 'default') return
    const ask = () => { void Notification.requestPermission() }
    window.addEventListener('pointerdown', ask, { once: true })
    return () => window.removeEventListener('pointerdown', ask)
  }, [])

  // Tab title reflects total unread so a backgrounded tab still signals activity.
  useEffect(() => {
    const total = Object.values(unreadByChannel).reduce((a, b) => a + b, 0)
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) brigata.ai studio` : 'brigata.ai studio'
  }, [unreadByChannel])

  // Fire an OS notification for an incoming message the user isn't looking at.
  // Skips the user's own messages; click focuses the tab + opens the channel.
  function maybeNotify(msg: Message, channelId: string | null) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    if (msg.sender_kind === 'user' && !!me.name && msg.user_name === me.name) return
    const sender = msg.sender_kind === 'agent' ? (msg.agent_name ?? 'Agent') : (msg.user_name ?? 'New message')
    try {
      const n = new Notification(sender, { body: (msg.body ?? '').slice(0, 140), tag: channelId ?? 'brigata' })
      n.onclick = () => { window.focus(); if (channelId) setActiveChannelId(channelId) }
    } catch { /* best-effort */ }
  }

  const { wsRef, connected: wsConnected } = useResilientWs('/ws', {
    onOpen: (ws) => {
      // (Re-)subscribe to the active channel after every (re)connect
      const cid = activeChannelIdRef.current
      if (cid) ws.send(JSON.stringify({ type: 'subscribe', channelId: cid }))
      // On a *re*connect, any message broadcast while we were disconnected was
      // missed (it's durably in the DB but never reached this socket). Refetch
      // the active channel so those replies appear instead of staying invisible
      // until a manual refresh. Skipped on the first open — the channel-load
      // effect already fetches then.
      if (wsReconnectRef.current && cid && currentWorkspace) {
        fetch(`/api/workspaces/${currentWorkspace.id}/channels/${cid}/messages`)
          .then(r => r.json())
          .then((d: { messages: Message[] }) => setMessages(d.messages ?? []))
          .catch(() => {})
      }
      wsReconnectRef.current = true
    },
    onMessage: (payload) => {
      const p = payload as {
        type?: string
        message?: Message
        messageId?: string
        body?: string
        channelId?: string
        agentId?: string
        agentName?: string
        avatar?: string | null
        typing?: boolean
        reactions?: { emoji: string; count: number }[]
      }
      if (p.type === 'message' && p.message) {
        const msgChannel = p.channelId
        if (msgChannel && msgChannel !== activeChannelIdRef.current) {
          // Cross-channel: bump unread count, don't add to messages state.
          setUnreadByChannel(prev => ({ ...prev, [msgChannel]: (prev[msgChannel] ?? 0) + 1 }))
          if (p.message.mentioned_user_ids?.includes(me.id)) {
            setMentionsByChannel(prev => ({ ...prev, [msgChannel]: (prev[msgChannel] ?? 0) + 1 }))
          }
          maybeNotify(p.message, msgChannel)
          return
        }
        const landedId = p.message.id
        setMessages(prev => {
          if (prev.some(m => m.id === landedId)) return prev
          return [...prev, p.message!]
        })
        // A mention that lands in the channel the user is actively viewing counts as
        // seen — ping /seen so it clears server-side and never triggers the "what you
        // missed" email. (Only when the tab is actually in front of the user.)
        if (!document.hidden && p.message.mentioned_user_ids?.includes(me.id) && currentWorkspace && msgChannel) {
          void fetch(`/api/workspaces/${currentWorkspace.id}/channels/${msgChannel}/seen`, { method: 'POST' })
        }
        // Active channel but the tab isn't in front of the user → still notify.
        if (document.hidden) maybeNotify(p.message, msgChannel ?? activeChannelIdRef.current)
        setNewMessageIds(prev => new Set(prev).add(landedId))
        setTimeout(() => {
          setNewMessageIds(prev => {
            if (!prev.has(landedId)) return prev
            const next = new Set(prev)
            next.delete(landedId)
            return next
          })
        }, 750)
      } else if (p.type === 'message_edited' && p.messageId && typeof p.body === 'string') {
        setMessages(prev => prev.map(m => m.id === p.messageId ? { ...m, body: p.body! } : m))
      } else if (p.type === 'message_deleted' && p.messageId) {
        setMessages(prev => prev.filter(m => m.id !== p.messageId))
      } else if (p.type === 'message_reactions' && p.messageId && Array.isArray(p.reactions)) {
        // Sync counts from the server but keep THIS viewer's own `mine` flags —
        // the broadcast aggregate is viewer-agnostic.
        setMessages(prev => prev.map(m => {
          if (m.id !== p.messageId) return m
          const mineByEmoji = new Map((m.reactions ?? []).map(r => [r.emoji, r.mine]))
          return {
            ...m,
            reactions: p.reactions!.map(r => ({
              emoji: r.emoji, count: r.count, mine: mineByEmoji.get(r.emoji) ?? false,
            })),
          }
        }))
      } else if (p.type === 'agent_typing' && p.channelId === activeChannelIdRef.current && p.agentId) {
        setTypingAgents(prev => {
          const next = new Map(prev)
          if (p.typing) next.set(p.agentId!, { name: p.agentName ?? 'agent', avatar: p.avatar ?? null })
          else next.delete(p.agentId!)
          return next
        })
      } else if (p.type === 'document_updated' || p.type === 'document_deleted') {
        refreshDocCounts.current()
      }
    },
  })

  useEffect(() => {
    fetch('/api/workspaces')
      .then(r => r.json())
      .then((d: { workspaces: WorkspaceRow[] }) => setWorkspaces(d.workspaces ?? []))
  }, [])

  const currentWorkspace =
    workspaces.find(w => w.id === activeWorkspaceId) ?? workspaces[0]
  // If active id is stale (workspace deleted, etc.) and a real one is loaded,
  // sync our state so localStorage reflects truth.
  useEffect(() => {
    if (currentWorkspace && currentWorkspace.id !== activeWorkspaceId) {
      setActiveWorkspaceId(currentWorkspace.id)
    }
  }, [currentWorkspace?.id, activeWorkspaceId])

  // Command-center data: handoffs + per-agent 30d usage (Relay feed, presence,
  // In-focus stats). Only fetched when the redesign shell is active.
  useEffect(() => {
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('cc') : null
    const active = q !== '0'
    if (!active || !currentWorkspace) return
    let cancelled = false
    const wid = currentWorkspace.id
    fetch(`/api/workspaces/${wid}/tasks`).then(r => r.json()).then(d => { if (!cancelled && d?.ok) setCcTasks(d.tasks ?? []) }).catch(() => {})
    fetch(`/api/workspaces/${wid}/handoff-counts`).then(r => r.json()).then(d => {
      if (cancelled || !d?.ok) return
      const m: Record<string, number> = {}
      for (const x of (d.counts ?? [])) m[x.agent_id] = x.picked_up
      setCcHandoffs(m)
    }).catch(() => {})
    fetch(`/api/workspaces/${wid}/usage?days=30`).then(r => r.json()).then(d => {
      if (cancelled || !d?.ok) return
      const m: Record<string, { turns: number; cost: number }> = {}
      for (const x of (d.by_agent ?? [])) if (x.agent_id) m[x.agent_id] = { turns: x.turns, cost: x.total_cost_usd }
      setCcUsage(m)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [currentWorkspace?.id, messages.length])

  // Per-agent persona blurbs for the In-focus card (from each agent's soul_md).
  useEffect(() => {
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('cc') : null
    if (q === '0' || !currentWorkspace || agents.length === 0) return
    let cancelled = false
    const wid = currentWorkspace.id
    void (async () => {
      const entries = await Promise.all(agents.map(async a => {
        const d = await fetch(`/api/workspaces/${wid}/agents/${a.id}`).then(r => r.json()).catch(() => null)
        return [a.id, ccBlurb(d?.agent?.soul_md ?? '')] as const
      }))
      if (!cancelled) setCcBios(Object.fromEntries(entries))
    })()
    return () => { cancelled = true }
  }, [currentWorkspace?.id, agents.map(a => a.id).join(',')])

  // Load the inline doc when one is opened in the channel pane; clear when closed.
  useEffect(() => {
    if (!inlineDocId || !currentWorkspace) { setInlineDoc(null); setInlineDocEditing(false); return }
    fetch(`/api/workspaces/${currentWorkspace.id}/documents/${inlineDocId}`)
      .then(r => r.json())
      .then((r: { document?: { id: string; title: string; body_md: string } }) => {
        if (r.document) { setInlineDoc(r.document); setInlineDraftBody(r.document.body_md) }
      })
      .catch(() => {})
  }, [inlineDocId, currentWorkspace?.id])

  // Switching channels returns you to that channel's chat (close any open doc).
  useEffect(() => { setInlineDocId(null) }, [activeChannelId])

  // Tally documents per channel for the channel-header docs affordance.
  const refreshDocCounts = useRef<() => void>(() => {})
  refreshDocCounts.current = () => {
    if (!currentWorkspace) return
    fetch(`/api/workspaces/${currentWorkspace.id}/documents`)
      .then(r => r.json())
      .then((r: { documents?: { id: string; title: string; channel_id: string | null; pinned: boolean }[] }) => {
        const counts: Record<string, number> = {}
        const byChannel: Record<string, { id: string; title: string; pinned: boolean }[]> = {}
        for (const d of r.documents ?? []) {
          if (!d.channel_id) continue
          counts[d.channel_id] = (counts[d.channel_id] ?? 0) + 1
          ;(byChannel[d.channel_id] ??= []).push({ id: d.id, title: d.title, pinned: d.pinned })
        }
        setDocCountByChannel(counts)
        setDocsByChannel(byChannel)
      })
      .catch(() => {})
  }
  useEffect(() => { refreshDocCounts.current() }, [currentWorkspace?.id])

  // When you switch into a workspace (or its own theme changes), apply that
  // workspace's theme as its identity default; fall back to the personal pref
  // when it has none.
  useEffect(() => {
    setAppliedTheme(currentWorkspace?.theme ? normalizeTheme(currentWorkspace.theme) : personalTheme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, currentWorkspace?.theme])

  // Keep personal-pref changes (e.g. server-loaded value) reflected when the
  // active workspace has no theme of its own — never clobbers a workspace theme.
  useEffect(() => {
    if (!currentWorkspace?.theme) setAppliedTheme(personalTheme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // Keep <html data-theme> in sync (the boot script set it from localStorage).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', appliedTheme)
  }, [appliedTheme])

  // Profile-dropdown theme change. Sets the personal pref + applies immediately,
  // AND (when you own/admin the workspace) persists it as the workspace theme so
  // it STICKS across refresh/navigation — the load path prioritizes the
  // workspace theme, so without this the dropdown choice reverted. Non-owners
  // keep the personal-pref behavior (the PATCH 403s and is ignored).
  async function applyTheme(themeId: string) {
    setTheme(themeId)
    setAppliedTheme(themeId)
    const canSetWorkspace = currentWorkspace && (currentWorkspace.role === 'owner' || currentWorkspace.role === 'admin')
    if (!canSetWorkspace) return
    try {
      const r = await fetch(`/api/workspaces/${currentWorkspace.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: themeId }),
      })
      if (r.ok) {
        const d = await fetch('/api/workspaces').then(r => r.json())
        setWorkspaces(d.workspaces ?? [])
      }
    } catch {
      /* keep the personal-pref + applied change even if the workspace save fails */
    }
  }

  function closeSwitcher() {
    setWsSwitcherOpen(false)
    setWsSwitcherMode('menu')
    setWsActionError(null)
    setWsCreateName('')
    setWsAcceptToken('')
  }

  async function createWorkspace() {
    const name = wsCreateName.trim()
    if (!name || wsActionBusy) return
    setWsActionBusy(true); setWsActionError(null)
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'network error' }))
    setWsActionBusy(false)
    if (r.ok && r.workspace) {
      const refreshed = await fetch('/api/workspaces').then(r => r.json())
      setWorkspaces(refreshed.workspaces ?? [])
      setActiveWorkspaceId(r.workspace.id)
      closeSwitcher()
    } else {
      // Branch on the machine-readable code (not the human string, which is
      // copy that may be edited server-side). See Cosimo's pricing contract.
      const gated =
        r.code === 'upgrade_required'
          ? 'Creating shared workspaces is a Standard feature. You can always join any workspace you’re invited to — free. Upgrade to Standard ($15/mo) to create your own (up to 2).'
          : r.code === 'workspace_cap_reached'
            ? 'You’ve created your 2 shared workspaces (3 total, counting your personal one). That’s the Standard limit for now.'
            : null
      setWsActionError(gated ?? r.error ?? 'Could not create workspace')
    }
  }

  async function acceptInviteByToken() {
    const raw = wsAcceptToken.trim()
    if (!raw || wsActionBusy) return
    // Accept either a full URL (https://studio.example.com/invite/<token>) or a bare token.
    const tokenMatch = raw.match(/(?:\/invite\/|^)([A-Za-z0-9_-]{8,})/)
    const token = tokenMatch ? tokenMatch[1] : raw
    setWsActionBusy(true); setWsActionError(null)
    const r = await fetch(`/api/workspaces/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'network error' }))
    setWsActionBusy(false)
    if (r.ok) {
      const refreshed = await fetch('/api/workspaces').then(r => r.json())
      setWorkspaces(refreshed.workspaces ?? [])
      // If the API tells us which workspace we just joined, switch to it.
      if (r.workspace?.id) setActiveWorkspaceId(r.workspace.id)
      closeSwitcher()
    } else {
      setWsActionError(r.error ?? 'Invite link is invalid or expired')
    }
  }

  useEffect(() => {
    if (!currentWorkspace) return
    fetch(`/api/workspaces/${currentWorkspace.id}/channels`)
      .then(r => r.json())
      .then((d: { channels: Channel[] }) => {
        setChannels(d.channels ?? [])
        // Prefer the last channel this user was on (per-workspace), fall back to first.
        const remembered = localStorage.getItem(`bw_active_channel_${currentWorkspace.id}`)
        const stillExists = remembered && d.channels?.some(c => c.id === remembered)
        setActiveChannelId(stillExists ? remembered : (d.channels?.[0]?.id ?? null))
      })
    fetch(`/api/workspaces/${currentWorkspace.id}/agents`)
      .then(r => r.json())
      .then((d: { agents: { id: string; name: string; avatar: string | null; hosting?: string | null; safety_profile?: SafetyProfile }[] }) => {
        setAgents(d.agents ?? [])
      })
    // Members — used to pill real human @mentions in message bodies.
    fetch(`/api/workspaces/${currentWorkspace.id}/members`)
      .then(r => r.json())
      .then((d: { members?: Member[] }) => setMembers(d.members ?? []))
      .catch(() => {})
    // Initial unread counts.
    fetch(`/api/workspaces/${currentWorkspace.id}/unread`)
      .then(r => r.json())
      .then((d: { unread: Record<string, number>; mentions?: Record<string, number> }) => {
        setUnreadByChannel(d.unread ?? {})
        setMentionsByChannel(d.mentions ?? {})
      })
      .catch(() => {})
  }, [currentWorkspace?.id])

  // Subscribe to *all* channels in the workspace so cross-channel messages can
  // drive unread badges. The active-channel resubscribe below is idempotent.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    for (const ch of channels) {
      ws.send(JSON.stringify({ type: 'subscribe', channelId: ch.id }))
    }
  }, [channels, wsRef])

  // Load history + subscribe via WS whenever the active channel changes.
  useEffect(() => {
    if (!activeChannelId || !currentWorkspace) return

    fetch(`/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/messages`)
      .then(r => r.json())
      .then((d: { messages: Message[] }) => setMessages(d.messages ?? []))

    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', channelId: activeChannelId }))
    }

    // Mark this channel as seen — clears unread server-side and locally.
    void fetch(`/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/seen`, { method: 'POST' })
    setUnreadByChannel(prev => {
      if (!(activeChannelId in prev)) return prev
      const next = { ...prev }
      delete next[activeChannelId]
      return next
    })
    // Opening the channel also clears its @mention badge (server marks them seen).
    setMentionsByChannel(prev => {
      if (!(activeChannelId in prev)) return prev
      const next = { ...prev }
      delete next[activeChannelId]
      return next
    })
  }, [activeChannelId, currentWorkspace?.id, wsRef])

  // Room-scope the Brigade list: fetch the agents that can access the selected
  // room. Falls back to the full `agents` list (roomAgents = null) when no room
  // is selected, or if the fetch fails / returns empty — so it's never empty.
  useEffect(() => {
    if (!currentWorkspace || !activeChannelId) { setRoomAgents(null); return }
    let cancelled = false
    fetch(`/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/agents`)
      .then(r => r.json())
      .then((d: { ok?: boolean; agents?: { id: string; name: string; avatar: string | null; hosting?: string | null }[] }) => {
        if (cancelled) return
        const list = d.ok && Array.isArray(d.agents) ? d.agents : []
        setRoomAgents(list.length > 0 ? list : null)
      })
      .catch(() => { if (!cancelled) setRoomAgents(null) })
    return () => { cancelled = true }
  }, [activeChannelId, currentWorkspace?.id])

  // Mark a flag whenever the channel changes or we switch to the channels tab;
  // consume it after the next messages render.
  useEffect(() => {
    justSwitchedChannelRef.current = true
    setTypingAgents(new Map())
    if (currentWorkspace && activeChannelId) {
      localStorage.setItem(`bw_active_channel_${currentWorkspace.id}`, activeChannelId)
    }
  }, [activeChannelId, currentWorkspace?.id])

  // When the channels tab becomes active again, jump straight to the bottom.
  // (The container has just remounted, so `messages` didn't change — we have to
  // trigger this manually.)
  useEffect(() => {
    if (tab !== 'channels') return
    requestAnimationFrame(() => {
      const el = messagesScrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [tab])

  useEffect(() => {
    const el = messagesScrollRef.current
    if (!el) return
    const settle = () => { el.scrollTop = el.scrollHeight }
    if (justSwitchedChannelRef.current) {
      // Jump to the newest message. On a fresh load/refresh the history fetch is
      // async, so the FIRST render here is often an empty list — don't consume the
      // flag until real content has actually rendered. Even then a fixed tick loses
      // to late-inflating content (markdown, avatars, images), and a reflow-driven
      // onScroll (scrollTop still 0) can mark us "not near bottom" and strand the
      // view at the TOP. So once real content exists, keep force-pinning to the
      // bottom across the load window via a ResizeObserver (content growth re-pins),
      // until the user actually scrolls or the window ends.
      settle()
      requestAnimationFrame(settle)
      if (messages.length > 0) {
        justSwitchedChannelRef.current = false
        wasNearBottomRef.current = true // we ARE at the bottom now
        const ro = new ResizeObserver(() => { el.scrollTop = el.scrollHeight })
        ro.observe(el)
        for (const c of Array.from(el.children)) ro.observe(c)
        const release = () => {
          ro.disconnect()
          el.removeEventListener('wheel', release)
          el.removeEventListener('touchmove', release)
        }
        // A real user scroll releases the pin; otherwise stop once content settles.
        el.addEventListener('wheel', release, { passive: true })
        el.addEventListener('touchmove', release, { passive: true })
        setTimeout(release, 1200)
      }
      return
    }
    // Follow new messages only if the user was already near the bottom *before*
    // the new content rendered (snapshot kept by onScroll). Measuring here would
    // be wrong: the new reply has already inflated scrollHeight while scrollTop
    // hasn't moved, so a tall reply looks like "scrolled up" and breaks follow.
    if (!wasNearBottomRef.current) return
    settle()
    requestAnimationFrame(settle)
    setTimeout(settle, 120)
  }, [messages])

  const activeChannel = channels.find(c => c.id === activeChannelId) ?? null

  function showFeedback(msg: string) {
    setCommandFeedback(msg)
    setTimeout(() => setCommandFeedback(null), 3500)
  }

  async function runSlashCommand(raw: string): Promise<boolean> {
    if (!raw.startsWith('/')) return false
    if (!currentWorkspace) return false
    const space = raw.indexOf(' ')
    const cmd = (space === -1 ? raw : raw.slice(0, space)).toLowerCase()
    const args = space === -1 ? '' : raw.slice(space + 1).trim()

    if (cmd === '/help') {
      setSlashHelpOpen(true); return true
    }
    if (cmd === '/shrug') {
      const body = (args ? args + ' ' : '') + '¯\\_(ツ)_/¯'
      await fetch(`/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      return true
    }
    if (cmd === '/topic') {
      if (!activeChannelId) { showFeedback('No room selected'); return true }
      const r = await fetch(`/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: args }),
      }).then(r => r.json())
      if (r.ok) {
        showFeedback(args ? `Topic set: ${args}` : 'Topic cleared')
        // refresh channels so the header updates
        const cr = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`).then(r => r.json())
        setChannels(cr.channels ?? [])
      } else showFeedback(r.error ?? 'Failed to set topic')
      return true
    }
    if (cmd === '/rename') {
      if (!activeChannelId || !args) { showFeedback('Usage: /rename <new-name>'); return true }
      const r = await fetch(`/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: args }),
      }).then(r => r.json())
      if (r.ok) {
        showFeedback(`Room renamed to #${r.channel.name}`)
        const cr = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`).then(r => r.json())
        setChannels(cr.channels ?? [])
      } else showFeedback(r.error ?? 'Failed to rename')
      return true
    }
    if (cmd === '/new') {
      if (!activeChannelId) { showFeedback('No room selected'); return true }
      if (!args) { showFeedback('Usage: /new <document title>'); return true }
      const r = await fetch(`/api/workspaces/${currentWorkspace.id}/documents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: args, body_md: '', channel_id: activeChannelId }),
      }).then(r => r.json()).catch(() => null)
      if (r?.document?.id) {
        refreshDocCounts.current()
        setInlineDocId(r.document.id); setInlineDocEditing(true)
        showFeedback(`Created “${args}”`)
      } else showFeedback('Could not create the document')
      return true
    }
    if (cmd === '/me') {
      if (!args) { showFeedback('Usage: /me <action>'); return true }
      await fetch(`/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `_${args}_` }),
      })
      return true
    }
    showFeedback(`Unknown command: ${cmd} — try /help`)
    return true
  }

  async function uploadOne(
    workspaceId: string,
    blob: Blob,
    filename: string,
  ): Promise<AttachmentMeta | null> {
    setUploadingCount(n => n + 1)
    setUploadError(null)
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/attachments`, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(filename),
        },
        body: blob,
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        // Strip HTML/JSON envelopes so we don't dump a whole error page into the UI.
        const cleaned = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
        setUploadError(`Upload failed: ${filename} (${r.status})${cleaned ? ` — ${cleaned}` : ''}`)
        return null
      }
      const j = await r.json()
      return j.attachment as AttachmentMeta
    } catch (e) {
      setUploadError(`Upload error: ${(e as Error).message}`)
      return null
    } finally {
      setUploadingCount(n => Math.max(0, n - 1))
    }
  }

  async function addFiles(files: File[] | FileList) {
    if (!currentWorkspace) return
    const wsId = currentWorkspace.id
    const list = Array.from(files)
    const results = await Promise.all(list.map(f => uploadOne(wsId, f, f.name)))
    const successes = results.filter((x): x is AttachmentMeta => x !== null)
    if (successes.length > 0) setPendingAttachments(prev => [...prev, ...successes])
  }

  async function attachLargePaste(text: string) {
    if (!currentWorkspace) return
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const blob = new Blob([text], { type: 'text/markdown' })
    const a = await uploadOne(currentWorkspace.id, blob, `paste-${ts}.md`)
    if (a) setPendingAttachments(prev => [...prev, a])
  }

  async function removePending(id: string) {
    if (!currentWorkspace) return
    setPendingAttachments(prev => prev.filter(p => p.id !== id))
    // Best-effort orphan delete; safe to ignore failures.
    void fetch(`/api/workspaces/${currentWorkspace.id}/attachments/${id}`, {
      method: 'DELETE',
    }).catch(() => {})
  }

  function startEdit(m: Message) {
    setEditingMessageId(m.id)
    setEditDraft(m.body)
  }

  async function saveEdit() {
    if (!currentWorkspace || !activeChannelId || !editingMessageId) return
    const body = editDraft.trim()
    if (!body) { setEditingMessageId(null); return }
    setEditingMessageId(null)
    await fetch(
      `/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/messages/${editingMessageId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    )
  }

  async function deleteMessage(messageId: string) {
    if (!currentWorkspace || !activeChannelId) return
    if (!confirm('Delete this message?')) return
    await fetch(
      `/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/messages/${messageId}`,
      { method: 'DELETE' },
    )
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    const body = draft.trim()
    const atts = pendingAttachments
    if (!activeChannelId || !currentWorkspace) return
    if (!body && atts.length === 0) return

    // Slash command intercept (only when there are no attachments)
    if (body.startsWith('/') && atts.length === 0) {
      recordPrompt(body)
      setDraft('')
      await runSlashCommand(body)
      return
    }

    recordPrompt(body)
    setDraft('')
    setPendingAttachments([])
    setSendError(null)
    const replyId = replyTo?.id ?? null
    setReplyTo(null)
    try {
      const res = await fetch(
        `/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body, attachment_ids: atts.map(a => a.id), reply_to_id: replyId }),
        },
      )
      if (!res.ok) throw new Error(`status ${res.status}`)
    } catch {
      // Restore what the user typed so the message isn't lost on a failed send.
      setDraft(d => (d ? d : body))
      setPendingAttachments(p => (p.length ? p : atts))
      if (replyId) setReplyTo(r => r ?? messages.find(m => m.id === replyId) ?? null)
      setSendError('Couldn’t send — check your connection and try again.')
    }
  }

  // Toggle a reaction on a message. Optimistically updates local state, then
  // calls the toggle endpoint; reverts on failure. No-ops quietly if the
  // backend endpoint isn't deployed yet (see brigade spec) so dev never breaks.
  async function toggleReaction(messageId: string, emoji: string) {
    if (!currentWorkspace || !activeChannelId) return
    setReactionPickerFor(null)
    const apply = (list: Message[]) => list.map(m => {
      if (m.id !== messageId) return m
      const reactions = [...(m.reactions ?? [])]
      const i = reactions.findIndex(r => r.emoji === emoji)
      if (i === -1) reactions.push({ emoji, count: 1, mine: true })
      else {
        const r = reactions[i]
        const count = r.count + (r.mine ? -1 : 1)
        if (count <= 0) reactions.splice(i, 1)
        else reactions[i] = { emoji, count, mine: !r.mine }
      }
      return { ...m, reactions }
    })
    const snapshot = messages
    setMessages(apply)
    try {
      const res = await fetch(
        `/api/workspaces/${currentWorkspace.id}/channels/${activeChannelId}/messages/${messageId}/reactions`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }) },
      )
      if (!res.ok) throw new Error(`status ${res.status}`)
    } catch {
      // Endpoint not live yet (or transient failure): revert the optimistic change.
      setMessages(snapshot)
    }
  }

  // --- @mention autocomplete ---
  function updateDraft(value: string, cursor: number) {
    // Typing breaks us out of history navigation — the value at this point is
    // the user's own edit, no longer a recalled prompt.
    if (historyIndexRef.current !== null) {
      historyIndexRef.current = null
      scratchDraftRef.current = ''
    }
    setDraft(value)
    const before = value.slice(0, cursor)
    const m = before.match(/(?:^|\s)@(\w*)$/)
    if (m) {
      setMentionQuery(m[1].toLowerCase())
      setMentionIndex(0)
    } else {
      setMentionQuery(null)
    }
  }
  // Autocomplete candidates: agents AND human members (the latter were missing —
  // the picker only knew agents). Humans insert their first-name handle, which is
  // what the server resolves; same-first-name people both appear and both resolve
  // (a known v1 collision until handles are unique).
  const mentionCandidates: MentionCandidate[] = useMemo(() => {
    const out: MentionCandidate[] = []
    for (const a of agents) out.push({ key: `a:${a.id}`, token: a.name, label: a.name, kind: 'agent', avatar: a.avatar })
    for (const mem of members) {
      if (me && mem.id === me.id) continue   // don't suggest mentioning yourself
      const display = (mem.name ?? mem.email).trim()
      if (!display) continue
      out.push({ key: `h:${mem.id}`, token: display.split(/\s+/)[0], label: display, kind: 'human', avatar: mem.avatar_url ?? null })
    }
    return out
  }, [agents, members, me])

  const mentionMatches = mentionQuery !== null
    ? mentionCandidates
        .filter(c => c.token.toLowerCase().startsWith(mentionQuery) || c.label.toLowerCase().startsWith(mentionQuery))
        .slice(0, 8)
    : []

  function applyMention(token: string) {
    const el = draftInputRef.current
    if (!el) return
    const cursor = el.selectionStart ?? draft.length
    const before = draft.slice(0, cursor)
    const after = draft.slice(cursor)
    const replaced = before.replace(/@(\w*)$/, '@' + token + ' ')
    const newDraft = replaced + after
    setDraft(newDraft)
    setMentionQuery(null)
    requestAnimationFrame(() => {
      const newCursor = replaced.length
      el.focus()
      el.setSelectionRange(newCursor, newCursor)
    })
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => (i + 1) % mentionMatches.length); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIndex(i => (i - 1 + mentionMatches.length) % mentionMatches.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyMention(mentionMatches[mentionIndex].token)
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return }
    }
    // Enter sends; Shift+Enter inserts a newline (textarea default).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
      return
    }
    // Shell-style prompt history with Up/Down. Only hijack when there's no
    // mention popup active (handled above) and either history navigation has
    // started or the input matches a known state (empty, or showing a recalled
    // entry). Otherwise the user might be using arrows for normal editing.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // In a multi-line draft, let the textarea move the caret between lines;
      // only recall history when the caret is on the first line (Up) or last line (Down).
      const selStart = e.currentTarget.selectionStart ?? 0
      const selEnd = e.currentTarget.selectionEnd ?? selStart
      if (e.key === 'ArrowUp' && draft.slice(0, selStart).includes('\n')) return
      if (e.key === 'ArrowDown' && draft.slice(selEnd).includes('\n')) return
      const history = promptHistoryRef.current
      if (history.length === 0) return
      const idx = historyIndexRef.current
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (idx === null) {
          scratchDraftRef.current = draft
          historyIndexRef.current = 0
          setDraft(history[0])
        } else if (idx < history.length - 1) {
          historyIndexRef.current = idx + 1
          setDraft(history[idx + 1])
        }
      } else {
        // ArrowDown
        if (idx === null) return // not in history mode
        e.preventDefault()
        if (idx === 0) {
          historyIndexRef.current = null
          setDraft(scratchDraftRef.current)
        } else {
          historyIndexRef.current = idx - 1
          setDraft(history[idx - 1])
        }
      }
    }
  }

  // ── Command-center layout (the default UI, launched 2026-06-27) ──────────
  // A from-scratch multi-column shell (rail · rooms+brigade · chat · context)
  // that reuses this component's live state + handlers, so it's fully
  // functional — not a mock. Default everywhere; ?cc=0 falls back to the legacy
  // layout below (escape hatch / quick comparison).
  const ccQuery = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('cc') : null
  // The command-center redesign is the default UI everywhere now (launched
  // 2026-06-27). ?cc=0 falls back to the legacy layout — an escape hatch for
  // quick comparison / rollback without a redeploy.
  const showCommandCenter = ccQuery !== '0'
  if (showCommandCenter) {
    // Demo showcase (?demo=1): the real shell rendered with curated "Northwind"
    // sample data, so the full alive experience (working presence, the in-stream
    // Relay handoff, In-focus stats, the feed) is visible without faking your
    // live account. Clearly badged as sample data.
    const demoMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1'
    if (demoMode) {
      return <CommandCenterDemo me={me} onLogout={onLogout} />
    }
    const meInitial = (me.name || '?').slice(0, 1).toUpperCase()
    // avatar content for the ringed .cc-av / .cc-mav containers: image or emoji/monogram
    const avInner = (av: string | null | undefined, fallback: string) =>
      isImageAvatar(av) ? <img src={av!} alt="" /> : <span>{av || fallback}</span>
    const agentById = new Map(agents.map(a => [a.id, a]))
    // an agent is "working" if it's the target of an in-progress handoff
    const workingByAgent = new Map<string, CCTask>()
    for (const t of ccTasks) if (t.status === 'in_progress') workingByAgent.set(t.to_agent_id, t)
    // In-focus = the agent active in the OPEN room (the last agent to post here),
    // then whoever's mid-handoff, then most-active (30d turns), then first.
    // Messages carry agent_name (not id), so match the roster by name.
    const lastRoomAgentName = [...messages].reverse().find(m => m.sender_kind === 'agent')?.agent_name
    const focusAgent =
      (lastRoomAgentName ? agents.find(a => a.name === lastRoomAgentName) : null) ??
      agents.find(a => workingByAgent.has(a.id)) ??
      [...agents].sort((a, b) => (ccUsage[b.id]?.turns ?? 0) - (ccUsage[a.id]?.turns ?? 0))[0] ??
      null
    const relayStatus = (s: string): { cls: string; label: string } =>
      s === 'done' ? { cls: 'done', label: '✓ done' }
        : s === 'in_progress' ? { cls: 'work', label: 'working · now' }
          : (s === 'failed' || s === 'declined' || s === 'cancelled') ? { cls: 'done', label: s }
            : { cls: 'new', label: 'new' }
    // Composer slash-command autocomplete — open while the draft is a bare "/cmd".
    const slashTyping = draft.startsWith('/') && !/\s/.test(draft)
    const slashMatches = slashTyping ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(draft.toLowerCase())) : []
    const slashOpen = slashMatches.length > 0
    const slashSel = Math.max(0, Math.min(slashIndex, slashMatches.length - 1))
    const pickSlash = (c: { cmd: string }) => {
      const next = c.cmd + ' '
      updateDraft(next, next.length)
      setSlashIndex(0)
      draftInputRef.current?.focus()
    }
    const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => (i + 1) % slashMatches.length); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => (i - 1 + slashMatches.length) % slashMatches.length); return }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickSlash(slashMatches[slashSel]); return }
        if (e.key === 'Escape') { e.preventDefault(); updateDraft('', 0); return }
      }
      onInputKeyDown(e)
    }
    const wsMono = (currentWorkspace?.name?.[0] ?? 'B').toUpperCase()
    const railBtn = (key: CcSection, glyph: React.ReactNode, label: string) => (
      <button key={key} className={`cc-rnav ${ccSection === key ? 'on' : ''}`} onClick={() => { setCcSection(key); setCcDrawerOpen(false) }} title={label} aria-label={label}>{glyph}</button>
    )
    const rail = (
      <nav className="cc-rail">
        <div className="cc-ws-wrap">
          <button className="cc-mark" onClick={() => setWsSwitcherOpen(o => !o)} title={`${currentWorkspace?.name ?? 'Workspace'} — switch workspace`} aria-label="Switch workspace">{wsMono}</button>
          {wsSwitcherOpen && (
            <div className="cc-ws-menu">
              {wsSwitcherMode === 'menu' && (
                <>
                  <div className="cc-ws-menu-label">Workspaces</div>
                  {workspaces.map(w => (
                    <button
                      key={w.id}
                      className={`cc-ws-row ${w.id === currentWorkspace?.id ? 'on' : ''}`}
                      onClick={() => { setActiveWorkspaceId(w.id); closeSwitcher() }}
                    >
                      <span className="cc-ws-badge2">{(w.name?.[0] ?? '?').toUpperCase()}</span>
                      <span className="cc-ws-name2">{w.name}</span>
                      {w.id === currentWorkspace?.id && <span className="cc-ws-check">✓</span>}
                    </button>
                  ))}
                  <div className="cc-ws-divider" />
                  <button className="cc-ws-act" onClick={() => { setWsActionError(null); setWsSwitcherMode('create') }}>+ New workspace</button>
                  <button className="cc-ws-act" onClick={() => { setWsActionError(null); setWsSwitcherMode('accept') }}>Accept invite by link</button>
                </>
              )}
              {wsSwitcherMode === 'create' && (
                <form className="cc-ws-form" onSubmit={e => { e.preventDefault(); void createWorkspace() }}>
                  <div className="cc-ws-menu-label">New workspace</div>
                  <input className="cc-ws-input" autoFocus value={wsCreateName} onChange={e => setWsCreateName(e.target.value)} placeholder="Workspace name" />
                  {wsActionError && <div className="cc-ws-err">{wsActionError}</div>}
                  <div className="cc-ws-formrow">
                    <button type="submit" className="cc-ws-submit" disabled={wsActionBusy || !wsCreateName.trim()}>{wsActionBusy ? 'Creating…' : 'Create'}</button>
                    <button type="button" className="cc-ws-cancel" onClick={() => { setWsSwitcherMode('menu'); setWsActionError(null) }}>Cancel</button>
                  </div>
                </form>
              )}
              {wsSwitcherMode === 'accept' && (
                <form className="cc-ws-form" onSubmit={e => { e.preventDefault(); void acceptInviteByToken() }}>
                  <div className="cc-ws-menu-label">Accept invite</div>
                  <input className="cc-ws-input" autoFocus value={wsAcceptToken} onChange={e => setWsAcceptToken(e.target.value)} placeholder="Paste invite link or token" />
                  {wsActionError && <div className="cc-ws-err">{wsActionError}</div>}
                  <div className="cc-ws-formrow">
                    <button type="submit" className="cc-ws-submit" disabled={wsActionBusy || !wsAcceptToken.trim()}>{wsActionBusy ? 'Joining…' : 'Join'}</button>
                    <button type="button" className="cc-ws-cancel" onClick={() => { setWsSwitcherMode('menu'); setWsActionError(null) }}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
        {railBtn('channels', <IconChannel size={19} />, 'Rooms')}
        {railBtn('brigade', <IconBrigade size={20} />, 'Brigade')}
        {railBtn('documents', <IconDocument size={19} />, 'Documents')}
        {railBtn('overview', <IconDashboard size={20} />, 'Overview')}
        {railBtn('settings', <IconGear size={20} />, 'Settings')}
        <button className="cc-me-av" onClick={() => setProfileOpen(v => !v)} title={me.name ?? ''}>
          <span>{meInitial}</span>
        </button>
      </nav>
    )
    // Rendered at the shell level (not inside the transformed rail) so it can be
    // a proper bottom sheet on mobile and a corner popup on desktop.
    const profileMenu = profileOpen && (
      <>
        <div className="cc-me-scrim" onClick={() => setProfileOpen(false)} />
        <div className="cc-me-menu">
          <div className="cc-me-name">{me.name}{me.email && <span className="cc-me-email">{me.email}</span>}</div>
          <div className="cc-me-section">Theme</div>
          <div className="cc-theme-row">
            {THEMES.map(t => (
              <button key={t.id} className={`cc-theme-sw ${appliedTheme === t.id ? 'on' : ''}`} onClick={() => { void applyTheme(t.id) }}>
                <span className="cc-theme-chip" style={{ background: t.swatch[0] }}><span style={{ background: t.swatch[1] }} /></span>
                <span className="cc-theme-label">{t.label}</span>
              </button>
            ))}
          </div>
          <div className="cc-ws-divider" />
          {me.is_admin && (
            <button onClick={() => { setAdminOpen(true); setProfileOpen(false); setCcDrawerOpen(false) }}><span aria-hidden="true">⚙</span> Admin console</button>
          )}
          <a href="/contact"><span aria-hidden="true">✉</span> Help &amp; feedback</a>
          <button onClick={onLogout}>Log out</button>
        </div>
      </>
    )
    const headMe = (
      <button className="cc-head-me" onClick={() => setProfileOpen(o => !o)} title={me.name ?? ''} aria-label="Account">
        <span>{meInitial}</span>
      </button>
    )

    // Non-chat destinations: render the real app view full-width beside the rail.
    if (ccSection !== 'channels') {
      const sectionLabel = ccSection === 'brigade' ? 'Brigade' : ccSection === 'documents' ? 'Documents' : ccSection === 'overview' ? 'Overview' : 'Settings'
      return (
        <div className={`cc-shell cc-shell-wide ${ccDrawerOpen ? 'cc-drawer-open' : ''}`}>
          {adminOpen && <Admin onClose={() => setAdminOpen(false)} />}
          {rail}
          {profileMenu}
          {ccDrawerOpen && <div className="cc-backdrop" onClick={() => setCcDrawerOpen(false)} />}
          <div className="cc-section">
            <div className="cc-mobile-bar">
              <button className="cc-burger" onClick={() => setCcDrawerOpen(true)} aria-label="Open menu" title="Menu">☰</button>
              <span style={{ flex: 1, minWidth: 0 }}>{sectionLabel}</span>
              {headMe}
            </div>
            {ccSection === 'brigade' && currentWorkspace && (
              <Brigade
                workspaceId={currentWorkspace.id}
                workspaceName={currentWorkspace.name}
                onManage={(id) => openInSettings({ kind: 'agent', id })}
                onNew={() => openInSettings({ kind: 'agent-new' })}
                onManagePlan={() => openInSettings({ kind: 'workspace' })}
              />
            )}
            {ccSection === 'documents' && currentWorkspace && (
              <Documents
                workspaceId={currentWorkspace.id}
                channels={channels}
                activeChannelId={activeChannelId}
                requestedScopeChannel={docScopeChannel}
                requestedScopeNonce={docScopeNonce}
                requestedDocId={docOpenId}
                requestedDocNonce={docOpenNonce}
              />
            )}
            {ccSection === 'overview' && currentWorkspace && (
              <Command workspaceId={currentWorkspace.id} workspaceName={currentWorkspace.name} />
            )}
            {ccSection === 'settings' && currentWorkspace && (
              <Settings
                workspaceId={currentWorkspace.id}
                openClaudeNonce={openClaudeNonce}
                openTarget={settingsTarget ?? undefined}
                openTargetNonce={settingsTargetNonce}
                onWorkspaceChanged={async () => {
                  const r = await fetch('/api/workspaces').then(r => r.json())
                  setWorkspaces(r.workspaces ?? [])
                }}
              />
            )}
          </div>
        </div>
      )
    }

    return (
      <div className={`cc-shell ${ccDrawerOpen ? 'cc-drawer-open' : ''}`}>
        {adminOpen && <Admin onClose={() => setAdminOpen(false)} />}
        {slashHelpOpen && <SlashHelp onClose={() => setSlashHelpOpen(false)} />}
        {rail}
        {profileMenu}
        {ccDrawerOpen && <div className="cc-backdrop" onClick={() => setCcDrawerOpen(false)} />}

        {/* CHANNELS + BRIGADE */}
        <section className="cc-side">
          <div className="cc-ws">
            <h1>{currentWorkspace?.name ?? 'Workspace'}</h1>
            <div className="cc-sub">{agents.length} {agents.length === 1 ? 'agent' : 'agents'} · {channels.length} {channels.length === 1 ? 'room' : 'rooms'}</div>
          </div>
          <div className="cc-clist">
            <div className="cc-csec">
              <span className="cc-label">Rooms</span>
              <button type="button" className="cc-csec-add" title="New room" aria-label="New room" onClick={() => setShowNewChannel(s => !s)}>+</button>
            </div>
            {showNewChannel && (
              <form
                className="cc-newroom"
                onSubmit={async e => {
                  e.preventDefault()
                  const name = newChannelName.trim().toLowerCase().replace(/\s+/g, '-')
                  if (!name || !currentWorkspace) return
                  const r = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                  }).then(r => r.json())
                  if (r.ok) {
                    setNewChannelName('')
                    setShowNewChannel(false)
                    const cr = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`).then(r => r.json())
                    setChannels(cr.channels ?? [])
                    setActiveChannelId(r.channel.id)
                    setCcDrawerOpen(false)
                  }
                }}
              >
                <input
                  autoFocus
                  value={newChannelName}
                  onChange={e => setNewChannelName(e.target.value)}
                  placeholder="room-name"
                  onKeyDown={e => { if (e.key === 'Escape') { setShowNewChannel(false); setNewChannelName('') } }}
                />
              </form>
            )}
            {channels.map(ch => {
              const isRenaming = renamingChannelId === ch.id
              async function commitRename() {
                const next = renameDraft.trim().toLowerCase().replace(/\s+/g, '-')
                setRenamingChannelId(null)
                if (!next || next === ch.name || !currentWorkspace) return
                const r = await fetch(`/api/workspaces/${currentWorkspace.id}/channels/${ch.id}`, {
                  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: next }),
                }).then(r => r.json())
                if (r.ok) {
                  const cr = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`).then(r => r.json())
                  setChannels(cr.channels ?? [])
                }
              }
              return (
                <div
                  key={ch.id}
                  className={`cc-room ${ch.id === activeChannelId ? 'on' : ''}`}
                  onClick={() => { if (!isRenaming) { setActiveChannelId(ch.id); setCcDrawerOpen(false) } }}
                  onDoubleClick={() => { setRenamingChannelId(ch.id); setRenameDraft(ch.name) }}
                >
                  <span className="cc-rg"><IconChannel size={14} /></span>
                  {isRenaming ? (
                    <form className="cc-rn-form" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void commitRename() }}>
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={e => setRenameDraft(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setRenamingChannelId(null) } }}
                      />
                    </form>
                  ) : (
                    <>
                      <span className="cc-rn">{ch.name}</span>
                      {mentionsByChannel[ch.id] ? <span className="cc-badge cc-badge--mention" title="You were mentioned">@{mentionsByChannel[ch.id] > 9 ? '9+' : mentionsByChannel[ch.id]}</span> : null}
                      {unreadByChannel[ch.id] ? <span className="cc-badge">{unreadByChannel[ch.id] > 99 ? '99+' : unreadByChannel[ch.id]}</span> : null}
                      <button
                        type="button"
                        className="cc-room-edit"
                        title="Rename room"
                        aria-label="Rename room"
                        onClick={e => { e.stopPropagation(); setRenamingChannelId(ch.id); setRenameDraft(ch.name) }}
                      >
                        <IconPencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="cc-room-edit cc-room-edit--danger"
                        title="Delete room"
                        aria-label="Delete room"
                        onClick={async e => {
                          e.stopPropagation()
                          if (!currentWorkspace) return
                          if (channels.length <= 1) { showFeedback('Can’t delete your only room.'); return }
                          if (!confirm(`Delete #${ch.name}? This permanently removes the room and all of its messages and documents. This can’t be undone.`)) return
                          const r = await fetch(`/api/workspaces/${currentWorkspace.id}/channels/${ch.id}`, { method: 'DELETE' }).then(r => r.json())
                          if (r.ok) {
                            const cr = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`).then(r => r.json())
                            const remaining = cr.channels ?? []
                            setChannels(remaining)
                            if (activeChannelId === ch.id) setActiveChannelId(remaining[0]?.id ?? null)
                          } else showFeedback(r.error ?? 'Failed to delete room')
                        }}
                      >
                        <IconTrash size={12} />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
            {channels.length === 0 && <div className="cc-ctx-empty">No rooms yet.</div>}
            <div className="cc-csec"><span className="cc-label">Brigade</span></div>
            {/* Room-scoped: agents with access to the selected room (roomAgents),
                falling back to all workspace agents. Each row deep-links to manage. */}
            <div className="cc-pres">
              {(roomAgents ?? agents).map(a => {
                const work = workingByAgent.get(a.id)
                return (
                  <button
                    type="button"
                    className="cc-pcard"
                    key={a.id}
                    style={{ cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => { openInSettings({ kind: 'agent', id: a.id }); setCcDrawerOpen(false) }}
                    title={`Manage ${a.name}`}
                  >
                    <span className="cc-av">{avInner(a.avatar, '🤖')}<span className={`cc-dot ${work ? 'work' : 'on'}`} /></span>
                    <div>
                      <div className="cc-nm">{a.name}</div>
                      {work
                        ? <div className="cc-st w">working — {work.title ?? 'a handoff'}</div>
                        : <div className="cc-st">awake</div>}
                    </div>
                  </button>
                )
              })}
              {(roomAgents ?? agents).length === 0 && <div className="cc-ctx-empty">No agents yet.</div>}
            </div>
          </div>
        </section>

        {/* CHAT */}
        <main className="cc-main">
          <header className="cc-main-head">
            <button className="cc-burger" onClick={() => setCcDrawerOpen(o => !o)} aria-label="Rooms & brigade" title="Rooms">☰</button>
            {activeChannel ? (
              <>
                <div className="min-w-0">
                  <div className="cc-t"><IconChannel size={15} /> {activeChannel.name}</div>
                  {activeChannel.topic && <div className="cc-topic">{activeChannel.topic}</div>}
                </div>
                <div className="cc-live"><i /> live</div>
              </>
            ) : <div className="cc-t" style={{ color: 'var(--ink-3)', flex: 1 }}>Select a room</div>}
            {headMe}
          </header>
          <div
            className="cc-stream"
            ref={messagesScrollRef}
            onScroll={e => { const el = e.currentTarget; wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 400 }}
          >
            {messages.length === 0 ? (
              <div className="cc-ctx-empty" style={{ textAlign: 'center', marginTop: '16%' }}>
                {activeChannel ? `Nothing in ${activeChannel.name} yet — say hello, or @mention an agent.` : 'Pick a room to start.'}
              </div>
            ) : (
              <>
                <div className="cc-day"><span>Conversation</span></div>
                {messages.map(m => {
                  if (m.sender_kind === 'system') return <div key={m.id} className="cc-day"><span>{m.body}</span></div>
                  const isAgent = m.sender_kind === 'agent'
                  const nm = isAgent ? (m.agent_name ?? 'Agent') : (m.user_name ?? 'You')
                  const av = isAgent ? m.agent_avatar : m.user_avatar
                  // "Is this mine?" — match on stable user id, fall back to name.
                  const isOwn = m.sender_kind === 'user' && (
                    m.sender_user_id ? m.sender_user_id === me.id : m.user_name === me.name
                  )
                  const isEditing = editingMessageId === m.id
                  const mentionsMe = !isOwn && !!m.mentioned_user_ids?.includes(me.id)
                  return (
                    <div key={m.id} id={`msg-${m.id}`} className={`cc-msg group ${isAgent ? 'ag' : 'hu'} ${mentionsMe ? 'cc-msg--mentioned' : ''}`}>
                      <span className="cc-mav">{avInner(av, isAgent ? '🤖' : '🧑')}</span>
                      <div className="cc-body">
                        <div className="cc-meta relative">
                          <span className="cc-who">{nm}</span>
                          <span className="cc-tag">{isAgent ? 'agent' : 'you'}</span>
                          <span className="cc-ts">{formatTime(m.created_at)}</span>
                          {mentionsMe && <span className="cc-mention-chip" title="You were mentioned">@ mentioned you</span>}
                          {!isEditing && (
                            <span className="cc-msg-actions ml-auto opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition flex items-center gap-2 text-xs relative">
                              <button
                                onClick={() => { setReplyTo(m); setReactionPickerFor(null) }}
                                className="text-[var(--ink-4)] hover:text-[var(--ink)]"
                                title="Reply"
                                aria-label="Reply to message"
                              >
                                ↩
                              </button>
                              <button
                                onClick={() => setReactionPickerFor(id => (id === m.id ? null : m.id))}
                                className="text-[var(--ink-4)] hover:text-[var(--ink)]"
                                title="Add reaction"
                                aria-label="Add reaction"
                              >
                                🙂
                              </button>
                              {reactionPickerFor === m.id && (
                                <>
                                  <div className="fixed inset-0 z-[37]" onClick={() => setReactionPickerFor(null)} />
                                  <div className="absolute right-0 top-5 z-[38] bg-[var(--raise)] border border-[var(--ember-edge)] rounded-md shadow-lg px-1.5 py-1 flex items-center gap-1">
                                    {REACTION_EMOJIS.map(e => (
                                      <button
                                        key={e}
                                        onClick={() => void toggleReaction(m.id, e)}
                                        className="text-base leading-none hover:scale-125 transition-transform px-0.5"
                                        title={`React ${e}`}
                                      >
                                        {e}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              )}
                              {isOwn && (
                                <>
                                  <button
                                    onClick={() => startEdit(m)}
                                    className="text-[var(--ink-4)] hover:text-[var(--ink)]"
                                    title="Edit"
                                    aria-label="Edit message"
                                  >
                                    <IconPencil size={13} />
                                  </button>
                                  <button
                                    onClick={() => deleteMessage(m.id)}
                                    className="text-[var(--ink-4)] hover:text-red-400"
                                    title="Delete"
                                    aria-label="Delete message"
                                  >
                                    <IconTrash size={13} />
                                  </button>
                                </>
                              )}
                            </span>
                          )}
                        </div>
                        {m.reply_to && (
                          <button
                            onClick={() => {
                              const el = document.getElementById(`msg-${m.reply_to!.id}`)
                              el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                            }}
                            className="mb-1 flex items-center gap-1.5 text-xs text-[var(--ink-4)] hover:text-[var(--ink)] max-w-full"
                            title="Jump to the replied-to message"
                          >
                            <span>↩</span>
                            <span className="font-medium flex-shrink-0">{m.reply_to.sender_label}</span>
                            <span className="truncate opacity-80 border-l border-[var(--ember-edge)] pl-1.5">{m.reply_to.excerpt}</span>
                          </button>
                        )}
                        {isEditing ? (
                          <div className="flex flex-col gap-2">
                            <textarea
                              autoFocus
                              value={editDraft}
                              onChange={e => setEditDraft(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit() }
                                if (e.key === 'Escape') { e.preventDefault(); setEditingMessageId(null) }
                              }}
                              rows={Math.min(8, Math.max(2, editDraft.split('\n').length))}
                              className="w-full bg-[var(--surface)] border border-[var(--ember-edge)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--ember)]"
                            />
                            <div className="flex gap-2 text-xs">
                              <button onClick={() => setEditingMessageId(null)} className="text-[var(--ink-4)] hover:text-[var(--ink)]">Cancel (Esc)</button>
                              <button onClick={() => void saveEdit()} className="bg-[var(--ember)] text-white px-2 py-0.5 rounded hover:opacity-90">Save (Enter)</button>
                            </div>
                          </div>
                        ) : m.body && (
                          <div className="cc-text"><ReactMarkdown remarkPlugins={mentionPlugins}>{m.body}</ReactMarkdown></div>
                        )}
                        {m.reactions && m.reactions.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {m.reactions.map(r => (
                              <button
                                key={r.emoji}
                                onClick={() => void toggleReaction(m.id, r.emoji)}
                                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none transition ${
                                  r.mine
                                    ? 'border-[var(--ember)] bg-[var(--ember-soft)] text-[var(--ink)]'
                                    : 'border-[var(--ember-edge)] text-[var(--ink-4)] hover:border-[var(--ember)]'
                                }`}
                                title={r.mine ? 'Remove your reaction' : 'React'}
                              >
                                <span>{r.emoji}</span>
                                <span>{r.count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {isAgent && !isEditing && (m.model || (m.turn_ms ?? 0) > 0) && (
                          <div className="cc-foot">
                            {m.model && <>model {m.model} · </>}
                            {(m.turn_ms ?? 0) > 0 && <>turn {formatTurnMs(m.turn_ms!)} · </>}
                            <span className="ok">✓ delivered</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
                {typingAgents.size > 0 && (
                  <div className="cc-typing">
                    <span>{Array.from(typingAgents.values()).map(a => a.name).join(', ')} {typingAgents.size === 1 ? 'is' : 'are'} thinking</span>
                    <span className="dd"><i /><i /><i /></span>
                  </div>
                )}
              </>
            )}
          </div>
          <form
            className="cc-composer"
            onSubmit={sendMessage}
            onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
            onDrop={e => { if (e.dataTransfer.files?.length) { e.preventDefault(); void addFiles(e.dataTransfer.files) } }}
          >
            {mentionQuery !== null && mentionMatches.length > 0 && (
              <div className="cc-mention">
                {mentionMatches.map((c, i) => (
                  <button type="button" key={c.key} onMouseDown={e => { e.preventDefault(); applyMention(c.token) }}
                    className={i === mentionIndex ? 'active' : ''}>
                    <AgentAvatar avatar={c.avatar} size={18} /> <span>{c.label}</span>
                    <span className="cc-mention-kind">{c.kind === 'human' ? 'person' : 'agent'}</span>
                  </button>
                ))}
              </div>
            )}
            {slashOpen && (
              <div className="cc-mention cc-slash">
                {slashMatches.map((c, i) => (
                  <button type="button" key={c.cmd} onMouseDown={e => { e.preventDefault(); pickSlash(c) }}
                    className={i === slashSel ? 'active' : ''}>
                    <span className="cc-slash-cmd">{c.cmd}{c.arg ? <span className="cc-slash-arg"> {c.arg}</span> : null}</span>
                    <span className="cc-slash-desc">{c.desc}</span>
                  </button>
                ))}
              </div>
            )}
            {commandFeedback && <div className="cc-cmd-feedback">{commandFeedback}</div>}
            {replyTo && (
              <div className="flex items-center gap-2 text-xs px-3 py-1.5 border-b border-[var(--color-border)]">
                <span className="text-[var(--color-accent)] flex-shrink-0">↩ Replying to {replyTo.sender_kind === 'agent' ? `@${replyTo.agent_name}` : (replyTo.user_name ?? 'Unknown')}</span>
                <span className="truncate flex-1 text-[var(--color-text-dim)] opacity-80">{replyTo.body}</span>
                <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply" className="flex-shrink-0 text-[var(--color-text-dim)] hover:text-[var(--color-text)]">✕</button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => { if (e.target.files?.length) { void addFiles(e.target.files); e.target.value = '' } }}
            />
            {(pendingAttachments.length > 0 || uploadingCount > 0 || uploadError || sendError) && (
              <div className="cc-attach-row">
                {pendingAttachments.map(a => (
                  <span key={a.id} className="cc-chip" title={a.filename}>
                    <span>{a.kind === 'image' ? '🖼️' : a.kind === 'pdf' ? '📄' : a.kind === 'text' ? '📝' : '📎'}</span>
                    <span className="cc-chip-name">{a.filename}</span>
                    <button type="button" onClick={() => removePending(a.id)} aria-label={`Remove ${a.filename}`}>✕</button>
                  </span>
                ))}
                {uploadingCount > 0 && <span className="cc-chip dim">Uploading {uploadingCount}…</span>}
                {uploadError && <span className="cc-chip err">{uploadError}</span>}
                {sendError && <span className="cc-chip err">{sendError}</span>}
              </div>
            )}
            <div
              className="cc-cbox"
              onMouseDown={e => {
                // Clicking anywhere in the box (the hint row, the padding, a near
                // miss) focuses the input — so a click never lands in dead space.
                // Skip when an actual control (Attach/send) or the textarea itself
                // was hit, so we don't fight native caret placement.
                const t = e.target as HTMLElement
                if (t.closest('button') || t.tagName === 'TEXTAREA') return
                e.preventDefault()
                draftInputRef.current?.focus()
              }}
            >
              <div className="cc-ctop">
                <textarea
                  ref={draftInputRef}
                  rows={1}
                  value={draft}
                  onChange={e => updateDraft(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                  onKeyDown={onComposerKeyDown}
                  placeholder={activeChannel ? `Message ${activeChannel.name} — or hand a task to an agent` : 'Select a room'}
                  disabled={!activeChannelId}
                />
                <button type="submit" className="cc-send" disabled={!activeChannelId || (!draft.trim() && pendingAttachments.length === 0)} title="Send (Enter)">↑</button>
              </div>
              <div className="cc-ctools">
                <button type="button" className="cc-attach-btn" onClick={() => fileInputRef.current?.click()} disabled={!activeChannelId}>📎 Attach</button>
                <span className="mono">@ mention</span><span className="mono">/ commands</span>
                <span className="mono" style={{ marginLeft: 'auto' }}>⏎ send</span>
              </div>
            </div>
          </form>
        </main>

        {/* CONTEXT / BRIGADE */}
        <aside className="cc-context">
          <h2><IconFocus size={14} /> In focus</h2>
          {focusAgent ? (
            <div className="cc-agentcard">
              <div className="cc-actop">
                <div className="cc-big">{avInner(focusAgent.avatar, '🤖')}</div>
                <div>
                  <div className="cc-acnm">{focusAgent.name}</div>
                  <div className="cc-acrole">
                    {workingByAgent.has(focusAgent.id)
                      ? <>Agent · <span style={{ color: 'var(--ember)' }}>working now</span></>
                      : 'In your brigade'}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 10 }}><SafetyBadge profile={focusAgent.safety_profile} /></div>
              {ccBios[focusAgent.id] && <div className="cc-bio">{ccBios[focusAgent.id]}</div>}
              {workingByAgent.get(focusAgent.id)?.title && (
                <div className="cc-bio" style={{ marginTop: ccBios[focusAgent.id] ? 8 : 0 }}>Currently: {workingByAgent.get(focusAgent.id)!.title}</div>
              )}
              <div className="cc-stats">
                <div className="cc-stat">
                  <div className="k">Handoffs</div>
                  <div className="v">{ccHandoffs[focusAgent.id] ?? 0} <small>picked up</small></div>
                </div>
                <div className="cc-stat">
                  <div className="k">Usage · 30d</div>
                  <div className="v">${(ccUsage[focusAgent.id]?.cost ?? 0).toFixed(2)} <small>· {ccUsage[focusAgent.id]?.turns ?? 0} turns</small></div>
                </div>
              </div>
            </div>
          ) : <div className="cc-ctx-empty">No agents in this workspace yet.</div>}

          <div className="cc-relayfeed">
            <h2 style={{ marginBottom: 6 }}><IconRelay size={15} /> Relay <span className="cc-label" style={{ marginLeft: 'auto' }}>handoffs</span></h2>
            {ccTasks.length === 0 ? (
              <div className="cc-ctx-empty">No handoffs yet — they appear here the moment one agent hands work to another.</div>
            ) : ccTasks.slice(0, 8).map(t => {
              const from = t.from_kind === 'user' ? null : agentById.get(t.from_agent_id ?? '')
              const to = agentById.get(t.to_agent_id)
              const st = relayStatus(t.status)
              return (
                <div className="cc-rfrow" key={t.id}>
                  <div className="cc-ar">
                    <span className={`cc-miniav ${t.from_kind === 'user' ? 'h' : ''}`}>{t.from_kind === 'user' ? '🧑' : avInner(from?.avatar, '🤖')}</span>
                    →
                    <span className="cc-miniav">{avInner(to?.avatar, '🤖')}</span>
                  </div>
                  <div className="cc-rfb">
                    <div className="cc-rft">{t.title ?? 'Handoff'}</div>
                    <div className={`cc-rfs ${st.cls}`}>{st.label}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </aside>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {adminOpen && <Admin onClose={() => setAdminOpen(false)} />}
      <div className="h-12 border-b border-[var(--color-border)] flex items-center px-3 md:px-4 gap-1 bg-[var(--color-surface)]">
        {/* Workspace switcher — lives in the top bar so it's reachable from
            any tab (Channels / Documents / Settings), on mobile too (the pill
            collapses to glyph-only below md; see .sb-ws.in-topbar CSS). */}
        <div className="flex items-center mr-1 md:mr-2">
          <div className="sb-ws in-topbar" data-open={wsSwitcherOpen ? 'true' : 'false'}>
            <button
              className="sb-ws-pill"
              type="button"
              onClick={() => setWsSwitcherOpen(o => !o)}
              title="Switch workspace"
            >
              <div className="glyph">
                {isWorkspaceIcon(currentWorkspace?.icon)
                  ? <img src={workspaceIconSrc(currentWorkspace.icon!)} alt="" className="w-full h-full object-cover rounded-[inherit]" />
                  : (currentWorkspace?.name ?? 'S').charAt(0).toUpperCase()}
              </div>
              <div className="meta">
                <div className="name">{currentWorkspace?.name ?? 'Studio'}</div>
              </div>
              <div className="chev">▾</div>
            </button>
            <div className="sb-ws-dd">
              {wsSwitcherMode === 'menu' && (
                <>
                  {workspaces.map(w => (
                    <button
                      key={w.id}
                      type="button"
                      className={`sb-ws-dd-row ${w.id === currentWorkspace?.id ? 'current' : ''}`}
                      onClick={() => { setActiveWorkspaceId(w.id); closeSwitcher() }}
                    >
                      <div className="glyph">
                        {isWorkspaceIcon(w.icon)
                          ? <img src={workspaceIconSrc(w.icon)} alt="" className="w-full h-full object-cover rounded-[inherit]" />
                          : w.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="name">{w.name}</div>
                        <div className="role flex items-center gap-1">
                          <span>{w.role}</span>
                          {w.theme && (
                            <>
                              <span
                                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                                style={{ background: THEME_META[normalizeTheme(w.theme)]?.accent }}
                              />
                              <span className="truncate">{THEME_META[normalizeTheme(w.theme)]?.label}</span>
                            </>
                          )}
                        </div>
                      </div>
                      {w.id === currentWorkspace?.id && <div className="check">✓</div>}
                    </button>
                  ))}
                  <div className="sb-ws-dd-divider" />
                  <button
                    type="button"
                    className="sb-ws-dd-action"
                    onClick={() => { setWsActionError(null); setWsSwitcherMode('create') }}
                  >
                    <span className="plus">+</span>
                    <span>New workspace</span>
                  </button>
                  <button
                    type="button"
                    className="sb-ws-dd-action"
                    onClick={() => { setWsActionError(null); setWsSwitcherMode('accept') }}
                  >
                    <span className="plus">↗</span>
                    <span>Accept invite by link</span>
                  </button>
                </>
              )}

              {wsSwitcherMode === 'create' && (
                <form
                  className="sb-ws-dd-form"
                  onSubmit={(e) => { e.preventDefault(); void createWorkspace() }}
                >
                  <div className="sb-ws-dd-form-head">
                    <button
                      type="button"
                      className="back"
                      onClick={() => { setWsSwitcherMode('menu'); setWsActionError(null); setWsCreateName('') }}
                      aria-label="Back"
                    >
                      ←
                    </button>
                    <span>New workspace</span>
                  </div>
                  <input
                    autoFocus
                    type="text"
                    value={wsCreateName}
                    onChange={(e) => setWsCreateName(e.target.value)}
                    placeholder="Workspace name"
                    maxLength={80}
                    className="sb-ws-dd-input"
                  />
                  {wsActionError && <div className="sb-ws-dd-error">{wsActionError}</div>}
                  <button
                    type="submit"
                    disabled={wsActionBusy || !wsCreateName.trim()}
                    className="sb-ws-dd-submit"
                  >
                    {wsActionBusy ? 'Creating…' : '▶ Create'}
                  </button>
                </form>
              )}

              {wsSwitcherMode === 'accept' && (
                <form
                  className="sb-ws-dd-form"
                  onSubmit={(e) => { e.preventDefault(); void acceptInviteByToken() }}
                >
                  <div className="sb-ws-dd-form-head">
                    <button
                      type="button"
                      className="back"
                      onClick={() => { setWsSwitcherMode('menu'); setWsActionError(null); setWsAcceptToken('') }}
                      aria-label="Back"
                    >
                      ←
                    </button>
                    <span>Accept invite</span>
                  </div>
                  <input
                    autoFocus
                    type="text"
                    value={wsAcceptToken}
                    onChange={(e) => setWsAcceptToken(e.target.value)}
                    placeholder="Paste invite link or token"
                    className="sb-ws-dd-input"
                  />
                  {wsActionError && <div className="sb-ws-dd-error">{wsActionError}</div>}
                  <button
                    type="submit"
                    disabled={wsActionBusy || !wsAcceptToken.trim()}
                    className="sb-ws-dd-submit"
                  >
                    {wsActionBusy ? 'Joining…' : '▶ Accept'}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
        {PANEL_ORDER.map(k => (
          <button
            key={k}
            onClick={() => selectPanel(k)}
            className={`text-sm px-2.5 md:px-3 py-1 rounded ${leftPanel === k || effectiveRight === k ? 'bg-[var(--color-active-bg)] text-[var(--color-text)]' : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'}`}
          >
            {PANEL_LABELS[k]}
          </button>
        ))}
        <div className="flex-1" />
        {/* Split: docked toolbar controls (no popup). Open a second pane, then
            swap or close it with always-visible buttons. */}
        <div className="hidden md:flex items-center gap-1 mr-2">
          {!effectiveRight ? (
            <button
              onClick={openSplit}
              className="p-1.5 rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-bg)]"
              title="Split into two panes"
              aria-label="Split into two panes"
            >
              <IconSplit size={18} />
            </button>
          ) : (
            <>
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)] mr-0.5">Split</span>
              <button
                onClick={swapPanes}
                className="px-1.5 py-1 rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-bg)]"
                title="Swap left and right panes"
                aria-label="Swap panes"
              >
                ⇄
              </button>
              <button
                onClick={closeSplit}
                className="px-1.5 py-1 rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-bg)]"
                title="Close split"
                aria-label="Close split"
              >
                ✕
              </button>
            </>
          )}
        </div>
        <div className="relative">
          <button
            onClick={() => setProfileOpen(o => !o)}
            className="flex items-center gap-2 rounded-full md:rounded-md pl-1 pr-1 md:pl-1.5 md:pr-2 py-1 hover:bg-[var(--color-hover-bg)] transition"
            title="Account, theme & settings"
            aria-haspopup="menu"
            aria-expanded={profileOpen}
          >
            <span className="relative inline-flex flex-shrink-0">
              {me.avatar_url ? (
                <img src={me.avatar_url} alt="" className="w-7 h-7 rounded-full" />
              ) : (
                <span className="w-7 h-7 rounded-full bg-[var(--color-surface-elevated)] border border-[var(--color-border)] flex items-center justify-center text-xs">
                  {(me.name ?? me.email ?? '?').charAt(0).toUpperCase()}
                </span>
              )}
              <span
                className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--color-surface)] ${wsConnected ? 'bg-green-500' : 'bg-yellow-500'}`}
                title={wsConnected ? 'realtime connected' : 'realtime disconnected'}
              />
            </span>
            <span className="hidden md:inline text-xs truncate max-w-[10rem]">{me.name ?? me.email}</span>
            <span className="hidden md:inline text-[10px] text-[var(--color-text-dim)] leading-none">▾</span>
          </button>

          {profileOpen && (
            <>
              <div className="fixed inset-0 z-[37]" onClick={() => setProfileOpen(false)} />
              <div className="absolute right-0 mt-1 z-[38] bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md shadow-elevated w-60 py-1 text-sm">
                <div className="px-3 py-2 border-b border-[var(--color-border)]">
                  <div className="text-[var(--color-text)] truncate">{me.name ?? '—'}</div>
                  <div className="text-[10px] text-[var(--color-text-dim)] truncate">{me.email}</div>
                </div>

                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">Theme</div>
                {THEMES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => { void applyTheme(t.id) }}
                    className={`w-full text-left px-3 py-1.5 hover:bg-[var(--color-hover-bg)] flex items-center gap-2 ${
                      appliedTheme === t.id ? 'text-[var(--color-text)]' : 'text-[var(--color-text-dim)]'
                    }`}
                  >
                    <span className="inline-flex border border-[var(--color-border)] rounded overflow-hidden flex-shrink-0" style={{ width: 22, height: 14 }}>
                      <span style={{ background: t.swatch[0], flex: 1 }} />
                      <span style={{ background: t.swatch[1], flex: 1 }} />
                    </span>
                    <span className="flex-1">{t.label}</span>
                    {appliedTheme === t.id && <span>✓</span>}
                  </button>
                ))}

                {me.is_admin && (
                  <>
                    <div className="border-t border-[var(--color-border)] my-1" />
                    <button
                      onClick={() => { setAdminOpen(true); setProfileOpen(false) }}
                      className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-hover-bg)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] flex items-center gap-2"
                    >
                      <span aria-hidden="true">⚙</span> Admin console
                    </button>
                  </>
                )}

                <div className="border-t border-[var(--color-border)] my-1" />
                <a
                  href="/contact"
                  onClick={() => setProfileOpen(false)}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-hover-bg)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] flex items-center gap-2"
                  title="Send feedback to the Brigata team"
                >
                  <span aria-hidden="true">✉</span> Help &amp; feedback
                </a>
                <button
                  onClick={() => { setProfileOpen(false); onLogout() }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-hover-bg)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0 relative">
        {/* Channels panel — always mounted; visibility/size from panelClasses + panelStyle */}
        <div className={panelClasses('channels')} style={panelStyle('channels')} onMouseDown={() => recordPaneActivity('channels')}>
          <div className="flex-1 flex min-h-0 relative">
      {railOpen && (
        <div
          className="absolute inset-0 bg-black/40 z-20"
          onClick={() => setRailOpen(false)}
        />
      )}
      <aside
        style={isDesktop && channelsRail.pinned && !channelsRail.collapsed ? { width: channelsRail.width, flex: '0 0 auto' } : undefined}
        className={`
          ${isDesktop && channelsRail.pinned ? 'static' : 'absolute'} inset-y-0 left-0 z-30
          w-64 bg-[var(--color-surface)]
          border-r border-[var(--color-border)] flex-col
          transition-transform duration-200
          ${railOpen || (isDesktop && channelsRail.pinned && !channelsRail.collapsed) ? 'translate-x-0 flex' : '-translate-x-full flex'}
          ${isDesktop && channelsRail.pinned && channelsRail.collapsed ? 'hidden' : ''}
        `}
      >
        {/* Thin chrome row at the top — pin/collapse moved out of the section header */}
        <div className="sb-chrome">
          <button
            onClick={() => channelsRail.setPinned(!channelsRail.pinned)}
            className="ctl hidden md:block"
            style={channelsRail.pinned ? undefined : { filter: 'grayscale(1)', opacity: 0.45 }}
            title={channelsRail.pinned ? 'Unpin sidebar (overlay mode)' : 'Pin sidebar (dock it)'}
          >
            📌
          </button>
          <button
            onClick={() => channelsRail.pinned ? channelsRail.setCollapsed(true) : setRailOpen(false)}
            className="ctl"
            title={channelsRail.pinned ? 'Collapse sidebar' : 'Close'}
          >
            ◀
          </button>
        </div>

        {/* (Workspace pill moved to the top app bar so it's reachable from every tab.) */}

        <div className="flex-1 overflow-y-auto">
          <div className="sb-section">
            <div className="sb-section-head">
              <span className="label">Rooms</span>
              <button
                onClick={() => setShowNewChannel(s => !s)}
                className="add"
                title="New room"
              >
                +
              </button>
            </div>
            {showNewChannel && (
              <form
                onSubmit={async e => {
                  e.preventDefault()
                  const name = newChannelName.trim().toLowerCase().replace(/\s+/g, '-')
                  if (!name || !currentWorkspace) return
                  const r = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                  }).then(r => r.json())
                  if (r.ok) {
                    setNewChannelName('')
                    setShowNewChannel(false)
                    const cr = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`).then(r => r.json())
                    setChannels(cr.channels ?? [])
                    setActiveChannelId(r.channel.id)
                  }
                }}
                className="px-4 pb-2"
              >
                <input
                  autoFocus
                  value={newChannelName}
                  onChange={e => setNewChannelName(e.target.value)}
                  placeholder="room-name"
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-xs focus:outline-none focus:border-[var(--color-accent)]"
                />
              </form>
            )}
            {channels.map(ch => {
              const isRenaming = renamingChannelId === ch.id
              const isActive = ch.id === activeChannelId
              async function commitRename() {
                const next = renameDraft.trim().toLowerCase().replace(/\s+/g, '-')
                setRenamingChannelId(null)
                if (!next || next === ch.name || !currentWorkspace) return
                const r = await fetch(`/api/workspaces/${currentWorkspace.id}/channels/${ch.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: next }),
                }).then(r => r.json())
                if (r.ok) {
                  const cr = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`).then(r => r.json())
                  setChannels(cr.channels ?? [])
                }
              }
              async function deleteChannel() {
                if (!currentWorkspace) return
                if (!confirm(`Delete room ${ch.name}? All its messages will be removed. This cannot be undone.`)) return
                const r = await fetch(`/api/workspaces/${currentWorkspace.id}/channels/${ch.id}`, { method: 'DELETE' }).then(r => r.json())
                if (r.ok) {
                  const cr = await fetch(`/api/workspaces/${currentWorkspace.id}/channels`).then(r => r.json())
                  setChannels(cr.channels ?? [])
                  if (activeChannelId === ch.id) setActiveChannelId(cr.channels?.[0]?.id ?? null)
                }
              }
              return (
                <div
                  key={ch.id}
                  className={`group sb-item ${isActive ? 'active' : ''}`}
                  onClick={() => { if (!isRenaming) { setActiveChannelId(ch.id); setRailOpen(false) } }}
                  onDoubleClick={() => { setRenamingChannelId(ch.id); setRenameDraft(ch.name) }}
                  title={isRenaming ? undefined : 'Double-click to rename'}
                >
                  {isRenaming ? (
                    <form
                      onSubmit={(e) => { e.preventDefault(); void commitRename() }}
                      className="flex-1 min-w-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { e.preventDefault(); setRenamingChannelId(null) }
                        }}
                        className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-0.5 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                      />
                    </form>
                  ) : (
                    <>
                      <span className="glyph"><IconChannel /></span>
                      <span className={`name ${unreadByChannel[ch.id] ? 'font-semibold' : ''}`}>{ch.name}</span>
                      {unreadByChannel[ch.id] ? (
                        <span className="badge">
                          {unreadByChannel[ch.id] > 99 ? '99+' : unreadByChannel[ch.id]}
                        </span>
                      ) : null}
                      <div className="hidden group-hover:flex items-center gap-1 ml-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); setRenamingChannelId(ch.id); setRenameDraft(ch.name) }}
                          className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-1"
                          title="Rename"
                          aria-label="Rename room"
                        >
                          <IconPencil size={14} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); void deleteChannel() }}
                          className="text-xs text-[var(--color-text-dim)] hover:text-red-400 px-1"
                          title="Delete"
                        >
                          ✕
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>

          {/* Docs for the active channel, surfaced right below the channels list
              (uses the rail's dead space; reinforces that channels own their docs). */}
          {activeChannel && (
            <div className="sb-section">
              <div className="sb-section-head">
                <span className="label">Docs · #{activeChannel.name}</span>
                <button
                  onClick={() => createDocInChannel(activeChannel.id)}
                  className="add"
                  title={`New document in #${activeChannel.name}`}
                >
                  +
                </button>
              </div>
              {(docsByChannel[activeChannel.id] ?? [])
                .slice()
                .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
                .map(d => (
                  <div
                    key={d.id}
                    className={`sb-item ${inlineDocId === d.id ? 'active' : ''}`}
                    onClick={() => setInlineDocId(d.id)}
                    title={d.title}
                  >
                    <span className="glyph"><IconDocument /></span>
                    <span className="name">{d.title}</span>
                    {d.pinned && <span className="w-1 h-1 rounded-full bg-[var(--color-accent)] flex-shrink-0 ml-1" />}
                  </div>
                ))}
              {(docsByChannel[activeChannel.id]?.length ?? 0) === 0 && (
                <div className="px-4 py-1 text-xs text-[var(--color-text-dim)]">No documents yet.</div>
              )}
            </div>
          )}

        </div>

        <RailFooter />

      </aside>
      {isDesktop && channelsRail.pinned && !channelsRail.collapsed && (
        <RailResizeHandle width={channelsRail.width} setWidth={channelsRail.setWidth} />
      )}

      <main className="flex-1 flex flex-col min-w-0 relative">
        <header className="h-14 border-b border-[var(--color-border)] flex items-center px-4 md:px-6 gap-3">
          {(!channelsRail.pinned || channelsRail.collapsed || !isDesktop) && (
            <button
              onClick={() => {
                if (isDesktop && channelsRail.pinned && channelsRail.collapsed) channelsRail.setCollapsed(false)
                else setRailOpen(true)
              }}
              className="text-xl text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              aria-label="Open rooms"
            >
              ☰
            </button>
          )}
          {activeChannel ? (
            <>
              <div className="font-medium inline-flex items-center gap-2"><IconChannel size={16} /> {activeChannel.name}</div>
              {activeChannel.topic && (
                <div className="ml-2 text-sm text-[var(--color-text-dim)] truncate hidden md:block">
                  {activeChannel.topic}
                </div>
              )}
              <div className="ml-auto inline-flex items-center gap-3 text-xs text-[var(--color-text-dim)]">
                <button
                  onClick={() => openDocsForChannel(activeChannel.id)}
                  className="inline-flex items-center gap-1 hover:text-[var(--color-text)]"
                  title={`Open all documents in #${activeChannel.name}`}
                >
                  <IconDocument size={13} />
                  <span>{docCountByChannel[activeChannel.id] ?? 0}</span>
                </button>
                <span className="inline-flex items-center gap-2">
                  <span className="live-dot" />
                  <span className="hidden sm:inline" style={{ fontFamily: 'var(--font-mono)' }}>live</span>
                </span>
              </div>
            </>
          ) : (
            <div className="text-[var(--color-text-dim)]">No room selected</div>
          )}
        </header>

        {/* Inline doc viewer: opens IN the channel pane (single window you flip
            between chat and doc), rather than switching to the separate Docs panel. */}
        {activeChannel && inlineDoc && (
          <div className="absolute inset-x-0 top-14 bottom-0 z-20 bg-[var(--color-bg)] flex flex-col">
            <div className="flex items-center gap-3 px-4 md:px-6 h-12 border-b border-[var(--color-border)] flex-shrink-0">
              <button
                onClick={() => setInlineDocId(null)}
                className="text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)] inline-flex items-center gap-1"
                title={`Back to #${activeChannel.name}`}
              >
                ← #{activeChannel.name}
              </button>
              <span className="font-medium truncate">{inlineDoc.title}</span>
              <div className="ml-auto flex items-center gap-2">
                {inlineDocEditing ? (
                  <>
                    <button onClick={() => void saveInlineDoc()} className="text-xs bg-[var(--color-accent)] text-white px-3 py-1 rounded hover:opacity-90">Save</button>
                    <button onClick={() => setInlineDocEditing(false)} className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-2 py-1">Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={startEditInline} className="text-xs px-3 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)]">Edit</button>
                    <button onClick={() => openDoc(activeChannel.id, inlineDoc.id)} className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-2 py-1" title="Open in the full Documents panel">Full view ↗</button>
                  </>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
              {inlineDocEditing ? (
                <textarea
                  value={inlineDraftBody}
                  onChange={e => setInlineDraftBody(e.target.value)}
                  className="w-full h-full min-h-[60vh] bg-transparent border border-[var(--color-border)] rounded p-3 text-sm resize-none focus:outline-none focus:border-[var(--color-accent)]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                  autoFocus
                />
              ) : (
                <article className="prose-doc max-w-3xl">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{inlineDoc.body_md || '*Empty document — hit Edit to start writing.*'}</ReactMarkdown>
                </article>
              )}
            </div>
          </div>
        )}

        {activeChannel && !me.has_anthropic_token && demo && !demo.converted && !demo.capReached && (
          <div className="flex-shrink-0 border-b border-[var(--color-accent)] bg-[var(--color-surface)] px-4 py-2.5 flex items-start gap-3">
            <span className="text-base leading-5 text-[var(--color-accent)]" aria-hidden>✨</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-[var(--color-text)]">
                Demo mode — {demo.messagesRemaining} {demo.messagesRemaining === 1 ? 'message' : 'messages'} left
              </div>
              <div className="text-xs text-[var(--color-text-dim)]">
                This is on us. Ask your agent to build a doc or search the web. Connect your Claude anytime to keep going.
              </div>
            </div>
            <button
              onClick={goConnectClaude}
              className="flex-shrink-0 text-sm bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90"
            >
              Connect Claude
            </button>
          </div>
        )}

        {activeChannel && !me.has_anthropic_token && demo && !demo.converted && demo.capReached && (
          <div className="flex-shrink-0 border-b border-[var(--color-accent)] bg-[var(--color-surface)] px-4 py-2.5 flex items-start gap-3">
            <span className="text-base leading-5 text-[var(--color-accent)]" aria-hidden>✨</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-[var(--color-text)]">Your free demo's used up</div>
              <div className="text-xs text-[var(--color-text-dim)]">
                Connect your Claude to keep your crew working — your costs and data stay yours.
              </div>
            </div>
            <button
              onClick={goConnectClaude}
              className="flex-shrink-0 text-sm bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90"
            >
              Connect Claude
            </button>
          </div>
        )}

        {/* Comp'd/admin accounts have no own token but their agents DO reply on the
            platform-funded studio token (see agents.ts credential resolution), so
            the "can't reply / connect Claude" wall would contradict the replies
            they're already seeing. Suppress it for them. */}
        {activeChannel && !me.has_anthropic_token && !demo && !me.is_comp && !me.is_admin && (
          <div className="flex-shrink-0 border-b border-[var(--color-accent)] bg-[var(--color-surface)] px-4 py-2.5 flex items-start gap-3">
            <span className="text-base leading-5 text-[var(--color-accent)]" aria-hidden>⚠</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-[var(--color-text)]">Your agents can't reply yet</div>
              <div className="text-xs text-[var(--color-text-dim)]">
                Connect your Claude account so the agents in this workspace can respond.
              </div>
            </div>
            <button
              onClick={goConnectClaude}
              className="flex-shrink-0 text-sm bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90"
            >
              Connect Claude
            </button>
          </div>
        )}

        <div
          ref={messagesScrollRef}
          onScroll={e => {
            const el = e.currentTarget
            wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 400
          }}
          className="workbench flex-1 overflow-y-auto p-6"
        >
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-[var(--color-text-dim)] gap-2 px-6">
              <div className="text-3xl mb-1" aria-hidden>💬</div>
              <div className="text-sm text-[var(--color-text)]">
                {activeChannel ? `Nothing in #${activeChannel.name} yet` : 'No messages yet'}
              </div>
              <div className="text-xs max-w-sm">
                {agents.length > 0
                  ? `Say hello, or @mention ${agents.length === 1 ? agents[0].name : 'an agent'} to start a conversation.`
                  : 'Send a message to get started. Add an agent from the rail to bring this room to life.'}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map(m => {
                const isAgent = m.sender_kind === 'agent'
                const senderName =
                  isAgent ? m.agent_name : m.user_name ?? 'Unknown'
                const senderAvatar =
                  isAgent ? m.agent_avatar : m.user_avatar
                // Prefer matching on the stable user id (so a custom workspace
                // display name doesn't break "is this mine"); fall back to the
                // name until the backend serves sender_user_id.
                const isOwn = m.sender_kind === 'user' && (
                  m.sender_user_id ? m.sender_user_id === me.id : m.user_name === me.name
                )
                const isEditing = editingMessageId === m.id
                const isPro = isAgent && m.agent_hosting === 'pro_droplet'
                const isByo = isAgent && isByovps(m.agent_hosting)
                const senderIsImage = isImageAvatar(senderAvatar)
                const monogram = (senderName ?? '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '?'
                return (
                  <div
                    key={m.id}
                    id={`msg-${m.id}`}
                    className={`msg flex gap-3 group ${isAgent ? 'msg-agent' : 'msg-human'} ${newMessageIds.has(m.id) ? 'is-new' : ''}`}
                  >
                    <div className="relative flex-shrink-0">
                      {senderIsImage ? (
                        <img src={senderAvatar!} alt="" className="w-8 h-8 rounded-full object-cover" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center">
                          <span className="monogram">{monogram}</span>
                        </div>
                      )}
                      {isPro && <ProStarBadge />}
                      {isByo && <ByovpsBadge />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        {isAgent ? (
                          <span className="handle text-[var(--color-text)]">
                            <span className="at">@</span>{senderName}
                          </span>
                        ) : (
                          <span className="font-medium text-sm">{senderName}</span>
                        )}
                        <span className="text-xs text-[var(--color-text-dim)]">
                          {formatTime(m.created_at)}
                        </span>
                        {!isEditing && m.sender_kind !== 'system' && (
                          <span className="cc-msg-actions ml-auto opacity-0 group-hover:opacity-100 flex items-center gap-2 text-xs relative">
                            <button
                              onClick={() => { setReplyTo(m); setReactionPickerFor(null) }}
                              className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                              title="Reply"
                              aria-label="Reply to message"
                            >
                              ↩
                            </button>
                            <button
                              onClick={() => setReactionPickerFor(id => (id === m.id ? null : m.id))}
                              className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                              title="Add reaction"
                              aria-label="Add reaction"
                            >
                              🙂
                            </button>
                            {reactionPickerFor === m.id && (
                              <>
                                <div className="fixed inset-0 z-[37]" onClick={() => setReactionPickerFor(null)} />
                                <div className="absolute right-0 top-5 z-[38] bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md shadow-elevated px-1.5 py-1 flex items-center gap-1">
                                  {REACTION_EMOJIS.map(e => (
                                    <button
                                      key={e}
                                      onClick={() => void toggleReaction(m.id, e)}
                                      className="text-base leading-none hover:scale-125 transition-transform px-0.5"
                                      title={`React ${e}`}
                                    >
                                      {e}
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}
                            {isOwn && (
                              <>
                                <button
                                  onClick={() => startEdit(m)}
                                  className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                                  title="Edit"
                                  aria-label="Edit message"
                                >
                                  <IconPencil size={14} />
                                </button>
                                <button
                                  onClick={() => deleteMessage(m.id)}
                                  className="text-[var(--color-text-dim)] hover:text-red-400"
                                  title="Delete"
                                  aria-label="Delete message"
                                >
                                  <IconTrash size={14} />
                                </button>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      {m.reply_to && (
                        <button
                          onClick={() => {
                            const el = document.getElementById(`msg-${m.reply_to!.id}`)
                            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          }}
                          className="mt-1 mb-0.5 flex items-center gap-1.5 text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] max-w-full"
                          title="Jump to the replied-to message"
                        >
                          <span className="text-[var(--color-text-dim)]">↩</span>
                          <span className="font-medium flex-shrink-0">{m.reply_to.sender_label}</span>
                          <span className="truncate opacity-80 border-l border-[var(--color-border)] pl-1.5">{m.reply_to.excerpt}</span>
                        </button>
                      )}
                      {isEditing ? (
                        <div className="mt-1 flex flex-col gap-2">
                          <textarea
                            autoFocus
                            value={editDraft}
                            onChange={e => setEditDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit() }
                              if (e.key === 'Escape') { e.preventDefault(); setEditingMessageId(null) }
                            }}
                            rows={Math.min(8, Math.max(2, editDraft.split('\n').length))}
                            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                          />
                          <div className="flex gap-2 text-xs">
                            <button
                              onClick={() => setEditingMessageId(null)}
                              className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                            >
                              Cancel (Esc)
                            </button>
                            <button
                              onClick={() => void saveEdit()}
                              className="bg-[var(--color-accent)] text-white px-2 py-0.5 rounded hover:opacity-90"
                            >
                              Save (Enter)
                            </button>
                          </div>
                        </div>
                      ) : m.body && (
                        <div className="text-sm break-words prose-doc prose-msg max-w-none">
                          <ReactMarkdown
                            remarkPlugins={mentionPlugins}
                            components={{
                              a: (props) => (
                                <a {...props} target="_blank" rel="noopener noreferrer" />
                              ),
                            }}
                          >
                            {m.body}
                          </ReactMarkdown>
                        </div>
                      )}
                      {m.attachments && m.attachments.length > 0 && currentWorkspace && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {m.attachments.map(a => {
                            const url = `/api/workspaces/${currentWorkspace.id}/attachments/${a.id}/download`
                            if (a.kind === 'image') {
                              return (
                                <a
                                  key={a.id}
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={a.filename}
                                  className="block"
                                >
                                  <img
                                    src={url}
                                    alt={a.filename}
                                    className="max-h-48 max-w-xs rounded border border-[var(--color-border)] object-contain bg-[var(--color-surface)]"
                                  />
                                </a>
                              )
                            }
                            const icon =
                              a.kind === 'pdf' ? '📄' : a.kind === 'text' ? '📝' : '📎'
                            return (
                              <a
                                key={a.id}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={a.filename}
                                className="inline-flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs hover:border-[var(--color-accent)]"
                              >
                                <span>{icon}</span>
                                <span className="truncate max-w-[24ch]">{a.filename}</span>
                                <span className="text-[var(--color-text-dim)]">{formatBytes(a.size_bytes)}</span>
                              </a>
                            )
                          })}
                        </div>
                      )}
                      {m.reactions && m.reactions.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {m.reactions.map(r => (
                            <button
                              key={r.emoji}
                              onClick={() => void toggleReaction(m.id, r.emoji)}
                              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none transition ${
                                r.mine
                                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text)]'
                                  : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]'
                              }`}
                              title={r.mine ? 'Remove your reaction' : 'React'}
                            >
                              <span>{r.emoji}</span>
                              <span>{r.count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {isAgent && !isEditing && (
                        <div className="msg-footnote">
                          {m.model && <>model <span style={{ color: 'var(--text-mono)' }}>{m.model}</span> · </>}
                          {typeof m.turn_ms === 'number' && m.turn_ms > 0 && <>turn {formatTurnMs(m.turn_ms)} · </>}
                          <span className="ok">✓</span> delivered
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <form
          onSubmit={sendMessage}
          className="border-t border-[var(--color-border)] p-4 relative"
          onDragEnter={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setIsDragging(true) } }}
          onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault() } }}
          onDragLeave={e => {
            // Only un-flag if leaving the form entirely
            if (e.currentTarget.contains(e.relatedTarget as Node)) return
            setIsDragging(false)
          }}
          onDrop={e => {
            if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return
            e.preventDefault()
            setIsDragging(false)
            void addFiles(e.dataTransfer.files)
          }}
        >
          {isDragging && (
            <div className="absolute inset-2 z-30 border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-bg)]/80 rounded-md flex items-center justify-center text-sm text-[var(--color-text)] pointer-events-none">
              Drop to attach
            </div>
          )}
          {mentionQuery !== null && mentionMatches.length > 0 && (
            <div className="absolute bottom-full left-4 right-4 mb-2 z-[38] bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md shadow-elevated overflow-hidden max-w-xs">
              {mentionMatches.map((c, i) => (
                <button
                  type="button"
                  key={c.key}
                  onMouseDown={(e) => { e.preventDefault(); applyMention(c.token) }}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${
                    i === mentionIndex ? 'bg-[var(--color-active-bg)] text-[var(--color-text)]' : 'text-[var(--color-text-dim)] hover:bg-[var(--color-hover-bg)]'
                  }`}
                >
                  <span className="relative inline-flex items-center justify-center">
                    <AgentAvatar avatar={c.avatar} size={18} />
                  </span>
                  <span className="flex-1">{c.label}</span>
                  <span className="text-[10px] uppercase tracking-wide opacity-50">{c.kind === 'human' ? 'person' : 'agent'}</span>
                </button>
              ))}
            </div>
          )}
          {commandFeedback && (
            <div className="absolute bottom-full left-4 right-4 mb-2 text-xs text-[var(--color-text-dim)] italic">
              {commandFeedback}
            </div>
          )}
          {typingAgents.size > 0 && (
            <div className="absolute bottom-full left-4 right-4 mb-1 text-xs text-[var(--color-text-dim)] flex items-center gap-2">
              <span className="inline-flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-[var(--color-text-dim)] animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 rounded-full bg-[var(--color-text-dim)] animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 rounded-full bg-[var(--color-text-dim)] animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
              {(() => {
                const names = Array.from(typingAgents.values()).map(a => isImageAvatar(a.avatar) ? a.name : `${a.avatar ?? '🤖'} ${a.name}`)
                if (names.length === 1) return <span><span className="text-[var(--color-text)]">{names[0]}</span> is thinking…</span>
                if (names.length === 2) return <span><span className="text-[var(--color-text)]">{names[0]}</span> and <span className="text-[var(--color-text)]">{names[1]}</span> are thinking…</span>
                return <span>{names.length} agents are thinking…</span>
              })()}
            </div>
          )}
          {(pendingAttachments.length > 0 || uploadingCount > 0 || uploadError || sendError) && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {pendingAttachments.map(a => (
                <div
                  key={a.id}
                  className="inline-flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs"
                  title={a.filename}
                >
                  <span>{a.kind === 'image' ? '🖼️' : a.kind === 'pdf' ? '📄' : a.kind === 'text' ? '📝' : '📎'}</span>
                  <span className="truncate max-w-[18ch]">{a.filename}</span>
                  <span className="text-[var(--color-text-dim)]">{formatBytes(a.size_bytes)}</span>
                  <button
                    type="button"
                    onClick={() => removePending(a.id)}
                    className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] ml-1"
                    aria-label={`Remove ${a.filename}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {uploadingCount > 0 && (
                <span className="text-xs text-[var(--color-text-dim)] italic">
                  Uploading {uploadingCount}…
                </span>
              )}
              {uploadError && (
                <span className="inline-flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1 max-w-full">
                  <span className="truncate">{uploadError}</span>
                  <button
                    type="button"
                    onClick={() => setUploadError(null)}
                    className="text-red-400/70 hover:text-red-300"
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                </span>
              )}
              {sendError && (
                <span className="inline-flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1 max-w-full">
                  <span className="truncate">{sendError}</span>
                  <button
                    type="button"
                    onClick={() => setSendError(null)}
                    className="text-red-400/70 hover:text-red-300"
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
          )}
          {replyTo && (
            <div className="mb-2 flex items-center gap-2 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1.5">
              <span className="text-[var(--color-text-dim)] flex-shrink-0">↩ Replying to</span>
              <span className="font-medium flex-shrink-0">
                {replyTo.sender_kind === 'agent' ? `@${replyTo.agent_name}` : replyTo.user_name ?? 'Unknown'}
              </span>
              <span className="truncate text-[var(--color-text-dim)] opacity-80">{replyTo.body}</span>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                className="ml-auto flex-shrink-0 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                aria-label="Cancel reply"
                title="Cancel reply"
              >
                ✕
              </button>
            </div>
          )}
          <div className="composer-card flex items-end gap-2 px-3 py-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => {
                if (e.target.files && e.target.files.length > 0) {
                  void addFiles(e.target.files)
                  e.target.value = ''
                }
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!activeChannelId}
              className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] disabled:opacity-30 px-1"
              title="Attach files"
              aria-label="Attach files"
            >
              <IconPaperclip size={18} />
            </button>
            <textarea
              ref={draftInputRef}
              rows={1}
              value={draft}
              onChange={e => updateDraft(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onKeyDown={onInputKeyDown}
              onPaste={e => {
                // Files first
                if (e.clipboardData.files && e.clipboardData.files.length > 0) {
                  e.preventDefault()
                  void addFiles(e.clipboardData.files)
                  return
                }
                // Large text → attach instead of inline
                const text = e.clipboardData.getData('text/plain')
                if (text && text.length >= LARGE_PASTE_CHARS) {
                  e.preventDefault()
                  void attachLargePaste(text)
                }
              }}
              placeholder={activeChannel ? `Message ${activeChannel.name}` : 'Select a room'}
              disabled={!activeChannelId}
              className="flex-1 bg-transparent border-0 px-1 py-1 text-sm focus:outline-none placeholder:text-[var(--color-text-dim)] resize-none leading-relaxed overflow-y-auto"
              style={{ maxHeight: 200 }}
            />
            <button
              type="submit"
              disabled={!activeChannelId || (!draft.trim() && pendingAttachments.length === 0)}
              className="run-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
              title="Send (Enter)"
              aria-label="Send message"
            >
              <span>▶</span><span className="hidden sm:inline">Run</span>
            </button>
          </div>
          <div className="composer-hints mt-1.5 px-1 flex items-center gap-3">
            <span><span style={{ color: 'var(--color-text)' }}>↵</span> send</span>
            <span><span style={{ color: 'var(--color-text)' }}>@</span> mention</span>
            <span><span style={{ color: 'var(--color-text)' }}>/help</span> commands</span>
            <span className="hidden sm:inline"><span style={{ color: 'var(--color-text)' }}>📎</span> or drag to attach</span>
          </div>
        </form>

        {slashHelpOpen && <SlashHelp onClose={() => setSlashHelpOpen(false)} />}
      </main>
    </div>
        </div>{/* /channels panel */}

        {effectiveRight && currentWorkspace && (
          <PaneResizer ratio={splitRatio} setRatio={setSplitRatio} />
        )}

        <div className={panelClasses('command')} style={panelStyle('command')} onMouseDown={() => recordPaneActivity('command')}>
          {currentWorkspace && <Command workspaceId={currentWorkspace.id} workspaceName={currentWorkspace.name} />}
        </div>

        <div className={panelClasses('brigade')} style={panelStyle('brigade')} onMouseDown={() => recordPaneActivity('brigade')}>
          {currentWorkspace && (
            <Brigade
              workspaceId={currentWorkspace.id}
              workspaceName={currentWorkspace.name}
              onManage={(id) => openInSettings({ kind: 'agent', id })}
              onNew={() => openInSettings({ kind: 'agent-new' })}
              onManagePlan={() => openInSettings({ kind: 'workspace' })}
            />
          )}
        </div>

        <div className={panelClasses('documents')} style={panelStyle('documents')} onMouseDown={() => recordPaneActivity('documents')}>
          {currentWorkspace && (
            <Documents
              workspaceId={currentWorkspace.id}
              channels={channels}
              activeChannelId={activeChannelId}
              requestedScopeChannel={docScopeChannel}
              requestedScopeNonce={docScopeNonce}
              requestedDocId={docOpenId}
              requestedDocNonce={docOpenNonce}
            />
          )}
        </div>

        <div className={panelClasses('settings')} style={panelStyle('settings')} onMouseDown={() => recordPaneActivity('settings')}>
          {currentWorkspace && (
            <Settings
              workspaceId={currentWorkspace.id}
              openClaudeNonce={openClaudeNonce}
              openTarget={settingsTarget ?? undefined}
              openTargetNonce={settingsTargetNonce}
              onWorkspaceChanged={async () => {
                const r = await fetch('/api/workspaces').then(r => r.json())
                setWorkspaces(r.workspaces ?? [])
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function PaneResizer({
  setRatio,
}: {
  ratio: number
  setRatio: (n: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const container = ref.current?.parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    function onMove(ev: MouseEvent) {
      const newRatio = (ev.clientX - rect.left) / rect.width
      setRatio(Math.max(0.15, Math.min(0.85, newRatio)))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  return (
    <div
      ref={ref}
      onMouseDown={onMouseDown}
      style={{ order: 1, flexBasis: 4 }}
      className="hidden md:block cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors"
    />
  )
}
