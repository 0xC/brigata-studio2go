FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg sudo openssl git \
      postgresql postgresql-contrib \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

# Remove the cluster the postgresql package auto-creates; the entrypoint creates
# a fresh one on the persistent volume at first boot.
RUN pg_dropcluster 16 main --stop 2>/dev/null || true

COPY . /opt/brigata-studio2go
WORKDIR /opt/brigata-studio2go

# Bake dependencies + build into the image so first boot is fast (npm ci is the
# slow part). The entrypoint re-runs the installer (idempotent) for DB + .env.
RUN cd server && npm ci && npm run build
RUN cd app && npm ci && npm run build

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3030
# Persist the Postgres cluster + generated config across container restarts.
VOLUME ["/var/lib/postgresql"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
