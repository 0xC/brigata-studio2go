#!/bin/bash
# Brigata Studio-to-Go — container entrypoint.
# Starts an embedded Postgres on the persistent volume, runs the standalone
# installer once (DB + migrations + .env), then launches the app on :3030.
set -e
PG_VER=16
export PGDATA="/var/lib/postgresql/${PG_VER}/main"
PERSIST="/var/lib/postgresql/s2g"     # our marker + saved .env (survives restarts)
APP="/opt/brigata-studio2go"

# The server reads BIND_HOST/PORT from the runtime env (default 127.0.0.1). In a
# container it MUST listen on 0.0.0.0 or the mapped port can't reach it. Export
# here so BOTH the installer and the final `node` exec inherit it.
export BIND_HOST="${BIND_HOST:-0.0.0.0}"
export PORT="${PORT:-3030}"

mkdir -p "$PERSIST"
chown -R postgres:postgres /var/lib/postgresql

# First boot (empty volume): create a fresh cluster on the volume.
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[entrypoint] initializing postgres cluster"
  pg_dropcluster "$PG_VER" main >/dev/null 2>&1 || true
  pg_createcluster "$PG_VER" main >/dev/null
elif [ ! -d "/etc/postgresql/${PG_VER}/main" ]; then
  # Data survived a container recreate but the cluster config (image layer) did
  # not — re-register the existing data dir without reinitializing it.
  echo "[entrypoint] re-registering existing cluster after container recreate"
  pg_createcluster "$PG_VER" main -d "$PGDATA" >/dev/null
fi
chown -R postgres:postgres /var/lib/postgresql /etc/postgresql 2>/dev/null || true

echo "[entrypoint] starting postgres"
pg_ctlcluster "$PG_VER" main start
for i in $(seq 1 30); do
  sudo -u postgres psql -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done

cd "$APP"

# Restore a previously-generated .env (survives container recreate / app update).
if [ -f "$PERSIST/server.env" ] && [ ! -f server/.env ]; then
  cp "$PERSIST/server.env" server/.env
fi

if [ ! -f "$PERSIST/.installed" ]; then
  : "${STANDALONE_ADMIN_PASSWORD:?STANDALONE_ADMIN_PASSWORD is required}"
  : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
  echo "[entrypoint] first-time install (DB + migrations + .env)"
  BIND_HOST=0.0.0.0 PG_HOST=localhost bash server/install-standalone.sh
  cp server/.env "$PERSIST/server.env"
  touch "$PERSIST/.installed"
fi

cd server
echo "[entrypoint] starting Brigata Studio on :3030"
exec node dist/index.standalone.js
