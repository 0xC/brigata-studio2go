import { useState, useRef, useEffect } from 'react'
import { IconChannel, IconBrigade, IconDocument, IconDashboard, IconGear, IconFocus, IconRelay } from './lib/icons'

// Interactive "Northwind" showcase for the redesign (preview.brigata.ai/?demo=1).
// The real command-center shell + .cc-* styles, driven by curated sample data
// you can actually click around in: switch rooms, type, send, and get a scripted
// reply from that room's lead agent. Clearly badged as sample data — never the
// user's real account.

type Dot = 'work' | 'on' | 'idle'
type Agent = { id: string; name: string; av: string; role: string; dot: Dot; st: string }
type Msg =
  | { id: string; kind: 'hu' | 'ag'; who: string; av: string; tag: string; ts: string; text: string; foot?: string }
  | { id: string; kind: 'relay'; from: string; to: string; body: string; meta: string }

const AGENTS: Agent[] = [
  { id: 'nico', name: 'Nico', av: '🗺️', role: 'The planner', dot: 'work', st: 'working — drafting the plan' },
  { id: 'mara', name: 'Mara', av: '🗂️', role: 'The librarian', dot: 'on', st: 'awake' },
  { id: 'theo', name: 'Theo', av: '🔎', role: 'The researcher', dot: 'on', st: 'awake' },
  { id: 'vera', name: 'Vera', av: '👀', role: 'The watcher', dot: 'on', st: 'awake' },
  { id: 'concierge', name: 'Concierge', av: '🛎️', role: 'The host', dot: 'idle', st: 'idle · 12d' },
]
const byId = (id: string) => AGENTS.find(a => a.id === id)!

type Room = { id: string; name: string; topic: string; badge?: number; lead: string }
const ROOMS: Room[] = [
  { id: 'this-week', name: 'this-week', topic: 'One clear plan, nudges that land.', badge: 3, lead: 'nico' },
  { id: 'research', name: 'research', topic: 'What the market is doing.', lead: 'theo' },
  { id: 'garden-plot', name: 'garden-plot', topic: 'The side project, tended weekly.', lead: 'mara' },
  { id: 'general', name: 'general', topic: 'Everything else.', lead: 'concierge' },
]

const MODEL = 'claude-sonnet-4-6'
const SEED: Record<string, Msg[]> = {
  'this-week': [
    { id: 's1', kind: 'hu', who: 'You', av: '🧑', tag: 'you', ts: '9:02', text: 'Map this week into a plan I can actually see — and pull in last week’s notes. @Nico take point.' },
    { id: 's2', kind: 'ag', who: 'Nico', av: '🗺️', tag: 'agent', ts: '9:02', text: 'On it. I’ve got the shape of the week — five priorities, two are blocked on decisions only you can make. I’ll handle the planning doc; the stale-notes sweep is Mara’s wheelhouse, so I’m passing that over.', foot: `model ${MODEL} · turn 6.1s` },
    { id: 's3', kind: 'relay', from: 'nico', to: 'mara', body: 'Sweep #garden-plot for stale notes, fold the live ones into the plan.', meta: 'picked up 4s later · result will post in #this-week' },
    { id: 's4', kind: 'ag', who: 'Mara', av: '🗂️', tag: 'agent', ts: '9:03', text: 'Got it from Nico. Found 4 notes worth keeping and 9 that were stale — archived those, threaded the keepers into the draft. The plan’s coming together cleanly.', foot: `model ${MODEL} · turn 8.4s` },
  ],
  'research': [
    { id: 'r1', kind: 'hu', who: 'You', av: '🧑', tag: 'you', ts: '8:40', text: 'What are the three competitors charging now? @Theo' },
    { id: 'r2', kind: 'ag', who: 'Theo', av: '🔎', tag: 'agent', ts: '8:41', text: 'Pulled fresh pricing this morning — two raised prices since last month. I’ll drop a side-by-side in a doc and flag the one that undercuts us.', foot: `model ${MODEL} · turn 5.2s` },
  ],
  'garden-plot': [
    { id: 'g1', kind: 'ag', who: 'Mara', av: '🗂️', tag: 'agent', ts: 'Tue', text: 'Weekly tend done — folded 4 live notes into the plan and archived the rest. Nothing here needs you right now.', foot: `model ${MODEL} · turn 7.0s` },
  ],
  'general': [
    { id: 'gn1', kind: 'ag', who: 'Concierge', av: '🛎️', tag: 'agent', ts: 'Mon', text: 'Welcome to Northwind. I keep the place tidy and route anything that needs a specialist. Say hello anytime.', foot: `model ${MODEL} · turn 2.1s` },
  ],
}

const REPLIES = [
  'Got it — on it. I’ll post the result back here when it’s done.',
  'Understood. Give me a moment to pull this together and I’ll report back.',
  'On it. I’ll flag anything blocked and hand off the rest.',
  'Starting now — I’ll thread the outcome into the plan and ping you.',
]

function nowTime(): string {
  const d = new Date()
  let h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m} ${ap}`
}

export function CommandCenterDemo({ me, onLogout }: { me: { name: string | null }; onLogout: () => void }) {
  const [roomId, setRoomId] = useState('this-week')
  const [msgs, setMsgs] = useState<Record<string, Msg[]>>(() => JSON.parse(JSON.stringify(SEED)))
  const [draft, setDraft] = useState('')
  const [thinkingIn, setThinkingIn] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [seq, setSeq] = useState(100)
  const streamRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const room = ROOMS.find(r => r.id === roomId)!
  const lead = byId(room.lead)
  const list = msgs[roomId] ?? []

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [list.length, thinkingIn, roomId])

  function send() {
    const t = draft.trim()
    if (!t || thinkingIn) return
    const uid = `u${seq}`
    setSeq(s => s + 2)
    setMsgs(prev => ({ ...prev, [roomId]: [...(prev[roomId] ?? []), { id: uid, kind: 'hu', who: 'You', av: '🧑', tag: 'you', ts: nowTime(), text: t }] }))
    setDraft('')
    if (taRef.current) taRef.current.style.height = 'auto'
    const replyRoom = roomId
    setThinkingIn(replyRoom)
    const reply = REPLIES[t.length % REPLIES.length]
    const turn = (1.4 + (t.length % 40) / 10).toFixed(1)
    window.setTimeout(() => {
      setMsgs(prev => ({
        ...prev,
        [replyRoom]: [...(prev[replyRoom] ?? []), {
          id: `a${uid}`, kind: 'ag', who: lead.name, av: lead.av, tag: 'agent', ts: nowTime(),
          text: reply, foot: `model ${MODEL} · turn ${turn}s`,
        }],
      }))
      setThinkingIn(null)
    }, 1300)
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div className="cc-shell">
      {/* RAIL */}
      <nav className="cc-rail">
        <div className="cc-mark">b</div>
        <button className="cc-rnav on" title="Channels"><IconChannel size={19} /></button>
        <button className="cc-rnav" title="Brigade"><IconBrigade size={20} /></button>
        <button className="cc-rnav" title="Documents"><IconDocument size={19} /></button>
        <button className="cc-rnav" title="Overview"><IconDashboard size={20} /></button>
        <button className="cc-rnav" title="Settings"><IconGear size={20} /></button>
        <button className="cc-me-av" onClick={() => setProfileOpen(v => !v)} title={me.name ?? ''}><span>🧑</span></button>
        {profileOpen && (
          <div className="cc-me-menu">
            <div className="cc-me-name">Demo workspace</div>
            <button onClick={() => { window.location.search = '?cc=1' }}>Exit demo</button>
            <button onClick={onLogout}>Log out</button>
          </div>
        )}
      </nav>

      {/* CHANNELS + BRIGADE */}
      <section className="cc-side">
        <div className="cc-ws">
          <h1>Northwind <span className="cc-plan">FOUNDING</span></h1>
          <div className="cc-sub">5 agents · 4 awake</div>
        </div>
        <div className="cc-clist">
          <div className="cc-csec"><span className="cc-label">Rooms</span></div>
          {ROOMS.map(r => (
            <button key={r.id} className={`cc-room ${r.id === roomId ? 'on' : ''}`} onClick={() => setRoomId(r.id)}>
              <span className="cc-rg"><IconChannel size={14} /></span>
              <span className="cc-rn">{r.name}</span>
              {r.badge ? <span className="cc-badge">{r.badge}</span> : null}
            </button>
          ))}
          <div className="cc-csec"><span className="cc-label">Brigade</span></div>
          <div className="cc-pres">
            {AGENTS.map(a => (
              <div className="cc-pcard" key={a.id}>
                <span className="cc-av"><span>{a.av}</span><span className={`cc-dot ${a.dot}`} /></span>
                <div><div className="cc-nm">{a.name}</div><div className={`cc-st ${a.dot === 'work' ? 'w' : ''}`}>{a.st}</div></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CHAT */}
      <main className="cc-main">
        <header className="cc-main-head">
          <div>
            <div className="cc-t"><IconChannel size={15} /> {room.name}</div>
            <div className="cc-topic">{room.topic}</div>
          </div>
          <div className="cc-live"><i /> live</div>
        </header>
        <div className="cc-stream" ref={streamRef}>
          <div className="cc-day"><span>Today</span></div>
          {list.map(msg => msg.kind === 'relay' ? (
            <div className="cc-relay" key={msg.id}>
              <div className="cc-ic"><IconRelay size={17} /></div>
              <div>
                <div className="cc-rt"><b>{byId(msg.from).name}</b> handed off to <b>{byId(msg.to).name}</b> — “{msg.body}”</div>
                <div className="cc-rs"><span style={{ color: 'var(--gold)' }}>Relay</span> · {msg.meta}</div>
              </div>
            </div>
          ) : (
            <div className={`cc-msg ${msg.kind}`} key={msg.id}>
              <span className="cc-mav"><span>{msg.av}</span></span>
              <div className="cc-body">
                <div className="cc-meta"><span className="cc-who">{msg.who}</span><span className="cc-tag">{msg.tag}</span><span className="cc-ts">{msg.ts}</span></div>
                <div className="cc-text">{msg.text}</div>
                {msg.foot && <div className="cc-foot">{msg.foot} · <span className="ok">✓ delivered</span></div>}
              </div>
            </div>
          ))}
          {thinkingIn === roomId && (
            <div className="cc-typing"><span className="cc-mav" style={{ width: 26, height: 26, fontSize: 13 }}><span>{lead.av}</span></span><span>{lead.name} is thinking</span><span className="dd"><i /><i /><i /></span></div>
          )}
        </div>
        <form className="cc-composer" onSubmit={e => { e.preventDefault(); send() }}>
          <div className="cc-cbox">
            <div className="cc-ctop">
              <textarea
                ref={taRef}
                rows={1}
                value={draft}
                onChange={e => { setDraft(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' }}
                onKeyDown={onKey}
                placeholder={`Message #${room.name} — or hand a task to ${lead.name}`}
              />
              <button type="submit" className="cc-send" title="Send (Enter)" disabled={!draft.trim()}>↑</button>
            </div>
            <div className="cc-ctools"><span>📎 Attach</span><span className="mono">@ mention</span><span className="mono">/ commands</span><span className="mono" style={{ marginLeft: 'auto' }}>⏎ send</span></div>
          </div>
        </form>
      </main>

      {/* CONTEXT / BRIGADE */}
      <aside className="cc-context">
        <h2><IconFocus size={14} /> In focus</h2>
        <div className="cc-agentcard">
          <div className="cc-actop">
            <div className="cc-big"><span>{lead.av}</span></div>
            <div>
              <div className="cc-acnm">{lead.name}</div>
              <div className="cc-acrole">{lead.role} · {lead.dot === 'work' ? <span style={{ color: 'var(--ember)' }}>working now</span> : lead.dot === 'idle' ? 'idle' : 'awake'}</div>
            </div>
          </div>
          <div className="cc-bio">Lead for #{room.name}. {room.topic}</div>
          <div className="cc-stats">
            <div className="cc-stat"><div className="k">Handoffs</div><div className="v">14 <small>picked up</small></div></div>
            <div className="cc-stat"><div className="k">Usage · 30d</div><div className="v">$0.62 <small>· 38 turns</small></div></div>
          </div>
        </div>
        <div className="cc-relayfeed">
          <h2 style={{ marginBottom: 6 }}><IconRelay size={15} /> Relay <span className="cc-label" style={{ marginLeft: 'auto' }}>handoffs</span></h2>
          <div className="cc-rfrow"><div className="cc-ar"><span className="cc-miniav"><span>🗺️</span></span>→<span className="cc-miniav"><span>🗂️</span></span></div><div className="cc-rfb"><div className="cc-rft">Sweep stale notes</div><div className="cc-rfs work">working · just now</div></div></div>
          <div className="cc-rfrow"><div className="cc-ar"><span className="cc-miniav h"><span>🧑</span></span>→<span className="cc-miniav"><span>🔎</span></span></div><div className="cc-rfb"><div className="cc-rft">Research competitor pricing</div><div className="cc-rfs new">new · 11m</div></div></div>
          <div className="cc-rfrow"><div className="cc-ar"><span className="cc-miniav"><span>🗂️</span></span>→<span className="cc-miniav"><span>🗺️</span></span></div><div className="cc-rfb"><div className="cc-rft">Wire the weekly digest</div><div className="cc-rfs done">✓ done · posted in #this-week</div></div></div>
          <div className="cc-rfrow"><div className="cc-ar"><span className="cc-miniav"><span>🔎</span></span>→<span className="cc-miniav"><span>👀</span></span></div><div className="cc-rfb"><div className="cc-rft">Flag anything time-sensitive</div><div className="cc-rfs done">✓ done · 2h</div></div></div>
        </div>
      </aside>

      <div className="cc-demo-badge">Demo workspace · sample data, not your account</div>
    </div>
  )
}
