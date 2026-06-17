# relay — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

WebSocket relay server + dashboard serving: handles NAT traversal, session routing, and JWT auth, while also serving the dashboard static files from `public/` over HTTP.
A single process on a single configurable port (default: 4000) handles both WebSocket connections and HTTP static serving.

## Domain Structure — apps / builds separation (migration 004+)

`apps` and `builds` are separate entities.

- **apps**: unique app identifier. `UNIQUE(bundle_id_key, platform)`. Same bundle ID on iOS and Android = separate rows.
- **builds**: build artifacts. `app_id FK → apps.id`. Contains `version_name`, `build_number`, `file_path`.
- `bundle_id_key` is used to auto-lookup/create the `apps` row → re-uploading the same app adds only a new `builds` row.

Build file storage path: `uploads/builds/`.

iOS build format: `.app.zip` (simulator builds). `.ipa` uploads return 400.
- Auto-extracts `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`, `CFBundleDisplayName`/`CFBundleName` from `*.app/Info.plist`.
- Validates simulator slices via `lipo -info`. **Skipped in Linux environments (lipo not available) — errors surface at install time instead**.

## HOW

- The agent connects to the relay via outbound WebSocket first (the key to NAT traversal).
- **Auth boundary**: connections from `localhost` are unauthenticated; every other origin must authenticate — browsers by JWT cookie / PAT, agents by a PAT with the `agent` scope (`Authorization: Bearer`). The role (browser / agent / stream) is decided in `classifyConnection` (`lib/connectionAuth.ts`); a `browser`-role socket that sends an agent-only message (`AGENT_MSG_TYPES`, which includes `stream:register`) is closed with 1008.
- JSON messages and binary frames share the same WebSocket connection, branched by the `isBinary` flag.
- Control message protocol: `input:touch:*`, `input:pinch:*`, `input:button`, `input:key`, `input:type`, `input:rotate`, `input:keyboard:toggle`, `device:boot`, `device:shutdown`, `session:start`, `session:end`.
- JWTs are issued based on team invite links.
- Serves the `public/` directory as HTTP static files (dashboard build output).
- The relay does not buffer stream data — it forwards immediately on arrival.
- WebSocket upgrade requests and regular HTTP requests are split on the same port.

### API Endpoints (builds / apps)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/apps` | App list (with latest_build summary) |
| `POST` | `/api/v1/apps` | Create an app entry |
| `PATCH` | `/api/v1/apps/:id` | Manually rename an app (Admin/Developer) |
| `DELETE` | `/api/v1/apps/:id` | Delete an app (and its builds) |
| `POST` | `/api/v1/builds` | Upload a build (`.app.zip` / `.apk`) |
| `GET` | `/api/v1/builds` | Build list (filterable by `app_id`) |
| `GET` | `/api/v1/builds/:id` | Single build |
| `PATCH` | `/api/v1/builds/:id` | Update `status_label` |

## Environment Variables

전체 목록 및 설명: [`docs/reference/configuration.md`](../../docs/reference/configuration.md)

비밀 기본 경로: `config.ts`의 `load()`가 dataDir 확정 직후 `<dataDir>/.env`를 로드한 뒤 나머지 `process.env`를 읽는다 → `JWT_SECRET`·`SMTP_*`·DNS/ACME 토큰 등 **모든 비밀이 `.env`를 기본 경로로** 쓴다. 우선순위는 **셸 env > `.env` > config.json**(`process.loadEnvFile`이 기존 값을 안 덮음). 예외는 `TAPFLOW_DATA_DIR` 하나 — `.env` 경로를 결정하는 값이라 `.env`에서 못 읽고 config.json/셸로만 받는다.

로컬 테스트 시 자주 쓰는 값:
- `TAPFLOW_BUILD_TTL_DAYS=0.001` — 빌드 자동 삭제를 즉시 확인할 때
- `TAPFLOW_WS_BACKPRESSURE_BYTES` — 브라우저 소켓 backpressure 임계값 (기본 1 MB)

## HOW NOT

- Do not store or analyze screen data in the relay.
- Do not allow session routing without authentication.
- Do not introduce designs that require more than a t3.small instance (cost principle).
- Do not modify files in `public/` directly — they are dashboard build output.
- Do not parse or deserialize binary frames as JSON — if `isBinary === true`, forward immediately.

---

## Compound

### Binary Frame Forwarding with Backpressure

**When**: relaying WebSocket binary messages from the Agent to the Browser

**How**: the binary branch of the `ws.on('message')` handler in `RelayServer.ts` — a per-session `createKeyframeAwareSender` (`@tapflowio/agent-core` `utils/stream.ts`) handles backpressure. Core call: `dropper.send(browserSocket, frame, threshold, isKeyframe, onDrop, requestIdr)`. `isKeyframe` comes from `readEnvelopeFlags(frame)` (JPEG, or H.264 IDR).

**Why** (not obvious from the code):
- Omitting `{ binary: true }` makes `ws` send the Buffer as UTF-8 text → `e.data` becomes a string in the browser. The relay must be content-agnostic, with zero parsing cost.
- **drop-to-keyframe**: a dropped H.264 P-frame tears the stream until the next IDR, so once it drops under backpressure it keeps dropping until a keyframe can be sent — the decoder never receives a P referencing a dropped frame. JPEG / no-envelope frames pass `isKeyframe=true`, reproducing drop-to-latest exactly.
- On a drop with no sendable keyframe, `requestIdr` sends a throttled `stream:request-idr` for an on-demand IDR (unsupported agents ignore it) → fast resync instead of waiting for the periodic IDR.
- Threshold default 1 MB (`TAPFLOW_WS_BACKPRESSURE_BYTES`). Per-session dropper / drop-warn (one warn/sec) / IDR-requester must be cleared on `session:end`.
