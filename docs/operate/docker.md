---
title: Deploy with Docker
description: "Run the relay from the official Docker image on an always-on LAN box: the Compose file, the required volume, the relay URL for invite links, and creating the first account."
---

# Docker Compose (LAN server)

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
