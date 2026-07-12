import { useEffect, useRef, useState } from 'react'
import { AGENT_TEMPLATES } from './lib/agentTemplates'

type Answers = {
  ai_familiarity?: 'new' | 'few-times' | 'daily' | 'developer'
  interests?: string[]   // Q2 — inspiration nuggets that seed channels + crew
  traits?: string[]      // Q3 — personality nuggets that shape the agents' voice
}

const STEPS = ['intro', 'idea', 'ideas', 'ai', 'intent', 'comfort', 'name', 'role', 'setup', 'assemble', 'claude', 'done'] as const
type Step = (typeof STEPS)[number]
// The setup "build" sequence — revealed one at a time (spinner → check) so it
// reads like real work happening, not an instant flash.
const SETUP_STEPS = [
  'Provisioning your workspace',
  'Creating your channels',
  'Adding your starter crew',
  'Tuning their personalities',
  'Pinning your plan & a first message',
]
const QUESTION_STEPS: Step[] = ['ai', 'intent', 'comfort']
const RAIL_LABEL: Record<string, string> = { ai: 'You', intent: 'Interests', comfort: 'Style' }

const AI_OPTIONS: { value: NonNullable<Answers['ai_familiarity']>; label: string }[] = [
  { value: 'new', label: "Brand new — heard about it, haven't really used it" },
  { value: 'few-times', label: "I've used ChatGPT or similar a few times" },
  { value: 'daily', label: 'I use AI tools daily for work or hobbies' },
  { value: 'developer', label: "I build with AI APIs / I'm a developer" },
]
// Q2 "fridge magnets" — ~30 plain-language nuggets. Each belongs to a bucket
// that maps to one channel + one starter agent, so picking several still yields
// a small, coherent studio (buckets dedupe) rather than 30 agents.
type Bucket = 'learn' | 'writing' | 'research' | 'coding' | 'business' | 'creative' | 'daily'
const BUCKET_MAP: Record<Bucket, { ch: string; tag: string; template: string }> = {
  learn:    { ch: 'getting-started', tag: 'guide', template: 'coach' },
  writing:  { ch: 'writing',         tag: 'topic', template: 'copywriter' },
  research: { ch: 'research',        tag: 'topic', template: 'researcher' },
  coding:   { ch: 'dev',             tag: 'topic', template: 'coder' },
  business: { ch: 'ops',             tag: 'topic', template: 'strategist' },
  creative: { ch: 'studio',          tag: 'topic', template: 'editor' },
  daily:    { ch: 'day-to-day',      tag: 'topic', template: 'concierge' },
}
const INTEREST_OPTIONS: { value: string; label: string; bucket: Bucket }[] = [
  { value: 'learn-ai',    label: 'Learn about AI',           bucket: 'learn' },
  { value: 'help-tasks',  label: 'Help with everyday tasks', bucket: 'daily' },
  { value: 'writing',     label: 'Writing & drafting',       bucket: 'writing' },
  { value: 'email',       label: 'Email & messages',         bucket: 'writing' },
  { value: 'research',    label: 'Research & fact-finding',  bucket: 'research' },
  { value: 'summarize',   label: 'Summarizing long reads',   bucket: 'research' },
  { value: 'brainstorm',  label: 'Brainstorming ideas',      bucket: 'creative' },
  { value: 'planning',    label: 'Planning & organizing',    bucket: 'daily' },
  { value: 'coding',      label: 'Coding & building',        bucket: 'coding' },
  { value: 'social',      label: 'Social media posts',       bucket: 'writing' },
  { value: 'marketing',   label: 'Marketing & copy',         bucket: 'writing' },
  { value: 'strategy',    label: 'Business strategy',        bucket: 'business' },
  { value: 'numbers',     label: 'Budgets & numbers',        bucket: 'business' },
  { value: 'scheduling',  label: 'Scheduling & reminders',   bucket: 'daily' },
  { value: 'notes',       label: 'Note-taking',              bucket: 'daily' },
  { value: 'studying',    label: 'Studying & learning',      bucket: 'learn' },
  { value: 'travel',      label: 'Travel planning',          bucket: 'daily' },
  { value: 'meals',       label: 'Recipes & meal plans',     bucket: 'daily' },
  { value: 'health',      label: 'Fitness & health',         bucket: 'daily' },
  { value: 'coaching',    label: 'Personal coaching',        bucket: 'learn' },
  { value: 'support',     label: 'Customer support',         bucket: 'business' },
  { value: 'data',        label: 'Data & spreadsheets',      bucket: 'business' },
  { value: 'design',      label: 'Design & creative',        bucket: 'creative' },
  { value: 'video',       label: 'Video & media',            bucket: 'creative' },
  { value: 'story',       label: 'Storytelling',             bucket: 'creative' },
  { value: 'editing',     label: 'Editing & proofreading',   bucket: 'writing' },
  { value: 'projects',    label: 'Project management',       bucket: 'business' },
  { value: 'jobs',        label: 'Job hunting & resumes',    bucket: 'writing' },
  { value: 'decisions',   label: 'Big decisions',            bucket: 'business' },
  { value: 'curious',     label: 'Just curious',             bucket: 'learn' },
]

// Q3 personality nuggets. Each can nudge tone (casual/formal), detail
// (brief/thorough), and/or add a soul-doc note — together they begin to define
// how the agents actually talk.
type Tone = 'casual' | 'formal'
type Detail = 'brief' | 'thorough'
const TRAIT_OPTIONS: { value: string; label: string; tone?: Tone; detail?: Detail; note?: string }[] = [
  { value: 'short',      label: 'Keep it short and to the point',  detail: 'brief' },
  { value: 'thorough',   label: 'Explain things thoroughly',       detail: 'thorough' },
  { value: 'casual',     label: 'Casual and friendly',             tone: 'casual' },
  { value: 'formal',     label: 'Professional and polished',       tone: 'formal' },
  { value: 'answer',     label: 'Just give me the answer',         detail: 'brief' },
  { value: 'steps',      label: 'Walk me through the steps',       detail: 'thorough' },
  { value: 'humor',      label: 'A little personality and humor',  tone: 'casual', note: 'playful' },
  { value: 'plain',      label: 'Plain, everyday language',        note: 'plain-spoken' },
  { value: 'technical',  label: 'Technical detail is welcome',     detail: 'thorough', note: 'technical' },
  { value: 'check',      label: 'Check with me before big steps',  note: 'asks first' },
  { value: 'initiative', label: 'Take initiative, I trust you',    note: 'proactive' },
  { value: 'encourage',  label: 'Encouraging and supportive',      tone: 'casual', note: 'warm' },
]

// Reduce the selected style nuggets into a small persona the workbench and the
// final receipt can show — and that the soul docs would draw from.
function derivePersona(traits: string[] = []): { tone: string; detail: string; tags: string[] } {
  const sel = TRAIT_OPTIONS.filter(t => traits.includes(t.value))
  const tones = sel.map(t => t.tone).filter(Boolean) as Tone[]
  const details = sel.map(t => t.detail).filter(Boolean) as Detail[]
  const tone = tones.includes('formal') && !tones.includes('casual') ? 'Polished'
    : tones.includes('casual') && !tones.includes('formal') ? 'Casual' : 'Balanced'
  const detail = details.includes('thorough') && !details.includes('brief') ? 'Thorough'
    : details.includes('brief') && !details.includes('thorough') ? 'Concise' : 'Balanced'
  const tags = sel.map(t => t.note).filter(Boolean) as string[]
  return { tone, detail, tags }
}

type WbChannel = { name: string; tag: string }
type WbAgent = { template: string; tag: string }

// Mirrors the studio we'll actually seed server-side, so the workbench panel
// previews exactly what the user is about to get.
function deriveStudio(a: Answers): { channels: WbChannel[]; agents: WbAgent[] } {
  const channels: WbChannel[] = []
  const agents: WbAgent[] = []
  const addCh = (name: string, tag: string) => { if (!channels.find(c => c.name === name)) channels.push({ name, tag }) }
  const addAg = (template: string, tag: string) => { if (!agents.find(x => x.template === template)) agents.push({ template, tag }) }

  if (a.ai_familiarity) addCh('general', 'core')
  if (a.ai_familiarity === 'new' || a.ai_familiarity === 'few-times') addCh('getting-started', 'guide')
  if (a.ai_familiarity === 'developer') addCh('dev', 'core')

  // Coach rides with every studio — the friendly default Kris wanted on the
  // base squad (opt out by changing its role later, not by omitting it here).
  addAg('coach', 'core')

  // Collapse the chosen nuggets to their buckets so several picks still produce
  // a tight studio. Each bucket contributes one channel + one starter agent.
  const buckets = new Set<Bucket>()
  for (const v of a.interests ?? []) {
    const opt = INTEREST_OPTIONS.find(o => o.value === v)
    if (opt) buckets.add(opt.bucket)
  }
  for (const b of buckets) {
    const m = BUCKET_MAP[b]
    addCh(m.ch, m.tag)
    addAg(m.template, 'template')
  }
  return { channels, agents }
}

function templateMeta(id: string) {
  return AGENT_TEMPLATES.find(t => t.id === id)
}

// One-line hello in each archetype's own voice, for the "crew assembles" reveal
// at the end of setup. Keyed by template id; falls back to a generic line.
const AGENT_HELLOS: Record<string, string> = {
  concierge: "Hey — I'll help with whatever comes up.",
  coach: "I'll keep us on track and honest.",
  researcher: "I'll dig up the facts and cite them.",
  coder: "I'll build it and sweat the bugs.",
  copywriter: "I'll get the words just right.",
  editor: "I'll sharpen every draft you bring me.",
  strategist: "I'll help you make the call.",
  sysadmin: "I'll keep the lights on behind the scenes.",
}

// ── Idea engine (LLM-backed first-project funnel) ──────────────────────────
// The crew cast + icons must match the server's ARCHETYPES (onboarding.ts) and
// the idea-engine icon enum exactly, so the cards preview what /seed creates.
type CrewId = 'mara' | 'theo' | 'iris' | 'sol' | 'nico' | 'vera'
const CREW_CAST: Record<CrewId, { name: string; blurb: string; avatar: string }> = {
  mara: { name: 'Mara', blurb: 'keeps it all organized', avatar: '🗂️' },
  theo: { name: 'Theo', blurb: 'digs up the good stuff', avatar: '🔎' },
  iris: { name: 'Iris', blurb: 'turns thoughts into writing', avatar: '✍️' },
  sol: { name: 'Sol', blurb: 'watches the money', avatar: '💰' },
  nico: { name: 'Nico', blurb: 'maps the steps', avatar: '🗺️' },
  vera: { name: 'Vera', blurb: 'flags what needs you', avatar: '👀' },
}
const IDEA_ICONS: Record<string, string> = { organize: '🗂', creative: '🎨', work: '💼', plan: '🗓' }

type Idea = {
  icon: string
  title: string
  tease: string
  crew: CrewId[]
  plan: [string, string, string]
}

export function Onboarding({ onDone, userName, demo = false, standalone = false }: { onDone: () => void; userName?: string | null; demo?: boolean; standalone?: boolean }) {
  const [step, setStep] = useState<Step>('intro')
  const [answers, setAnswers] = useState<Answers>({})
  const [agentNames, setAgentNames] = useState<Record<string, string>>({})
  const [entitled, setEntitled] = useState<boolean | null>(null)
  const [chosenRole, setChosenRole] = useState<string>('')
  const skippedRef = useRef(false)
  const submittedRef = useRef(false)
  const [setupDone, setSetupDone] = useState(0) // how many build steps have completed
  const [assembled, setAssembled] = useState(0) // how many crew members have said hello
  // Connect Claude step state
  const [claudeToken, setClaudeToken] = useState('')
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [claudeError, setClaudeError] = useState<string | null>(null)
  const [claudeConnected, setClaudeConnected] = useState(false)
  const [claudeShowApi, setClaudeShowApi] = useState(false)
  const [demoEnabled, setDemoEnabled] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [demoError, setDemoError] = useState<string | null>(null)
  // Idea-engine flow state
  const [wantText, setWantText] = useState('')
  const [ideaList, setIdeaList] = useState<Idea[] | null>(null)
  const [ideaBusy, setIdeaBusy] = useState(false)
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)
  const [seeded, setSeeded] = useState<{ crew: string[]; channel: string } | null>(null)

  // Determine entitlement once: free owners get a single role-pickable agent,
  // entitled owners (comp/paid) get the full derived crew.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [b, m] = await Promise.all([
        fetch('/api/billing/status').then(r => r.json()).catch(() => null),
        fetch('/api/auth/me').then(r => r.json()).catch(() => null),
      ])
      if (!cancelled) setEntitled(!!b?.active || !!m?.user?.is_comp)
    })()
    return () => { cancelled = true }
  }, [])

  const studio = deriveStudio(answers)
  const persona = derivePersona(answers.traits)
  const isFree = entitled === false
  const suggestedRole = studio.agents[0]?.template ?? 'concierge'
  const roleForFree = chosenRole || suggestedRole
  // Entitled users get the full derived crew; free users get exactly one agent.
  const starterTemplates = isFree ? [roleForFree] : studio.agents.map(a => a.template)
  const previewAgents = isFree ? [{ template: roleForFree, tag: 'your agent' }] : studio.agents
  const firstName = (userName ?? '').trim().split(/\s+/)[0] || ''
  // The crew that actually gets created — drives the "say hello" reveal.
  const crewList = starterTemplates.map(id => {
    const meta = templateMeta(id)
    return {
      id,
      name: (agentNames[id]?.trim() || meta?.name || id),
      avatar: meta?.avatar_path,
      hello: AGENT_HELLOS[id] ?? "Ready when you are.",
    }
  })

  function starterAgentsPayload() {
    return starterTemplates.map(id => {
      const meta = templateMeta(id)
      return {
        template_id: id,
        name: (agentNames[id] ?? meta?.name ?? id).trim() || (meta?.name ?? id),
        soul_md: meta?.soul_md ?? '',
      }
    })
  }

  // Fire the POST + animate the setup log once we land on the setup scene.
  useEffect(() => {
    if (step !== 'setup' || submittedRef.current) return
    submittedRef.current = true
    setSetupDone(0)
    const skipped = skippedRef.current
    if (!demo) {
      void fetch('/api/workspaces/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...answers,
          skipped,
          starter_agents: skipped ? [] : starterAgentsPayload(),
          starter_channels: skipped ? [] : studio.channels.map(c => c.name),
        }),
      }).catch(() => {})
    }
    // Reveal the build steps one at a time (~1.3s each) so it reads like real
    // work — slow enough that people can actually read each line as it lands.
    const per = 1300
    const timers = SETUP_STEPS.map((_, i) => setTimeout(() => setSetupDone(i + 1), per * (i + 1)))
    // After the last check lands, hold a beat, then hand off to the crew reveal
    // (if there's a crew to meet) before the final scene.
    const afterSetup = crewList.length ? 'assemble' : (demo || standalone ? 'done' : 'claude')
    const advance = setTimeout(() => setStep(afterSetup), per * SETUP_STEPS.length + 1500)
    return () => { timers.forEach(clearTimeout); clearTimeout(advance) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // "Crew assembles": reveal each agent's hello one at a time, then move on.
  useEffect(() => {
    if (step !== 'assemble') return
    setAssembled(0)
    const n = crewList.length
    const per = 700
    const timers = crewList.map((_, i) => setTimeout(() => setAssembled(i + 1), 400 + per * i))
    // Let the whole crew sit there and breathe before advancing — Chris noted the
    // old hold cut the moment off. ~3.6s after the last hello lands.
    const advance = setTimeout(() => setStep(demo || standalone ? 'done' : 'claude'), 400 + per * n + 3600)
    return () => { timers.forEach(clearTimeout); clearTimeout(advance) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // When entering the claude step, check whether the user already has a token
  // (e.g., comp invitee who connected via Settings before redoing onboarding).
  // If so, mark connected and auto-skip after a beat.
  useEffect(() => {
    if (step !== 'claude') return
    let cancelled = false
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return
        if (d?.user?.has_anthropic_token) {
          setClaudeConnected(true)
          // Don't auto-advance — show the success state for ~1.5s then move on.
          setTimeout(() => { if (!cancelled) setStep('done') }, 1500)
        }
      })
      .catch(() => {})
    // Is the platform-funded newbie demo available? If so, offer it as a
    // no-setup third path. Silently absent when the operator hasn't enabled it.
    fetch('/api/auth/demo/state')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.enabled) setDemoEnabled(true) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [step])

  async function startDemoFlow() {
    if (demoBusy) return
    setDemoBusy(true); setDemoError(null)
    const r = await fetch('/api/auth/demo/start', { method: 'POST' })
      .then(r => r.json()).catch(() => ({ ok: false }))
    setDemoBusy(false)
    // Only enter the studio once the demo allotment actually exists. If we
    // advanced on failure, the user would be promised a free demo and instead
    // hit the connect-Claude wall on their first message — a bait-and-switch.
    if (r?.ok) {
      onDone()
    } else {
      setDemoError("Couldn't start the demo just now. Try again, or connect your Claude above to get going.")
    }
  }

  // Ask the idea engine for 3 first-project ideas. On any non-LLM result
  // (disabled/limited/timeout/empty) we route to the honest question flow rather
  // than show canned cards — no fake "magic".
  async function submitWant() {
    const want = wantText.trim()
    if (!want || ideaBusy) return
    setIdeaBusy(true)
    const r = await fetch('/api/onboarding/ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ want }),
    }).then(r => r.json()).catch(() => ({ ok: false, ideas: null }))
    setIdeaBusy(false)
    if (r?.ideas && Array.isArray(r.ideas) && r.ideas.length) {
      setIdeaList(r.ideas)
      setStep('ideas')
    } else {
      setStep('ai')
    }
  }

  // Carry the chosen idea into the real workspace. /seed self-completes
  // onboarding (sets funnel_seeded_at), so this path must NOT also fire the
  // template POST at the 'setup' step — we jump straight to 'claude'.
  async function pickIdea(idea: Idea) {
    if (seedBusy) return
    if (demo) {
      // No real workspace to seed — fake the result from the chosen idea so the
      // reveal lands, then end on a "run it again" loop. Nothing is persisted.
      const crew = idea.crew.map(c => CREW_CAST[c]?.name ?? c)
      const channel = idea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 22) || 'your-project'
      setSeeded({ crew, channel })
      setStep('done')
      return
    }
    setSeedBusy(true); setSeedError(null)
    const r = await fetch('/api/onboarding/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea, want: wantText.trim() || undefined }),
    }).then(r => r.json()).catch(() => ({ ok: false }))
    setSeedBusy(false)
    if (r?.ok) {
      setSeeded({
        crew: (r.crew?.length ? r.crew : idea.crew.map(c => CREW_CAST[c]?.name ?? c)) as string[],
        channel: r.channel ?? '',
      })
      setStep('claude')
    } else {
      setSeedError("Couldn't set that up just now. Pick another, or try again.")
    }
  }

  async function connectClaude() {
    const t = claudeToken.trim()
    if (!t || claudeBusy) return
    setClaudeBusy(true); setClaudeError(null)
    const r = await fetch('/api/auth/me/anthropic-token', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'network error' }))
    setClaudeBusy(false)
    if (r.ok) {
      setClaudeConnected(true)
      setClaudeToken('')
      // Brief beat to let the user see the success state, then auto-advance.
      setTimeout(() => setStep('done'), 1200)
    } else {
      setClaudeError(r.error ?? 'Could not save token. Check it and try again.')
    }
  }

  function skipAll() {
    skippedRef.current = true
    setStep('setup')
  }
  function goSetupFromQuestions() {
    // Free owners pick the role for their single agent; entitled owners name
    // their derived crew (or go straight to setup if none was derived).
    if (isFree) { setStep('role'); return }
    setStep(starterTemplates.length > 0 ? 'name' : 'setup')
  }

  const railVisible = QUESTION_STEPS.includes(step)
  const railIndex = QUESTION_STEPS.indexOf(step)

  // ---- Workbench panel (right side of question scenes) ----
  const workbench = (
    <aside className="ob-workbench">
      <div className="ob-wb-header">
        <span className="title">Your studio</span>
        <span className="pulse-line"><span className="dot" />assembling…</span>
      </div>
      <div className="ob-wb-body">
        <div>
          <div className="ob-wb-label">Channels <span className="count">{studio.channels.length}</span></div>
          <div className="ob-wb-list">
            {(studio.channels.length ? studio.channels : [null, null]).map((c, i) =>
              c ? (
                <div key={c.name} className="ob-wb-item in">
                  <span className="hash">#</span>
                  <span className="iname">{c.name}</span>
                  <span className="tag">{c.tag}</span>
                </div>
              ) : (
                <div key={`pc${i}`} className="ob-wb-item pending"><span className="hash">#</span><span className="iname">…</span></div>
              ),
            )}
          </div>
        </div>
        <div>
          <div className="ob-wb-label">{isFree ? 'Your agent' : 'Starter agents'} <span className="count">{isFree ? 1 : studio.agents.length}</span></div>
          <div className="ob-wb-list">
            {(previewAgents.length ? previewAgents : [null, null]).map((a, i) =>
              a ? (
                <div key={a.template} className="ob-wb-item in agent">
                  <span className="av"><img src={templateMeta(a.template)?.avatar_path} alt="" /></span>
                  <span className="iname">{templateMeta(a.template)?.name ?? a.template}</span>
                  <span className="tag">{a.tag}</span>
                </div>
              ) : (
                <div key={`pa${i}`} className="ob-wb-item pending agent"><span className="hash">⌗</span><span className="iname">…</span></div>
              ),
            )}
          </div>
        </div>
        {(answers.traits?.length ?? 0) > 0 && (
          <div>
            <div className="ob-wb-label">Personality</div>
            <div className="ob-wb-persona">
              <span className="ob-wb-chip">{persona.tone} tone</span>
              <span className="ob-wb-chip">{persona.detail} replies</span>
              {persona.tags.slice(0, 3).map(t => <span key={t} className="ob-wb-chip">{t}</span>)}
            </div>
          </div>
        )}
        <div className="ob-wb-note">
          <div className="label">Note</div>
          {isFree
            ? `Nothing's saved until you finish. Your free agent is the real thing — custom soul, skills, memory. Pick its role next. Add a whole crew anytime with Standard.`
            : `Nothing's saved until you finish. Starter agents come pre-named after their role — you'll name them next, and can change everything later.`}
        </div>
      </div>
    </aside>
  )

  function questionScene(opts: {
    num: string
    railName: string
    title: string
    subtitle?: string
    body: React.ReactNode
    backStep: Step
    canNext: boolean
    onNext: () => void
    nextLabel?: string
  }) {
    return (
      <div className="ob-scene ob-question">
        <div className="ob-paper">
          <div className="ob-stepnum"><span>{opts.num}</span><span className="of">/ 03 · {opts.railName}</span></div>
          <h2 className="ob-question-h">{opts.title}</h2>
          {opts.subtitle && <p className="ob-subtitle">{opts.subtitle}</p>}
          {opts.body}
          <div className="ob-footer">
            <div className="left">
              <button className="ob-btn-quiet" onClick={() => setStep(opts.backStep)}>← Back</button>
              <button className="ob-btn-quiet" onClick={skipAll}>Skip remaining</button>
            </div>
            <button className="ob-btn-primary" disabled={!opts.canNext} onClick={opts.onNext}>
              <span className="glyph">▶</span> {opts.nextLabel ?? 'Next'}
            </button>
          </div>
        </div>
        {workbench}
      </div>
    )
  }

  // Multi-select "fridge magnet" cloud, shared by the interests + style steps.
  const chipCloud = (
    options: { value: string; label: string }[],
    selected: string[] = [],
    toggle: (v: string) => void,
  ) => (
    <div className="ob-chips ob-chips-cloud">
      {options.map(o => {
        const on = selected.includes(o.value)
        return (
          <button key={o.value} className={`ob-chip ${on ? 'selected' : ''}`} onClick={() => toggle(o.value)}>
            <span className="glyph">{on ? '✓' : '+'}</span>{o.label}
          </button>
        )
      })}
    </div>
  )

  const optionRow = <V extends string>(
    options: { value: V; label: string }[],
    current: V | undefined,
    onPick: (v: V) => void,
  ) => (
    <div className="ob-opts">
      {options.map((o, i) => (
        <button
          key={o.value}
          className={`ob-opt ${current === o.value ? 'selected' : ''}`}
          onClick={() => onPick(o.value)}
        >
          <span className="radio" />
          {o.label}
          <span className="key">{i + 1}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="ob-root">
      {demo && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 60, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.04em', color: 'var(--color-text-dim)', background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '6px 12px' }}>
          Onboarding demo — a replayable walkthrough. Nothing is saved; refresh anytime to start over.
        </div>
      )}
      <div className="ob-brand">brig<span className="accent">a</span>ta<span className="meta">studio · onboarding</span></div>

      {railVisible && (
        <div className="ob-step-rail">
          {QUESTION_STEPS.map((s, i) => (
            <span key={s} style={{ display: 'contents' }}>
              {i > 0 && <span className="sep">·</span>}
              <span className={`pill ${i === railIndex ? 'active' : i < railIndex ? 'done' : ''}`}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <span className="pname">{RAIL_LABEL[s]}</span>
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="ob-stage">
        {step === 'intro' && (
          <div className="ob-scene ob-intro">
            <div className="ob-meta-line">
              <span>your studio · ready in 30s</span>
              <span className="dot" />
              <span>3 questions · all optional</span>
            </div>
            <h1 className="ob-hero-title">Welcome to Brigata <span className="accent">Studio</span>.</h1>
            <p className="ob-lede">
              Brigata is a shared workspace where you and a small team of AI helpers work side by side.
              Answer a few quick questions — no jargon — and we'll set the room up so it fits you from
              the very first message.
            </p>
            <div className="ob-btn-row">
              <button className="ob-btn-quiet" onClick={skipAll}>I'll explore myself</button>
              {/* Demo (obdemo) leads with the questionnaire so onboarding tests are
                  repeatable/deterministic; the real flow keeps the conversation path.
                  In the demo, the questionnaire's first step links back to 'describe it'. */}
              {demo && <button className="ob-btn-quiet" onClick={() => setStep('idea')}>I already have an idea I'd like help with</button>}
              <button className="ob-btn-primary" onClick={() => setStep(demo ? 'ai' : 'idea')}><span className="glyph">▶</span> Continue</button>
            </div>
          </div>
        )}

        {step === 'idea' && (
          <div className="ob-scene ob-question">
            <div className="ob-paper">
              <div className="ob-stepnum"><span>★</span><span className="of">your first project</span></div>
              <h2 className="ob-question-h">What's something you'd love a hand with?</h2>
              <p className="ob-subtitle">A few words is plenty. We'll turn it into a few concrete first projects — and the crew to tackle each.</p>
              <textarea
                className="ob-idea-input"
                value={wantText}
                maxLength={240}
                rows={3}
                autoFocus
                placeholder="e.g. keep my freelance invoices and expenses from becoming a mess"
                onChange={e => setWantText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submitWant() } }}
              />
              <div className="ob-footer">
                <div className="left">
                  <button className="ob-btn-quiet" onClick={() => setStep('intro')}>← Back</button>
                  <button className="ob-btn-quiet" onClick={() => setStep('ai')}>I'd rather answer a few questions</button>
                </div>
                <button className="ob-btn-primary" disabled={!wantText.trim() || ideaBusy} onClick={() => void submitWant()}>
                  <span className="glyph">▶</span> {ideaBusy ? 'Thinking…' : 'Show me ideas'}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'ideas' && (
          <div className="ob-scene ob-question">
            <div className="ob-paper">
              <div className="ob-stepnum"><span>★</span><span className="of">pick a starting point</span></div>
              <h2 className="ob-question-h">Here's where we could start.</h2>
              <p className="ob-subtitle">Pick the one that feels right. Your crew assembles around it — you can change anything later.</p>
              <div className="ob-ideas-grid">
                {(ideaList ?? []).map((idea, i) => (
                  <button key={i} className="ob-idea-card" disabled={seedBusy} onClick={() => void pickIdea(idea)}>
                    <span className="ob-idea-icon">{IDEA_ICONS[idea.icon] ?? '🗓'}</span>
                    <span className="ob-idea-title">{idea.title}</span>
                    <span className="ob-idea-tease">{idea.tease}</span>
                    <span className="ob-idea-crew">
                      {idea.crew.map(c => (
                        <span key={c} className="ob-idea-crew-chip" title={CREW_CAST[c]?.blurb}>
                          <span className="av">{CREW_CAST[c]?.avatar ?? '•'}</span>{CREW_CAST[c]?.name ?? c}
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
              {seedError && <div className="ob-claude-error">{seedError}</div>}
              <div className="ob-footer">
                <div className="left">
                  <button className="ob-btn-quiet" onClick={() => setStep('idea')}>← Try different words</button>
                </div>
                {seedBusy && <span className="ob-subtitle" style={{ margin: 0 }}>Setting up your studio…</span>}
              </div>
            </div>
          </div>
        )}

        {step === 'ai' && questionScene({
          num: '01', railName: 'you',
          title: 'How familiar are you with AI tools today?',
          body: optionRow(AI_OPTIONS, answers.ai_familiarity, v => setAnswers(a => ({ ...a, ai_familiarity: v }))),
          backStep: 'intro',
          canNext: !!answers.ai_familiarity,
          onNext: () => setStep('intent'),
        })}

        {step === 'intent' && questionScene({
          num: '02', railName: 'interests',
          title: 'Do any of these appeal to you?',
          subtitle: 'Tap anything that sparks — pick as many as you like. Each one becomes a channel and a teammate in your studio. There are no wrong answers.',
          body: chipCloud(
            INTEREST_OPTIONS,
            answers.interests,
            v => setAnswers(a => {
              const s = new Set(a.interests ?? [])
              if (s.has(v)) s.delete(v); else s.add(v)
              return { ...a, interests: Array.from(s) }
            }),
          ),
          backStep: 'ai',
          canNext: true,
          onNext: () => setStep('comfort'),
        })}

        {step === 'comfort' && questionScene({
          num: '03', railName: 'style',
          title: 'Pick the ones that sound like you.',
          subtitle: 'These shape how your agents talk — how short, how formal, how much they check in before acting.',
          body: chipCloud(
            TRAIT_OPTIONS,
            answers.traits,
            v => setAnswers(a => {
              const s = new Set(a.traits ?? [])
              if (s.has(v)) s.delete(v); else s.add(v)
              return { ...a, traits: Array.from(s) }
            }),
          ),
          backStep: 'intent',
          canNext: true,
          onNext: goSetupFromQuestions,
          nextLabel: 'Set up my studio',
        })}

        {step === 'name' && (
          <div className="ob-scene ob-question">
            <div className="ob-paper">
              <div className="ob-stepnum"><span>★</span><span className="of">name your agents</span></div>
              <h2 className="ob-question-h">Name your starter agents.</h2>
              <p className="ob-subtitle">They come pre-named after their role. Keep these or make them your own.</p>
              <div className="ob-name-grid">
                {starterTemplates.map(id => {
                  const meta = templateMeta(id)
                  return (
                    <div key={id} className="ob-name-row">
                      <span className="av"><img src={meta?.avatar_path} alt="" /></span>
                      <div className="flex-1 min-w-0">
                        <div className="role">{meta?.name ?? id}</div>
                        <input
                          className="ob-name-input"
                          value={agentNames[id] ?? meta?.name ?? ''}
                          onChange={e => setAgentNames(n => ({ ...n, [id]: e.target.value }))}
                          placeholder={meta?.name ?? id}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="ob-footer">
                <div className="left">
                  <button className="ob-btn-quiet" onClick={() => setStep('comfort')}>← Back</button>
                </div>
                <button className="ob-btn-primary" onClick={() => setStep('setup')}>
                  <span className="glyph">▶</span> Set up my studio
                </button>
              </div>
            </div>
            {workbench}
          </div>
        )}

        {step === 'role' && (
          <div className="ob-scene ob-question">
            <div className="ob-paper">
              <div className="ob-stepnum"><span>★</span><span className="of">pick your agent</span></div>
              <h2 className="ob-question-h">Choose your agent's role.</h2>
              <p className="ob-subtitle">Your free agent is the real thing — custom soul, skills, memory. Pick the role that fits; you can switch it anytime, and add a whole crew with Standard.</p>
              <div className="ob-role-grid">
                {AGENT_TEMPLATES.map(t => (
                  <button
                    key={t.id}
                    className={`ob-role-card ${roleForFree === t.id ? 'selected' : ''}`}
                    onClick={() => setChosenRole(t.id)}
                  >
                    <span className="av"><img src={t.avatar_path} alt="" /></span>
                    <span className="role-name">{t.name}</span>
                    <span className="role-blurb">{t.blurb}</span>
                  </button>
                ))}
              </div>
              <div className="ob-name-row mt-4">
                <span className="av"><img src={templateMeta(roleForFree)?.avatar_path} alt="" /></span>
                <div className="flex-1 min-w-0">
                  <div className="role">Name your {templateMeta(roleForFree)?.name ?? 'agent'}</div>
                  <input
                    className="ob-name-input"
                    value={agentNames[roleForFree] ?? templateMeta(roleForFree)?.name ?? ''}
                    onChange={e => setAgentNames(n => ({ ...n, [roleForFree]: e.target.value }))}
                    placeholder={templateMeta(roleForFree)?.name ?? 'Agent'}
                  />
                </div>
              </div>
              <div className="ob-footer">
                <div className="left">
                  <button className="ob-btn-quiet" onClick={() => setStep('comfort')}>← Back</button>
                </div>
                <button className="ob-btn-primary" onClick={() => setStep('setup')}>
                  <span className="glyph">▶</span> Set up my studio
                </button>
              </div>
            </div>
            {workbench}
          </div>
        )}

        {step === 'setup' && (
          <div className="ob-scene ob-setup">
            <h2 className="ob-setup-title">Setting up your studio…</h2>
            <div className="ob-setup-log">
              {SETUP_STEPS.map((label, i) => {
                const state = i < setupDone ? 'ok' : i === setupDone ? 'run' : 'wait'
                return (
                  <div key={label} className={`ob-log-line ${state}`}>
                    <span className="glyph">{state === 'ok' ? '✓' : state === 'run' ? <span className="ob-spinner" /> : '○'}</span>
                    <span>{label}{state === 'run' ? '…' : ''}</span>
                  </div>
                )
              })}
            </div>
            <div className="ob-setup-footer">your studio · <span className="accent">live</span> in a moment</div>
          </div>
        )}

        {step === 'assemble' && (
          <div className="ob-scene ob-assemble">
            <div className="ob-assemble-eyebrow"><span className="dot" /> your brigade is here</div>
            <h2 className="ob-assemble-title">Say hello to your <span className="accent">studio</span>.</h2>
            <div className="ob-crew">
              {crewList.map((c, i) => (
                <div key={c.id} className={`ob-crew-member ${i < assembled ? 'in' : ''}`}>
                  <span className="av">
                    <img src={c.avatar} alt="" />
                    <span className="pres" aria-hidden="true" />
                  </span>
                  <div className="who">
                    <span className="name">{c.name}</span>
                    <span className="hello">{c.hello}</span>
                  </div>
                  <span className="status" aria-hidden="true">online</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 'claude' && (
          <div className="ob-scene ob-claude">
            <div className="ob-claude-pulse"><span className="dot" /><span>one last thing</span></div>
            <h2 className="ob-claude-title">Bring your <span className="accent">Claude</span> account.</h2>
            <p className="ob-claude-lede">
              Your agents think with your own Claude account. Costs stay with you. Conversations stay private.
            </p>

            {claudeConnected ? (
              <div className="ob-claude-success">
                <span className="check">✓</span>
                <span>Connected — your agents are ready. Taking you in…</span>
              </div>
            ) : (
              <>
                <div className="ob-claude-card">
                  <div className="ob-claude-card-head">
                    <span className="label">Use your Claude subscription</span>
                    <span className="rec">recommended</span>
                  </div>
                  <p className="ob-claude-card-desc">
                    Runs on your Claude Pro or Max plan, no extra charges.
                  </p>
                  <ol className="ob-claude-steps">
                    <li>Install the Claude CLI (one time):
                      <code className="ob-claude-cmd">npm install -g @anthropic-ai/claude-code</code>
                    </li>
                    <li>Generate a token:
                      <code className="ob-claude-cmd">claude setup-token</code>
                    </li>
                    <li>Paste the <code>sk-ant-oat…</code> token below.</li>
                  </ol>
                  <div className="ob-claude-input-row">
                    <input
                      type="password"
                      value={claudeToken}
                      onChange={e => setClaudeToken(e.target.value)}
                      placeholder={claudeShowApi ? 'sk-ant-oat01-… or sk-ant-api03-…' : 'sk-ant-oat01-…'}
                      className="ob-claude-input"
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void connectClaude() } }}
                    />
                    <button
                      type="button"
                      onClick={() => void connectClaude()}
                      disabled={claudeBusy || !claudeToken.trim()}
                      className="ob-btn-primary"
                    >
                      <span className="glyph">▶</span> {claudeBusy ? 'Verifying…' : 'Connect'}
                    </button>
                  </div>
                  {claudeError && (
                    <div className="ob-claude-error">{claudeError}</div>
                  )}
                </div>

                <button
                  type="button"
                  className="ob-claude-disclosure"
                  onClick={() => setClaudeShowApi(s => !s)}
                >
                  <span className="chev">{claudeShowApi ? '▾' : '▸'}</span>
                  Have an Anthropic API key instead?
                </button>
                {claudeShowApi && (
                  <div className="ob-claude-card api">
                    <p className="ob-claude-card-desc">
                      Bills against your Anthropic console credit. Create one at{' '}
                      <code>console.anthropic.com</code>; format is <code>sk-ant-api03-…</code>.
                      Paste it in the same field above and click Connect.
                    </p>
                  </div>
                )}

                {demoEnabled && (
                  <div className="ob-claude-demo">
                    <span className="ob-claude-demo-or">new to all this?</span>
                    <button
                      type="button"
                      className="ob-btn-quiet ob-claude-demo-btn"
                      onClick={() => void startDemoFlow()}
                      disabled={demoBusy}
                    >
                      {demoBusy ? 'Setting up…' : 'Try a quick demo first — no setup'}
                    </button>
                    <p className="ob-claude-demo-note">
                      Watch an agent build a doc and search the web, on us. Connect your Claude
                      anytime to keep going.
                    </p>
                    {demoError && <div className="ob-claude-error">{demoError}</div>}
                  </div>
                )}
              </>
            )}

            <div className="ob-claude-footer">
              <button
                type="button"
                className="ob-btn-quiet"
                onClick={() => setStep('done')}
              >
                Skip for now
              </button>
              <button
                type="button"
                className="ob-btn-primary"
                onClick={() => setStep('done')}
                disabled={!claudeConnected}
              >
                <span className="glyph">▶</span> Continue
              </button>
            </div>

            {!claudeConnected && (
              <p className="ob-claude-skip-note">
                If you skip, your agents won't be able to respond until you connect a token from Settings → Connect Claude.
              </p>
            )}
          </div>
        )}

        {step === 'done' && (
          <div className="ob-scene ob-done">
            <h2 className="ob-greeting">You're in{firstName ? <>, <span className="accent">{firstName}.</span></> : <span className="accent">.</span>}</h2>
            <p className="summary">
              {seeded
                ? `Your studio's ready. ${seeded.crew.join(', ')} ${seeded.crew.length === 1 ? 'is' : 'are'} set up${seeded.channel ? ` in #${seeded.channel}` : ''}, with your plan pinned and a first message waiting.`
                : isFree
                  ? `Your studio's ready. Your free agent is the real thing — custom soul, skills, memory — and yours from the first message. Switch its role anytime, or add a crew with Standard.`
                  : `Your studio's ready. We've set up your channels and starter agents based on your answers — renamed and yours from the first message.`}
            </p>
            <div className="ob-receipt">
              {seeded ? (
                <>
                  <span><strong>{seeded.crew.length || 1}</strong> {(seeded.crew.length || 1) === 1 ? 'agent' : 'agents'}</span>
                  <span>·</span>
                  <span><strong>{seeded.channel ? `#${seeded.channel}` : 'project'}</strong></span>
                  <span>·</span>
                  <span><strong>plan</strong> pinned</span>
                </>
              ) : (
                <>
                  <span><strong>{studio.channels.length || 1}</strong> channels</span>
                  <span>·</span>
                  <span><strong>{isFree ? 1 : (starterTemplates.length || 1)}</strong> {(isFree ? 1 : (starterTemplates.length || 1)) === 1 ? 'agent' : 'agents'}</span>
                  <span>·</span>
                  <span><strong>{persona.tone}</strong> tone</span>
                </>
              )}
            </div>
            <button className="ob-btn-primary" onClick={onDone}><span className="glyph">{demo ? '↻' : '▶'}</span> {demo ? 'Run it again' : 'Open Studio'}</button>
          </div>
        )}
      </div>
    </div>
  )
}
