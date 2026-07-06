// Single source of truth for the Claude models an agent may run. The frontend
// pickers fetch this via GET /api/models, agent create/update validates against
// it, and every "default model" fallback in the codebase points at DEFAULT_MODEL
// so there is exactly one place to change when models come and go.
//
// Policy (see memory "model-update-strategy"): new models are ENABLE-ONLY. Adding
// a model here makes it selectable but never silently changes existing agents'
// defaults — DEFAULT_MODEL stays put unless we deliberately move it.

export interface ModelInfo {
  id: string
  label: string
  // Shown as the suggested pick in the UI; exactly one entry should set this.
  recommended?: boolean
}

// Order matters: the UI renders the picker in this order (newest/most capable
// first), but the *default* selection is DEFAULT_MODEL, not the first entry.
export const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (most capable)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (very capable, slower)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced, recommended)', recommended: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast, lightweight)' },
]

// The default an agent runs when nothing else is specified. Changing this changes
// the default for newly-created agents only; existing agents keep their stored model.
export const DEFAULT_MODEL = 'claude-sonnet-4-6'

const KNOWN = new Set(MODELS.map(m => m.id))

export function isKnownModel(id: unknown): id is string {
  return typeof id === 'string' && KNOWN.has(id)
}
