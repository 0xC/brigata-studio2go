import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { checkboxId } from './lib/checkboxId'
import { useResilientWs } from './lib/useWs'
import { useRailState, useIsDesktop, RailResizeHandle } from './lib/rail'
import { IconPencil, IconTrash, IconDownload, IconPrint, IconChannel, IconFolder, IconDocument } from './lib/icons'

// Replace #channel-name tokens in text with an inline constellation icon + name.
// Conservative match: word boundary on each side, alphanumeric + dash, 2+ chars.
function transformChannelMentions(node: React.ReactNode): React.ReactNode {
  if (typeof node === 'string') {
    const parts: React.ReactNode[] = []
    const re = /(^|[\s(])#([a-z0-9][a-z0-9-]{1,})\b/gi
    let last = 0
    let m: RegExpExecArray | null
    let key = 0
    while ((m = re.exec(node)) !== null) {
      if (m.index + m[1].length > last) parts.push(node.slice(last, m.index + m[1].length))
      parts.push(
        <span key={key++} className="inline-flex items-baseline gap-1">
          <IconChannel size={12} />
          <span>{m[2]}</span>
        </span>,
      )
      last = re.lastIndex
    }
    if (last === 0) return node
    if (last < node.length) parts.push(node.slice(last))
    return <>{parts}</>
  }
  if (Array.isArray(node)) return node.map((c, i) => <span key={i}>{transformChannelMentions(c)}</span>)
  return node
}

// Flatten React children to plain text (for heading slugs / anchors).
function nodeToText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeToText((node as { props?: { children?: React.ReactNode } }).props?.children)
  }
  return ''
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

// Self-contained task checkbox. Holds its own checked state so toggling
// re-renders only this item — the parent must NOT rebuild the markdown
// `components` map on toggle, or ReactMarkdown remounts the whole doc and
// the scroll position jumps to the top (very visible on mobile).
function TaskItem({
  label, initialChecked, onPersist,
}: {
  label: string
  initialChecked: boolean
  onPersist: (next: boolean) => void
}) {
  const [checked, setChecked] = useState(initialChecked)
  return (
    <li className="list-none flex items-start gap-2 -ml-6 my-1">
      <input
        type="checkbox"
        checked={checked}
        onChange={() => { const next = !checked; setChecked(next); onPersist(next) }}
        className="mt-1.5 accent-[var(--color-accent)]"
      />
      <span className={checked ? 'text-[var(--color-text-dim)] line-through' : ''}>
        {label}
      </span>
    </li>
  )
}

type Heading = { id: string; text: string; num: string }

// Strip a single leading "# title" (the paper renders the title separately),
// then collect the ## headings (skipping fenced code) for the TOC + anchors.
function prepareDoc(bodyMd: string): { body: string; headings: Heading[] } {
  const lines = bodyMd.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i < lines.length && /^#\s+/.test(lines[i])) lines.splice(i, 1)
  const body = lines.join('\n')

  const headings: Heading[] = []
  let inFence = false
  let n = 0
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      n++
      const text = m[1].trim()
      headings.push({ id: slugify(text), text, num: String(n).padStart(2, '0') })
    }
  }
  return { body, headings }
}

function fmtDocDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

type DocSummary = {
  id: string
  title: string
  folder: string | null
  channel_id: string | null
  pinned: boolean
  updated_at: string
}
type ChannelSummary = { id: string; name: string }
type DocFull = {
  id: string
  title: string
  body_md: string
  state: Record<string, unknown>
  folder: string | null
  channel_id: string | null
  pinned: boolean
  updated_at: string
}

// Scope sentinels for the channel filter. A real channel id scopes to that
// channel; these two cover the non-channel cases.
const SCOPE_ALL = '__all__'
const SCOPE_WORKSPACE = '__ws__' // docs with no channel (channel_id IS NULL)

export function Documents({
  workspaceId,
  channels,
  activeChannelId,
  requestedScopeChannel,
  requestedScopeNonce,
  requestedDocId,
  requestedDocNonce,
}: {
  workspaceId: string
  channels: ChannelSummary[]
  activeChannelId: string | null
  requestedScopeChannel: string | null
  requestedScopeNonce: number
  requestedDocId?: string | null
  requestedDocNonce?: number
}) {
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [scope, setScope] = useState<string>(() => activeChannelId ?? SCOPE_ALL)
  const [activeId, setActiveId] = useState<string | null>(() => {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('bw_doc_active') : null
  })
  const [doc, setDoc] = useState<DocFull | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftBody, setDraftBody] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [railOpen, setRailOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [folderEditing, setFolderEditing] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const isDesktop = useIsDesktop()
  const rail = useRailState('bw_doc_rail')

  useEffect(() => {
    if (activeId) localStorage.setItem('bw_doc_active', activeId)
    else localStorage.removeItem('bw_doc_active')
  }, [activeId])

  const channelNames = channels.map(c => c.name)
  const channelNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of channels) m.set(c.id, c.name)
    return m
  }, [channels])

  async function refreshList() {
    const r = await fetch(`/api/workspaces/${workspaceId}/documents`).then(r => r.json())
    setDocs(r.documents ?? [])
  }

  // When a channel header asks to open its docs, jump the scope to it.
  useEffect(() => {
    if (requestedScopeNonce > 0) setScope(requestedScopeChannel ?? SCOPE_WORKSPACE)
  }, [requestedScopeNonce])

  // When an inline doc chip asks to open one specific doc, select it.
  useEffect(() => {
    if (requestedDocNonce && requestedDocId) setActiveId(requestedDocId)
  }, [requestedDocNonce])

  // Filter the loaded list to the current scope.
  const visibleDocs = useMemo(() => {
    if (scope === SCOPE_ALL) return docs
    if (scope === SCOPE_WORKSPACE) return docs.filter(d => !d.channel_id)
    return docs.filter(d => d.channel_id === scope)
  }, [docs, scope])

  // The channel a newly created doc should attach to, given the current scope.
  const scopeTargetChannel: string | null =
    scope === SCOPE_ALL ? activeChannelId : scope === SCOPE_WORKSPACE ? null : scope

  async function uploadFiles(files: FileList | File[]) {
    const arr = Array.from(files)
    if (!workspaceId) { setUploadStatus('Error: no workspace selected'); return }
    setUploadStatus(`Uploading ${arr.length} file${arr.length === 1 ? '' : 's'}…`)
    let okCount = 0
    const errors: string[] = []
    for (const file of arr) {
      try {
        const text = await file.text()
        const title = file.name.replace(/\.(md|markdown|txt)$/i, '').trim() || 'Untitled'
        const r = await fetch(`/api/workspaces/${workspaceId}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body_md: text, channel_id: scopeTargetChannel }),
        })
        if (r.ok) okCount++
        else {
          const body = await r.text().catch(() => '')
          errors.push(`${file.name}: HTTP ${r.status} ${body.slice(0, 100)}`)
        }
      } catch (e) {
        errors.push(`${file.name}: ${(e as Error).message}`)
      }
    }
    await refreshList()
    setUploadStatus(errors.length > 0 ? `Uploaded ${okCount} of ${arr.length}. ${errors[0]}` : `Uploaded ${okCount} of ${arr.length}`)
    setTimeout(() => setUploadStatus(null), 6000)
  }

  useEffect(() => { void refreshList() }, [workspaceId])

  useEffect(() => {
    if (!activeId) { setDoc(null); return }
    fetch(`/api/workspaces/${workspaceId}/documents/${activeId}`)
      .then(r => r.json())
      .then((r: { document: DocFull }) => {
        setDoc(r.document)
        setDraftBody(r.document.body_md)
        setDraftTitle(r.document.title)
      })
  }, [activeId, workspaceId])

  // Live-refresh on document_updated events. Use refs so the resilient WS
  // hook doesn't have to be torn down on every active-doc / editing change.
  const activeIdRef = useRef(activeId)
  const editingRef = useRef(editing)
  activeIdRef.current = activeId
  editingRef.current = editing
  useResilientWs('/ws', {
    onMessage: (payload) => {
      const p = payload as { type?: string; documentId?: string }
      if (p.type === 'document_updated') {
        if (p.documentId === activeIdRef.current && !editingRef.current) {
          fetch(`/api/workspaces/${workspaceId}/documents/${activeIdRef.current}`)
            .then(r => r.json())
            .then((r: { document: DocFull }) => setDoc(r.document))
        }
        void refreshList()
      } else if (p.type === 'document_deleted') {
        if (p.documentId === activeIdRef.current) {
          setActiveId(null)
          setDoc(null)
        }
        void refreshList()
      } else if (p.type === 'agent_document_focus') {
        // Agent just created or edited a doc — pull it into focus, unless the
        // user is mid-edit on something else (don't yank them out of typing).
        if (p.documentId && !editingRef.current && p.documentId !== activeIdRef.current) {
          setActiveId(p.documentId)
          setCreating(false)
          setRailOpen(false)
        }
      }
    },
  })

  function startCreate() {
    setCreating(true)
    setActiveId(null)
    setDoc(null)
    setRailOpen(false)
  }

  async function submitNewDoc(title: string, folder: string) {
    if (!title.trim()) return
    const r = await fetch(`/api/workspaces/${workspaceId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        body_md: '# ' + title.trim() + '\n\n',
        folder: folder.trim(),
        channel_id: scopeTargetChannel,
      }),
    }).then(r => r.json())
    await refreshList()
    setCreating(false)
    setActiveId(r.document.id)
    setEditing(true)
  }

  // Print the open document by rendering it into its OWN clean window, rather
  // than trying to isolate it inside the app's transformed panel layout (which
  // squeezed it into a sliver). The window gets the rendered HTML + print styles.
  function printDoc() {
    const el = document.querySelector('.doc-page')
    if (!el) { window.print(); return }
    const title = (doc?.title ?? 'Document').replace(/[<>&]/g, '')
    const w = window.open('', '_blank', 'width=820,height=1000')
    if (!w) { alert('Allow pop-ups to print this document.'); return }
    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>' +
      'html,body{background:#fff;color:#000;margin:0;}' +
      'main{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:46rem;margin:2.5rem auto;padding:0 1.25rem;}' +
      'h1{font-size:1.9rem;line-height:1.2;margin:1.4rem 0 .6rem;} h2{font-size:1.45rem;line-height:1.25;margin:1.4rem 0 .5rem;} h3{font-size:1.2rem;margin:1.1rem 0 .4rem;}' +
      'p{margin:.6rem 0;} ul,ol{margin:.6rem 0 .6rem 1.4rem;} li{margin:.2rem 0;}' +
      'a{color:#000;text-decoration:underline;} img{max-width:100%;}' +
      'code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;background:#f3f3f3;padding:.1em .3em;border-radius:3px;}' +
      'pre{background:#f5f5f5;padding:.8rem 1rem;border-radius:6px;overflow:auto;} pre code{background:none;padding:0;}' +
      'blockquote{margin:.6rem 0;padding:.2rem 0 .2rem 1rem;border-left:3px solid #ccc;color:#333;}' +
      'table{border-collapse:collapse;margin:.6rem 0;} th,td{border:1px solid #bbb;padding:.35rem .6rem;text-align:left;}' +
      'hr{border:0;border-top:1px solid #ccc;margin:1.2rem 0;} @page{margin:1.6cm;}' +
      '</style></head><body><main>' + el.innerHTML + '</main></body></html>')
    w.document.close()
    w.focus()
    // Give the new window a tick to lay out before invoking the print dialog.
    setTimeout(() => { try { w.print() } catch { /* user can Ctrl+P */ } }, 300)
  }

  async function deleteDoc(d: DocFull) {
    if (!confirm(`Delete "${d.title}"? This cannot be undone.`)) return
    const r = await fetch(`/api/workspaces/${workspaceId}/documents/${d.id}`, { method: 'DELETE' })
    if (!r.ok) {
      alert('Could not delete the document.')
      return
    }
    // The WS document_deleted handler will clear state + refresh the list.
  }

  async function togglePin(d: DocSummary | DocFull) {
    await fetch(`/api/workspaces/${workspaceId}/documents/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !d.pinned }),
    })
    await refreshList()
    if (doc && doc.id === d.id) setDoc({ ...doc, pinned: !d.pinned })
  }

  async function saveFolder(d: DocFull, next: string) {
    setFolderEditing(false)
    if ((next.trim() || null) === (d.folder ?? null)) return
    await fetch(`/api/workspaces/${workspaceId}/documents/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: next }),
    })
    await refreshList()
    setDoc({ ...d, folder: next.trim() || null })
  }

  async function moveDocToChannel(d: DocFull, channelId: string | null) {
    if ((channelId ?? null) === (d.channel_id ?? null)) return
    await fetch(`/api/workspaces/${workspaceId}/documents/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId }),
    })
    await refreshList()
    setDoc({ ...d, channel_id: channelId })
  }

  // File a doc into a folder (or unfile it with null) — the target of drag-and-drop
  // in the doc list. Optimistic-ish: PATCH then refresh the list.
  async function moveDocToFolder(docId: string, folder: string | null) {
    await fetch(`/api/workspaces/${workspaceId}/documents/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folder ?? '' }),
    })
    await refreshList()
    if (docId === activeId && doc) setDoc({ ...doc, folder })
  }

  const existingFolders = Array.from(
    new Set([
      ...docs.map(d => d.folder).filter((f): f is string => !!f && !!f.trim()),
      ...channelNames,
    ]),
  ).sort()

  async function saveBody() {
    if (!doc) return
    const r = await fetch(`/api/workspaces/${workspaceId}/documents/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: draftTitle, body_md: draftBody }),
    }).then(r => r.json())
    setDoc(r.document)
    setEditing(false)
    void refreshList()
  }

  const docRef = useRef(doc)
  docRef.current = doc

  // Persist via a ref so this stays referentially stable and out of the
  // `components` deps — see TaskItem for why a stable map matters.
  function persistCheckbox(id: string, next: boolean) {
    const d = docRef.current
    if (!d) return
    setDoc({ ...d, state: { ...d.state, [id]: next } }) // optimistic
    void fetch(`/api/workspaces/${workspaceId}/documents/${d.id}/state/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: next }),
    })
  }

  const state = doc?.state ?? {}
  const stateRef = useRef(state)
  stateRef.current = state

  const prepared = useMemo(() => prepareDoc(doc?.body_md ?? ''), [doc?.body_md])

  const [activeHeading, setActiveHeading] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Track the heading currently in view to highlight the TOC.
  useEffect(() => {
    if (editing || !doc) return
    const root = scrollRef.current
    if (!root) return
    const hs = Array.from(root.querySelectorAll('.doc-page h2[id]')) as HTMLElement[]
    if (hs.length === 0) { setActiveHeading(null); return }
    setActiveHeading(hs[0].id)
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActiveHeading((vis[0].target as HTMLElement).id)
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    )
    hs.forEach(h => obs.observe(h))
    return () => obs.disconnect()
  }, [doc?.id, doc?.body_md, editing])

  const components = useMemo(
    () => ({
      input: ({ checked, type, ...rest }: { checked?: boolean; type?: string }) => {
        if (type !== 'checkbox') return <input type={type} {...rest} />
        // unused — we render the checkbox via the `li` task-item override below.
        return null
      },
      p: ({ children, ...rest }: { children?: React.ReactNode } & React.HTMLAttributes<HTMLParagraphElement>) => (
        <p {...rest}>{transformChannelMentions(children)}</p>
      ),
      strong: ({ children, ...rest }: { children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) => (
        <strong {...rest}>{transformChannelMentions(children)}</strong>
      ),
      h2: ({ children, ...rest }: { children?: React.ReactNode } & React.HTMLAttributes<HTMLHeadingElement>) => {
        const id = slugify(nodeToText(children))
        const h = prepared.headings.find(x => x.id === id)
        return (
          <h2 id={id} {...rest}>
            {h && <span className="anchor">{h.num}</span>}
            {transformChannelMentions(children)}
          </h2>
        )
      },
      h3: ({ children, ...rest }: { children?: React.ReactNode } & React.HTMLAttributes<HTMLHeadingElement>) => (
        <h3 {...rest}>{transformChannelMentions(children)}</h3>
      ),
      li: ({
        children,
        ...props
      }: {
        children?: React.ReactNode
        checked?: boolean | null
        className?: string
      } & React.HTMLAttributes<HTMLLIElement>) => {
        // react-markdown w/ remark-gfm marks task-list items with className "task-list-item"
        const isTask = (props.className || '').includes('task-list-item')
        if (!isTask) return <li {...props}>{transformChannelMentions(children)}</li>

        // Extract the label text by stripping the leading input from the rendered children
        const arr = Array.isArray(children) ? children : [children]
        const labelText = arr
          .map(c => {
            if (typeof c === 'string') return c
            if (c && typeof c === 'object' && 'props' in c) {
              const p = (c as { props?: { children?: unknown } }).props
              const inner = p?.children
              if (typeof inner === 'string') return inner
              if (Array.isArray(inner)) return inner.map(x => (typeof x === 'string' ? x : '')).join('')
            }
            return ''
          })
          .join('')
          .trim()

        const id = checkboxId(labelText)
        const persisted = stateRef.current[id]
        const initialChecked =
          typeof persisted === 'boolean' ? persisted : props.checked === true

        return (
          <TaskItem
            label={labelText}
            initialChecked={initialChecked}
            onPersist={(next) => persistCheckbox(id, next)}
          />
        )
      },
    }),
    // Stable across checkbox toggles — TaskItem owns its own checked state.
    // Recreate only on doc switch or body edit, else ReactMarkdown remounts
    // the whole doc and the scroll jumps to top.
    [doc?.id, prepared],
  )

  return (
    <div className="h-full flex relative">
      {railOpen && (
        <div
          className="absolute inset-0 bg-black/40 z-20"
          onClick={() => setRailOpen(false)}
        />
      )}
      <aside
        style={isDesktop && rail.pinned && !rail.collapsed ? { width: rail.width, flex: '0 0 auto' } : undefined}
        className={`
          ${isDesktop && rail.pinned ? 'static' : 'absolute'} inset-y-0 left-0 z-30
          w-64 bg-[var(--color-surface)]
          border-r border-[var(--color-border)] flex-col
          transition-transform duration-200
          ${railOpen || (isDesktop && rail.pinned && !rail.collapsed) ? 'translate-x-0 flex' : '-translate-x-full flex'}
          ${isDesktop && rail.pinned && rail.collapsed ? 'hidden' : ''}
        `}
      >
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-dim)]">
            Documents
          </span>
          <div className="flex items-center gap-2">
            <input
              ref={uploadInputRef}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              multiple
              hidden
              onChange={e => {
                if (e.target.files && e.target.files.length > 0) void uploadFiles(e.target.files)
                if (e.target) e.target.value = ''
              }}
            />
            <button
              onClick={() => uploadInputRef.current?.click()}
              className="text-xs px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]"
              title="Upload .md or .txt files as new documents"
            >
              Upload
            </button>
            {uploadStatus && (
              <span className="text-[10px] text-[var(--color-text-dim)] truncate max-w-[160px]" title={uploadStatus}>
                {uploadStatus}
              </span>
            )}
            <button
              onClick={startCreate}
              className="text-xs px-2 py-0.5 rounded bg-[var(--color-accent)] text-white hover:opacity-90"
            >
              New
            </button>
            <button
              onClick={() => rail.setPinned(!rail.pinned)}
              className="hidden md:block text-xs transition-all"
              style={rail.pinned ? undefined : { filter: 'grayscale(1)', opacity: 0.45 }}
              title={rail.pinned ? 'Unpin (overlay mode)' : 'Pin (dock)'}
            >
              📌
            </button>
            <button
              onClick={() => rail.pinned ? rail.setCollapsed(true) : setRailOpen(false)}
              className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              title={rail.pinned ? 'Collapse sidebar' : 'Close'}
            >
              ◀
            </button>
          </div>
        </div>
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
          <select
            value={scope}
            onChange={e => setScope(e.target.value)}
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
            title="Show documents for…"
          >
            <option value={SCOPE_ALL}>All documents</option>
            {channels.map(c => (
              <option key={c.id} value={c.id}># {c.name}</option>
            ))}
            <option value={SCOPE_WORKSPACE}>Workspace-level</option>
          </select>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {visibleDocs.length === 0 ? (
            <div className="px-4 py-2 text-xs text-[var(--color-text-dim)]">
              {scope === SCOPE_ALL
                ? 'No documents yet.'
                : 'No documents in this channel yet.'}
            </div>
          ) : (
            <DocList
              docs={visibleDocs}
              activeId={activeId}
              onPick={(id) => { setActiveId(id); setEditing(false); setRailOpen(false) }}
              onTogglePin={togglePin}
              onMoveToFolder={moveDocToFolder}
            />
          )}
        </div>
      </aside>
      {isDesktop && rail.pinned && !rail.collapsed && (
        <RailResizeHandle width={rail.width} setWidth={rail.setWidth} />
      )}

      <main className="flex-1 flex flex-col min-w-0">
        {creating ? (
          <NewDocForm
            folders={existingFolders}
            onSubmit={submitNewDoc}
            onCancel={() => setCreating(false)}
            onOpenRail={() => setRailOpen(true)}
          />
        ) : !doc ? (
          <>
            {(!rail.pinned || rail.collapsed || !isDesktop) && (
              <header className="h-14 border-b border-[var(--color-border)] flex items-center px-4 md:px-6 gap-3">
                <button onClick={() => { if (isDesktop && rail.pinned && rail.collapsed) rail.setCollapsed(false); else setRailOpen(true) }} className="text-xl text-[var(--color-text-dim)] hover:text-[var(--color-text)]" aria-label="Open documents">☰</button>
                <span className="text-sm text-[var(--color-text-dim)]">Documents</span>
              </header>
            )}
            <div className="flex-1 flex flex-col items-center justify-center text-sm text-[var(--color-text-dim)] p-6 text-center gap-2">
              <div className="text-3xl mb-1" aria-hidden>📄</div>
              {docs.length === 0 ? (
                <>
                  <div className="text-[var(--color-text)]">No documents yet</div>
                  <div className="text-xs max-w-sm">
                    Click <span className="mx-1 text-[var(--color-accent)]">New</span> to create your first doc — notes, specs, anything you want your agents to reference.
                  </div>
                </>
              ) : (
                <div>
                  Select a document on the left, or click <span className="mx-1 text-[var(--color-accent)]">New</span> to create one.
                </div>
              )}
            </div>
          </>
        ) : editing ? (
          <>
            <header className="h-14 border-b border-[var(--color-border)] flex items-center px-4 md:px-6 gap-2">
              <button onClick={() => { if (isDesktop && rail.pinned && rail.collapsed) rail.setCollapsed(false); else setRailOpen(true) }} className={`${!rail.pinned || rail.collapsed || !isDesktop ? '' : 'hidden'} text-xl text-[var(--color-text-dim)] hover:text-[var(--color-text)]`} aria-label="Open documents">☰</button>
              <input
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                className="bg-transparent text-lg font-medium flex-1 focus:outline-none min-w-0"
              />
              <button
                onClick={() => setEditing(false)}
                className="text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              >
                Cancel
              </button>
              <button
                onClick={saveBody}
                className="text-sm bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90"
              >
                Save
              </button>
            </header>
            <textarea
              value={draftBody}
              onChange={e => setDraftBody(e.target.value)}
              className="flex-1 bg-transparent p-4 md:p-6 font-mono text-sm focus:outline-none resize-none"
              spellCheck={false}
            />
          </>
        ) : (
          <>
            <header className="h-14 border-b border-[var(--color-border)] flex items-center px-4 md:px-6 gap-3 md:gap-4">
              <button onClick={() => { if (isDesktop && rail.pinned && rail.collapsed) rail.setCollapsed(false); else setRailOpen(true) }} className={`${!rail.pinned || rail.collapsed || !isDesktop ? '' : 'hidden'} text-xl text-[var(--color-text-dim)] hover:text-[var(--color-text)]`} aria-label="Open documents">☰</button>
              <div className="flex-1 min-w-0 flex items-baseline gap-2">
                <div className="font-medium truncate">{doc.title}</div>
                <select
                  value={doc.channel_id ?? ''}
                  onChange={e => moveDocToChannel(doc, e.target.value || null)}
                  className="bg-transparent text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] border border-transparent hover:border-[var(--color-border)] rounded px-1 py-0.5 focus:outline-none focus:border-[var(--color-accent)] max-w-[40%]"
                  title="Move to channel"
                >
                  <option value="">Workspace-level</option>
                  {channels.map(c => (
                    <option key={c.id} value={c.id}># {c.name}</option>
                  ))}
                </select>
                {folderEditing ? (
                  <FolderInput
                    defaultValue={doc.folder ?? ''}
                    folders={existingFolders}
                    onCommit={(v) => saveFolder(doc, v)}
                    onCancel={() => setFolderEditing(false)}
                  />
                ) : doc.folder ? (
                  <button
                    onClick={() => setFolderEditing(true)}
                    className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] truncate"
                    title="Move to folder"
                  >
                    in {doc.folder}
                  </button>
                ) : (
                  <button
                    onClick={() => setFolderEditing(true)}
                    className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                    title="Move to folder"
                  >
                    + folder
                  </button>
                )}
              </div>
              <button
                onClick={() => togglePin(doc)}
                className={`text-base ${doc.pinned ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'}`}
                title={doc.pinned ? 'Unpin' : 'Pin'}
              >
                {doc.pinned ? '★' : '☆'}
              </button>
              <a
                href={`/api/workspaces/${workspaceId}/documents/${doc.id}/download`}
                className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-1"
                title="Download as .md"
                aria-label="Download"
              >
                <IconDownload />
              </a>
              <button
                onClick={printDoc}
                className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-1"
                title="Print"
                aria-label="Print"
              >
                <IconPrint />
              </button>
              <button
                onClick={() => setEditing(true)}
                className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-1"
                title="Edit"
                aria-label="Edit"
              >
                <IconPencil />
              </button>
              <button
                onClick={() => deleteDoc(doc)}
                className="text-[var(--color-text-dim)] hover:text-red-400 px-1"
                title="Delete document"
                aria-label="Delete"
              >
                <IconTrash />
              </button>
            </header>
            <div ref={scrollRef} className="flex-1 overflow-y-auto docs-paper-scroll">
              <div className="docs-shell">
                <div className="docs-main">
                  <article className="doc-page">
                    <h1 className="doc-title">{doc.title}</h1>
                    <div className="doc-meta-line">
                      {doc.channel_id && channelNameById.has(doc.channel_id) && (
                        <span># {channelNameById.get(doc.channel_id)}</span>
                      )}
                      {doc.folder && <span>in {doc.folder}</span>}
                      <span className="dim">updated {fmtDocDate(doc.updated_at)}</span>
                    </div>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as never}>
                      {prepared.body}
                    </ReactMarkdown>
                  </article>
                </div>
                {prepared.headings.length > 0 && (
                  <nav className="docs-toc">
                    <div className="toc-label">On this page</div>
                    {prepared.headings.map(h => (
                      <a
                        key={h.id}
                        title={h.text}
                        className={activeHeading === h.id ? 'active' : ''}
                        onClick={() =>
                          document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }
                      >
                        {h.text}
                      </a>
                    ))}
                  </nav>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function FolderInput({
  defaultValue,
  folders,
  onCommit,
  onCancel,
}: {
  defaultValue: string
  folders: string[]
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(defaultValue)
  const listId = 'folder-list-' + Math.random().toString(36).slice(2, 8)
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={value}
        list={listId}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
        placeholder="folder (blank = unfile)"
        className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-0.5 text-xs focus:outline-none focus:border-[var(--color-accent)] w-44"
      />
      <datalist id={listId}>
        {folders.map(f => <option key={f} value={f} />)}
      </datalist>
    </span>
  )
}

function NewDocForm({
  folders,
  onSubmit,
  onCancel,
  onOpenRail,
}: {
  folders: string[]
  onSubmit: (title: string, folder: string) => void
  onCancel: () => void
  onOpenRail: () => void
}) {
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('')
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(title, folder) }}
      className="flex-1 flex flex-col"
    >
      <header className="h-14 border-b border-[var(--color-border)] flex items-center px-4 md:px-6 gap-3">
        <button type="button" onClick={onOpenRail} className="md:hidden text-xl text-[var(--color-text-dim)] hover:text-[var(--color-text)]" aria-label="Open documents">☰</button>
        <div className="font-medium flex-1 truncate">New document</div>
        <button type="button" onClick={onCancel} className="text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)]">Cancel</button>
        <button
          type="submit"
          disabled={!title.trim()}
          className="text-sm bg-[var(--color-accent)] text-white px-3 py-1.5 rounded hover:opacity-90 disabled:opacity-50"
        >
          Create
        </button>
      </header>
      <div className="p-6 max-w-2xl space-y-4">
        <label className="block">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Title</div>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Deploy checklist"
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <label className="block">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] mb-1">Folder (optional)</div>
          <input
            value={folder}
            list="new-doc-folders"
            onChange={(e) => setFolder(e.target.value)}
            placeholder="pick or type a folder name"
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
          />
          <datalist id="new-doc-folders">
            {folders.map(f => <option key={f} value={f} />)}
          </datalist>
        </label>
      </div>
    </form>
  )
}

function DocList({
  docs,
  activeId,
  onPick,
  onTogglePin,
  onMoveToFolder,
}: {
  docs: DocSummary[]
  activeId: string | null
  onPick: (id: string) => void
  onTogglePin: (d: DocSummary) => void
  onMoveToFolder: (docId: string, folder: string | null) => void
}) {
  // Folder key being hovered during a drag ('' = the Unfiled group).
  const [dragOver, setDragOver] = useState<string | null>(null)
  // Created-but-empty folders: shown as drop targets so you can file into a fresh folder.
  const [extraFolders, setExtraFolders] = useState<string[]>([])

  // Pinned first, then group remaining by folder ("" for unfiled).
  const pinned = docs.filter(d => d.pinned)
  const rest = docs.filter(d => !d.pinned)
  const byFolder = new Map<string, DocSummary[]>()
  for (const d of rest) {
    const key = d.folder?.trim() ? d.folder.trim() : ''
    if (!byFolder.has(key)) byFolder.set(key, [])
    byFolder.get(key)!.push(d)
  }
  for (const f of extraFolders) if (f && !byFolder.has(f)) byFolder.set(f, [])
  if (!byFolder.has('')) byFolder.set('', []) // always offer an Unfiled drop target
  const folderKeys = [...byFolder.keys()].sort((a, b) => {
    if (a === '') return 1
    if (b === '') return -1
    return a.localeCompare(b)
  })
  const hasAnyFolder = folderKeys.some(k => k !== '')

  function dropProps(folderKey: string) {
    return {
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOver !== folderKey) setDragOver(folderKey) },
      onDragLeave: (e: React.DragEvent) => { if (e.currentTarget === e.target) setDragOver(prev => (prev === folderKey ? null : prev)) },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        const id = e.dataTransfer.getData('text/doc-id')
        setDragOver(null)
        if (id) onMoveToFolder(id, folderKey || null)
      },
    }
  }

  function Row({ d, indent = false }: { d: DocSummary; indent?: boolean }) {
    return (
      <div
        key={d.id}
        draggable
        onDragStart={(e) => { e.dataTransfer.setData('text/doc-id', d.id); e.dataTransfer.effectAllowed = 'move' }}
        className={`group flex items-center cursor-grab active:cursor-grabbing hover:bg-[var(--color-hover-bg)] ${
          d.id === activeId ? 'bg-[var(--color-active-bg)] text-[var(--color-text)]' : 'text-[var(--color-text-dim)]'
        }`}
      >
        <button
          onClick={() => onPick(d.id)}
          className={`flex-1 flex items-center gap-2 text-left ${indent ? 'pl-9 pr-4' : 'px-4'} py-1 text-sm truncate`}
        >
          <IconDocument size={12} className="flex-shrink-0 opacity-50" />
          <span className="truncate">{d.title}</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onTogglePin(d) }}
          className={`px-2 text-base ${d.pinned ? 'text-[var(--color-accent)]' : 'opacity-0 group-hover:opacity-100 text-[var(--color-text-dim)] hover:text-[var(--color-text)]'}`}
          title={d.pinned ? 'Unpin' : 'Pin'}
        >
          {d.pinned ? '★' : '☆'}
        </button>
      </div>
    )
  }

  return (
    <div>
      {pinned.length > 0 && (
        <div className="mb-2">
          <div className="px-4 py-1 text-xs uppercase tracking-wide text-[var(--color-text-dim)]">
            Pinned
          </div>
          {pinned.map(d => <Row key={d.id} d={d} />)}
        </div>
      )}
      {folderKeys.map(folder => {
        const rows = byFolder.get(folder) ?? []
        // No folders at all (only unfiled docs): flat list, no header.
        const skipHeader = folder === '' && !hasAnyFolder
        // Hide an empty Unfiled group unless something's being dragged onto it.
        if (folder === '' && rows.length === 0 && hasAnyFolder && dragOver !== '') return null
        const isOver = dragOver === folder
        return (
          <div
            key={folder || '__unfiled'}
            {...dropProps(folder)}
            className={`mb-2 rounded ${isOver ? 'ring-1 ring-[var(--color-accent)] bg-[var(--color-hover-bg)]' : ''}`}
          >
            {!skipHeader && (
              <div className={`px-4 pt-3 pb-1 flex items-center gap-2 truncate ${
                folder
                  ? 'text-sm font-semibold text-[var(--color-text)]'
                  : 'uppercase tracking-wide text-[11px] text-[var(--color-text-dim)] font-medium'
              }`}>
                {folder ? (
                  <>
                    <IconFolder size={18} className="flex-shrink-0 text-[var(--color-accent)]" />
                    <span className="truncate">{folder}</span>
                  </>
                ) : (
                  <span>Unfiled</span>
                )}
              </div>
            )}
            {rows.length > 0
              ? rows.map(d => <Row key={d.id} d={d} indent={!!folder} />)
              : <div className="px-4 pb-2 pl-9 text-xs italic text-[var(--color-text-dim)]">drop a doc here</div>}
          </div>
        )
      })}
      <button
        onClick={() => {
          const name = prompt('New folder name')?.trim()
          if (name) setExtraFolders(f => (f.includes(name) ? f : [...f, name]))
        }}
        className="mx-4 mt-1 mb-2 text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
      >
        + New folder
      </button>
    </div>
  )
}
