---
title: Deployment options
description: Choose where the relay runs — on the same Mac as the agent, or on a separate relay server — and how teammates on the same network reach it.
---

<a id="self-hosting-the-relay"></a>

# Deployment options

The relay is a lightweight Node.js server. It only routes WebSocket traffic and serves the dashboard — no heavy compute needed.

::: info The relay URL has two uses
- **Dashboard** — open in a browser: `http://localhost:4000` (local) or `http://192.168.x.x:4000` (team on same LAN)
- **Agent connection** — when the relay is on a separate Mac: `tapflow agent start --relay ws://192.168.x.x:4000`. The agent→relay path stays on the LAN. The scheme is `ws://`, or `wss://` when the relay has `tls` configured and serves HTTPS. Remote agents authenticate with an `agent`-scope token ([Remote relay authentication](/operate/agents#remote-relay-authentication)).
:::

## Deployment scenarios

::: tip Keep agents and the relay on the same wired LAN
The agent streams video frames to the relay continuously, so the two must share a LAN. Different floors or VLANs in one building are fine — internal routing keeps latency low — but placing an agent across the internet raises RTT and drops frames. **Wired Ethernet is recommended**; Wi-Fi works but can stutter on a Mac (AWDL), so see [Stream lag or stuttering](/troubleshooting/streaming#stream-lag) if playback hitches.
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

## Internal access (same network)

The simplest way for teammates on the same office network to reach the dashboard.

```sh
npm install -g tapflow
tapflow start
```

A single relay auto-generates its `JWT_SECRET`, so there's nothing to set here. To pin a fixed key, see [JWT_SECRET](/operate/configure#jwt-secret).

Teammates connect to `http://MACHINE_LOCAL_IP:4000` in their browser. The port matches `local.port` in `tapflow.config.json` (default `4000`).

## Moved sections {#moved-sections}

Sections that used to be on this page now live on these pages.

- [Deploy with Docker](/operate/docker)
  - <a id="docker-compose-lan-server" data-moved-to="/operate/docker#docker-compose-lan-server"></a>[Deploy with Docker](/operate/docker#docker-compose-lan-server)
- [Configuring tapflow](/operate/configure)
  - <a id="deployment-configuration" data-moved-to="/operate/configure#deployment-configuration"></a>[Deployment configuration](/operate/configure#deployment-configuration)
  - <a id="jwt-secret" data-moved-to="/operate/configure#jwt-secret"></a>[JWT_SECRET](/operate/configure#jwt-secret)
  - <a id="tapflow-config-json" data-moved-to="/operate/configure#tapflow-config-json"></a>[tapflow.config.json](/operate/configure#tapflow-config-json)
- [External access](/operate/external-access)
  - <a id="external-access" data-moved-to="/operate/external-access#external-access"></a>[External access](/operate/external-access#external-access)
  - <a id="tailscale-recommended" data-moved-to="/operate/external-access#tailscale-recommended"></a>[Tailscale (recommended)](/operate/external-access#tailscale-recommended)
  - <a id="enable-https-for-the-smoother-stream-optional" data-moved-to="/operate/external-access#enable-https-for-the-smoother-stream-optional"></a>[Enable HTTPS for the smoother stream (optional)](/operate/external-access#enable-https-for-the-smoother-stream-optional)
  - <a id="vps-rathole" data-moved-to="/operate/external-access#vps-rathole"></a>[VPS + rathole](/operate/external-access#vps-rathole)
  - <a id="_1-set-up-caddy-for-https-on-the-vps" data-moved-to="/operate/external-access#_1-set-up-caddy-for-https-on-the-vps"></a>[1. Set up Caddy for HTTPS on the VPS](/operate/external-access#_1-set-up-caddy-for-https-on-the-vps)
  - <a id="_2-configure-tapflow-on-the-relay-mac" data-moved-to="/operate/external-access#_2-configure-tapflow-on-the-relay-mac"></a>[2. Configure tapflow on the relay Mac](/operate/external-access#_2-configure-tapflow-on-the-relay-mac)
- [Backups & uptime](/operate/relay-operations)
  - <a id="backup" data-moved-to="/operate/relay-operations#backup"></a>[Backup](/operate/relay-operations#backup)
  - <a id="recommended-litestream-for-sqlite" data-moved-to="/operate/relay-operations#recommended-litestream-for-sqlite"></a>[Recommended: Litestream for SQLite](/operate/relay-operations#recommended-litestream-for-sqlite)
  - <a id="pm2-keeping-the-relay-mac-always-on" data-moved-to="/operate/relay-operations#pm2-keeping-the-relay-mac-always-on"></a>[PM2 (keeping the relay Mac always on)](/operate/relay-operations#pm2-keeping-the-relay-mac-always-on)
  - <a id="systemd-linux-relay-server" data-moved-to="/operate/relay-operations#systemd-linux-relay-server"></a>[systemd (Linux relay server)](/operate/relay-operations#systemd-linux-relay-server)
