# Self-Hosting the Relay

The relay is a lightweight Node.js server. It only routes WebSocket traffic and serves the dashboard — no heavy compute needed.

::: info The relay URL has two uses
- **Dashboard** — open in a browser: `http://localhost:4000` (local) or `http://192.168.x.x:4000` (team on same LAN)
- **Agent connection** — when the relay is on a separate Mac: `tapflow agent start --relay ws://192.168.x.x:4000`. The agent→relay path always uses LAN `ws://`, and remote agents authenticate with an `agent`-scope token ([Remote relay authentication](/guide/agent#remote-relay-authentication)).
:::

## Deployment scenarios

### Local (single Mac)

Run the relay and agent on the same Mac at once.

```sh
tapflow start
```

### Team (separate relay server)

Run the relay on a dedicated Mac; run the agent on each Mac with a simulator.

::: tip Keep agents and the relay on the same internal network
The agent streams video frames to the relay continuously. Agents and relay can be on different floors or VLANs within the same office building — internal routing keeps latency low enough. Placing agents across the internet on a different network increases RTT and causes frame drops.
:::

**On the relay Mac:**

```sh
tapflow relay start
```

**On each agent Mac:**

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

The relay runs on a different machine than the agents, so an `agent`-scope token is required. See [Remote relay authentication](/guide/agent#remote-relay-authentication) for how to create one.

## Deployment configuration

### JWT_SECRET

If you don't set `JWT_SECRET`, the relay generates a strong per-install secret on first boot and persists it to the data directory (`jwt-secret`, owner-only). No action is required for a single relay.

Set it explicitly only when you need a fixed key — for example, to share one secret across multiple relay instances. Generate a secure random value:

```sh
openssl rand -hex 32
```

Put it in `.tapflow-data/.env` so it survives restarts without re-exporting — the relay reads the file on start:

```ini
JWT_SECRET=YOUR_JWT_SECRET
```

Or inject it as a shell environment variable, which takes precedence over the file:

```sh
JWT_SECRET=YOUR_JWT_SECRET tapflow start
```

Once set, keep this value stable — changing it invalidates all active sessions immediately. Only rotate if the secret is compromised or you want to force everyone to log out.

### tapflow.config.json

The relay reads `tapflow.config.json` from the working directory. See [Configuration](/reference/configuration).

## Internal access (same network)

The simplest way for teammates on the same office network to reach the dashboard.

For the smoothest stream, run the agent and relay over a wired LAN. See [Stream lag or stuttering](/guide/troubleshooting#stream-lag) if playback hitches.

```sh
npm install -g tapflow
tapflow start
```

A single relay auto-generates its `JWT_SECRET`, so there's nothing to set here. To pin a fixed key, see [JWT_SECRET](#jwt-secret) above.

Teammates connect to `http://MACHINE_LOCAL_IP:4000` in their browser. The port matches `local.port` in `tapflow.config.json` (default `4000`).

## External access

Keep the relay and agents on the same internal network at all times. External access works by opening an outbound tunnel from the relay Mac to a public endpoint — browsers connect to the public URL, which forwards traffic back to the relay.

The relay requires authentication on every connection that does not come from localhost. Browsers authenticate by signing in; agents authenticate with an `agent`-scope token — the agent side is covered in [Remote relay authentication](/guide/agent#remote-relay-authentication).

tapflow supports two tunnel providers:

::: tip tapflow init writes the tunnel config for you
The `tunnel` blocks shown below can be generated interactively — run `tapflow init` and pick a provider. See [Configuring tapflow](/guide/configure). The sections here cover the resulting config and the provider-side setup.
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

#### Enable HTTPS for the sharper stream (optional)

The default URL is `http://...ts.net:4000`, so the browser uses software decode (the Standard profile). To unlock hardware decode (WebCodecs), terminate the relay over Tailscale's free HTTPS. Tailscale issues and renews the `*.ts.net` certificate automatically, so no domain or DNS token is needed.

1. In the Tailscale admin console under **DNS**, enable **MagicDNS** and **HTTPS Certificates**. You'll acknowledge that machine names appear in the public Certificate Transparency log.
2. On the relay Mac, terminate the relay port over HTTPS. Tailscale manages the certificate for you, so there's no separate issue step:

```sh
tailscale serve 4000
```

3. Point `publicUrl` at the HTTPS address in `tapflow.config.json` so the banner and shared URL match:

```json
{
  "tunnel": {
    "provider": "tailscale",
    "publicUrl": "https://your-hostname.tailnet.ts.net"
  }
}
```

Teammates opening that HTTPS address now get a secure context and a hardware-decode profile. The relay itself stays on HTTP (4000) and needs no `tls` config — Tailscale terminates TLS in front of it. See [Streaming Quality](/guide/streaming) for the profiles.

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

Put the tunnel token in `.tapflow-data/.env`:

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

::: tip VPS firewall
Open ports `2333/tcp` (rathole) and `443/tcp` (Caddy) on the VPS. Port `4000` does not need to be public — Caddy proxies it internally.
:::

::: danger Do not deploy the relay directly to a cloud service
Deploying the relay to fly.io, Railway, or similar services puts the agent→relay path over the internet. RTT then exceeds the 30fps threshold (33ms/frame), causing persistent frame drops with no way to recover. tapflow does not support this configuration.
:::

## PM2 (keeping the relay Mac always on)

Handles automatic restart on crash, restart on server reboot, and log management — run this on the relay Mac.

```sh
npm install -g pm2 tapflow
```

With `JWT_SECRET` in `.tapflow-data/.env` (or left unset to auto-generate), start:

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
Once the relay is running, open `http://localhost:4000` in a browser — the dashboard redirects to the setup page automatically. For headless servers, use `tapflow admin init` instead. For team invitations and your first build upload, see [First-time Setup](/dashboard/setup).
:::
