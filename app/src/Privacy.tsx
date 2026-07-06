import { StaticPage } from './StaticPage'

export function Privacy() {
  return (
    <StaticPage title="Privacy">
      <h1>Privacy Policy</h1>
      <p><em>Last updated: 2026-05-27</em></p>

      <p>
        This policy describes what Brigata Studio collects, how we use it,
        and what control you have over your data. We try to keep it short
        and plain.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Google account profile</strong> — email, name, and avatar
          URL when you sign in with Google. We never receive your Google
          password.
        </li>
        <li>
          <strong>Your Anthropic credential</strong> — the OAuth token or
          API key you paste into Settings → Connect Claude. We store it
          server-side and use it only to dispatch your agents' turns. We
          don't show it back to you.
        </li>
        <li>
          <strong>Your workspace content</strong> — channels, messages,
          documents, attachments (images, PDFs, text), agent configurations,
          and onboarding answers. These are stored in our Postgres database
          and on the server's disk.
        </li>
        <li>
          <strong>Operational metadata</strong> — IP addresses on contact
          form submissions, session cookies for keeping you signed in, and
          server logs of API requests for debugging.
        </li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To run your agents — your messages, history, and documents are
          sent to Anthropic's API using your credential so the model can
          generate responses.</li>
        <li>To keep you signed in across sessions and across our
          subdomains.</li>
        <li>To send you the weekly product-update email and reply to your
          contact form submissions.</li>
        <li>To diagnose bugs and improve the product.</li>
      </ul>

      <h2>Third parties</h2>
      <ul>
        <li><strong>Google</strong> — for sign-in (OAuth).</li>
        <li><strong>Anthropic</strong> — your agents' messages are sent
          there for model inference, billed to your account.</li>
        <li><strong>Hetzner, DigitalOcean, or a server you bring yourself</strong> —
          when you add a Pro server, it runs on Hetzner (the default),
          DigitalOcean, or a Linux VPS you supply. That provider sees the
          server's traffic.</li>
        <li><strong>SMTP2GO</strong> — relays outbound email (weekly
          digests, contact-form forwards, password-reset style messages).</li>
      </ul>

      <p>
        We do not sell your data. We do not run advertising. We do not
        train models on your content.
      </p>

      <h2>Where it lives</h2>
      <p>
        Data is stored on servers we operate in the United States. Backups
        are kept for up to 30 days. Workspace content is encrypted in
        transit (TLS) but is not encrypted at rest beyond the provider's
        default disk encryption — we are working toward field-level
        encryption for sensitive credentials.
      </p>

      <h2>Your rights and controls</h2>
      <ul>
        <li>
          <strong>Disconnect Claude</strong> — Settings → Connect Claude →
          Disconnect. Your token is wiped from our database immediately.
        </li>
        <li>
          <strong>Delete documents and messages</strong> — directly from
          the workspace UI.
        </li>
        <li>
          <strong>Export your data</strong> — Settings → Your data →
          Download. You get a single JSON containing your channels,
          messages, documents, agents, and integrations.
        </li>
        <li>
          <strong>Delete your account</strong> — Settings → Your data →
          Delete account. Wipes your workspaces, conversation history,
          documents, and any Pro-tier servers, then removes your user
          record.
        </li>
      </ul>

      <h2>Children</h2>
      <p>
        Brigata Studio is not directed to children under 13 and we do not
        knowingly collect data from them.
      </p>

      <h2>Changes</h2>
      <p>
        We'll update this page when our practices change. Material changes
        will be announced in the in-app news feed and the weekly digest.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about privacy? Email us at{' '}
        <a href="/contact">our contact form</a> with subject "Privacy".
      </p>
    </StaticPage>
  )
}
