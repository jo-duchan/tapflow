# Self-Hosting the Relay

The relay is a lightweight Node.js server. It only routes WebSocket traffic and serves the dashboard — no heavy compute needed.

::: info The relay URL has two uses
- **Dashboard**: Open `http://your-relay-url` in a browser to reach the dashboard.
- **Agent connection**: `tapflow agent start --relay wss://your-relay-url`
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
tapflow agent start --relay wss://your-relay-url
```

## Deployment configuration

### JWT_SECRET

::: warning Replace before deploying to a server
The default value (`tapflow-dev-secret-change-in-production`) is public in the source code. Leaving it unchanged lets anyone forge valid tokens.
:::

Generate a secure random secret:

```sh
openssl rand -hex 32
```

Inject the generated value as an environment variable when starting the relay:

```sh
JWT_SECRET=YOUR_JWT_SECRET tapflow relay start
```

Once set, keep this value stable — changing it invalidates all active sessions immediately. Only rotate if the secret is compromised or you want to force everyone to log out.

### tapflow.config.json

The relay reads `tapflow.config.json` from the working directory. See [Configuration](/reference/configuration).

## Internal access (same network)

The simplest way for teammates on the same office network to reach the dashboard.

```sh
npm install -g tapflow
JWT_SECRET=YOUR_JWT_SECRET tapflow relay start
```

Teammates connect to `http://MACHINE_LOCAL_IP:4000` in their browser. The port matches `local.port` in `tapflow.config.json` (default `4000`).

## External access

Keep the relay and agents on the same internal network at all times. External access works by opening an outbound tunnel from the relay Mac to a public endpoint — browsers connect to the public URL, which forwards traffic back to the relay.

### VPS + Tunnel (recommended)

The most reliable option for external access. Traffic passes through your own VPS, so the "data stays in your infrastructure" principle is maintained.

```text
browser → VPS (public URL) → tunnel → relay Mac (office)
                                        ↑
                                 agent Macs (same internal network)
```

The relay Mac opens an outbound tunnel to the VPS, so no port forwarding or static IP is required — CGNAT is not a problem.

#### 1. Install rathole on the VPS

```sh
curl -sL https://github.com/rathole-org/rathole/releases/download/dev-latest/rathole-dev-x86_64-unknown-linux-musl.tar.gz | tar -xz
sudo mv rathole /usr/local/bin/
```

Create the server config:

```toml
# /etc/rathole-server.toml
[server]
bind_addr = "0.0.0.0:2333"

[server.services.tapflow-relay]
token = "your-secret-token"
bind_addr = "0.0.0.0:4000"
```

Run it (add to systemd or a process manager for persistence):

```sh
rathole --server /etc/rathole-server.toml
```

#### 2. Set up Caddy for HTTPS

Caddy handles TLS automatically — no certbot needed.

```sh
sudo apt install -y caddy
```

```
# /etc/caddy/Caddyfile
your-vps.com {
    reverse_proxy localhost:4000
}
```

```sh
sudo systemctl reload caddy
```

#### 3. Configure tapflow on the relay Mac

Add the `tunnel` section to `tapflow.config.json`:

```json
{
  "tunnel": {
    "provider": "rathole",
    "serverAddr": "your-vps.com:2333",
    "publicUrl": "https://your-vps.com"
  }
}
```

Pass the token as an environment variable and start:

```sh
TAPFLOW_TUNNEL_TOKEN=your-secret-token tapflow relay start
```

The public URL is printed in the banner when the tunnel is ready. Browsers connect to `https://your-vps.com`; agents still connect to the relay's internal IP (`ws://192.168.x.x:4000`).

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

Inject the JWT_SECRET you generated above, then start:

```sh
JWT_SECRET=YOUR_JWT_SECRET pm2 start tapflow --name relay -- relay start
pm2 save
pm2 startup
```

To update tapflow:

```sh
npm update -g tapflow
pm2 restart relay
```

::: tip Next step
Once the relay is running, create the first admin account with `tapflow init`. For team invitations and your first build upload, see [First-time Setup](/dashboard/setup).
:::
