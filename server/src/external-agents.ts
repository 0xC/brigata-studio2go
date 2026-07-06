// STANDALONE BUILD STUB — swapped in for src/external-agents.ts by
// scripts/package-studio-to-go.sh. Self-host runs every agent in-process
// (Standard tier); there is no external / Pro-VPS bridge dispatch. Agents are
// always hosting='standard', so sendToExternalAgent is never reached at runtime.
// The type exports mirror the cloud module verbatim so agents.ts compiles
// unchanged. The real bridge-dispatch source is never shipped.

export interface OutboundAttachment {
  kind: 'image' | 'pdf' | 'text' | 'other'
  filename: string
  mime_type: string
  data?: string
}

export interface OutboundHistoryItem {
  sender_kind: 'user' | 'agent' | 'system'
  sender_name: string
  body: string
  created_at: string
  attachments?: OutboundAttachment[]
}

export async function sendToExternalAgent(
  _agent: unknown,
  _channelId: string,
  _ctx: unknown,
  _history: OutboundHistoryItem[],
  _triggerMessageId: string,
  _taskId?: string,
): Promise<void> {}

export async function isExternalAgentAlive(_agentId: string): Promise<boolean> {
  return false
}
