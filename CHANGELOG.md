# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `tapflow setup android` installs Android `build-tools` (pinned `35.0.0`), and `tapflow doctor` gains an `aapt (build-tools)` check — apk metadata extraction needs it.

### Breaking Changes

- `POST /api/v1/builds`: an `.apk` upload that specifies `app_id` is now rejected with `400` whenever the relay can't read the APK's package name (Android build-tools / `aapt` missing, or the APK itself unreadable/corrupt), instead of storing an unversioned build under that app. Migrate: install build-tools on the relay host with `tapflow setup android` (or re-export a valid APK), or omit `app_id` to file the build separately.

### Fixed

- relay: an `.apk` whose metadata can't be read is no longer merged into an unrelated app or false-promoted to platform `both`; without `app_id` it is isolated under its own entry. `tapflow doctor` and the relay now share the same `aapt` search paths (`ANDROID_SDK_ROOT` and the Linux SDK path included), so a green doctor no longer masks an upload failure.

## [0.14.0] - 2026-07-09

### Added

- Automated QA axis. `query_ui_tree` (MCP) and `GET /api/v1/sessions/:sessionId/ui-tree` return a unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`) with frames normalized 0–1, so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window, no WebDriverAgent); Android via `uiautomator dump` with a device-side timeout (#133).
- `@tapflowio/flow-runner` (new package) and `tapflow flow run` replay YAML flows with zero LLM calls: a 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, and a CI exit-code contract (0 pass / 1 flow failed / 2 env error).
- `run_flow` (MCP) — an agent authors a flow once, then replays it deterministically over the existing session.
- relay `app:clear-state` — reset app data (Android `pm clear`, iOS data-container wipe).
- `@tapflowio/mcp-server` and `@tapflowio/flow-runner` graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

### Changed

- Text entry waits for an `input:type-done` ack so a following key press stays correctly ordered. **A self-hosted agent older than v0.14.0 does not send this ack — update the agent and relay together, or text steps will time out.**

### Fixed

- mcp: `type_text`, cross-platform hardware buttons, and input payloads aligned with the agent protocol (#376, #377).

## [0.13.0] - 2026-07-05

### Added

- relay: outbound webhooks for build review-status changes. The relay POSTs to registered URLs when a build's review status transitions to `Done` or `Rejected`, so review outcomes can flow into Slack or the next CI step. Register at runtime via `POST /api/v1/webhooks` (`builds:write` scope) or declare endpoints in `tapflow.config.json` (`webhooks`, with signing secrets read from env vars). Deliveries carry metadata only — never app binaries — and are HMAC-SHA256 signed (`X-Tapflow-Signature`) when a secret is set. Registration blocks loopback and cloud-metadata addresses (#367).

## [0.12.0] - 2026-07-03

### Added

- relay: accept EAS `eas build` iOS simulator artifacts (`.tar.gz` / `.tgz`) as a first-class build upload, alongside `.app.zip` (iOS) and `.apk` (Android). The archive is stored as-is and extracted with `tar` at install time — no re-zip — so the `.app`'s executable bits and symlinks are preserved. Uploads are validated before storage: path traversal (`..`/absolute), symbolic/hard links, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4) are rejected. Expo/EAS teams can now run `eas build → CI → tapflow` and upload the native `.tar.gz` directly, with no CI re-packaging step (#362).

## [0.11.1] - 2026-07-02

### Added

- relay: Docker support and a container image publish workflow, so the relay can be self-hosted as an image instead of only from source (#352).
- docs: add navigation links to the project changelog.

### Changed

- deps: bump the npm minor/patch dependency group (22 updates).

### Fixed

- ios: physical device-frame buttons are confined to the bezel — a tap inside the screen area is no longer hijacked as a button press on devices where a button sits near the edge (e.g. iPhone SE). HID buttons also support press-and-hold via an optional `phase: 'down' | 'up'` on `input:button`; existing single-press clients are unaffected.
- dashboard: use the `TimerOff` icon for the cancel-deletion action.

### Security

- Patch js-yaml to 3.15.0 to address CVE-2026-53550.

## [0.11.0] - 2026-06-29

### Added

- audio: simulator/emulator audio output is streamed to the browser, **on by default** on both iOS and Android (opt out with `TAPFLOW_AUDIO=off`). iOS taps the whole simulator process tree via Core Audio process taps (macOS 14.2+) — app audio, WebKit `WebContent`, and system sounds; Android captures over the emulator's gRPC stream. The agent Mac stays muted so audio goes only to the browser — on Android via a shared mute-only process tap (`@tapflowio/audiotap-helper`, macOS 14.2+; below that, use the Mac's volume). The simulator/emulator's own volume is reflected. (#339, #341)
- docs: add self-hosted relay backup guidance for `.tapflow-data/`, Litestream replication, restore order, and non-database artifacts.

### Changed

- build: migrate the monorepo to TypeScript project references and point each package's `exports.types` at the published `dist/*.d.ts` (was `src/`, which isn't in the npm tarball) so consumers resolve types correctly. typecheck/build run via `tsc -b`. Also extracts the shared macOS process-tap helper into `@tapflowio/audiotap-helper`. (#345)

### Fixed

- android: concurrent emulators now each use their own gRPC port (discovered from the running emulator's `.ini`) instead of a fixed `8554`, which collided and made every session show the first emulator's screen.
- cli: `tapflow setup android` now treats a missing emulator binary or Android system image as a partial SDK and repairs it instead of reporting the SDK as ready.
- cli: `tapflow doctor` now checks whether the default relay port 4000 is already in use and prints the `lsof -ti:4000 | xargs kill` recovery command before `tapflow start` hits `EADDRINUSE`.
- cli: `tapflow setup android` now reminds users to open a new shell when the Android SDK rc block already exists but `adb` is still missing from the live `PATH`; `tapflow doctor` now points to the shell-refresh step instead of looping back to setup.

## [0.10.0] - 2026-06-23

### Added

- builds: deletion is now an explicit, manual action decoupled from review status (#258). Marking a build **Done** no longer schedules it for deletion — `status_label` stays a pure review state and purge keys off a new `delete_after` timestamp instead of `completed_at`. Schedule or cancel via `POST`/`DELETE /api/v1/builds/:id/schedule-deletion`; build payloads now include `delete_after`. Migration 012 grandfathers builds already on the old clock (`delete_after = completed_at + TTL`) so upgrades keep reclaiming disk. The App Center shows a deletion-countdown badge separate from the status column with explicit schedule/cancel controls.
- relay: WebSocket heartbeat (ping/pong, 30s) terminates sockets that miss a pong window, so dead agent/browser/stream connections (Wi-Fi loss, sleep, cable pull) are detected promptly instead of lingering until the TCP timeout — evicting stale sessions and clearing the duplicate "Stale" card.
- ios: `capture-wait` diagnostic metric under `TAPFLOW_STREAM_METRICS=1` — the polling gap between an IOSurface change and when the frame is encoded, emitted per 150-sample window. Capture behavior is unchanged.

### Changed

- cli: `tapflow setup` reports per-step state (found / created / repaired) instead of a binary result, so you can see which prerequisites were already in place versus newly provisioned. Android SDK env registration that was already present is reported as "repaired" rather than "found".
- relay: build-upload validation errors are returned in English, matching the rest of the API (previously the `.app.zip` format, missing-`.app`-directory, and device-only-slice messages were Korean only).

## [0.9.2] - 2026-06-20

### Changed

- cli: unify the stream-quality tier label to "Smooth".

### Fixed

- cli: `tapflow start` now wires TLS like `relay start`, so the all-in-one path can serve HTTPS/WSS for secure-context streaming (Smooth/WebCodecs) to LAN teammates — previously only `relay start` did. The co-located agent trusts the localhost `wss://` cert only (it never leaves the machine); external relays keep full verification.
- cli: include `--token` in the agent connect hint for remote relays.
- agent: prevent display sleep by default (`caffeinate -di`) so the host Mac keeps streaming during a session.
- relay/agents: dedup agent re-register by machine id, removing duplicate "Stale" cards.
- relay: reject in-flight screenshots when an agent is evicted on re-register.
- ios: 16-align downscaled encode dimensions to remove the WASM (tinyh264) green edge on the no-downscale tier.

### Security

- Bump nodemailer to 9.0.1 — the message-level `raw` option bypassed `disableFileAccess`/`disableUrlAccess`, enabling arbitrary file read and full-response SSRF (GHSA-p6gq-j5cr-w38f). relay uses a plain SMTP send path, so real-world exposure was nil.
- Bump undici to 7.28.0 (TLS certificate validation bypass via SOCKS5 ProxyAgent, GHSA-vmh5-mc38-953g) and override dompurify to 3.4.11 (`ALLOWED_ATTR` pollution via `setConfig()`, GHSA-cmwh-pvxp-8882) — both dev/build-only transitive dependencies. Remove an orphaned dashboard lockfile the security graph scanned as a duplicate manifest.

## [0.9.1] - 2026-06-18

### Changed

- relay: every secret can now live in `.tapflow-data/.env`, not just DNS/ACME tokens. The relay loads `.env` before reading its config, so `JWT_SECRET`, the SMTP password, and the tunnel token are picked up from there too. Precedence is shell env > `.env` > config file (a shell variable still overrides the file); `TAPFLOW_DATA_DIR` is the exception since it determines where `.env` lives.

## [0.9.0] - 2026-06-17

### Added

- LAN HTTPS: the relay terminates TLS in-process with automatic certificates — Let's Encrypt via DNS-01 (Cloudflare / Vercel) or bring-your-own — backed by a disk certificate store with automatic renewal. It auto-publishes the detected LAN IP to the configured domain's A record and self-heals it so the HTTPS hostname keeps resolving on the local network. `tapflow init` gains a guided HTTPS setup step; DNS/ACME credentials load from a gitignored `.env` file namespaced under `TAPFLOW_`. This enables WebCodecs-based low-latency streaming, which requires a secure context. Requires Node >= 20.12.0.
- dashboard: a performance-mode indicator in the session info strip shows the active decode path, with a Standard-mode upgrade notice.
- relay: upload size limits are configurable via `TAPFLOW_MAX_BUILD_BYTES` / `TAPFLOW_MAX_COMMENT_BYTES`.

### Changed

- relay: serves brotli-precompressed static assets with immutable caching for faster dashboard loads.
- dashboard: route-level code splitting (`React.lazy`) and a lighter chart stack (visx, replacing recharts) shrink the initial bundle; variable fonts are trimmed to woff2 + latin subsets.
- relay: hardened for public exposure — CORS is restricted to the configured origins instead of `*`, cookie-authenticated state-changing requests need a same-origin / allowlisted origin (lightweight CSRF guard; PAT requests exempt), and invite links are built from the configured base URL instead of the request `Host` header.

### Fixed

- relay: handler exceptions are logged (method, path, stack) instead of silently swallowed, so 5xx failures are diagnosable. Response bodies still return a generic message and PATs are masked.
- relay: robust `Accept-Encoding` negotiation for static assets.

### Security

- Bump esbuild, hono, and other transitive dependencies to clear open Dependabot advisories. Add `.github/dependabot.yml` for weekly grouped updates, excluding semver-major (reviewed manually).

## [0.8.2] - 2026-06-13

### Changed

- relay: a per-install JWT secret is now generated and persisted automatically when `JWT_SECRET` is unset, replacing the shared development default. No action is needed for a single relay; set `JWT_SECRET` only to share one key across multiple instances.
- relay: login attempts are rate-limited with exponential backoff (per IP + account).
- relay: first-time bootstrap (`auth/init`) is restricted to localhost. On headless servers, run `tapflow admin init` on the relay host.

### Added

- relay: `TAPFLOW_TRUSTED_PROXIES` — when the relay runs behind a same-host reverse proxy, set this so it resolves the real client IP from `X-Forwarded-For` instead of treating every proxied client as localhost. Configure the proxy to forward `X-Forwarded-For`.

## [0.8.1] - 2026-06-12

### Changed

- relay: agents connecting from another machine now authenticate with a token. A relay only accepts a remote agent that presents a PAT with the new `agent` scope (create one in Settings → Tokens; pass it via `tapflow agent start --token` or `TAPFLOW_AGENT_TOKEN`). Agents on the same machine as the relay (`localhost`, e.g. `tapflow start`) stay unauthenticated. See [Remote relay authentication](https://github.com/jo-duchan/tapflow/blob/main/docs/guide/agent.md#remote-relay-authentication).
- ios: `tapflow agent start --device` is a relay-exposure filter (which simulators are offered), not a boot target. `connect` no longer pre-boots a simulator — booting stays on-demand via the dashboard.

### Fixed

- relay: restore remote agent connections (#271). A prior security fix closed every non-loopback WebSocket without a credential, so no remote agent could register and the agent hung at "Connecting ios agent…". Remote agents connect again, authenticated; the agent also fails fast with a clear reason instead of hanging on a rejected or malformed handshake.
- relay: bind dual-stack (IPv4 + IPv6) so an agent on another Mac connecting over `ws://<ipv4>:4000` no longer times out (#269).
- ios: auto-recover a simulator whose data directory vanished from disk (an Xcode/macOS update can prune it) — the agent erases and retries the boot once instead of failing.

## [0.8.0] - 2026-06-11

### Added

- cli: `tapflow setup [platform]` — guided, one-pass environment setup. Auto-detects platforms when run without an argument. iOS opens the App Store for Xcode, activates it (license / first-launch), and downloads a simulator runtime. Android installs a JDK and builds a self-contained SDK at `~/Library/Android/sdk` (command-line tools, platform-tools, emulator, system image — no Android Studio GUI), then creates a set of AVDs across form factors. Booting stays on-demand via the relay.
- cli: `tapflow doctor [platform]` — checks a single platform or all. iOS shows Xcode / simctl / Simulator; Android shows SDK / adb / AVD (symmetric). `--json` emits machine-readable output; a device/AVD only needs to exist, not be running.

### Changed

- cli: `doctor` reports a missing prerequisite as a failure consistently across iOS and Android, and no longer triggers the macOS Command Line Tools install popup on a machine without Xcode.

## [0.7.0] - 2026-06-08

### Added

- android: emulators now capture over gRPC and encode H.264 on the Mac host (VideoToolbox). The gRPC backend is the default for emulators (auto-detected, 30fps cap), with automatic scrcpy fallback; real devices continue to use scrcpy.
- streaming: unified per-session downscale. Resolution is chosen from the viewer's connection context — native on a secure context, 1280px on LAN-HTTP, 1000px external — and is tunable via `TAPFLOW_MAX_SIZE` and the per-platform / `_LAN` / `_EXTERNAL` overrides.
- relay: request an IDR keyframe when a browser (re)joins a booted device, so a late joiner paints immediately.

### Changed

- dashboard: iOS/Android decoding and perf telemetry are unified behind a single `useDecoderStream` hook (hardware WebCodecs on a secure context, WASM fallback otherwise).
- ios-agent: static-frame skip — unchanged H.264 frames are no longer re-sent.

### Fixed

- ios: tear-free framebuffer snapshots via a seed-stable copy, and keyframe-aware backpressure on the agent→relay stream.
- android: keyframe-aware backpressure on the agent→relay stream, and 16-aligned encode sizing to avoid macroblock padding on the WASM decoder.

## [0.6.1] - 2026-06-06

### Fixed

- android: fix a crash when the scrcpy video stream is cancelled. The v0.6.0 socket-close cleanup could call `close()`/`error()` on an already-closed stream controller, throwing inside the socket event handler.

## [0.6.0] - 2026-06-06

### Added

- android: opt-in stream throughput metrics (`TAPFLOW_STREAM_METRICS=1`) logging fps / KB·s / drop every 5s, matching the iOS agent.
- agents: hold a macOS power assertion (`caffeinate -i`) while connected so an unattended/idle Mac doesn't throttle the simulator/emulator. macOS-only; no-op elsewhere.

### Changed

- android: H.264 frames now carry the codec/keyframe flags in the stream envelope, so the relay's keyframe-aware backpressure drops to the next keyframe under LAN congestion instead of forwarding P-frames that tear. (scrcpy `send_frame_meta=true`; the public `stream()` contract is unchanged.)
- android: on-demand IDR recovery — `stream:request-idr` now resets the scrcpy encoder (RESET_VIDEO), resyncing fast instead of waiting for the periodic IDR (parity with iOS).

### Fixed

- android: the scrcpy stream now terminates on socket close, so the agent's pump and its timers no longer leak after a device shuts down.

## [0.5.1] - 2026-06-06

### Fixed

- android: screen rotation on Android 15+ (API 35+). `AdbWrapper.setRotation` now uses `wm user-rotation lock` instead of the legacy `settings put system user_rotation`, which newer Android silently ignores (only a rotation suggestion appears). The bundled scrcpy server is upgraded 3.1 → 3.3, fixing the locked capture-orientation direction (scrcpy #6010) that left the stream sideways after rotation. Verified on API 34 and API 36 emulators.

## [0.5.0] - 2026-06-04

### Added

- H.264 streaming pipeline: iOS streams H.264 by default via a VideoToolbox encoder, cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
- Automatic codec negotiation: the browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers. Opt out with `TAPFLOW_IOS_CODEC=jpeg`.
- Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.
- cli: `tapflow start` prints the public tunnel URL banner (Tailscale MagicDNS host / tailnet IP auto-detected); a missing rathole token now falls back to local-only instead of exiting.
- dashboard: 404 error page and rectangular auth submit button.

### Changed

- envelope: codec/keyframe marker added to the frame header (byte5 flags). Backward compatible — older clients read frames as JPEG and the relay forwards payloads untouched; agents without `acceptH264` (version skew) default to JPEG.
- ios-agent: lower the default JPEG stream quality `0.95` → `0.8`, cutting iOS frame bandwidth ~40% on idle/simple screens to reduce relay→browser frame drops on LAN. Tune with the `TAPFLOW_JPEG_QUALITY` env var (`0`–`1`).

### Fixed

- android: landscape rotation and recording via a locked stream + local intent.

## [0.4.1] - 2026-06-01

### Security

- relay: fix path traversal in `/uploads/` — `serveUpload` now validates that the resolved file path stays within `uploadsDir`; requests that escape the directory return 403.
- relay: `/uploads/` route now requires view authentication — unauthenticated requests return 401 before file serving.
- relay: WebSocket connections from non-localhost clients without a valid JWT cookie or PAT are rejected with close code 1008.
- relay: WebSocket role gating — browser-role sockets that send agent-only messages (`agent:register`, `agent:resources`, etc.) are disconnected immediately.

## [0.4.0] - 2026-06-01

### Breaking Changes

- `tapflow init` no longer creates an admin account. It now scaffolds `tapflow.config.json`.
  - **Before:** `tapflow start` (auto-created config) → `tapflow init` (admin creation via CLI)
  - **After:** `tapflow init` (scaffold config) → `tapflow start` → open `/setup` in browser (admin creation)
  - **Migrate:** use the `/setup` page on first launch, or `tapflow admin init` in headless environments.
- `tapflow start` and `tapflow relay start` no longer create `tapflow.config.json` as a side effect. Run `tapflow init` explicitly, or skip it to use built-in defaults (port 4000, `.tapflow-data/`).

### Added

- `tapflow init` — scaffold `tapflow.config.json` interactively; `--tunnel tailscale|rathole` for non-interactive mode; `--force` to overwrite.
- `tapflow init` auto-updates `.gitignore` — creates the file if absent, appends `.tapflow-data/` if not already present.
- `tapflow admin init` — create the first admin account via CLI (headless / CI fallback).
- Dashboard `/setup` page — web-based first admin account creation; auto-redirected from `/login` when no accounts exist.
- `GET /api/v1/auth/status` — public endpoint returning `{ initialized: boolean }`.
- Tailscale tunnel provider (`tunnel.provider: "tailscale"`) — E2E encrypted, no VPS required.

### Removed

- Automatic `tapflow.config.json` creation as a side effect of `tapflow start` / `tapflow relay start`.

[Unreleased]: https://github.com/jo-duchan/tapflow/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/jo-duchan/tapflow/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/jo-duchan/tapflow/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/jo-duchan/tapflow/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/jo-duchan/tapflow/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/jo-duchan/tapflow/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/jo-duchan/tapflow/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/jo-duchan/tapflow/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/jo-duchan/tapflow/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/jo-duchan/tapflow/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/jo-duchan/tapflow/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/jo-duchan/tapflow/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/jo-duchan/tapflow/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jo-duchan/tapflow/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/jo-duchan/tapflow/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jo-duchan/tapflow/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/jo-duchan/tapflow/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/jo-duchan/tapflow/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/jo-duchan/tapflow/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jo-duchan/tapflow/compare/v0.3.1...v0.4.0
