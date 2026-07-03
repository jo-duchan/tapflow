# Security Policy

tapflow is **self-hosted**: your builds, recordings, and device streams stay on infrastructure
you control, and nothing is sent to an external service. Keeping that promise trustworthy is the
whole point of this policy. We take security reports seriously and appreciate the time researchers
spend to make tapflow safer.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for security problems.** Public
disclosure before a fix is available puts every self-hosted deployment at risk.

Report privately through either channel:

1. **GitHub Private Vulnerability Reporting (preferred)** — open a draft advisory from the
   [Security tab](https://github.com/jo-duchan/tapflow/security/advisories/new). This keeps the
   report private and lets us discuss and fix it in the same place.
2. **Email** — `jo_duchan@icloud.com` with the subject `[tapflow security] <short summary>`.
   If you'd like to encrypt the report, say so in your first message and we'll arrange a key.

### What to include

The more of this you can provide, the faster we can act:

- **Affected component** — `relay`, `ios-agent`, `android-agent`, `dashboard`, `cli`,
  `mcp-server`, or `agent-core` — and the version or commit.
- **Impact** — what an attacker could actually do.
- **Reproduction** — step by step, ideally with a minimal proof of concept.
- **Environment** — OS, Node version, and deployment shape (LAN, tunnel, reverse proxy, etc.).
- **Suggested remediation**, if you have one.

## Our response process

| Stage | Target |
|-------|--------|
| **Acknowledge** your report | within **48 hours** |
| **Initial assessment** (severity + reproduction) | within **7 days** |
| **Status updates** while a fix is in progress | at least every **7 days** |
| **Fix + coordinated disclosure** | severity-dependent; we aim for **≤ 90 days** |

These are good-faith targets from a small, currently single-maintainer project — not a contractual
SLA. For a critical, actively exploitable issue, we will move faster.

## Disclosure policy

We follow **coordinated disclosure**:

1. You report privately and give us a reasonable window to fix the issue.
2. We develop and release a patched version, then publish a
   [GitHub Security Advisory](https://github.com/jo-duchan/tapflow/security/advisories)
   (with a CVE where applicable).
3. We credit you in the advisory (see [Recognition](#recognition)) unless you prefer to stay anonymous.

Please give us a chance to ship a fix before disclosing publicly. We will not pursue legal action
against researchers who act in good faith, follow this policy, and avoid privacy violations, data
destruction, and service disruption.

## Supported versions

tapflow is pre-1.0 and ships security fixes on the **latest release line only**. Fixes land in a new
patch release — please run a recent version.

| Version | Supported |
|---------|-----------|
| Latest `0.x` release | ✅ |
| Older `0.x` releases | ❌ — upgrade to the latest |

Once `1.0.0` is tagged, this table will be updated with a longer support window.

## Threat model

tapflow runs on your LAN by default and can be exposed beyond it through an opt-in tunnel
(rathole, cloudflared) or a reverse proxy. The security model assumes that the moment the relay
becomes reachable from an untrusted network, its authentication and device-control endpoints are
effectively internet-facing.

The **relay is the trust boundary**: it holds accounts, sessions, and uploaded builds, and it
relays live device control. Agents connect from the same internal network; browsers connect from
the LAN or the public tunnel URL. The assets worth protecting are account credentials and JWTs,
personal access tokens, uploaded builds and recordings, and live device control (touch, keys,
boot). The adversary we design against is an unauthenticated party who can reach an externally
exposed relay.

Single-Mac loopback use is the low-friction default and is treated as trusted. The hardening below
is calibrated for the moment that local-only assumption breaks.

## Security posture

What the relay enforces, from a defender's point of view:

- **Authentication is required** on the REST API and on WebSocket connections. WebSocket message
  types are restricted by role, so a browser connection cannot issue agent-only control messages.
- **Remote agents present an `agent`-scope token**, issued by an admin, rather than being trusted by
  IP address. IP heuristics quietly become allow-all behind a Docker bridge or a reverse proxy, so
  they are not used as an authentication boundary.
- **Authentication endpoints are rate-limited** per IP and per account with backoff, which bounds
  online guessing.
- **No shipped default signing secret.** The JWT secret is generated per install and persisted with
  restrictive file permissions. The relay refuses to start with a placeholder secret when it is
  bound for external exposure, and only warns for localhost-only binding.
- **First-admin setup is gated** so a remote party cannot claim the initial-setup window on a freshly
  exposed instance.
- **Reverse-proxy deployments use an explicit trusted-proxy boundary.** The real client address is
  resolved only from proxies you list in `TAPFLOW_TRUSTED_PROXIES`; forwarded headers from anywhere
  else are ignored, and an ambiguous case is treated as remote, so a token is required.
- **Request hygiene**: CORS is limited to configured origins on authenticated paths rather than a
  blanket wildcard, state-changing requests carry a same-origin guard, and invitation links are built
  from a configured base URL rather than a request header.
- **Uploads are contained and authenticated**, oversized uploads are rejected, and partial files are
  cleaned up.
- **Tokens carry least-privilege scopes** (`view`, `builds:write`, `agent`); the `agent` scope is
  admin-only.
- **Secrets have one home.** All relay secrets default to `.tapflow-data/.env`, with the shell
  environment overriding the file and the file overriding config.
- **tapflow does not phone home.** It moves builds, recordings, and streams only between your own
  agents, relay, and browsers, never to a tapflow-run or analytics service. Where that traffic
  travels is your choice: a LAN or your own VPS keeps it on hardware you control, while a hosted
  tunnel such as `cloudflared` routes it through that provider, a trade-off you opt into.

## Exposing tapflow beyond your LAN

If you put tapflow behind a tunnel or a public reverse proxy, you own the perimeter. At minimum:

- Set a strong `JWT_SECRET` (the relay refuses to start externally without one).
- Terminate TLS in front of the relay.
- Set `TAPFLOW_TRUSTED_PROXIES` to your proxy's address so client-IP checks cannot be spoofed.
- Issue `agent`-scope tokens to remote agents, and keep every token least-privilege.
- Stay on the latest release for security fixes.

## Scope

Because tapflow is self-hosted, security responsibility is **shared**. Vulnerabilities in tapflow's
own code are **in scope**:

- Authentication / authorization flaws — PAT handling, scope enforcement, session access control.
- Remote code execution, path traversal, or injection in the relay, REST API, or agents.
- One team's builds, recordings, or device streams being exposed to another.
- The MCP server (`@tapflowio/mcp-server`) exposing more control than intended.
- Secrets or tokens leaking through logs, errors, or API responses.

The following are **out of scope** — your deployment's responsibility, not a flaw in tapflow's code:

- Hardening of the host machine, network, reverse proxy, or tunnel you run tapflow behind.
- Running tapflow on an untrusted network without TLS in front of it.
- Misconfiguration of your own environment variables, secrets, or OS permissions.
- Issues that require an already-compromised host or physical access to the Mac.

If you're unsure whether something is in scope, **report it anyway** — we'd rather hear it.

## Recognition

With your permission, we credit reporters by name or handle in the published advisory and release
notes. tapflow is a young project without a paid bounty program yet, but we genuinely value — and
will acknowledge — every valid report.
