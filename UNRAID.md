# Running Brigata Studio-to-Go on Unraid (Docker)

A single container: the Studio web UI + API + an embedded PostgreSQL, all state on
one persistent volume. **No cloud dependency, no inbound connection** — you reach it
on your LAN at `http://<tower>:3030`. The only outbound traffic is to the Anthropic
API when the agent runs (your key).

## Option A — build on the Unraid box (works today, no registry)

On the Unraid terminal:

```sh
mkdir -p /mnt/user/appdata/brigata-studio2go
cd /tmp && rm -rf brigata-studio2go
git clone -b unraid-docker https://github.com/0xC/brigata-studio2go.git
cd brigata-studio2go
docker build -t brigata-s2g:local .
docker run -d --name brigata-studio2go --restart unless-stopped \
  -e STANDALONE_ADMIN_PASSWORD='choose-a-password' \
  -e ANTHROPIC_API_KEY='sk-ant-api03-...' \
  -p 3030:3030 \
  -v /mnt/user/appdata/brigata-studio2go:/var/lib/postgresql \
  brigata-s2g:local
```

Open `http://<tower-ip>:3030` and sign in with the admin password. First boot
initializes the database + builds (~1 min); after that it's fast. The DB and config
persist in `appdata`, so container updates/recreates keep your data.

### Optional homelab access (for "have the agent manage my NVR" etc.)
Add these to `docker run` — both are **opt-in and powerful**:
```sh
  -v /mnt/user:/mnt/user \                     # read/write your shares (e.g. Frigate config)
  -v /var/run/docker.sock:/var/run/docker.sock # let the agent manage containers (ROOT-EQUIVALENT)
```

## Option B — one-click via GHCR + Community App template

Once the image is published to `ghcr.io/0xc/brigata-studio2go` (needs a token with
`write:packages`), add the `brigata-studio2go.xml` template to
`/boot/config/plugins/dockerMan/templates-user/` and install from Unraid's Docker tab —
just fill in the admin password, Anthropic key, and data path.

## Notes
- `BIND_HOST` defaults to `0.0.0.0` inside the container (required so the mapped port works).
- Don't expose port 3030 to the internet without TLS — put a reverse proxy (Caddy/nginx)
  or a tunnel (Tailscale/cloudflared) in front, and set `SESSION_COOKIE_DOMAIN`.
- Image is ~1.95 GB (Ubuntu + Postgres + Node + built assets).
