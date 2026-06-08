# Security & Privacy

tapflow is a self-hosted product. Build files, device streams, session recordings — all data stays inside your infrastructure. This page explains how tapflow protects your data by design.

## Data never leaves your network

tapflow does not route anything through an external cloud service.

| Data | Where it lives | Sent externally |
|------|----------------|-----------------|
| Build files (.ipa / .apk) | Local storage on the Mac running the relay | ❌ |
| Device stream (video · touch) | Browser ↔ relay ↔ agent — all internal | ❌ |
| Session recordings | Stored on the relay's Mac; expire after 72h and are purged automatically | ❌ |
| Logs | The Mac running the relay and agents | ❌ |
| Account & team data | SQLite DB on the relay's Mac | ❌ |

Unlike Appetize or BrowserStack, there is no step where you upload your app binary to an external server. The binary stays on your Mac.

## LAN-first architecture

tapflow's recommended deployment keeps the agent and relay **on the same LAN**.

```text
browser (anywhere) ──WAN──▶ relay ◀──LAN──▶ agent
                              │
                              └── SQLite DB, build files
```

The agent ↔ relay leg is LAN-internal traffic. Because the device stream never passes through an external service, your app's UI and behavior are not exposed outside your network.

To apply TLS to the browser ↔ relay leg (WAN), use a reverse proxy or tunnel in front of the relay. See the [Self-Hosting guide](/guide/self-hosting) for details.

## PAT-based authentication

Programmatic access to tapflow is controlled by **Personal Access Tokens (PAT)**.

- Tokens are issued per user. When someone leaves, revoke their token.
- Each token carries a **scope** that limits what it can do:
  - `builds:write` — upload builds, for CI/CD pipelines (issued from the dashboard under Settings → Tokens)
  - `view` — read and device-stream access
- Dashboard access for team members is governed separately by **roles** (Admin / Developer / QA / Viewer), not by PATs.

## Access control boundaries

Here is what tapflow handles and what you manage as the infrastructure operator.

**tapflow provides:**
- PAT authentication and scope enforcement on every endpoint
- Session isolation between teams — no access to another team's builds or streams
- No outbound data transmission to external services

**You are responsible for:**
- OS and network security of the Mac running the relay
- TLS on the WAN leg (reverse proxy or tunnel configuration)
- Network access control to the relay host (firewall, VPN, etc.)
- Managing `JWT_SECRET` and other environment variables for the relay

::: tip Running on an internal network only
If the relay is only reachable within your internal LAN, you can operate without WAN-leg TLS. This is appropriate when every team member is on the same network — office Wi-Fi or a shared VPN.
:::

## Reporting a vulnerability

If you find a security issue in tapflow's code, please report it privately rather than opening a public issue. See [SECURITY.md](https://github.com/jo-duchan/tapflow/blob/main/SECURITY.md) for the full disclosure process.
