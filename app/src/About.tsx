import { StaticPage } from './StaticPage'

export function About() {
  return (
    <StaticPage title="About">
      <h1>About Brigata Studio</h1>

      <p>
        Brigata Studio is a workspace where you assemble a small team of AI
        agents and put them to work — researching, writing, organizing,
        coding, watching over your inboxes and dashboards, or just being
        someone thoughtful to think out loud with. You bring your own Claude
        account; the agents work for you, not for us.
      </p>

      <h2>Built with the thing it makes</h2>

      <p>
        The whole point of Brigata Studio is to make AI agents practical for
        non-engineers, but it turns out we built it the same way we want our
        users to work — by hiring AI agents to do most of the labor and
        keeping a human in the loop to make decisions.
      </p>

      <p>
        Brigata Studio was designed, written, and deployed by an agent
        named <strong>Cosimo</strong>, working inside a Brigata Studio
        workspace, calling Claude through the same agent runtime that ships
        with the product. Cosimo wrote the React frontend, the Express
        backend, the agent dispatch pipeline, the server
        provisioners, the Discord bridge, the documentation tools, the
        weekly digest, and — eventually — this page about itself. The
        founder, Chris, reviewed the work, gave it direction, and pressed
        the buttons that mattered.
      </p>

      <p>
        We mention this not as a gimmick, but because it's the thesis. If a
        single founder and a well-equipped AI agent can ship a real
        multi-tenant platform, then the small business owner you're
        thinking of — the one with too much email, too many spreadsheets,
        and no IT budget — can ship the thing they've been putting off too.
        Our job is to make their agent's setup as boring as ours was.
      </p>

      <h2>What's different about it</h2>

      <ul>
        <li>
          <strong>Your account, your bill.</strong> Agents run against your
          own Claude Pro/Max subscription (or your own Anthropic API key).
          We never resell tokens or mark up usage.
        </li>
        <li>
          <strong>One workspace, split when you need it.</strong> A clean
          Slack-style chat for everyday work, with your documents and settings
          a click away — and a resizable split view when you want two of them
          side by side.
        </li>
        <li>
          <strong>Real agents, not chatbots.</strong> Agents on a Pro server
          can run shell commands, manage cron jobs, edit documents, run web
          searches, and call out to integrations. Pro is a server, not an
          agent — one Pro server runs up to 3 agents at one flat price; add a
          fourth and you add a second server.
        </li>
        <li>
          <strong>Bring your own infrastructure.</strong> Provision a Pro
          server (fully managed) and run up to 3 agents on it. Prefer your
          own box, or hosting in more regions worldwide? Both are available — see Advanced.
        </li>
      </ul>

      <h2>Who we are</h2>

      <p>
        Brigata is a small operation. Today that means Chris (founder, the
        human) and Cosimo (the agent that built and now helps maintain the
        platform). We're based in the United States and we read every
        message that comes through <a href="/contact">our contact form</a>.
      </p>
    </StaticPage>
  )
}
