# tapflow

## 0.5.0

### Minor Changes

- H.264 streaming pipeline with automatic codec negotiation.

  - iOS streams H.264 by default (VideoToolbox encoder), cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
  - The browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers.
  - Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.

  Backward compatible: the envelope codec/keyframe marker reuses a previously zero flag byte, so older clients read frames as JPEG and the relay forwards payloads untouched. Agents without `acceptH264` (version skew) default to JPEG. Opt out of H.264 anytime with `TAPFLOW_IOS_CODEC=jpeg`.

- 267447c: feat(cli): `tapflow start`가 `tapflow.config.json`의 tunnel 설정을 읽어 공개 URL을 배너에 출력합니다.

  기존에는 `tapflow relay start`에서만 터널(Tailscale/rathole)을 기동했습니다. 이제 로컬 올인원 명령인 `tapflow start`도 동일하게 터널을 띄우고, Tailscale MagicDNS 호스트명(또는 tailnet IP)을 자동 감지해 배너에 `Public :` URL을 표시합니다. 터널 기동 로직은 `lib/tunnel-runner.ts`로 공통화했습니다.

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.5.0
  - @tapflowio/ios-agent@0.5.0
  - @tapflowio/relay@0.5.0
  - @tapflowio/android-agent@0.5.0

## 0.4.1

### Patch Changes

- 17b8615: fix: path traversal in /uploads/ and unauthenticated WebSocket access
- Updated dependencies [17b8615]
  - @tapflowio/agent-core@0.4.1
  - @tapflowio/ios-agent@0.4.1
  - @tapflowio/android-agent@0.4.1
  - @tapflowio/relay@0.4.1

## 0.4.0

### Minor Changes

- feat!: tapflow init redesign, Tailscale tunnel, web onboarding, and UX improvements

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.4.0
  - @tapflowio/ios-agent@0.4.0
  - @tapflowio/android-agent@0.4.0
  - @tapflowio/relay@0.4.0

## 0.3.1

### Patch Changes

- Fix mcp-server release: add publishConfig for experimental tag and public access
- Updated dependencies
  - @tapflowio/agent-core@0.3.1
  - @tapflowio/ios-agent@0.3.1
  - @tapflowio/android-agent@0.3.1
  - @tapflowio/relay@0.3.1

## 0.3.0

### Minor Changes

- bec7ff1: Release v0.3.0

  - relay: add screenshot REST endpoint (`GET /api/v1/sessions/:id/screenshot`) for CI and AI agent use
  - relay: enforce PAT scope checks on builds endpoints; new tokens include `view` scope by default
  - relay: add `session:leave` message type — MCP clients can disconnect without ending the session
  - relay: fix `.app` bundle names with spaces in zip upload validation
  - dashboard: add deeplink URL execution from QA session toolbar
  - dashboard: add keyboard shortcuts and Kbd UI to simulator toolbar
  - dashboard: add streaming performance overlay

### Patch Changes

- Updated dependencies [bec7ff1]
  - @tapflowio/agent-core@0.3.0
  - @tapflowio/ios-agent@0.3.0
  - @tapflowio/android-agent@0.3.0
  - @tapflowio/relay@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [306d859]
  - @tapflowio/relay@0.2.2
  - @tapflowio/android-agent@0.2.2
  - @tapflowio/ios-agent@0.2.2
  - @tapflowio/agent-core@0.2.2

## 0.2.1

### Patch Changes

- fix: WebSocket backpressure, Android pinch via scrcpy multi-touch, dashboard skeleton visibility
- Updated dependencies
  - @tapflowio/agent-core@0.2.1
  - @tapflowio/relay@0.2.1
  - @tapflowio/ios-agent@0.2.1
  - @tapflowio/android-agent@0.2.1

## 0.2.0

### Minor Changes

- Add typed errors, CLI install banner, and dashboard toast feedback

  - **typed errors** (`agent-core`): `ValidationError`, `PlatformError`, `AuthError` exported from `@tapflowio/agent-core`; key runtime throw sites updated for typed `instanceof` handling (#63)
  - **CLI install banner**: `postinstall` prints success banner after global npm install (suppressed in CI / non-TTY / local workspace); `tapflow` with no args shows version banner and quick-start commands (#90)
  - **dashboard toast feedback**: sonner toasts on all key mutation flows — token create/revoke/copy, workspace/profile/password/app settings, app creation, build upload; `confirm()` replaced with `AlertDialog`; `toast.promise` for upload progress (#91)

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.2.0
  - @tapflowio/ios-agent@0.2.0
  - @tapflowio/android-agent@0.2.0
  - @tapflowio/relay@0.2.0

## 0.1.0

### Patch Changes

- a27f220: fix(ci): use --tag alpha for changeset publish in pre mode
- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

- Updated dependencies [f13bd85]
  - @tapflowio/relay@0.1.0
  - @tapflowio/android-agent@0.1.0
  - @tapflowio/ios-agent@0.1.0
  - @tapflowio/agent-core@0.1.0

## 0.1.0-alpha.8

### Patch Changes

- fix(ci): use --tag alpha for changeset publish in pre mode
  - @tapflowio/agent-core@0.1.0-alpha.8
  - @tapflowio/ios-agent@0.1.0-alpha.8
  - @tapflowio/android-agent@0.1.0-alpha.8
  - @tapflowio/relay@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

- Updated dependencies [f13bd85]
  - @tapflowio/relay@0.1.0-alpha.7
  - @tapflowio/android-agent@0.1.0-alpha.7
  - @tapflowio/ios-agent@0.1.0-alpha.7
  - @tapflowio/agent-core@0.1.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- fix(release): correct build filter name for CLI package and add npm README thumbnail
  - @tapflowio/agent-core@0.1.0-alpha.2
  - @tapflowio/ios-agent@0.1.0-alpha.2
  - @tapflowio/android-agent@0.1.0-alpha.2
  - @tapflowio/relay@0.1.0-alpha.2
