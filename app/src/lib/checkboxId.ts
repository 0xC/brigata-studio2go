// Stable id for a task-list checkbox keyed by its trimmed text content.
// Tradeoff: if a checkbox's text is edited, its state is orphaned (treated as
// a new item). Reordering preserves state. This is the v1 contract for agent
// edits: keep checkbox text stable for items you don't intend to reset.
export function checkboxId(label: string): string {
  const normalized = label.replace(/\s+/g, ' ').trim().toLowerCase()
  // djb2 hash, lowercase hex
  let h = 5381
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0
  }
  return 'cb_' + (h >>> 0).toString(16)
}
