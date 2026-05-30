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

Run the relay on a Linux server or dedicated Mac; run the agent on each Mac with a simulator.

::: tip Keep agents on the same LAN as the relay
The agent streams video frames to the relay continuously. Place agent Macs on the same LAN as the relay server — or on the same Mac — for the best streaming quality. Connecting across different networks increases latency and may cause frame drops.
:::

**On the server** (PM2 or plain Node.js — see below):

```sh
tapflow relay start
```

**On each Mac:**

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

## Internal access

The simplest way for teammates on the same network to reach the dashboard.

```sh
npm install -g tapflow
JWT_SECRET=YOUR_JWT_SECRET tapflow relay start
```

Teammates connect to `http://MACHINE_LOCAL_IP:4000` in their browser. The port matches `server.port` in `tapflow.config.json` (default `4000`).

## External access

You need an external URL when teammates access the dashboard from outside your local network, or when agents connect from a different network.

### ngrok (quick start)

The fastest way to get a public URL without setting up a domain or server.

```sh
# Terminal 1: start the relay
tapflow relay start

# Terminal 2: expose with ngrok
ngrok http 4000
```

ngrok prints a URL like `https://abc123.ngrok-free.app`. That URL is both the relay address and the dashboard address.

When connecting agents, use the `wss://` scheme:

```sh
tapflow agent start --relay wss://abc123.ngrok-free.app
```

::: warning ngrok free plan limitations
- The URL changes on every restart (fixed URL requires a paid plan).
- All traffic — including video streams — passes through ngrok servers. This conflicts with tapflow's "data stays in your infrastructure" principle.
- Use ngrok for **testing and demos only**. Use a reverse proxy for team production environments.
:::

### nginx example

::: warning WebSocket upgrade headers required
Without `Upgrade` and `Connection` headers, the agent's WebSocket connection will fail.
:::

```nginx
server {
    listen 443 ssl;
    server_name tapflow.myteam.example.com;

    ssl_certificate     /etc/letsencrypt/live/tapflow.myteam.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tapflow.myteam.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_read_timeout 3600s;
    }
}
```

### Caddy example

```
tapflow.myteam.example.com {
    reverse_proxy localhost:4000
}
```

Caddy handles TLS and WebSocket upgrades automatically.

## PM2 (recommended for servers)

Handles automatic restart on crash, restart on server reboot, and log management.

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
