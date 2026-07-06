import { StaticPage } from './StaticPage'

export function Terms() {
  return (
    <StaticPage title="Terms">
      <h1>Terms of Service</h1>
      <p><em>Last updated: 2026-06-04</em></p>

      <p>
        These Terms govern your use of Brigata Studio ("the Service",
        "we", "us") operated by Brigata. By signing in, you agree to be
        bound by them. If you don't agree, don't use the Service.
      </p>

      <h2>1. Closed beta status</h2>
      <p>
        Brigata Studio is in closed beta. The Service may break, change,
        lose data, or be taken offline without notice. We strongly
        recommend keeping your own backup of anything important you
        produce here.
      </p>

      <h2>2. Eligibility</h2>
      <p>
        You must be at least 18 years old to use Brigata Studio. By using
        the Service you represent that you meet that requirement and that
        any information you provide is accurate.
      </p>

      <h2>3. Your account</h2>
      <p>
        You're responsible for keeping your Google account, Anthropic
        credential, and any provisioned VPS credentials secure. You're
        responsible for everything your agents do on your behalf. If you
        suspect your account has been compromised, contact us.
      </p>

      <h2>4. Your AI usage and costs</h2>
      <p>
        Brigata Studio runs your agents against your own Anthropic account
        using the credential you provide. <strong>You — not Brigata — pay
        Anthropic for that usage</strong>, on whatever billing terms
        Anthropic has with you. We don't meter, resell, or mark up tokens.
        Watch your agents' activity if you're on a per-call API key.
      </p>

      <h2>5. Subscription &amp; hosting costs</h2>
      <p>
        Brigata Studio charges a Standard subscription of $15/month per
        account. Pro server add-ons are billed separately and in addition to
        the Standard subscription: $25/month per managed Hetzner server,
        $35/month per managed DigitalOcean server, or $10/month for a server
        you supply. Each Pro server may host up to three agents. Current
        pricing is shown before you confirm any charge.
      </p>
      <p>
        For a server you supply (BYOVPS), you provision the VPS on the provider
        of your choice and are <strong>responsible for that provider's
        charges</strong>; you remain the operator and Brigata Studio provides
        no uptime SLA.
      </p>

      <h2>6. Acceptable use</h2>
      <p>
        We give you wide latitude in how you use the Service. We only draw a
        few lines, and they exist to keep you, us, and other people safe —
        not to police your preferences. You agree not to use the Service to:
      </p>
      <ul>
        <li>Break any law or anyone else's rights.</li>
        <li>Generate, transmit, or store content that is illegal,
          defamatory, harassing, or that infringes intellectual property.</li>
        <li>Generate CSAM, non-consensual intimate imagery, or content
          intended to incite violence.</li>
        <li>Attack other systems, scrape sites that prohibit scraping, or
          conduct denial-of-service activity.</li>
        <li>Impersonate someone you aren't, including by misusing an
          agent's voice.</li>
        <li>Probe, reverse-engineer, or attempt to bypass our security
          controls (responsible disclosure of bugs is welcome — contact us).</li>
      </ul>

      <h3>6.1 Fair use of Brigata-managed Pro VPSs</h3>
      <p>
        When you subscribe to a Pro add-on whose VPS we provision and manage
        on your behalf (Hetzner or DigitalOcean), the VPS is intended to host
        the Brigata-orchestrated agent(s) covered by that add-on, plus
        reasonable supporting workloads those agents create on your
        instruction (e.g., a web app the agent builds for you, a scheduled
        task it sets up, browser automation it runs). It is <strong>not</strong>{' '}
        intended as a general-purpose compute box for unrelated workloads,
        for hosting other people's services, for running additional
        LLM-driven agents outside the Brigata orchestration layer, or for
        any activity designed to evade the per-server pricing of the Pro
        add-on (including running more than three agents on a single Pro
        server, or operating additional Pro servers without the corresponding
        paid add-on). Doing so may result in suspension of the Pro add-on or
        termination of your subscription. This clause does not apply to
        BYOVPS agents (§5 / §6.2) — you own that server, you decide what
        runs on it.
      </p>

      <h3>6.2 BYOVPS responsibilities</h3>
      <p>
        When you connect Brigata to a VPS you already own (BYOVPS), Brigata
        installs and orchestrates the agent bridge on that VPS but you
        remain the operator of the server. You are responsible for keeping
        the OS patched, monitoring resource usage, maintaining backups,
        and handling outages. <strong>We do not provide an uptime SLA on
        BYOVPS-hosted agents.</strong> If our bridge breaks because of
        something we shipped, we'll fix it; if your VPS goes down or runs
        out of disk, that's on you.
      </p>

      <p>
        Your agents run on AI models from third-party providers (for example
        Anthropic, OpenAI, or a model you supply yourself). You are
        responsible for complying with the usage policies of whichever
        provider you use — including{' '}
        <a href="https://www.anthropic.com/legal/aup" target="_blank" rel="noreferrer">Anthropic's
        acceptable use policy</a> for model calls routed through Anthropic. If
        you violate a provider's terms, they may cut off access to the model
        your agent depends on, and we can't restore it.
      </p>

      <p>
        <strong>Beyond the lines above, we don't moralize.</strong> Lawful,
        private use that complies with these Terms and your model provider's
        policies — including personal, adult, or unconventional uses — is your
        business, not ours. We are a tool provider, not an arbiter of taste.
        The one exception: the prohibition on sexual content involving minors
        is absolute, is not subject to this discretion, and will be reported.
      </p>

      <h2>7. AI output disclaimer</h2>
      <p>
        AI agents make mistakes. They hallucinate, miss context, and
        sometimes confidently produce wrong answers. Brigata Studio does
        not warrant the accuracy, completeness, or fitness for any
        particular purpose of agent output. <strong>Do not rely on agent
        output for medical, legal, financial, safety-critical, or
        regulatory decisions</strong> without independent verification by a
        qualified human.
      </p>

      <h2>8. Your content</h2>
      <p>
        You retain ownership of the messages, documents, and other content
        you create in the Service. You grant us a limited license to store
        and process that content as needed to operate the Service for you.
        We do not use your content to train models — yours, ours, or any
        third party's.
      </p>

      <h2>9. Termination</h2>
      <p>
        You can stop using the Service at any time and delete your
        account. We can suspend or terminate accounts that violate these
        Terms or that pose a risk to the Service, with reasonable notice
        where possible.
      </p>

      <h2>10. Warranty disclaimer</h2>
      <p>
        THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT
        WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES
        OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
        NON-INFRINGEMENT.
      </p>

      <h2>11. Limitation of liability</h2>
      <p>
        TO THE FULLEST EXTENT PERMITTED BY LAW, BRIGATA WILL NOT BE LIABLE
        FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
        DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL, ARISING
        OUT OF OR IN CONNECTION WITH THE SERVICE. OUR AGGREGATE LIABILITY
        WILL NOT EXCEED THE GREATER OF (a) THE AMOUNT YOU PAID US IN THE 12
        MONTHS PRECEDING THE CLAIM, OR (b) USD $100.
      </p>

      <h2>12. Indemnification</h2>
      <p>
        You agree to defend and indemnify Brigata from any claims arising
        out of your use of the Service, your content, or your violation of
        these Terms.
      </p>

      <h2>13. Changes</h2>
      <p>
        We may update these Terms. We'll announce material changes in the
        in-app news feed and the weekly digest. Continued use after a change
        means you accept the new Terms.
      </p>

      <h2>14. Governing law</h2>
      <p>
        These Terms are governed by the laws of the State of Michigan,
        without regard to its conflict-of-laws principles, and the
        applicable laws of the United States. You and Brigata agree that
        the state and federal courts located in Michigan have exclusive
        jurisdiction over any dispute arising out of these Terms or your
        use of the Service.
      </p>

      <h2>15. Contact</h2>
      <p>
        Questions about these Terms? <a href="/contact">Get in touch</a>.
      </p>
    </StaticPage>
  )
}
