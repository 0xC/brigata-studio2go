// Server-side counterpart of app/src/lib/checkboxId.ts. Keep algorithm identical.
export function checkboxId(label: string): string {
  const normalized = label.replace(/\s+/g, ' ').trim().toLowerCase()
  let h = 5381
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0
  }
  return 'cb_' + (h >>> 0).toString(16)
}

// Markdown task list item pattern: leading "- [ ]" or "- [x]" with the rest as label.
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/

// Overlay state onto the markdown body so a reader (human or agent) sees the
// effective checkbox status without needing to look up `state` separately.
export function resolveBody(bodyMd: string, state: Record<string, unknown>): string {
  return bodyMd
    .split('\n')
    .map((line) => {
      const m = line.match(TASK_RE)
      if (!m) return line
      const [, indent, , label] = m
      const id = checkboxId(label)
      const persisted = state[id]
      const checked =
        typeof persisted === 'boolean' ? persisted : /[xX]/.test(m[2])
      return `${indent}- [${checked ? 'x' : ' '}] ${label}`
    })
    .join('\n')
}

// Parse `- [x]` / `- [ ]` markers in a body into a state map.
// Used when an agent (or future direct API edit) submits a new body — we treat
// the markers as ground truth for state, overlaying onto any prior state.
export function extractStateFromBody(bodyMd: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const line of bodyMd.split('\n')) {
    const m = line.match(TASK_RE)
    if (!m) continue
    const label = m[3]
    const id = checkboxId(label)
    out[id] = /[xX]/.test(m[2])
  }
  return out
}
