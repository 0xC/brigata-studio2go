import { useRef, useState } from 'react'
import { AGENT_TEMPLATES } from './agentTemplates'

const UPLOAD_MIMES = ['image/png', 'image/jpeg', 'image/webp']
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024

// Agent avatars are either an image path (template PNG at /avatars/templates/…,
// or an uploaded URL) or a short emoji string (brigade agents, "surprise me",
// legacy). Detect images so render sites can branch to <img>.
export function isImageAvatar(v?: string | null): v is string {
  return !!v && (v.startsWith('/') || v.startsWith('http'))
}

// Bundled avatars are 1024×1024 PNGs but render at ≤52px. Map a known
// template/extra path to its 128px WebP thumbnail. Uploaded/remote avatars
// (and anything not matching) are returned unchanged — they have no thumb.
export function thumbAvatarUrl(path: string): string {
  return path.replace(/^\/avatars\/(templates|extras)\/([^/]+)\.png$/, '/avatars/$1/thumb/$2.webp')
}

export function AgentAvatar({
  avatar, size = 24, className = '',
}: {
  avatar?: string | null
  size?: number
  className?: string
}) {
  if (isImageAvatar(avatar)) {
    return (
      <img
        src={thumbAvatarUrl(avatar)}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, boxShadow: '0 0 0 1px var(--color-border)' }}
        className={`rounded-full object-cover ${className}`}
      />
    )
  }
  return (
    <span style={{ fontSize: Math.round(size * 0.72), lineHeight: 1 }} className={className}>
      {avatar || '🤖'}
    </span>
  )
}

// Avatar form field: a 48px preview, an "Upload custom…" escape hatch (when
// onUploadFile is supplied), and the eight template PNGs. onUploadFile sends
// the file to the server and resolves with the served URL, which we set as the
// value. When absent (e.g. agent not yet created), the upload button is hidden.
export function AvatarPicker({
  value, onChange, onUploadFile,
}: {
  value: string
  onChange: (v: string) => void
  onUploadFile?: (file: File) => Promise<string>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file || !onUploadFile) return
    setError(null)
    if (!UPLOAD_MIMES.includes(file.type)) {
      setError('Use a PNG, JPEG, or WebP image.')
      return
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      setError('Image must be under 5MB.')
      return
    }
    setUploading(true)
    try {
      const url = await onUploadFile(file)
      onChange(url)
    } catch {
      setError('Upload failed. Try again.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-center flex-shrink-0">
          <AgentAvatar avatar={value} size={48} />
        </div>
        {onUploadFile && (
          <div className="ml-auto flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={handleFile}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition disabled:opacity-50"
            >
              {uploading ? 'Uploading…' : 'Upload custom…'}
            </button>
          </div>
        )}
      </div>
      {error && <div className="text-xs text-[var(--color-danger,#e5484d)]">{error}</div>}
      <div className="grid grid-cols-8 gap-2">
        {AGENT_TEMPLATES.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.avatar_path)}
            title={t.name}
            className={`rounded-full overflow-hidden border transition ${
              value === t.avatar_path
                ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]'
                : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
            }`}
          >
            <img src={thumbAvatarUrl(t.avatar_path)} alt={t.name} loading="lazy" className="w-full aspect-square object-cover block" />
          </button>
        ))}
      </div>

      {/* "More avatars" — extras decoupled from the role templates. Same
          illustrator's hand, no role mapping. User picks whichever fits. */}
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-dim)] pt-2">
        More avatars
      </div>
      <div className="grid grid-cols-8 gap-2">
        {EXTRA_AVATARS.map(a => (
          <button
            key={a.path}
            type="button"
            onClick={() => onChange(a.path)}
            title={a.label}
            className={`rounded-full overflow-hidden border transition ${
              value === a.path
                ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]'
                : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
            }`}
          >
            <img src={thumbAvatarUrl(a.path)} alt={a.label} loading="lazy" className="w-full aspect-square object-cover block" />
          </button>
        ))}
      </div>

      <div className="text-xs text-[var(--color-text-dim)]">
        Pick any above, or upload your own · PNG, 512 × 512 recommended
      </div>
    </div>
  )
}

// Extra avatars — the same illustrated style as the role templates, but
// decoupled from any specific archetype. Users can pick whichever they like.
const EXTRA_AVATARS: { path: string; label: string }[] = [
  { path: '/avatars/extras/bunny.png', label: 'Bunny' },
  { path: '/avatars/extras/groundhog.png', label: 'Groundhog' },
  { path: '/avatars/extras/possum.png', label: 'Possum' },
  { path: '/avatars/extras/ram.png', label: 'Ram' },
  { path: '/avatars/extras/quokka-teacher.png', label: 'Quokka (teacher)' },
  { path: '/avatars/extras/horse-superhero.png', label: 'Horse (superhero)' },
  { path: '/avatars/extras/lemur-pilot.png', label: 'Lemur (pilot)' },
  { path: '/avatars/extras/panda-secretary.png', label: 'Panda (secretary)' },
  { path: '/avatars/extras/penguin-butler.png', label: 'Penguin (butler)' },
  { path: '/avatars/extras/red-panda-soldier.png', label: 'Red panda (soldier)' },
  { path: '/avatars/extras/beagle-pilot.png', label: 'Beagle (pilot)' },
  { path: '/avatars/extras/fox-analyst.png', label: 'Fox (analyst)' },
]
