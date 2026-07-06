// Rule-of-two safety model for an agent (Chris, 2026-07-01).
//
// The "rule of two": an agent should have at most TWO of these three risk axes.
// Having all three is the danger zone (the agentic "lethal trifecta" applied to
// autonomy):
//   1. Untrusted input   — reads external/untrusted content (inbound email, web,
//                          external-facing channels) → an injection surface.
//   2. Consequential      — can spend money, send/act in external systems, or
//                          reach sensitive data/credentials → real-world effect.
//   3. Autonomy           — acts on consequential things WITHOUT a human approving
//                          first (i.e. no human in the loop).
//
// These capabilities are SELF-DECLARED: the subscriber wires most of them up
// themselves (a payment key, an inbound-email handler on a Pro box), so we can't
// auto-detect them reliably. Declaring is the point — it forces the "wait, this
// reads email AND spends money AND runs unattended" realization.

// Exactly one boolean per rule-of-two axis. Three toggles, three axes, each worth
// one — no coupling, so the count can never jump by more than one per click. The
// specific capabilities (spend, inbound email, sensitive data) live as examples in
// each axis's hint rather than as separate checkboxes that collapse/couple.
export interface SafetyProfile {
  untrusted_input?: boolean   // reads external/untrusted content
  consequential?: boolean     // can spend, send/act externally, or reach sensitive data
  autonomous?: boolean        // acts on consequential things without a human approving first
}

export type SafetyLevel = 'ok' | 'caution' | 'violation'

export interface SafetyStatus {
  level: SafetyLevel
  hotAxes: number            // how many of the 3 axes are "hot" (0..3)
  axes: {
    untrustedInput: boolean
    consequential: boolean
    autonomous: boolean
  }
  label: string
  detail: string
  remediation: string | null // the one concrete fix, or null when fine
}

export function computeSafety(p: SafetyProfile | null | undefined): SafetyStatus {
  const sp = p ?? {}
  // One toggle per axis — independent, each worth exactly one. Empty = 0/3.
  const untrustedInput = !!sp.untrusted_input
  const consequential = !!sp.consequential
  const autonomous = !!sp.autonomous
  const hotAxes = [untrustedInput, consequential, autonomous].filter(Boolean).length

  let level: SafetyLevel
  if (hotAxes >= 3) level = 'violation'
  else if (hotAxes === 2) level = 'caution'
  else level = 'ok'

  const label =
    level === 'violation' ? 'Rule-of-two violation'
    : level === 'caution' ? 'Caution'
    : 'Within the rule of two'

  const detail =
    level === 'violation'
      ? 'This agent reads untrusted input, can take consequential actions, and runs without a human in the loop — all three at once. A prompt-injection or mistake could cause real harm with nobody to catch it.'
    : level === 'caution'
      ? 'This agent is hot on two of the three risk axes. That is within the rule of two, but stay deliberate about the third.'
      : 'This agent has at most one risk axis active — comfortably within the rule of two.'

  // The cheapest way back under the line is almost always adding a human gate.
  const remediation: string | null =
    level === 'violation'
      ? 'Turn off "Runs without human approval" — put a person in the loop for consequential actions. That drops you to 2 of 3.'
      : null

  return {
    level,
    hotAxes,
    axes: { untrustedInput, consequential, autonomous },
    label,
    detail,
    remediation,
  }
}

// The declarable capabilities, for rendering the checklist. `axis` groups them so
// the UI can show which rule-of-two axis each one feeds.
export const SAFETY_ITEMS: Array<{
  key: keyof SafetyProfile
  label: string
  hint: string
  axis: 'untrusted' | 'consequential' | 'gate'
}> = [
  { key: 'untrusted_input', label: 'Reads untrusted input', hint: 'Inbound email, web pages, or messages from people outside your team — anything that could carry a prompt injection.', axis: 'untrusted' },
  { key: 'consequential', label: 'Can take consequential actions', hint: 'Spend money, send email/messages, change external systems, or reach sensitive data/credentials.', axis: 'consequential' },
  { key: 'autonomous', label: 'Runs without human approval', hint: 'Acts on the above with no person confirming first. Leaving this off — a human approves consequential actions — is the safety valve.', axis: 'gate' },
]
