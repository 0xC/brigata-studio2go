#!/bin/bash
# Brigata Studio-to-Go — container entrypoint.
# Runs an embedded Postgres whose ENTIRE state (config + data) lives in one dir
# on the persistent volume, then runs the standalone installer once and launches
# the app on :3030. Keeping config inside PGDATA (not Ubuntu's /etc/postgresql
# split) is what makes a container recreate — i.e. an Unraid app update — safe.
set -e
PGBIN="/usr/lib/postgresql/16/bin"
export PGDATA="/var/lib/postgresql/data"   # self-contained cluster on the volume
PERSIST="/var/lib/postgresql/s2g"          # install marker + saved .env
APP="/opt/brigata-studio2go"

mkdir -p "$PERSIST" "$PGDATA" /var/run/postgresql
chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql

# First boot only: initialize the cluster into the volume.
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[entrypoint] initializing postgres cluster in $PGDATA"
  su postgres -c "$PGBIN/initdb -D $PGDATA --auth-local=peer --auth-host=scram-sha-256" >/dev/null
  {
    echo "unix_socket_directories = '/var/run/postgresql'"
    echo "listen_addresses = 'localhost'"
  } >> "$PGDATA/postgresql.conf"
fi
chown -R postgres:postgres "$PGDATA"

echo "[entrypoint] starting postgres"
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -w -t 60 -l /var/lib/postgresql/pg.log start"
for i in $(seq 1 30); do
  su postgres -c "psql -tAc 'SELECT 1'" >/dev/null 2>&1 && break
  sleep 1
done

cd "$APP"
export BIND_HOST="${BIND_HOST:-0.0.0.0}" PORT="${PORT:-3030}"

# Restore a previously-generated .env (survives container recreate / app update).
if [ -f "$PERSIST/server.env" ] && [ ! -f server/.env ]; then
  cp "$PERSIST/server.env" server/.env
fi

if [ ! -f "$PERSIST/.installed" ]; then
  : "${STANDALONE_ADMIN_PASSWORD:?STANDALONE_ADMIN_PASSWORD is required}"
  : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
  echo "[entrypoint] first-time install (DB + migrations + .env)"
  PG_HOST=localhost bash server/install-standalone.sh
  cp server/.env "$PERSIST/server.env"
  touch "$PERSIST/.installed"
fi

cd server
echo "[entrypoint] starting Brigata Studio on :3030"
exec node dist/index.standalone.js
