// Studio-side LLM calls that draw from the operator's Claude subscription
// (via STUDIO_CLAUDE_OAUTH_TOKEN) instead of the platform's API key.
//
// Used for one-shot completions that aren't tied to a user's workspace:
// soul generation, future help/onboarding copy, etc. For per-user agent
// turns, the Pro-tier bridge handles its own OAuth wiring; Standard-tier
// agent responses still go through agents.ts and the regular API-key path.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_MODEL } from './models.js'

export interface StudioCompleteOptions {
  prompt: string
  model?: string
  systemPrompt?: string
}

export async function studioComplete(opts: StudioCompleteOptions): Promise<string> {
  const token = process.env.STUDIO_CLAUDE_OAUTH_TOKEN
  if (!token) throw new Error('STUDIO_CLAUDE_OAUTH_TOKEN not set')

  // Mirror the bridge's env-stripping: Claude Code prefers ANTHROPIC_API_KEY
  // over OAuth when both are present, so strip the API key to force OAuth.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: token,
  }
  delete sdkEnv.ANTHROPIC_API_KEY

  const q = query({
    prompt: opts.prompt,
    options: {
      model: opts.model ?? DEFAULT_MODEL,
      settingSources: [],
      env: sdkEnv as Record<string, string>,
      // Override the default Claude Code system prompt with our own minimal
      // one (or a passed-in one) so soul gen / one-shot completions don't
      // inherit "you are a coding agent" bias.
      systemPrompt: opts.systemPrompt ?? 'You are a one-shot text generator. Follow the user prompt exactly. No preamble, no extras.',
    },
  })

  let text = ''
  for await (const msg of q) {
    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        text = (msg as { result: string }).result
      } else {
        throw new Error(`studioComplete failed: ${msg.subtype}`)
      }
    }
  }
  if (!text) throw new Error('studioComplete returned no text')
  return text
}
