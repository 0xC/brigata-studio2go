#!/usr/bin/env bash
# =============================================================================
# Brigata Studio — one-command STANDALONE / self-host installer
# =============================================================================
# Gets you from a fresh Ubuntu/Debian host to a running single-tenant Brigata
# Studio: one admin (password login), one workspace, one Standard (in-process)
# agent. No Google OAuth, no Stripe, no Pro-tier VPS provisioning.
#
# What it does:
#   1. Checks prereqs (node >= 20, npm, psql).
#   2. Creates a local Postgres role + database (idempotent).
#   3. Runs db/migrations/*.sql in order, tracking applied files so re-runs are
#      safe (a schema_migrations table records what has already run).
#   4. Writes server/.env from server/.env.standalone.template (won't clobber an
#      existing .env unless you pass FORCE_ENV=1).
#   5. Builds the server (server/) and the web app (app/).
#   6. Prints how to start it — or emits a systemd unit if EMIT_SYSTEMD=1.
#
# Values you must supply (env vars, or you'll be prompted where interactive):
#   STANDALONE_ADMIN_PASSWORD   the shared admin login password (required)
#   ANTHROPIC_API_KEY           sk-ant-api03-... or sk-ant-oat01-... (required)
#
# Auto-generated / overridable:
#   DATABASE_URL   default postgres://brigata:<random>@localhost:5432/brigata
#   PG_DB          default "brigata"      PG_USER default "brigata"
#   PORT           default 3030           BIND_HOST default 127.0.0.1
#
# Usage:
#   STANDALONE_ADMIN_PASSWORD='...' ANTHROPIC_API_KEY='sk-ant-...' \
#     bash server/install-standalone.sh
#
# Remote access: the server binds to 127.0.0.1 by default (safe). To reach it
# from elsewhere, put a reverse proxy (Caddy/nginx) or a tunnel (cloudflared,
# tailscale) in front of it and terminate TLS there. Do NOT expose the raw port
# to the internet without TLS. See the "Next steps" printout at the end.
# =============================================================================

set -euo pipefail

# ---- pretty logging --------------------------------------------------------
step()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
warn()  { printf '\033[1;33m[!] %s\033[0m\n' "$*" >&2; }
die()   { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

# ---- locate the repo -------------------------------------------------------
# This script lives in server/, so the repo root is one level up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
SERVER_DIR="$SCRIPT_DIR"
APP_DIR="$REPO_ROOT/app"
MIGRATIONS_DIR="$REPO_ROOT/db/migrations"
ENV_TEMPLATE="$SERVER_DIR/.env.standalone.template"
ENV_FILE="$SERVER_DIR/.env"

[ -d "$MIGRATIONS_DIR" ] || die "migrations dir not found at $MIGRATIONS_DIR"
[ -f "$ENV_TEMPLATE" ]  || die "env template not found at $ENV_TEMPLATE"
[ -d "$APP_DIR" ]       || die "app dir not found at $APP_DIR"

# ---- config (env-overridable) ---------------------------------------------
PG_DB="${PG_DB:-brigata}"
PG_USER="${PG_USER:-brigata}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PORT="${PORT:-3030}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
step "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "node not found. Install Node.js 20+ (https://nodejs.org) and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node $NODE_MAJOR found; need 20+. Upgrade Node.js and re-run."
info "node $(node -v)"

command -v npm  >/dev/null 2>&1 || die "npm not found."
info "npm $(npm -v)"

command -v psql >/dev/null 2>&1 || die "psql not found. Install PostgreSQL client+server (e.g. 'sudo apt install postgresql') and re-run."
info "psql $(psql --version | awk '{print $3}')"

# A psql we can run administrative commands with. Prefer the local 'postgres'
# superuser via peer auth (sudo -u postgres), falling back to the current user.
if command -v sudo >/dev/null 2>&1 && sudo -n -u postgres psql -tAc 'SELECT 1' >/dev/null 2>&1; then
  PSQL_ADMIN=(sudo -u postgres psql)
  info "using 'sudo -u postgres psql' for admin operations"
elif psql -tAc 'SELECT 1' >/dev/null 2>&1; then
  PSQL_ADMIN=(psql)
  info "using current-user psql for admin operations"
else
  die "cannot connect to Postgres as an admin. Ensure PostgreSQL is running and either the 'postgres' superuser (peer auth) or your user can psql."
fi

# ---------------------------------------------------------------------------
# 2. Collect required secrets
# ---------------------------------------------------------------------------
step "Configuring secrets"

# Password: from env, else prompt (interactive only).
if [ -z "${STANDALONE_ADMIN_PASSWORD:-}" ]; then
  if [ -t 0 ]; then
    read -r -s -p "    Set the admin login password: " STANDALONE_ADMIN_PASSWORD; echo
  fi
fi
[ -n "${STANDALONE_ADMIN_PASSWORD:-}" ] || die "STANDALONE_ADMIN_PASSWORD is required (set env var or run interactively)."

# Anthropic key: from env, else prompt.
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  if [ -t 0 ]; then
    read -r -p "    Anthropic API key (sk-ant-api03-... or sk-ant-oat01-...): " ANTHROPIC_API_KEY
  fi
fi
[ -n "${ANTHROPIC_API_KEY:-}" ] || die "ANTHROPIC_API_KEY is required (set env var or run interactively)."

# Postgres password for the app role: reuse an existing DATABASE_URL if given,
# else generate a random one.
if [ -z "${DATABASE_URL:-}" ]; then
  if command -v openssl >/dev/null 2>&1; then
    PG_PASSWORD="$(openssl rand -hex 24)"
  else
    PG_PASSWORD="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}"
  info "generated a DATABASE_URL with a random Postgres password"
else
  info "using the DATABASE_URL you supplied"
  # Best-effort parse of user/password/db from a supplied URL for role creation.
  PG_USER="$(printf '%s' "$DATABASE_URL" | sed -n 's#^[a-z]*://\([^:/@]*\).*#\1#p')"
  PG_PASSWORD="$(printf '%s' "$DATABASE_URL" | sed -n 's#^[a-z]*://[^:]*:\([^@]*\)@.*#\1#p')"
  PG_DB="$(printf '%s' "$DATABASE_URL" | sed -n 's#.*/\([^/?]*\)\(?.*\)\{0,1\}$#\1#p')"
fi

# ---------------------------------------------------------------------------
# 3. Create the database + role (idempotent)
# ---------------------------------------------------------------------------
step "Creating Postgres role '$PG_USER' and database '$PG_DB'"

# Create role if missing, then (re)set its password to match DATABASE_URL.
"${PSQL_ADMIN[@]}" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}';
  ELSE
    ALTER ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}';
  END IF;
END
\$\$;
SQL
info "role ready"

# Create the database if missing (owned by the app role). CREATE DATABASE can't
# run inside a DO block, so guard with a shell check.
if "${PSQL_ADMIN[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'" | grep -q 1; then
  info "database '$PG_DB' already exists"
else
  "${PSQL_ADMIN[@]}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};"
  info "database '$PG_DB' created"
fi

# Make sure uuid-ossp (used by 001_initial) can be created — it needs superuser.
"${PSQL_ADMIN[@]}" -v ON_ERROR_STOP=1 -d "${PG_DB}" -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' >/dev/null

# ---------------------------------------------------------------------------
# 4. Run migrations in order, tracked so re-runs are safe
# ---------------------------------------------------------------------------
step "Applying migrations"

# We connect AS THE APP ROLE so every table/grant is owned correctly and the
# runtime user can read/write. Export a libpq-friendly connection.
export PGPASSWORD="$PG_PASSWORD"
APP_PSQL=(psql -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB")

# Ledger of applied migrations (filename PK) so this step is idempotent.
"${APP_PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());" >/dev/null

applied=0
skipped=0
# Sort by filename so numeric prefixes apply in order (handles the two 021_* files
# deterministically by lexical name).
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  base="$(basename "$f")"
  already="$("${APP_PSQL[@]}" -tAc "SELECT 1 FROM schema_migrations WHERE filename = '${base}'")"
  if [ "$already" = "1" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  info "applying $base"
  # Each migration + its ledger insert run in a single transaction so a failure
  # leaves nothing half-applied.
  "${APP_PSQL[@]}" --single-transaction \
    -f "$f" \
    -c "INSERT INTO schema_migrations (filename) VALUES ('${base}');"
  applied=$((applied + 1))
done
info "migrations: $applied applied, $skipped already present"

# ---------------------------------------------------------------------------
# 5. Write server/.env from the template
# ---------------------------------------------------------------------------
step "Writing $ENV_FILE"

if [ -f "$ENV_FILE" ] && [ "${FORCE_ENV:-0}" != "1" ]; then
  warn "$ENV_FILE already exists — leaving it untouched (set FORCE_ENV=1 to overwrite)."
else
  # Start from the template, then substitute the values we know. Anything not
  # matched keeps its template line so the operator can hand-edit later.
  tmp="$(mktemp)"
  cp "$ENV_TEMPLATE" "$tmp"
  # Use a helper that replaces a KEY=... line wholesale (values may contain
  # slashes/specials, so we build the line with printf and swap by key).
  set_kv() {
    local key="$1" val="$2"
    if grep -q "^${key}=" "$tmp"; then
      # Delete the old line, then append the new one (avoids sed escaping pain).
      grep -v "^${key}=" "$tmp" > "$tmp.next" && mv "$tmp.next" "$tmp"
    fi
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  }
  set_kv STANDALONE_MODE 1
  set_kv DATABASE_URL "$DATABASE_URL"
  set_kv ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
  set_kv STANDALONE_ADMIN_PASSWORD "$STANDALONE_ADMIN_PASSWORD"
  set_kv APP_BASE_URL "http://${BIND_HOST}:${PORT}"
  set_kv PORT "$PORT"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "wrote $ENV_FILE (mode 600)"
fi

# ---------------------------------------------------------------------------
# 6. Build server + app
# ---------------------------------------------------------------------------
step "Building server ($SERVER_DIR)"
( cd "$SERVER_DIR" && npm ci && npm run build )
info "server build ok"

step "Building web app ($APP_DIR)"
( cd "$APP_DIR" && npm ci && npm run build )
info "app build ok (static assets in $APP_DIR/dist)"

# ---------------------------------------------------------------------------
# 7. Optional systemd unit
# ---------------------------------------------------------------------------
if [ "${EMIT_SYSTEMD:-0}" = "1" ]; then
  step "Emitting systemd unit"
  UNIT_PATH="$SERVER_DIR/brigata-standalone.service"
  RUN_USER="${SUDO_USER:-$(id -un)}"
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Brigata Studio (standalone)
After=network.target postgresql.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${SERVER_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) ${SERVER_DIR}/dist/index.standalone.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  info "wrote $UNIT_PATH"
  info "install it with:"
  info "  sudo cp $UNIT_PATH /etc/systemd/system/brigata-standalone.service"
  info "  sudo systemctl daemon-reload && sudo systemctl enable --now brigata-standalone"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
step "Install complete"
cat <<DONE

  Brigata Studio (standalone) is installed.

  Start it:
      cd $SERVER_DIR
      node dist/index.standalone.js

  It will listen on http://${BIND_HOST}:${PORT} and serves BOTH the web app and
  the API — open that URL in a browser and sign in with the admin password you
  configured. No reverse proxy is needed to use it locally.

  Remote access (the server binds to ${BIND_HOST}, not the public internet):
    - Reverse proxy + TLS (recommended): Caddy or nginx in front, terminating
      HTTPS, proxying to 127.0.0.1:${PORT}. Then set SESSION_COOKIE_DOMAIN to
      your hostname in $ENV_FILE and restart.
    - Or a tunnel: cloudflared / tailscale funnel — no open ports needed.
    Do NOT expose port ${PORT} directly to the internet without TLS.

  Config lives in: $ENV_FILE
DONE
