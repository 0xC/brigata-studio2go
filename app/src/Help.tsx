import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// File-backed help center. The task pages are authored as markdown in
// `docs/help/*.md` (repo root) and raw-imported at build time, so this page
// and the future help overlay read from one source of truth. To add or edit a
// task page, edit the markdown — no change needed here.
const rawPages = import.meta.glob('../../docs/help/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function slugFromPath(path: string): string {
  return path.split('/').pop()!.replace(/\.md$/, '')
}

function titleOf(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

type Page = { slug: string; title: string; body: string }

const pages: Record<string, Page> = {}
for (const [path, body] of Object.entries(rawPages)) {
  const slug = slugFromPath(path)
  if (slug === 'README') continue // index/authoring doc, not a user page
  pages[slug] = { slug, title: titleOf(body, slug), body }
}

// Section order mirrors docs/help/README.md.
const SECTIONS: { title: string; slugs: string[] }[] = [
  { title: 'Getting started', slugs: ['connect-claude'] },
  { title: 'Working with agents', slugs: ['enable-skills', 'restore-agent-version', 'change-agent-role'] },
  { title: 'Hosting your agents', slugs: ['choose-agent-hosting', 'restart-an-agent', 'redeploy-an-agent'] },
  { title: 'Team & workspaces', slugs: ['invite-teammates'] },
  { title: 'Integrations', slugs: ['connect-discord'] },
  { title: 'Your data', slugs: ['export-workspace'] },
]

const HOME = 'home'

function currentSlug(): string {
  const h = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : ''
  if (h && pages[h]) return h
  return HOME
}

export function Help() {
  const [slug, setSlug] = useState<string>(currentSlug())

  useEffect(() => {
    const onHash = () => setSlug(currentSlug())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const page = slug === HOME ? null : pages[slug]

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="h-12 border-b border-[var(--color-border)] flex items-center px-4 gap-3 bg-[var(--color-surface)] flex-shrink-0">
        <a href="/" className="text-sm font-medium hover:text-[var(--color-accent)]">← Back</a>
        <span className="text-sm text-[var(--color-text-dim)]">Help</span>
      </header>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        <nav className="md:w-60 md:flex-shrink-0 border-b md:border-b-0 md:border-r border-[var(--color-border)] overflow-y-auto p-3 max-h-44 md:max-h-none bg-[var(--color-surface)] md:bg-transparent">
          <a
            href="#home"
            className={`block px-2 py-1.5 rounded text-sm ${
              slug === HOME ? 'bg-[var(--color-active-bg)] text-[var(--color-text)]' : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-bg)]'
            }`}
          >
            Basics &amp; FAQ
          </a>
          {SECTIONS.map(section => (
            <div key={section.title} className="mt-3">
              <div className="px-2 text-[11px] uppercase tracking-wide text-[var(--color-text-dim)] mb-1">
                {section.title}
              </div>
              {section.slugs.filter(s => pages[s]).map(s => (
                <a
                  key={s}
                  href={`#${s}`}
                  className={`block px-2 py-1.5 rounded text-sm ${
                    slug === s ? 'bg-[var(--color-active-bg)] text-[var(--color-text)]' : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-bg)]'
                  }`}
                >
                  {pages[s].title}
                </a>
              ))}
            </div>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto flex justify-center p-6">
          <article className="max-w-2xl w-full prose-doc text-sm leading-relaxed">
            {page ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.body}</ReactMarkdown>
            ) : (
              <HelpHome />
            )}
          </article>
        </div>
      </div>

      <footer className="border-t border-[var(--color-border)] py-4 px-6 text-xs text-[var(--color-text-dim)] flex items-center justify-between flex-wrap gap-3">
        <div>© {new Date().getFullYear()} brigata.ai. All rights reserved.</div>
        <div className="flex items-center gap-4">
          <a href="/about" className="hover:text-[var(--color-text)]">About</a>
          <a href="/help" className="hover:text-[var(--color-text)]">Help</a>
          <a href="/privacy" className="hover:text-[var(--color-text)]">Privacy</a>
          <a href="/terms" className="hover:text-[var(--color-text)]">Terms</a>
          <a href="/contact" className="hover:text-[var(--color-text)]">Contact</a>
        </div>
      </footer>
    </div>
  )
}

// Basics + FAQ: the still-accurate Q&A folded from the previous hardcoded Help
// page. Task-specific how-tos now live in the markdown pages in the left nav;
// this covers the conceptual questions those pages don't.
function HelpHome() {
  return (
    <>
      <h1>Help &amp; FAQ</h1>
      <p>
        Task guides are in the menu — connecting Claude, enabling skills,
        restarting an agent, and more. Below are the questions we hear most
        often. If you don't see yours, <a href="/contact">drop us a line</a> —
        we read every message.
      </p>

      <h2>Getting started</h2>

      <h3>What is Brigata Studio?</h3>
      <p>
        A workspace where you assemble a small team of AI agents and put them to
        work — researching, writing, organizing, watching dashboards, running
        code. You bring your own Claude account; the agents work for you, not
        for us.
      </p>

      <h3>How do I sign up?</h3>
      <p>
        Brigata Studio is in invite-only closed beta. Sign in with your Google
        account on <a href="/">the landing page</a>. If your email isn't on the
        invitation list yet, you'll see a polite "not yet available" page —
        email <a href="/contact">us through the contact form</a> and we'll
        consider adding you.
      </p>

      <h3>I'm in — what's the first thing I do?</h3>
      <p>
        After sign-in you'll go through a short onboarding wizard that seeds your
        workspace with channels, an agent or two, and a welcome document tuned to
        how you described yourself. Then{' '}
        <a href="#connect-claude">connect your Claude account</a> so the agents
        can actually respond.
      </p>

      <h2>Agents</h2>

      <h3>How do I create an agent?</h3>
      <p>
        Click <strong>+ New</strong> in the agents bar at the top of the
        workspace (or in Studio mode, the brigade dock under the header), or head
        to Settings and pick "New agent". Give it a name, an avatar emoji, and a
        Soul (its personality + voice) and Mission (what you're hiring it to do).
        Save, and it's ready to chat.
      </p>

      <h3>Why isn't my agent responding?</h3>
      <p>The usual suspects:</p>
      <ul>
        <li>
          You haven't <a href="#connect-claude">connected your Claude account</a>{' '}
          yet.
        </li>
        <li>Your Anthropic token was revoked or hit a rate limit.</li>
        <li>
          For agents on a Pro server: the server is still provisioning (takes
          ~3–5 min on first creation) or hit a startup error — try{' '}
          <a href="#restart-an-agent">restarting it</a>.
        </li>
      </ul>

      <h2>Workspace</h2>

      <h3>Studio vs Side-by-side — how do I choose?</h3>
      <ul>
        <li>
          <strong>Side-by-side</strong> is the default. Slack-style channels on
          one pane, documents or settings on another. Comfortable for everyday
          chat-driven work.
        </li>
        <li>
          <strong>Studio</strong> is the floating-window mode. Drag, resize,
          tile, cascade, and snap windows freely on a desktop-style canvas.
          Comfortable when you want three or four agents and documents on screen
          at once. Double-click a title bar to maximize.
        </li>
      </ul>
      <p>Toggle between them with the button in the top header.</p>

      <h3>How do channels work?</h3>
      <p>
        Channels are shared rooms where you and your agents talk. Any agent can
        be addressed by name, by <code>@mention</code>, or just by talking —
        they'll figure out whether it's their turn.
      </p>

      <h3>How do documents work?</h3>
      <p>
        Documents are Markdown files your workspace + your agents can both edit.
        They support checkboxes (synced to a database, not just the rendered
        view), folders, pinning, and full revision history. Ask an agent to "make
        a list of next steps" and watch it create or update a document live.
      </p>

      <h2>Cost &amp; billing</h2>

      <h3>What does Brigata Studio cost?</h3>
      <ul>
        <li>
          <strong>Free — $0, forever.</strong> One real agent (custom or
          AI-generated soul, skills, memory, channels, shared docs in your own
          workspace). You can join shared workspaces you're invited to. Bring
          your own Anthropic key.
        </li>
        <li>
          <strong>Standard — $15/mo.</strong> Unlimited agents, plus the ability
          to create your own shared workspaces (up to 2; 3 total with your
          personal one).
        </li>
        <li>
          <strong>+ Pro server — $25/mo, flat.</strong> A
          server that runs up to 3 agents. Need a 4th? Add a second server. The
          Pro server is a separate Brigata charge on top of your $15 Standard
          seat. The workspace owner pays the server's compute; members ride free.
        </li>
        <li>
          <strong>Advanced:</strong> bring your own server (
          <strong>+$10/mo</strong>, no uptime SLA) or choose global-region hosting (
          <strong>+$35/mo</strong>).
        </li>
        <li>
          <strong>Founding:</strong> $10/mo locked for life for the first ~100
          members or 60 days, whichever comes first.
        </li>
        <li>
          <strong>Annual:</strong> pay for 10 months, get 12.
        </li>
      </ul>
      <p>
        Anthropic and VPS-provider costs are billed directly to your own
        accounts and have always been your responsibility (see{' '}
        <a href="/terms">Terms</a>).
      </p>

      <h2>Your data</h2>

      <h3>How do I delete my account?</h3>
      <p>
        Settings → Your data → Delete account. Type your email to confirm, click
        Delete. This wipes your workspaces, conversations, documents, and any
        Pro servers we provisioned for you. We don't keep a copy.
      </p>

      <h3>Do you train AI on my data?</h3>
      <p>
        No. Your messages and documents are not used to train models — ours,
        yours, or any third party's. See the <a href="/privacy">Privacy Policy</a>{' '}
        for the full picture.
      </p>

      <h2>Troubleshooting</h2>

      <h3>Something's broken / I have a question</h3>
      <p>
        <a href="/contact">Contact us</a> — include screenshots when you can. We
        read every message and reply during US business hours.
      </p>

      <h3>I want to suggest a feature</h3>
      <p>
        Same form — make the subject "Feature request". We can't promise every
        suggestion ships, but every one gets read by a human.
      </p>
    </>
  )
}
