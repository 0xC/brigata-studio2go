import { useEffect, useRef, useState } from 'react'

// Curated agent-flavored emojis grouped by vibe. Not exhaustive — designed for
// "pick a face/symbol for an AI agent" rather than full unicode coverage.
// Users can still paste any emoji directly into the input.

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: 'Faces',
    emojis: ['🤖','😀','😎','🤓','🥸','🧐','😈','🤠','🦾','🧠','👾','👻','🦸','🧙','🧛','🧞','🧟','🧝','🧜','🧚','🦹','🥷','🧑‍🚀','🧑‍💻','🧑‍🔬','🧑‍🎨','🧑‍🏫','🧑‍⚖️','🧑‍🌾','🧑‍🍳'],
  },
  {
    label: 'Animals',
    emojis: ['🐶','🐱','🦊','🐼','🐻','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🦉','🦅','🦆','🐺','🐗','🐴','🦄','🐝','🐞','🦋','🐢','🐍','🐙','🦑','🦞','🦀','🐳','🐬','🦈','🐠'],
  },
  {
    label: 'Food',
    emojis: ['🍝','🍕','🍔','🍟','🌮','🍣','🍱','🍜','🥘','🍳','🥐','🥖','🥨','🥯','🧀','🍞','🍩','🍪','🍰','🎂','🍫','🍭','🍬','🍡','🍦','🍨','☕','🍵','🍺','🍷','🥂','🍸','🍹'],
  },
  {
    label: 'Work & tools',
    emojis: ['💻','🛠️','🔧','🔨','⚙️','🔬','🧪','📝','✍️','📚','📖','📓','📌','📎','🖇️','📊','📈','📉','💼','🗂️','🗃️','🗄️','📂','📁','✏️','✒️','🖋️','🖊️','🖍️','🎨','🪄','🧭'],
  },
  {
    label: 'Symbols',
    emojis: ['⭐','🌟','✨','💡','🔥','🚀','💎','🎯','🎲','🧩','🎭','🎬','🎤','🎧','🎵','🔔','🔮','⚡','☀️','🌙','🌈','🌊','🌳','🌲','🍀','🌺','🌸','🌻','🌷','🌹','💐','🌵'],
  },
]

export function EmojiPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (emoji: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [paste, setPaste] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  function pick(e: string) {
    onChange(e)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-20 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-center text-xl hover:border-[var(--color-accent)]"
        title="Click to pick an emoji"
      >
        {value || '🤖'}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-80 max-h-96 overflow-y-auto bg-[var(--color-surface-elevated)] border border-[var(--color-border)] rounded-md shadow-elevated p-3 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)] mb-1">
              Paste your own
            </div>
            <input
              value={paste}
              onChange={e => setPaste(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && paste.trim()) { e.preventDefault(); pick(paste.trim().slice(0, 4)) } }}
              maxLength={8}
              placeholder="paste any emoji + Enter"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          {EMOJI_GROUPS.map(group => (
            <div key={group.label}>
              <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)] mb-1">
                {group.label}
              </div>
              <div className="grid grid-cols-10 gap-1">
                {group.emojis.map(e => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => pick(e)}
                    className={`text-lg p-1 rounded hover:bg-[var(--color-hover-bg)] ${
                      value === e ? 'bg-[var(--color-active-bg)] ring-1 ring-[var(--color-accent)]' : ''
                    }`}
                    title={e}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
