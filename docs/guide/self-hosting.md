# Self-Hosting the Relay

The relay is a lightweight Node.js server. It only routes WebSocket traffic and serves the dashboard — no heavy compute needed.

::: info The relay URL has two uses
- **Dashboard** — open in a browser: `http://localhost:4000` (local) or `http://192.168.x.x:4000` (team on same LAN)
- **Agent connection** — when the relay is on a separate Mac: `tapflow agent start --relay ws://192.168.x.x:4000`. The agent→relay path stays on the LAN. The scheme is `ws://`, or `wss://` when the relay has `tls` configured and serves HTTPS. Remote agents authenticate with an `agent`-scope token ([Remote relay authentication](/operate/agents#remote-relay-authentication)).
:::

## Deployment scenarios

::: tip Keep agents and the relay on the same wired LAN
The agent streams video frames to the relay continuously, so the two must share a LAN. Different floors or VLANs in one building are fine — internal routing keeps latency low — but placing an agent across the internet raises RTT and drops frames. **Wired Ethernet is recommended**; Wi-Fi works but can stutter on a Mac (AWDL), so see [Stream lag or stuttering](/guide/troubleshooting#stream-lag) if playback hitches.
:::

### Docker Compose (LAN server)

You can run the relay via Docker on an always-on LAN box. This provides a clean deployment using the official image, freeing you from installing Node.js globally.

```sh
docker pull tapflow/tapflow:latest
```

::: tip Hitting Docker Hub's pull limit? The same image is on GHCR
Docker Hub limits anonymous pulls to 100 per six hours per IP address, and a multi-architecture image spends one of those per architecture — so roughly 50 in practice, shared by everyone behind the same address. A CI runner or an office network can reach that without anyone doing anything unusual.

The identical image is published to the GitHub Container Registry, which has no such limit for public images:

```sh
docker pull ghcr.io/jo-duchan/tapflow:latest
```

Both registries receive the same digests from the same build, so `latest` and a version tag mean the same thing on either. Swap the `image:` line in the Compose file below if you prefer it.
:::

Create a `docker-compose.yml`:

```yaml
services:
  relay:
    image: tapflow/tapflow:latest
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/.tapflow/data
    restart: unless-stopped
```

Start the container:

```sh
docker compose up -d
```

::: warning Set `publicUrl`, or invite links point at the recipient's own machine
The relay never infers its address from the `Host` header — deliberately, because a forged one would
send a phishing link out as a normal invitation. With nothing configured it falls back to
`http://localhost:4000`, so an invitation mailed to a teammate opens *their* machine and fails.

Set `TAPFLOW_RELAY_URL` to the address people will actually type, in the same `environment:` block
as the variables below:

```yaml
    environment:
      - TAPFLOW_RELAY_URL=http://<docker-box-ip>:4000
```

An environment variable rather than the config file, because the relay reads `tapflow.config.json`
from its install directory, which `TAPFLOW_HOME` in the image pins to `/app`, while the Compose
volume mounts `/app/.tapflow/data` — so a file placed in the volume is never opened. The same value also goes into the
CORS and CSRF allowlist, which a proxied deployment needs.
:::

::: warning Create the first account before you open the browser
The browser onboarding at `/setup` answers only requests from loopback, and a container reaches the
relay through the bridge gateway — so the page shows no form. It points to `tapflow admin init`
on the host, which the relay-only image does not contain. Set `TAPFLOW_ADMIN_EMAIL` and
`TAPFLOW_ADMIN_PASSWORD` and the relay creates the account as it starts. Both must be set — with only
one the relay refuses to start — and the password must be at least 8 characters. On an install that
already has an owner it does nothing. The
details, including which `.env` file is read, are in
[Configuration](/reference/configuration#create-the-first-admin-account-in-a-docker-container-tapflow-admin-email).
:::

::: danger A volume is mandatory
Notice the `./data:/app/.tapflow/data` volume above. It is strictly required. The relay writes a per-install secret to `<dataDir>/jwt-secret` and reuses it; without the volume that file lives in the container's writable layer. `docker restart` keeps it, because the layer survives — but anything that **recreates** the container loses it, including an image update, `docker compose down && docker compose up -d`, and `docker rm`. A new secret instantly logs out every user and breaks all agent connections.
:::

**Topology:** The container runs the relay *only*. Agents (which drive real simulators) must still run on Macs on your LAN, connecting outbound to this Docker server using an `agent`-scope token (`tapflow agent start --relay ws://<docker-box-ip>:4000 --token ...`).

**A tunnel or proxy in the same network namespace:** set `TAPFLOW_TUNNEL_PORT` (or `local.tunnelPort`) and point it at the port it names. The relay does not ask connections that reach it over loopback to sign in, and a proxy sharing the container's namespace reaches it that way. Nothing here opens the tunnel port from a `tunnel` config: that is what `tapflow start` and `tapflow relay start` do, and this image runs neither. Naming the port is what opens it. A proxy on another host reaches the relay over the bridge and is remote already, so it needs nothing.

::: danger Do not deploy the relay directly to a cloud service
Deploying the Docker container to fly.io or similar services puts the agent→relay path over the internet. RTT then exceeds the 30fps threshold (33ms/frame), causing persistent frame drops with no way to recover. tapflow does not support this configuration.
:::

### Local (single Mac)

Run the relay and agent on the same Mac at once.

```sh
tapflow start
```

### Team (separate relay server)

Run the relay on a dedicated Mac; run the agent on each Mac with a simulator.

**On the relay Mac:**

```sh
tapflow relay start
```

**On each agent Mac:**

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

The relay runs on a different machine than the agents, so an `agent`-scope token is required. See [Remote relay authentication](/operate/agents#remote-relay-authentication) for how to create one.

## Deployment configuration

### JWT_SECRET

If you don't set `JWT_SECRET`, the relay generates a strong per-install secret on first boot and persists it to the data directory (`jwt-secret`, owner-only). No action is required for a single relay.

Set it explicitly only when you need a fixed key — for example, to share one secret across multiple relay instances. Generate a secure random value:

```sh
openssl rand -hex 32
```

Put it in the `.env` in the data directory (`~/.tapflow/data/.env` on a default install) so it survives restarts without re-exporting — the relay reads the file on start:

```ini
JWT_SECRET=YOUR_JWT_SECRET
```

Or inject it as a shell environment variable, which takes precedence over the file:

```sh
JWT_SECRET=YOUR_JWT_SECRET tapflow start
```

Once set, keep this value stable — changing it invalidates all active sessions immediately. Only rotate if the secret is compromised or you want to force everyone to log out.

### tapflow.config.json

The relay reads `tapflow.config.json` from this machine's install directory — `~/.tapflow` by default, or wherever `TAPFLOW_HOME` points. On a server, set `TAPFLOW_HOME` in the service environment so the unit, your shell and any `tapflow` command you run by hand all mean the same install. See [Configuration](/reference/configuration).

## Internal access (same network)

The simplest way for teammates on the same office network to reach the dashboard.

```sh
npm install -g tapflow
tapflow start
```

A single relay auto-generates its `JWT_SECRET`, so there's nothing to set here. To pin a fixed key, see [JWT_SECRET](#jwt-secret) above.

Teammates connect to `http://MACHINE_LOCAL_IP:4000` in their browser. The port matches `local.port` in `tapflow.config.json` (default `4000`).

## External access

Keep the relay and agents on the same internal network at all times. External access works by opening an outbound tunnel from the relay Mac to a public endpoint — browsers connect to the public URL, which forwards traffic back to the relay.

The relay requires authentication on every connection that does not come from localhost. Browsers authenticate by signing in; agents authenticate with an `agent`-scope token — the agent side is covered in [Remote relay authentication](/operate/agents#remote-relay-authentication).

tapflow supports two tunnel providers:

::: tip tapflow init writes the tunnel config for you
The `tunnel` blocks shown below can be generated interactively — run `tapflow init` and pick a provider. See [Configuring tapflow](/operate/configure). The sections here cover the resulting config and the provider-side setup.
:::

| | Tailscale | VPS + rathole |
|---|-----------|---------------|
| **Setup** | Install app + sign in | VPS with SSH access required |
| **Cost** | Free (≤ 6 users) or paid | VPS running cost |
| **Who can connect** | Tailscale tailnet members only | Anyone with the URL |
| **Best for** | Internal teams | External collaborators, public demos |

### Tailscale (recommended)

[Tailscale](https://tailscale.com) is a zero-config VPN built on WireGuard. It creates an encrypted overlay network (a "tailnet") across your devices — no VPS, no port forwarding, no static IP required.

```text
browser (tailnet) ──[WireGuard E2E]──► relay Mac (tailnet)
                                             ↑
                                      agent Macs (same internal network)
```

Traffic never leaves your infrastructure in plaintext. Even when Tailscale's DERP relay is used as a fallback, only encrypted WireGuard packets pass through — Tailscale servers cannot decrypt them.

**Prerequisites**: Install Tailscale on the relay Mac and on every browser machine that needs access.

- [Download Tailscale →](https://tailscale.com/download) — macOS, Windows, Linux, iOS, Android
- Free plan: up to 6 users · [Pricing →](https://tailscale.com/pricing)

1. Install and connect Tailscale on the relay Mac:

```sh
brew install tailscale   # macOS
sudo tailscale up
```

2. Add the `tunnel` section to `tapflow.config.json`:

```json
{
  "tunnel": {
    "provider": "tailscale"
  }
}
```

3. Start. The command depends on your deployment scenario.

If you run the relay and agent on the same Mac:

```sh
tapflow start
```

If the relay runs on a dedicated Mac:

```sh
tapflow relay start
```

tapflow reads the Tailscale MagicDNS hostname (or tailnet IP) automatically and prints the public URL in the banner. Teammates with Tailscale installed connect to that URL in their browser.

::: tip Custom URL
Set `"publicUrl": "http://your-hostname.tailnet.ts.net:4000"` in the tunnel config to override the auto-detected URL.
:::

::: info Agents stay on the internal network
Tailscale only provides the browser→relay path. Agents (simulator Macs) still connect to the relay's internal IP over your LAN — no change needed there.
:::

::: warning Run tailscaled with a TUN device
The relay does not ask connections that reach the relay port over loopback to sign in. In userspace-networking mode (`tailscaled --tun=userspace-networking`, common in containers), Tailscale hands every tailnet connection to the relay from inside the relay's machine, so those visitors skip sign-in. Use the default TUN mode. `tapflow start` and `tapflow relay start` warn when they detect userspace networking.
:::

#### Enable HTTPS for the smoother stream (optional)

The default Tailscale URL is plain HTTP, and tailnet addresses count as external, so teammates get a stream trimmed to 1000 px and decoded by the WASM decoder. Terminating over Tailscale's free HTTPS brings them in through the tunnel port, which moves them to the Smooth profile, with native resolution and hardware decoding (see [Streaming Quality](/operate/streaming-quality)). Tailscale issues and renews the `*.ts.net` certificate automatically, so no domain or DNS token is needed.

1. In the Tailscale admin console under **DNS**, enable **MagicDNS** and **HTTPS Certificates**. You'll acknowledge that machine names appear in the public Certificate Transparency log.
2. On the relay Mac, terminate HTTPS in front of the relay's **tunnel port**. That is `4001`, unless you set `TAPFLOW_TUNNEL_PORT` or the relay itself runs on 4001, in which case it steps aside to 4002. The start banner prints the port it took, so use that number in the command below. Tailscale manages the certificate for you, so there's no separate issue step:

```sh
tailscale serve --bg 4001
```

::: warning Serve the tunnel port, not 4000
`tailscale serve` connects to the relay from the relay Mac itself. On port `4000` the relay treats those connections as local and does not ask them to sign in. On the tunnel port every connection counts as remote. If an earlier setup serves `4000`, run `tailscale serve reset` and then the command above. `tapflow start` warns while the old setting is in place.
:::

3. Point `publicUrl` at the HTTPS address in `tapflow.config.json` so the banner and shared URL match:

```json
{
  "tunnel": {
    "provider": "tailscale",
    "publicUrl": "https://your-hostname.tailnet.ts.net"
  }
}
```

Teammates opening that HTTPS address now get the Smooth profile. The relay itself stays on HTTP and needs no `tls` config — Tailscale terminates TLS in front of it.

### VPS + rathole

Use this when you need a fully public URL — for external collaborators, anonymous demos, or when Tailscale isn't an option. Traffic is routed through a VPS you own.

```text
browser → VPS (public URL) → tunnel → relay Mac (office)
                                        ↑
                                 agent Macs (same internal network)
```

tapflow uses [rathole](https://github.com/rapiz1/rathole) — a lightweight reverse tunnel — to open an outbound connection from the relay Mac to your VPS. tapflow manages rathole automatically: it downloads, installs, and starts rathole on the VPS on first run. No manual setup on the VPS is needed.

**Prerequisites**:
- A VPS with SSH access. Any provider works (1 vCPU + 512 MB RAM is enough). Popular choices: [Hetzner](https://www.hetzner.com), [DigitalOcean](https://www.digitalocean.com), [Vultr](https://www.vultr.com).
- A domain or [sslip.io](https://sslip.io) for HTTPS (handled by [Caddy](https://caddyserver.com)).
- `TAPFLOW_TUNNEL_TOKEN` — a secret string you choose. This is shared between the relay Mac and the rathole server to authenticate the tunnel. Pick any random value; keep it private.

The relay Mac opens an outbound tunnel to the VPS over SSH, so no port forwarding or static IP is required — CGNAT is not a problem.

#### 1. Set up Caddy for HTTPS on the VPS

Caddy handles TLS automatically — no certbot needed.

```sh
sudo apt install -y caddy
```

```caddyfile
# /etc/caddy/Caddyfile
your-vps.com {
    reverse_proxy localhost:4000
}
```

```sh
sudo systemctl reload caddy
```

::: tip No domain? Use sslip.io
If you don't own a domain, `<YOUR_VPS_IP>.sslip.io` works as a free HTTPS endpoint — for example `https://1.2.3.4.sslip.io`. Caddy issues a Let's Encrypt certificate automatically.
:::

#### 2. Configure tapflow on the relay Mac

Add the `tunnel` section to `tapflow.config.json`:

```json
{
  "tunnel": {
    "provider": "rathole",
    "serverAddr": "your-vps.com:2333",
    "publicUrl": "https://your-vps.com",
    "ssh": {
      "host": "your-vps.com",
      "user": "ubuntu",
      "keyPath": "~/.ssh/id_ed25519"
    }
  }
}
```

Put the tunnel token in the `.env` in the data directory (`~/.tapflow/data/.env` on a default install):

```ini
TAPFLOW_TUNNEL_TOKEN=your-secret-token
```

Then start. If you run the relay and agent on the same Mac:

```sh
tapflow start
```

If the relay runs on a dedicated Mac:

```sh
tapflow relay start
```

tapflow connects to the VPS over SSH, downloads and installs rathole automatically on first run, then starts both the VPS-side server and the local tunnel client. The public URL is printed in the banner when the tunnel is ready.

Browsers connect to `https://your-vps.com`; agents still connect to the relay's internal IP (`ws://192.168.x.x:4000`).

On the relay Mac, the tunnel hands visitors to the relay's **tunnel port** (`127.0.0.1:4001`), not to `4000`. The relay counts every connection on that port as remote, even though it comes from the Mac itself, so visitors sign in and tools present a token. If `4001` is taken, set `TAPFLOW_TUNNEL_PORT`; tapflow points the tunnel at whichever port the banner shows.

::: tip VPS firewall
Open ports `2333/tcp` (rathole) and `443/tcp` (Caddy) on the VPS. Keep port `4000` closed. Caddy reaches it from inside the VPS, and a direct connection would skip TLS.
:::

::: danger Do not deploy the relay directly to a cloud service
Deploying the relay to fly.io, Railway, or similar services puts the agent→relay path over the internet. RTT then exceeds the 30fps threshold (33ms/frame), causing persistent frame drops with no way to recover. tapflow does not support this configuration.
:::

## Backup

The relay keeps its durable state under the resolved data directory — `~/.tapflow/data/` on a default install, or `<install>/.tapflow/data/` for one that lives in its own folder from an earlier version. `tapflow start` and `tapflow relay start` print the directory they resolved; `TAPFLOW_DATA_DIR` overrides `local.dataDir`. Back that directory up before OS upgrades, relay migration, or any long-running team pilot.

If you are upgrading from a version that stored state in `.tapflow-data/`, nothing breaks: a pinned `local.dataDir` is honored and a config-less install keeps reading the existing `.tapflow-data/`. Stop the relay and run `tapflow migrate data-dir` once to adopt the unified layout: it atomically renames `.tapflow-data/` → `.tapflow/data/` (no copy, no data loss), repoints `local.dataDir` when it pinned the old default, and updates `.gitignore`.

The paths below are inside that data directory — the one on the `Data →` line `tapflow start` prints.

Important paths:

| Path | Why it matters |
|------|----------------|
| `tapflow.db` | SQLite database for accounts, apps, builds, sessions, comments, tokens, and settings. |
| `tapflow.db-wal` / `tapflow.db-shm` | SQLite WAL sidecar files. Include them in filesystem snapshots, or use Litestream so changes are captured safely. |
| `uploads/` | Uploaded build artifacts served by the relay. |
| `recordings/` | Session recordings uploaded through the relay. |
| `.env` and `jwt-secret` | Relay secrets. Keep them private and restore them with the data directory so existing sessions and integrations keep working. |

### Recommended: Litestream for SQLite

[Litestream](https://litestream.io/) is an external process; tapflow does not bundle, install, or supervise it. Litestream streams SQLite WAL changes to object storage such as AWS S3, Cloudflare R2, Backblaze B2, or any S3-compatible endpoint. It does not require tapflow schema changes or a separate database server.

Install Litestream on the relay host:

```sh
brew install litestream
```

On Linux, install the Litestream release binary for your architecture from the official releases page.

Create `litestream.yml` next to your tapflow config, with an absolute database path — Litestream resolves a relative one against its own working directory, which is not necessarily the install:

```yaml
dbs:
  - path: /Users/you/.tapflow/data/tapflow.db
    replicas:
      - type: s3
        bucket: YOUR_BUCKET
        path: tapflow/relay/tapflow.db
        endpoint: YOUR_S3_ENDPOINT
```

Set the credentials required by your storage provider, then run Litestream alongside the relay:

```sh
litestream replicate -config litestream.yml
```

If you use PM2, keep the relay and Litestream as separate processes so each can restart independently:

```sh
pm2 start tapflow --name relay -- relay start
pm2 start litestream --name relay-backup -- replicate -config litestream.yml
pm2 save
```

Restore the database before starting tapflow on a new host:

```sh
DATA_DIR=/Users/you/.tapflow/data   # ~/.tapflow/data, $TAPFLOW_HOME/data, or your TAPFLOW_DATA_DIR
litestream restore -config litestream.yml -if-replica-exists "$DATA_DIR/tapflow.db"
```

Work the directory out from those rules rather than by starting tapflow to see what it prints: the first start creates an empty `tapflow.db`, and `litestream restore` will not overwrite a database that already exists.

Then restore `uploads/`, `recordings/`, `.env`, and `jwt-secret` inside that same data directory from your file backup. Litestream protects the SQLite database only; build files, recordings, and secrets still need a normal filesystem or object-storage backup.

## PM2 (keeping the relay Mac always on)

Handles automatic restart on crash, restart on server reboot, and log management — run this on the relay Mac.

```sh
npm install -g pm2 tapflow
```

With `JWT_SECRET` in the data directory's `.env` (`~/.tapflow/data/.env` on a default install), or left unset to auto-generate, start:

```sh
pm2 start tapflow --name relay -- relay start
pm2 save
pm2 startup
```

To update tapflow:

```sh
npm update -g tapflow
pm2 restart relay
```

::: tip Next step
Once the relay is running, open `http://localhost:4000` in a browser — the dashboard redirects to the setup page automatically. For headless servers, use `tapflow admin init` instead. It asks for an email and a password, so run it from a terminal rather than from a provisioning script. For team invitations and your first build upload, see [First-time Setup](/dashboard/setup).
:::

## systemd (Linux relay server)

Use systemd when the relay runs on a Linux host and you want it to start at boot, restart after crashes, and write logs to journald. Install tapflow globally first:

```sh
npm install -g tapflow
```

Create a dedicated user and data directory:

```sh
sudo useradd --system --create-home --home-dir /var/lib/tapflow --shell /usr/sbin/nologin tapflow
sudo mkdir -p /etc/tapflow /var/lib/tapflow/.tapflow/data
sudo chown -R tapflow:tapflow /var/lib/tapflow
```

Put relay secrets in `/etc/tapflow/relay.env`. The existing [JWT_SECRET](#jwt-secret) section also describes the `.env` convention that the relay reads directly from its data directory:

```ini
TAPFLOW_DATA_DIR=/var/lib/tapflow/.tapflow/data
JWT_SECRET=YOUR_JWT_SECRET
```

`TAPFLOW_HOME` alone would put the data in `/var/lib/tapflow/data`. `TAPFLOW_DATA_DIR` is named here anyway, so this unit matches a server set up before the install directory existed and keeps its data where it already is. To use the shorter layout on a fresh server, drop the line and change `/var/lib/tapflow/.tapflow/data` in the `mkdir` above to `/var/lib/tapflow/data`. As long as a `.tapflow/data` folder exists, even an empty one, the relay treats it as existing data and keeps using it.

Generate `JWT_SECRET` with `openssl rand -hex 32`, then keep `/etc/tapflow/relay.env` readable only by root:

```sh
sudo chmod 600 /etc/tapflow/relay.env
```

Create `/etc/systemd/system/tapflow-relay.service`:

```ini
[Unit]
Description=tapflow relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tapflow
Group=tapflow
WorkingDirectory=/var/lib/tapflow
Environment=TAPFLOW_HOME=/var/lib/tapflow
EnvironmentFile=/etc/tapflow/relay.env
ExecStart=/usr/bin/env tapflow relay start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/tapflow

[Install]
WantedBy=multi-user.target
```

The hardening directives keep the filesystem read-only except for
`/var/lib/tapflow`, which contains the `TAPFLOW_DATA_DIR` set above. The relay
writes nowhere else, so nothing further needs opening — but if you move
`TAPFLOW_DATA_DIR`, add its new path to `ReadWritePaths` too.

With one exception: `ProtectHome=true` makes `/home`, `/root` and `/run/user`
unreachable outright, and `ReadWritePaths` cannot open a path back up inside
them. A data directory in any of those is invisible to the service no matter
what you list. Keep it elsewhere, or switch to `ProtectHome=read-only`. This is
also why the `tapflow` user is given a home in `/var/lib/tapflow` above rather
than under `/home`.

Place `tapflow.config.json` in `/var/lib/tapflow` if you need to customize the port or other settings, because `TAPFLOW_HOME` above makes that the install directory. Set the same variable in your own shell before running `tapflow` commands by hand, or they will read the default install in your home directory instead of the service's.

Run a smoke test before enabling the service, so a problem arrives as a message
you can read instead of a unit that restarts every five seconds. `systemd-run`
applies the same sandbox the unit will, which a plain `sudo -u tapflow` would
not — the directives above are what most often turn out to be the problem:

```sh
sudo systemd-run --pty --unit=tapflow-smoke   --property=User=tapflow --property=Group=tapflow   --property=WorkingDirectory=/var/lib/tapflow   --property=Environment=TAPFLOW_HOME=/var/lib/tapflow   --property=EnvironmentFile=/etc/tapflow/relay.env   --property=NoNewPrivileges=true   --property=ProtectSystem=strict   --property=ProtectHome=true   --property=PrivateTmp=true   --property=ReadWritePaths=/var/lib/tapflow   /usr/bin/env tapflow relay start
```

In another shell, confirm the relay answers. Give it the URL rather than relying
on the default: `tapflow status` reads *your* configuration to find the relay,
not the service's, so a port set in `/var/lib/tapflow/tapflow.config.json` is
one this shell does not know about.

Copy the address the command above printed on startup — `Relay : …`. `--relay`
accepts it as-is and switches the scheme itself, so a TLS deployment needs no
edit:

```sh
tapflow status --relay http://localhost:4000   # whatever `Relay :` said
```

Stop the foreground relay with Ctrl-C once the status check passes.

Enable and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tapflow-relay
sudo systemctl status tapflow-relay
```

View logs with:

```sh
journalctl -u tapflow-relay -f
```

After updating the global package, restart the service:

```sh
npm update -g tapflow
sudo systemctl restart tapflow-relay
```
