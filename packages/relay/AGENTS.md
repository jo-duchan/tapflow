---
type: rules
topics: [relay, websocket, server]
status: living
---

# relay — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

WebSocket relay server + dashboard serving: handles NAT traversal, session routing, and JWT auth, while also serving the dashboard static files from `public/` over HTTP.
A single process on a single configurable port (default: 4000) handles both WebSocket connections and HTTP static serving. With `tls` configured it terminates HTTPS + WSS on that same port (LAN secure context, required for WebCodecs hardware decode) — full setup in [`docs/reference/configuration.md`](../../docs/reference/configuration.md). Given a `tunnelPort` it also listens on a loopback-only **tunnel port**: the same handler, `WebSocketServer` and TLS material, but nothing arriving there counts as local. The CLI passes one whenever a tunnel is configured (default 4001, `TAPFLOW_TUNNEL_PORT`); `server.ts` passes only what `local.tunnelPort` names, because that entry point starts no tunnel.

## Domain Structure — apps / builds separation (migration 004+)

`apps` and `builds` are separate entities.

- **apps**: product-level app identity, keyed by `bundle_id_key` alone (migration 007 dropped the old `UNIQUE(bundle_id_key, platform)`; uniqueness is enforced in `upsertApp`). `platform` is `ios` | `android` | `both` — the same bundle ID uploaded on both platforms is **one** row promoted to `both`, not separate rows.
- **builds**: build artifacts. `app_id FK → apps.id`. Contains `version_name`, `build_number`, `file_path`.
- `bundle_id_key` is used to auto-lookup/create the `apps` row → re-uploading the same app adds only a new `builds` row.

Build file storage path: `uploads/builds/`.

iOS build format: `.app.zip` **or** `.tar.gz`/`.tgz` (EAS `eas build` simulator artifacts). `.ipa` uploads return 400. `.tar.gz` is stored natively (no re-zip) so the `.app`'s exec bits / symlinks survive to install time; `tar` extraction happens on the macOS agent.
- Auto-extracts `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`, `CFBundleDisplayName`/`CFBundleName` from the top-level `*.app/Info.plist` (zip: `unzip -p`; tar: `tar -xzOf`).
- Validates simulator slices via `lipo -info`. **Skipped in Linux environments (lipo not available) — errors surface at install time instead**.
- `.tar.gz` uploads are validated before storage (`validateTarGz`): rejects path traversal (`..`/absolute), symlink/hardlink entries, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4). `tar` resolves PAX/GNU long names so header parsing can't be bypassed.

## HOW

- The agent connects to the relay via outbound WebSocket first (the key to NAT traversal).
- **Auth boundary**: connections from `localhost` **on the relay port** are unauthenticated; every other connection must authenticate — browsers by JWT cookie or a PAT with the `view` scope, agents by a PAT with the `agent` scope whose owner is currently an Admin (`Authorization: Bearer`).
  **Every credential is re-read from the database, at the handshake and for as long as the socket is open.** `getAuth` checks the users row on every call, which is the one place every cookie path passes; a remote socket's principal (cookie user + JWT `exp`, or PAT id) is kept in a `WeakMap` and re-judged by `revalidatePrincipal` on the heartbeat and from `onAuthChanged()`, which the team, token and invitation handlers call after their write. A new handler whose write can take access away gets that hook too; the heartbeat still catches it within 30 s if it does not. Host-only doors (`auth/init`, `auth/status`, `/api/v1/logs`) share `resolveRequestClient` with the same trusted-proxy list as the socket path. **Loopback on the tunnel port is not local.** A tunnel client (rathole, `tailscale serve`) connects from loopback on someone else's behalf, and rathole adds no header, so the listener is the only fact that tells it apart from `tapflow start`'s own agent. `resolveClientAddress` takes a required `viaTunnel` for that, and requests are marked by the tunnel server before anything reads them. The role (browser / agent / stream) is decided in `classifyConnection` (`lib/connectionAuth.ts`); a `browser`-role socket that sends an agent-only message (`directionOf` from `@tapflowio/protocol/validate`, which counts `stream:register` as its own direction) is closed with 1008. That set used to be `AGENT_MSG_TYPES`, a hand-copied array of 29 literals held against the protocol by two type assertions; it is derived now, and the derived set was verified member for member against the array it replaced.

  **The role and direction are settled before the shape is, and the order is load-bearing.** A malformed frame is dropped, but an agent-only type a browser spoofed *badly* must still close the socket — gating after shape validation lets such a spoofer keep its connection. The direction is a fact about the `type` alone, which is known even when the payload is not. A failed handshake is the one exception: it confers no role, so an agent whose `agent:register` does not parse gets its frame dropped rather than a `Forbidden` close, and its next attempt still introduces it.
- JSON messages and binary frames share the same WebSocket connection, branched by the `isBinary` flag.
- Control message protocol: `input:touch:*`, `input:pinch:*`, `input:button`, `input:key`, `input:type`, `input:rotate`, `input:keyboard:toggle`, `device:boot`, `device:shutdown`, `session:start`, `session:end`, `clipboard:read`, `clipboard:write`.
- **The message shapes live in [`@tapflowio/protocol`](../protocol/AGENTS.md), not here.** Every message the relay *originates* goes through `sendTo(socket, msg: RelayOutbound)`, so adding one means adding it to that union first — the compiler will not let you do it in the other order. **Inbound frames are parsed into a discriminated union at the door** (`parseInbound`), not cast — see the header of `protocol/src/validate/`. Which frame gets forwarded differs by direction and is checked by `scripts/__tests__/browserInboundRouting.test.mjs`:

  - **agent → browser: the original frame (`raw`).** `z.object` strips undeclared keys, so forwarding the parse product would delete a field a newer agent added — the one direction where the sender is the more recently updated side.
  - **browser → agent: the parse product (`msg`).** Here the stripping is the point: a key a viewer appended from devtools is gone before any agent sees it.

  **A refused browser request is answered, not just dropped.** The envelope is judged separately from
  the payload, so a frame whose `sessionId` and `requestId` are good carries everything a reply needs —
  and `refuseMalformed` sends the error type that request's own waiter reads, with `reason: 'malformed'`
  on the input pair. Without it this door would have converted an answered failure into silence: a
  malformed `open-url` used to reach the agent, whose guard answered, and `IOSAgent.ts` names this
  validation as what takes that over. The cost is worst on the inputs, because `awaitInputAck` reports
  silence from a never-acked session as **success** (#457). The thirteen answerable requests,
  `ANSWERABLE` in the protocol and the replies in `refuseMalformed` are held to one derived set by
  `scripts/__tests__/correlatedRequestsGated.test.mjs`.

  Agent payloads are **deliberately not validated**, and the reason is not a deferral. `AgentRegister.platform` is `string`, open so a third-party platform can register through `AgentRegistry.register()` (OCP), while `ChromePayload` is a closed two-member union — so a platform this repo promises to support has no valid `session:chrome` variant, and refusing one would cost it bezel and buttons for the life of the session. The six messages the relay *consumes* (`agent:register`, `agent:resources`, the screenshot and ui-tree replies) are validated, with a `.default()` for every field the relay used to read through a `??`.
- **Clipboard bridge** (`clipboard:*`): browser→agent `clipboard:read` (`payload.press`: `'copy' | 'cut'` presses that chord on the device first) and `clipboard:write` (`payload.text`, `payload.pasteAfter`); agent→browser `clipboard:data` / `clipboard:write-done` / `clipboard:error`, correlated by `requestId`. Unlike the other agent→browser replies these are **bound to the session's own `agentSocket`** — their payload lands on the viewer's host OS clipboard, so a second agent must not be able to address someone else's session. An undeliverable request answers `clipboard:error` immediately rather than letting the caller's deadline expire. Agents advertise `capabilities: ['clipboard']` in `agent:register`; the relay echoes them on `session:joined` so a viewer can tell a capable agent from one that predates the feature instead of inferring it from silence.
- **An input the relay cannot dispatch is answered here, with a reason.** The four terminal frames get an
  `input:error` and `input:type` gets an `input:type-error`, so an MCP or browser caller fails now instead of
  waiting out its own timeout — which its fallback would report as success. `input:type` used to receive
  nothing and burn its full deadline; widening the terminal set would not have fixed it, because its waiters
  key on the `input:type-*` pair and ignore an `input:error`, and L5c did what the note here called the
  honest fix — a reply in the shape those waiters read.
  Two situations reach that reply and only one is the agent's fault, so they carry **different prose
  and the same reason**: a held session with a closed socket is `agent offline`, while no session at
  all is `Session not found` — evicted after the reconnect grace, or never valid, and the agent may be
  perfectly healthy. `device:boot` already told that pair apart with those two strings. The reason is
  `channel-unavailable` for both because the set is derived from what a consumer must *do* differently
  and both want a reconnect or a re-join; the machine field was right for both while the prose was
  wrong for one, which is the concrete case for reading `reason` rather than `message` (#492).
  **Everything else gets nothing, and that is the contract**: opening and move frames, `input:rotate` and
  `input:keyboard:toggle` have no waiter, so a reply would be one nobody is listening for.
  The eleven `input:*` cases are **two clauses**, split by whether an ack answers them, and the split is
  load-bearing rather than tidy — the correlator gate belongs on the answered five, and written into the
  shared body it would have dropped every opening and move frame with it.
- **A browser-role command is acted on only from the client the session is bound to** — one client's several sockets are one holder, which is what a browser tab needs and what a socket could not express. The mirror of the
  clipboard rule above, and it was missing until L5c on **every** branch: the relay resolved the session and
  forwarded without asking who was asking, so any authenticated client that knew a session id could drive a
  device another tester was looking at — `clipboard:write` pasting its text into that device,
  `clipboard:read` pressing copy or cut on it with the payload landing on *that* tester's host OS clipboard,
  `session:end` deleting their session. The reply then routed to the session's own browser, never to the
  injector.
  `dispatchTarget` decides it once for all of them — session exists, **this client owns it**, agent
  connected — and each case wraps the prose it returns in the reply type its own waiter reads. The two
  ownership strings are one reason with different prose (`ownershipRefusal`), the treatment #492 settled:
  telling a caller the session is in use when it is idle steers it off a device it could have had.
  **A refusal is answered where a waiter exists and dropped where none does.** `input:*`, `device:boot`,
  `open-url`, `app:*` and `clipboard:*` are answered — `awaitInputAck` reports silence from a session that
  has never acked as *success*, so a silent refusal would report a command that never left the relay as
  having landed. `session:leave` and `session:end` are dropped, because neither has a reply and inventing
  one would grow the wire for a message no consumer reads.
  **A session is owned by a *client*, not by a socket** (#527). The owner is `<userId>:<clientId>`, taken
  from the `?client=` query parameter at the handshake and minted per connection when absent — so there is
  no fallback branch, and a caller that identifies itself gets an identity spanning its sockets while one
  that does not gets the per-socket identity ownership used to have. The dashboard sends one value per
  *document*, deliberately not `sessionStorage`: that store is copied into a tab opened from another, and
  two tabs sharing an identity would silently take each other's devices.
  **`device:shutdown` has its own, weaker gate** — refused when another client holds the session, permitted
  when nobody does. Not "owned by me", because the unmount teardown races its own viewer socket's close on
  a different connection: if the close lands first the session is unheld, and an owns-it gate would refuse
  the very teardown that stops a device costing money. The residual surface — a device between owners — is
  the price, and it is unchanged from before, when this command had no gate at all.
  A session held by a client that identified itself with **nothing** relaxes the gate further, since each
  of that client's connections was granted a separate identity and none of them can pass an ownership
  test — **but only for the same signed-in user**, so a build predating the parameter never becomes a way
  to power off a colleague's device. Whether an identity was *claimed* or *granted* is a field on the
  session: a first version recovered it from the identifier, which the caller supplies, so claiming one
  that looked granted handed the caller its own exemption.
  It is **not** an exception to being answered, and used to be both. `reachableTarget` is `dispatchTarget`
  minus the ownership clause, so the other two refusals — no such session, agent gone — come back as
  `device:shutdown-error` instead of the silence that burned `shutdownDevice`'s 30s deadline with no cause
  (#542). Splitting the resolver rather than inlining two checks is what makes closing #527 a one-line
  move to `dispatchTarget`; the cost, written down rather than waved past, is that a non-owner now learns
  whether a session id exists — small against being able to shut that device down, which it still can.
  The app-command handlers check ownership **after** the session lookup and **before** the build lookup,
  deliberately not through `dispatchTarget`: that resolver also decides agent liveness, and using it there
  would move `agent offline` ahead of `Build not found`, changing which of two simultaneous problems the
  caller is told about.
- JWTs are issued based on team invite links.
- **Every address handed to someone else is decided in `lib/publicUrl.ts`** — invite mail, the link the dashboard copies, CORS, and what `/api/v1/relay/host` reports. Never from the `Host` header (#6). A tunnel's `publicUrl` is for teammates' browsers and `relay.url` is where agents connect, so the endpoint reports them separately. **What a tunnel actually did beats what config says**: config names a tunnel but not whether it came up or at which address (Tailscale's is detected, #794), so an entry point that starts one passes the outcome as the `RelayServer` `tunnel` option, and the CLI starts the tunnel before the relay for that reason. No option means no entry point manages a tunnel, and config is trusted — the standalone `server.ts` case. `scripts/__tests__/teammateUrlsSingleSource.test.mjs` holds that only `publicUrl.ts` and `config.ts` read those two settings.
- Serves the `public/` directory as HTTP static files (dashboard build output).
- The relay does not buffer stream data — it forwards immediately on arrival.
- WebSocket upgrade requests and regular HTTP requests are split on the same port.
- A heartbeat (`runHeartbeat`, every `HEARTBEAT_MS`=30s) pings every socket (agent/browser/stream); a socket that has not answered for 1.5 intervals → `ws.terminate()`, which fires the existing `close` cleanup — detects dead sockets without waiting for TCP timeout.
  **Liveness is a pong timestamp, not a swept flag**, and the difference matters beyond termination. The flag was set `false` for every socket at the start of a sweep and back to `true` when the pong returned, so a healthy socket read as dead for a whole round trip — harmless while it only decided termination, and not once session occupancy and `busy` read it. The window was longest for the holder: video goes out on that socket and the ping is queued behind it. Occupancy and `busy` take the same predicate; two that disagreed would show a device as free while a join for it was refused (#579).

### API Endpoints (builds / apps)

Routes are registered in `RelayServer.ts`; user-facing reference: [`docs/reference/api.md`](../../docs/reference/api.md).

> **Deletion lifecycle (issue #258)**: review status and deletion are orthogonal. `status_label` (incl. `Done`) is a pure review state and never schedules deletion; purge keys off `delete_after` only, which is set by the explicit schedule-deletion action. `completed_at` is informational.

## Environment Variables

전체 목록 및 설명: [`docs/reference/configuration.md`](../../docs/reference/configuration.md)

설치 디렉토리: `lib/dataDir.ts`의 `resolveInstallDir()`이 `TAPFLOW_HOME` → 현재 폴더가 이미 설치 → `~/.tapflow` 순으로 정한다. 설정 파일 안의 상대 경로(`local.dataDir`, `tls.certPath`)는 **그 파일이 있는 폴더 기준**이고, `TAPFLOW_DATA_DIR`만 셸 기준이다. 데이터는 설치 디렉토리 안에서 `.tapflow/data` → `.tapflow-data` → `data`(새 기본값) 순으로 찾는다. `jwt-secret` 하나만 든 데이터 폴더는 설치로 치지 않는다 — 예전 CLI가 실행한 자리마다 남긴 흔적이고, 릴레이는 부팅 때 항상 `tapflow.db`를 만든다.

JWT 시크릿은 `getJwtSecret()`으로 **처음 쓸 때** 만든다. `RelayServer.start()`가 부팅 때 한 번 호출하므로 로그와 실패 시점은 전과 같고, 릴레이를 띄우지 않는 CLI 명령은 아무 데도 시크릿을 남기지 않는다. `JWT_SECRET` 길이 검증만 import 시점에 그대로 둔다(파일을 만들지 않으므로 부작용이 없다).

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
