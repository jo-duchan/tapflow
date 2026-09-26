---
title: External access
description: Reach the relay from outside the office through an outbound tunnel — Tailscale for tailnet members, or rathole through a VPS you own for a public URL — with optional HTTPS for the Smooth profile.
---

# External access

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

## Tailscale (recommended)

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

### Enable HTTPS for the smoother stream (optional)

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

## VPS + rathole

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

### 1. Set up Caddy for HTTPS on the VPS

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

### 2. Configure tapflow on the relay Mac

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
