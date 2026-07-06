// Pure, dependency-free guards for Standard-tier agent tool calls.
//
// Standard agents share one OS/process, so the ONLY thing keeping tenant A's
// agent out of tenant B's data is that every tool query is scoped by a valid
// workspace_id. These helpers make that invariant explicit and fail-closed, and
// are kept free of DB/runtime imports so they can be unit-tested in isolation.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

// Fail closed: a turn that reaches a tool without a valid workspace UUID is a
// bug or a forged context — refuse rather than run a query that isn't bound to a
// tenant.
export function assertWorkspaceScope(workspaceId: unknown): void {
  if (!isUuid(workspaceId)) {
    throw new Error('tool call rejected: missing or invalid workspace scope')
  }
}

// Tools that take a document_id must receive a well-formed UUID. Without this a
// malformed/empty id reaches the parameterized query and silently matches
// nothing ("not found"), masking real misuse.
export const DOC_ID_TOOLS = new Set([
  'read_document',
  'focus_document',
  'edit_document',
  'append_to_document',
  'delete_document',
])
