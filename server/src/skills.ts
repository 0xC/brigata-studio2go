// Curated skills catalog (code-defined, vetted by us) + the resolver that turns a
// per-agent list of enabled skill ids into the extra allowedTools and system-prompt
// sections to inject at dispatch.
//
// Design: BASE_TOOLS is exactly today's hardcoded Standard tool set. Skills are
// purely ADDITIVE — an agent with no skills enabled gets BASE_TOOLS and nothing
// else, i.e. identical behavior to before this system existed. Some catalog
// entries map to tools already in BASE (Web Research, Documents & PDF); enabling
// those adds explanatory prompt guidance but no new capability. Others map to
// tools not yet wired into the product dispatch path — these carry available:false
// so the UI can show the roadmap without us pretending they work yet.

export type SkillTier = 'standard' | 'pro'

export interface SkillDef {
  id: string
  label: string
  /** One-line "what it does" for the catalog card. */
  description: string
  /** Honest capability/permission line — "what it can access". */
  access: string
  tier: SkillTier
  /** Tier-2 skills that require an OAuth/connect-account step before they work. */
  needsConnection: boolean
  /** Whether the backing tools are actually wired into the product dispatch path yet. */
  available: boolean
  /** allowedTools entries this skill contributes (deduped against BASE at resolve time). */
  tools: string[]
  /** System-prompt section appended when this skill is enabled. */
  prompt: string
}

// Exactly today's hardcoded Standard SDK tool set. Source of truth for the base
// dispatch allowlist; agents.ts imports this instead of inlining the list.
export const BASE_TOOLS: readonly string[] = [
  'mcp__brigata__list_documents',
  'mcp__brigata__read_document',
  'mcp__brigata__focus_document',
  'mcp__brigata__create_document',
  'mcp__brigata__edit_document',
  'mcp__brigata__append_to_document',
  'mcp__brigata__delete_document',
  'mcp__brigata__hand_off_task',
  'WebSearch',
  'WebFetch',
]

// Catalog v1 (accepted 2026-06-05). Tier 1 = no external accounts; Tier 2 = needs
// the connect-account/OAuth framework (fast-follow, not in this foundation).
export const SKILL_CATALOG: readonly SkillDef[] = [
  {
    id: 'scheduling-followups',
    label: 'Scheduling & Follow-ups',
    description: 'Have your agent check back later, remind you, or chase a task instead of going silent.',
    access: 'Schedules timed jobs that wake your agent to post a follow-up in this workspace.',
    tier: 'standard',
    needsConnection: false,
    available: false, // backing scheduler tool not yet wired into the product path
    tools: [],
    prompt:
      '## Scheduling & Follow-ups\nWhen you promise to do, check, or report something later, schedule a real follow-up before ending your turn rather than relying on a new message to arrive. Never silently drop a promised task.',
  },
  {
    id: 'web-research',
    label: 'Web Research',
    description: 'Look up current information on the web and read specific pages, with sources cited.',
    access: 'Reads public web pages and search results. No account or private data access.',
    tier: 'standard',
    needsConnection: false,
    available: true, // WebSearch/WebFetch are already in BASE
    tools: ['WebSearch', 'WebFetch'],
    prompt:
      '## Web Research\nUse web search to find current information you don\'t have, and web fetch to read specific pages. Always cite the source when you use information from the web.',
  },
  {
    id: 'documents-pdf',
    label: 'Documents & PDF',
    description: 'Read and summarize long documents and PDFs already in your workspace.',
    access: 'Reads and writes documents in this workspace. No access outside the workspace.',
    tier: 'standard',
    needsConnection: false,
    available: true, // document tools are already in BASE
    tools: [
      'mcp__brigata__list_documents',
      'mcp__brigata__read_document',
      'mcp__brigata__focus_document',
    ],
    prompt:
      '## Documents & PDF\nUse the document tools to read, summarize, and organize long documents and PDFs in the workspace. When summarizing, preserve key structure (headings, action items) and cite the document you drew from.',
  },
  {
    id: 'browser-automation',
    label: 'Browser Automation',
    description: 'Navigate websites and extract information — do a thing on a site for you.',
    access: 'Controls a browser to visit pages and extract content on your behalf.',
    tier: 'standard',
    needsConnection: false,
    available: false, // browser tool not yet wired into the product path
    tools: [],
    prompt:
      '## Browser Automation\nWhen a task needs navigating a website (logging in is out of scope), use browser automation to visit pages and extract the information requested. Describe what you did and what you found.',
  },
]

export function getSkill(id: string): SkillDef | undefined {
  return SKILL_CATALOG.find(s => s.id === id)
}

export interface ResolvedSkills {
  /** BASE_TOOLS plus any tools contributed by enabled, available skills (deduped). */
  tools: string[]
  /** System-prompt sections for enabled skills, in catalog order. */
  promptSections: string[]
}

// Turn a per-agent enabled-skills list (raw jsonb value) into the dispatch additions.
// Unknown ids and not-yet-available skills are ignored for tool purposes; an empty
// or absent list yields exactly BASE_TOOLS and no extra prompt — today's behavior.
export function resolveSkills(enabled: unknown): ResolvedSkills {
  const ids = new Set(normalizeEnabled(enabled))
  const tools = new Set<string>(BASE_TOOLS)
  const promptSections: string[] = []
  for (const skill of SKILL_CATALOG) {
    if (!ids.has(skill.id)) continue
    promptSections.push(skill.prompt)
    if (skill.available) for (const t of skill.tools) tools.add(t)
  }
  return { tools: [...tools], promptSections }
}

export function normalizeEnabled(enabled: unknown): string[] {
  if (!Array.isArray(enabled)) return []
  return enabled.filter((x): x is string => typeof x === 'string')
}

// Validate ids against the catalog for the update endpoint. Returns only known ids,
// deduped and in catalog order.
export function sanitizeEnabledIds(input: unknown): string[] {
  const wanted = new Set(normalizeEnabled(input))
  return SKILL_CATALOG.filter(s => wanted.has(s.id)).map(s => s.id)
}
