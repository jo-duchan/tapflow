# Security & Privacy

tapflow is a self-hosted product. Build files, device streams, session recordings — all data stays inside your infrastructure. This page explains how tapflow protects your data by design.

## Data never leaves your network

tapflow does not route anything through an external cloud service.

| Data | Where it lives | Sent externally |
|------|----------------|-----------------|
| Build files (.app.zip / .tar.gz / .apk) | Local storage on the Mac running the relay | ❌ |
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

To apply TLS to the browser ↔ relay leg (WAN), use a reverse proxy or tunnel in front of the relay. See [External access](/operate/external-access) for details. The relay can also terminate TLS itself through its [`tls` setting](/reference/configuration#https-secure-context).

## PAT-based authentication

Programmatic access to tapflow is controlled by **personal access tokens (PATs)**.

- Tokens are issued per user. Removing a team member deletes their tokens too.
- Each token carries a **scope** that limits what it can do:
  - `builds:write` — upload builds, for CI/CD pipelines (issued from the dashboard under Settings → Tokens)
  - `view` — read the app list, uploaded files, session screenshots and UI trees. Also required to open a device session over WebSocket from a remote machine.
  - `agent` — connect an agent on a remote Mac to the relay. Only an Admin can issue one, and it works only while the member who issued it is still an Admin.
- Dashboard access for team members is governed separately by **roles** (Admin / Developer / QA / Viewer), not by PATs.
- A call made with a PAT is held to its owner's current role. Viewer is read-only, so a `builds:write` token owned by a Viewer cannot upload builds. The HTTP endpoints that check roles read the role on every request, so a role change applies there right away, for cookies and tokens alike.
- Open device sessions are covered as well. Removing a member, revoking a token, or changing the role of the Admin who issued an `agent` token makes the relay close the WebSocket connections opened with it at once. A connection whose token or sign-in session expires is closed within 30 seconds.

## Access control boundaries

Here is what tapflow handles and what you manage as the infrastructure operator.

**tapflow provides:**
- API authentication: build upload and listing, comments and webhooks accept a signed-in session or a `builds:write` PAT; the app list, uploaded files, screenshots and UI trees accept a signed-in session or a `view` PAT. The [REST API reference](/reference/api) lists which endpoints accept a PAT.
- Device stream (WebSocket) authentication: a remote connection needs a signed-in session or a PAT with the `view` scope, and a remote agent needs an `agent`-scope PAT issued by a current Admin.
- Relay logs (`GET /api/v1/logs`) are served only to the relay host.
- Sign-in for every connection that does not reach the relay port over loopback, including tunnel traffic, which arrives on a separate loopback port of its own
- No outbound data transmission to external services

**You are responsible for:**
- OS and network security of the Mac running the relay
- TLS on the WAN leg (reverse proxy or tunnel configuration)
- Network access control to the relay host (firewall, VPN, etc.)
- Managing `JWT_SECRET` and other environment variables for the relay
- Team separation: one relay serves one team, so run a separate relay for each team whose builds and streams must stay apart

::: tip Running on an internal network only
If the relay is only reachable within your internal LAN, you can operate without WAN-leg TLS. This is appropriate when every team member is on the same network — office Wi-Fi or a shared VPN.
:::

## Reporting a vulnerability

If you find a security issue in tapflow's code, please report it privately rather than opening a public issue. See [SECURITY.md](https://github.com/jo-duchan/tapflow/blob/main/SECURITY.md) for the full disclosure process.
