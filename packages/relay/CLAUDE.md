# relay — CLAUDE.md

> Common rules: [CLAUDE.md](../../CLAUDE.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

WebSocket relay server + dashboard serving: handles NAT traversal, session routing, and JWT auth, while also serving the dashboard static files from `public/` over HTTP.
A single process on a single configurable port (default: 4000) handles both WebSocket connections and HTTP static serving.

## Domain Structure — apps / builds separation (migration 004+)

`apps` and `builds` are separate entities.

- **apps**: unique app identifier. `UNIQUE(bundle_id_key, platform)`. Same bundle ID on iOS and Android = separate rows.
- **builds**: build artifacts. `app_id FK → apps.id`. Contains `version_name`, `build_number`, `file_path`.
- `bundle_id_key` is used to auto-lookup/create the `apps` row → re-uploading the same app adds only a new `builds` row.

Build file storage path: `uploads/builds/` (legacy `uploads/apps/` is preserved).

iOS build format: `.app.zip` (simulator builds). `.ipa` uploads return 400.
- Auto-extracts `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`, `CFBundleDisplayName`/`CFBundleName` from `*.app/Info.plist`.
- Validates simulator slices via `lipo -info`. **Skipped in Linux environments (lipo not available) — errors surface at install time instead**.

## HOW

- The agent connects to the relay via outbound WebSocket first (the key to NAT traversal).
- JSON messages and binary frames share the same WebSocket connection, branched by the `isBinary` flag.
- Control message protocol: `input:touch:*`, `input:pinch:*`, `input:button`, `input:key`, `input:type`, `input:rotate`, `input:keyboard:toggle`, `device:boot`, `device:rotate`, `device:shutdown`, `session:start`, `session:end`.
- JWTs are issued based on team invite links.
- Serves the `public/` directory as HTTP static files (dashboard build output).
- The relay does not buffer stream data — it forwards immediately on arrival.
- WebSocket upgrade requests and regular HTTP requests are split on the same port.

### API Endpoints (builds / apps)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/apps` | App list (with latest_build summary) |
| `PATCH` | `/api/v1/apps/:id` | Manually rename an app (Admin/Developer) |
| `POST` | `/api/v1/builds` | Upload a build (`.app.zip` / `.apk`) |
| `GET` | `/api/v1/builds` | Build list (filterable by `app_id`) |
| `GET` | `/api/v1/builds/:id` | Single build |
| `PATCH` | `/api/v1/builds/:id` | Update `status_label` |

## HOW NOT

- Do not store or analyze screen data in the relay.
- Do not allow session routing without authentication.
- Do not introduce designs that require more than a t3.small instance (cost principle).
- Do not modify files in `public/` directly — they are dashboard build output.
- Do not parse or deserialize binary frames as JSON — if `isBinary === true`, forward immediately.

---

## Compound

### Binary Frame Forwarding

**When**: relaying WebSocket binary messages from the Agent to the Browser

**How**:
```typescript
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const session = this.sessions.getBySocket(ws)
    if (session?.browserSocket?.readyState === WebSocket.OPEN) {
      session.browserSocket.send(data, { binary: true })
    }
    return
  }
  try {
    const msg: RelayMessage = JSON.parse(data.toString())
    this.route(ws, msg)
  } catch { }
})
```

**Why**: Omitting `{ binary: true }` causes the `ws` library to send the Buffer as UTF-8 text, making `e.data` a string in the browser. The relay must be content-agnostic and incur zero parsing cost.
