# Webhooks

When your team finishes a review and moves a build to `Done` or `Rejected`, tapflow notifies a URL you registered. Wire that signal into a Slack alert or the next deploy step, and review outcomes flow through automatically.

tapflow doesn't build your app, so what it reports here isn't a build completion — it's the **review verdict a person made**.

## How it works

```
Someone reviews the build in App Center
  → moves status to Done / Rejected
  → tapflow POSTs to your registered URL (signed metadata)
  → your receiver fires a Slack alert · the next CI step
```

::: info Two testing paths
This guide covers the **manual review path**: CI delivers the build; people do the testing.

For automated testing where an LLM agent controls the simulator, see [MCP in CI/CD](/guide/mcp-ci). That is a separate, experimental feature.
:::

## Register an endpoint

There are two ways to register. Declare endpoints in `config.json` if you manage settings as files, or use the REST API to add and remove them at runtime. Endpoints from both sources are delivered together.

### Declare in config.json (recommended)

Add entries to the `webhooks` array in `tapflow.config.json`. This keeps webhooks in the same file a self-hosted operator already uses for TLS, SMTP, and the rest.

```json
{
  "webhooks": [
    { "url": "https://ci.internal/hooks/tapflow", "secretEnv": "TAPFLOW_WEBHOOK_SECRET_CI" }
  ]
}
```

Secrets never go in config.json. Point `secretEnv` at an environment variable name and tapflow reads that value as the signing key. Keep the actual secret in `.env`.

```
TAPFLOW_WEBHOOK_SECRET_CI=a-long-random-string
```

| Field | Description |
|-------|-------------|
| `url` | Destination that receives the POST (required) |
| `secretEnv` | Name of the env var holding the signing secret (optional, strongly recommended) |
| `enabled` | Whether the endpoint is active (defaults to `true`) |

Changes to config.json take effect after a relay restart.

### Register via the REST API

To add one at runtime, use `POST /api/v1/webhooks`. Authentication is the same as build upload — a Personal Access Token with the `builds:write` scope. See [Build Distribution](/guide/build-distribution) for token generation.

```sh
curl -X POST https://your-relay/api/v1/webhooks \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://ci.internal/hooks/tapflow","secret":"a-long-random-string"}'
```

| Field | Description |
|-------|-------------|
| `url` | Destination that receives the POST (required) |
| `secret` | Key used to sign deliveries (optional, strongly recommended) |
| `enabled` | Whether the endpoint is active (defaults to `true`) |

Unlike config.json, the REST API takes the secret directly in the request body. Register several and every enabled endpoint receives its own POST — connect Slack and an internal CI hook at the same time.

The REST management endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/webhooks` | Register an endpoint |
| `GET` | `/api/v1/webhooks` | List endpoints (`secret` is never returned) |
| `PATCH` | `/api/v1/webhooks/:id` | Update `url` · `secret` · `enabled` |
| `DELETE` | `/api/v1/webhooks/:id` | Delete an endpoint |

## Payload

The delivered body is JSON:

```json
{
  "event": "build.status_changed",
  "build": {
    "id": "42",
    "platform": "ios",
    "appVersion": "1.4.0",
    "status": "Done"
  },
  "changedAt": "2026-07-03T10:00:00.000Z"
}
```

| Field | Description |
|-------|-------------|
| `event` | Event type. Currently always `build.status_changed` |
| `build.id` | Build identifier |
| `build.platform` | `ios` or `android` |
| `build.appVersion` | App version, or `null` when unknown |
| `build.status` | `Done` or `Rejected` |
| `changedAt` | When the status changed (ISO 8601) |

The body carries build identification only — no app binary or screen data.

## Verifying the signature

If you set a `secret` at registration, tapflow signs the body with HMAC-SHA256 and sends it in the `X-Tapflow-Signature` header, hex-encoded with a `sha256=` prefix. Re-sign the body with the same secret and compare — a match proves the request came from tapflow and the body wasn't tampered with.

```js
import crypto from 'crypto'

function isFromTapflow(rawBody, signature, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(signature ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
```

Always verify against the raw, unparsed body — parsing the JSON and re-serializing it changes the bytes and breaks the signature.

## When it fires

A webhook is sent **only when** `status_label` changes to `Done` or `Rejected`.

- A request that leaves the value unchanged — re-setting a `Done` build to `Done` — sends nothing.
- Changes to `Backlog` or `In Progress`, or updates that touch only other fields, send nothing.
- Delivery is best-effort. If your receiver is down or fails, the status change itself still succeeds, and each request times out after 5 seconds.

| Status | Meaning |
|--------|---------|
| `Done` | Stakeholders approved |
| `Rejected` | Issues found, needs fixes |

## Security

- The payload carries metadata only; app binaries are never sent.
- Registration rejects loopback (`127.0.0.1`) and cloud-metadata (`169.254.169.254`) addresses. Private LAN addresses (`10.x`, `192.168.x`, …) are allowed for self-hosted CI.
- `secret` is optional, but set one — an exposed URL can otherwise receive forged requests.

## Getting a build in

This is an outbound notification tapflow sends. The opposite direction — getting a build *into* tapflow in the first place — is a normal build upload, covered in [Build Distribution](/guide/build-distribution).
