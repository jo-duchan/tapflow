# tapflow

tapflow is an open-source, self-hosted device streaming and remote manual QA platform. It connects physical Mac agents (which drive iOS Simulators and Android emulators) to a central relay, making those devices accessible from a web browser for your entire team.

This Docker image is the **Relay server** component, which also serves the web dashboard.

## Deployment

The relay container is meant to run on an **always-on LAN server**, while Macs run the `tapflow agent` and connect out to this relay over the same LAN.

> **Warning:** Do not deploy this image to public cloud services (e.g. fly.io) when agents run locally on your Macs. tapflow streams 30fps video, and routing it over the internet introduces latency that breaks the required 33ms/frame round-trip time. Keep the relay on your LAN.

## Usage (Docker Compose)

The relay container **must** have a volume mounted at `/app/.tapflow/data`. This ensures that the generated `JWT_SECRET` (which authenticates all connected agents and web users) and the internal SQLite database are persisted across container restarts.

```yaml
services:
  relay:
    image: tapflow/tapflow:edge
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/.tapflow/data
    restart: unless-stopped
```

After the container starts, open `http://localhost:4000` or `http://<LAN_IP>:4000` in your browser to access the setup wizard.

## Documentation

For full setup guides and more detailed self-hosting information, please refer to the official documentation:

- [Self-Hosting Guide](https://www.tapflow.dev/guide/self-hosting)
- [Agent Setup](https://www.tapflow.dev/guide/agent)
- [GitHub Repository](https://github.com/jo-duchan/tapflow)
