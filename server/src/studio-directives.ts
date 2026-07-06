// Platform-wide system-prompt directives sent to every agent on dispatch.
// Standard-tier agents get these spliced into their local prompt; Pro/external
// agents receive them in the IncomingPayload's `studio_directives` field and
// their bridge appends them to the system prompt.
//
// Lives in its own file so prompt-shape changes ship via a Studio deploy
// without needing a bridge code update across every Pro VPS.

export function buildStudioDirectives(
  ownerTimezone: string | null | undefined,
  requesterRole?: 'owner' | 'admin' | 'member' | null,
): string {
  const tz = ownerTimezone || 'UTC'
  let nowLocal: string
  try {
    nowLocal = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(new Date())
  } catch {
    nowLocal = new Date().toISOString() + ' (UTC; user timezone unknown)'
  }
  const parts = [
    `Current local time (${tz}): ${nowLocal}.`,
    `Your model training data is at least several months stale relative to this date. For ANY topic that touches "current," "recent," "this week/month/year," or "latest" — use the web tools available to you (web_search / Tavily / Jina / web_fetch) to find sources from the last ~30 days BEFORE writing. Add explicit date qualifiers to search queries (e.g. "X May 2026" or "X last 7 days"). When you cite a source, note its publication date. If you can't find recent sources, say so explicitly rather than fall back to training data.`,
    `When answering time-related questions, default to the timezone above. Only mention UTC if the user explicitly asks for it.`,
  ]
  // Role-aware action gating. The workspace owner pays for the compute and
  // the VPS; they get full authority. Members are guests — they can converse,
  // read, and trigger lightweight research, but the agent must NOT execute
  // destructive or costly actions on their behalf. This is prompt-level
  // enforcement (a tool-ACL system in the bridge is the proper long-term
  // fix); for now it stops innocent mistakes.
  if (requesterRole === 'member') {
    parts.push(
      `**Requester is a workspace MEMBER, not the owner.** You must NOT perform any of the following on their behalf:\n\n` +
      `- Shell/system actions (\`bash_exec\`, file writes/edits/deletes outside Brigata documents, package installs, service restarts, server reboots, network changes, firewall changes).\n` +
      `- External-service mutations (sending emails, posting to APIs, making payments, creating bookings, modifying calendars or contacts, posting to social media).\n` +
      `- Costly background work (\`schedule_wakeup\` for recurring tasks, long-running research, large web-fetch loops, anything that creates ongoing compute).\n` +
      `- Account/credential actions (rotating tokens, changing settings, granting access).\n\n` +
      `What you CAN do for a member: answer questions, read workspace documents, do focused web research with citations, summarize, brainstorm, write drafts they can copy/use elsewhere. If they ask for something on the restricted list, decline politely and explain "this needs the workspace owner — please ask them, or have them grant you the access." Do not work around this by hiding what you're doing; be transparent about why you're declining.`,
    )
  }
  return parts.join('\n\n')
}
