# tapflow relay

Run iOS simulators and Android emulators in any browser. Your builds, streams and recordings stay on
infrastructure you control — no device pool, no cloud uploads, no accounts on someone else's service.

**This image is the relay only.** It serves the dashboard and brokers traffic. The agents that drive
real simulators and emulators are macOS-native and run on your Macs, joining this relay over your
network.

## Where to run it

**On the same Mac, or on a box on your own network.** Not on a public cloud VM.

Every video and audio frame between an agent and a browser passes through the relay, so a relay on a
cloud VM sends app screen data outside your network — and the detour costs more latency than the
30fps budget can absorb. An always-on LAN box is the topology this image exists for.

## Quick start

```yaml
services:
  relay:
    image: tapflow/tapflow:latest
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/.tapflow/data
    environment:
      - TAPFLOW_RELAY_URL=http://<this-box-ip>:4000
      - TAPFLOW_ADMIN_EMAIL=you@example.com
      - TAPFLOW_ADMIN_PASSWORD=<at least 8 characters>
    restart: unless-stopped
```

```sh
docker compose up -d
```

**Also on GHCR**, from the same build and with the same digests:

```
ghcr.io/jo-duchan/tapflow:latest
```

Anonymous pulls here are limited to 100 per six hours per IP address, and a multi-architecture image
spends one per architecture — about 50 in practice, shared by everyone behind that address. GHCR has
no such limit for public images. Either registry serves the same thing.

Three of those lines are not optional, and each one fails in a way that is hard to read backwards.

**The volume.** The relay writes a per-install secret to `<dataDir>/jwt-secret` and reuses it.
Without the volume that file lives in the container's writable layer: `docker restart` keeps it, but
anything that *recreates* the container loses it — an image update, `docker compose down && docker
compose up -d`, `docker rm`. A new secret logs out every user and breaks every agent connection.

**`TAPFLOW_RELAY_URL`.** The relay never reads its own address from the `Host` header — a forged one
would send a phishing link out as a normal invitation — so with nothing set it falls back to
`http://localhost:4000`, and an invitation mailed to a teammate opens *their* machine. The same value
also forms the CORS and CSRF allowlist.

**`TAPFLOW_ADMIN_EMAIL` / `TAPFLOW_ADMIN_PASSWORD`.** Browser onboarding answers loopback only, and a
container reaches the relay through the bridge gateway, so it refuses — and the error tells you to run
a CLI this image does not contain. These two create the first account at startup instead. Both or
neither; at least 8 characters; and nothing happens on an install that already has an owner.

## Tags

- `latest` — the most recent release. Use this.
- `edge` — whatever is on `main` right now.
- `0.21`, `0.21.0` — pinned releases; every published version has both.
- `sha-<commit>` — a specific build.

Every tag carries `linux/amd64` and `linux/arm64`.

## Then what

Agents run on your Macs and connect outbound to this relay:

```sh
tapflow agent start --relay ws://<this-box-ip>:4000 --token <agent-scope token>
```

Full setup, TLS, tunnels and the agent side: **https://www.tapflow.dev/operate/docker**

Source and issues: **https://github.com/jo-duchan/tapflow** · MIT
