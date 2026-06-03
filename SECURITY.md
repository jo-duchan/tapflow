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
