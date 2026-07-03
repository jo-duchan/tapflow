---
type: rationale
topics: [relay, auth, security]
status: stable
---

# Why remote agents authenticate with an `agent`-scope PAT, not an IP check

> Read this before gating agent registration on IP address, or before removing the PAT
> requirement for non-loopback agents. Loopback stays unauthenticated on purpose; everything
> remote needs a token.

## The shape

A local agent on loopback registers without authentication, so the single-Mac `tapflow start`
path is unchanged. A remote (non-loopback) agent must present a Personal Access Token carrying
the `agent` scope, which only an admin can issue. The token rides the WebSocket upgrade as an
`Authorization: Bearer` header on both the control and the stream socket.

## Decisions

- **Reuse the PAT infrastructure, add an `agent` scope — do not gate on IP.** An IP allowlist
  silently degrades to allow-all behind a Docker bridge or a reverse proxy, where every source
  appears as a private address. A token does not have that failure mode.
- **Verification goes through one entry point.** A single `verifyAgentAuth`-style function does
  the check (a SHA-256 hash plus one SQLite lookup, sub-millisecond, once per connection). The
  per-frame streaming path is untouched.
- **The token is an opaque string to the agent** (`--token` / `TAPFLOW_AGENT_TOKEN`), never
  named `--pat`. This leaves room to split out a non-account service token later without a
  breaking change; agent and session data are not tied to the PAT's `userId` beyond audit logs.
- **Role stays first-message-decided.** A non-loopback connection with a valid `agent`-scope PAT
  is classified the same way a local one is (by its first `agent:register`/`stream:register`),
  not forced to `browser`. A cookie-authenticated or `view`-scope connection stays `browser`, so
  the anti-spoofing guard does not regress.
