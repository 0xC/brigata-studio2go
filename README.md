# Brigata Studio — Studio to Go

**Self-hosted, single-tenant Brigata Studio.** One admin, one workspace, one
AI agent that runs in-process on your own Anthropic key — on your own machine,
with no account on brigata.ai and nothing phoning home.

This is the same Studio engine that powers the hosted product, built in a
**standalone mode**: no Google sign-in, no billing, no cloud provisioning. You
log in with a password you set, and everything runs locally.

---

## What you need

- A Linux host (Ubuntu/Debian tested) — a laptop, a mini-PC, or a small VPS.
- **Node.js 20+** and **PostgreSQL** — install steps below.
- An **Anthropic API key** (`sk-ant-api03-…`) or a Claude subscription token
  (`sk-ant-oat01-…`, from `claude setup-token`). Your agent runs on this
  credential — you can run entirely on your Claude Pro/Max subscription, no
  separate API billing required. Nothing is shared with anyone.

### Install the prerequisites

The installer does **not** install Node or Postgres for you — it checks they're
present and sets up the database *inside* your Postgres. Install them first.

**Ubuntu / Debian:**

```bash
# Postgres (server + client; creates the 'postgres' superuser + starts the service)
sudo apt-get update
sudo apt-get install -y curl git postgresql

# Node.js 20+ (NodeSource — installs system-wide, works under systemd)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Fedora / RHEL:**

```bash
sudo dnf install -y git postgresql-server postgresql
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
```

**macOS (Homebrew):**

```bash
brew install node@22 postgresql@16
brew services start postgresql@16
```

Verify before continuing (Node must be **20 or higher**):

```bash
node -v      # v20+  (this setup gives v22 LTS)
psql --version
```

The installer creates the database role, database, and `uuid-ossp` extension
itself using the local `postgres` superuser — you don't create them by hand.

## Install

```bash
git clone https://github.com/0xC/brigata-studio2go.git
cd brigata-studio2go
STANDALONE_ADMIN_PASSWORD='choose-a-long-password' \
ANTHROPIC_API_KEY='sk-ant-...' \
  bash server/install-standalone.sh
```

The installer checks prerequisites, creates a local Postgres database, applies
the schema, writes `server/.env`, builds the server and the web app, and tells
you how to start it.

Then start it:

```bash
cd server
node dist/index.standalone.js
```

Open **http://localhost:3030** and sign in with the password you set. The first
run seeds one workspace and one agent, so you land in a working studio.

To run it as a background service, re-run the installer with `EMIT_SYSTEMD=1`
and follow the printed `systemctl` steps.

## Configuration

All settings live in `server/.env` (created from `server/.env.standalone.template`):

| Variable | What it does |
| --- | --- |
| `STANDALONE_MODE` | Must be `1`. Turns on self-host mode. |
| `DATABASE_URL` | Your local Postgres connection string. |
| `ANTHROPIC_API_KEY` | The key your agent runs on. |
| `STANDALONE_ADMIN_PASSWORD` | Your login password. |
| `PORT` | Port to listen on (default `3030`). |
| `BIND_HOST` | Interface to bind (default `127.0.0.1`). |
| `SESSION_COOKIE_DOMAIN` | Set only when serving over HTTPS on a real domain. |

## Running it on a network / the internet

The server binds to `127.0.0.1` by default, which is the safe choice. To reach
it from other machines, put a reverse proxy (Caddy or nginx) or a tunnel
(cloudflared, tailscale) in front of it and terminate TLS there — then set
`SESSION_COOKIE_DOMAIN` to your hostname. **Do not expose the raw port to the
internet without TLS.**

## What's included — and what isn't

Studio to Go is the **core** Studio runtime: workspaces, channels, agents that
run in-process on your key, documents, skills, agent memory, tasks, and the live
web UI.

It deliberately leaves out the hosted product's cloud features — team billing,
managed Pro VPS provisioning, GitHub document sync, and Discord/Matrix channel
connectors. Those depend on brigata.ai's infrastructure and aren't part of a
self-hosted install.

## Updating

Pull the latest and re-run the installer — it's idempotent and won't clobber your
`.env` or re-apply migrations that already ran.

```bash
git pull
bash server/install-standalone.sh   # rebuilds; safe to re-run
```
