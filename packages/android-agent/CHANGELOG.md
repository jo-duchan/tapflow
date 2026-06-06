# @tapflowio/android-agent

## 0.6.1

### Patch Changes

- Fix a crash when the scrcpy video stream is cancelled. The v0.6.0 socket-close cleanup could call `close()`/`error()` on an already-closed ReadableStream controller (after the consumer cancelled the reader), throwing `ERR_INVALID_STATE` inside the socket event handler. The stream is now marked settled on cancel and the close/error is guarded.
  - @tapflowio/agent-core@0.6.1

## 0.6.0

### Minor Changes

- Robust Android LAN streaming — keyframe-aware backpressure, on-demand IDR recovery, and idle-throttle prevention.

  - Android H.264 frames now carry the codec/keyframe flags in the stream envelope, so the relay's keyframe-aware backpressure preserves the reference chain under LAN congestion — it drops to the next keyframe instead of forwarding P-frames that tear. (`scrcpy send_frame_meta=true`; the public `stream()` contract is unchanged.)
  - On-demand IDR recovery for Android: the relay's `stream:request-idr` now resets the scrcpy encoder (RESET_VIDEO), resyncing fast instead of waiting for the periodic IDR — bringing Android congestion recovery to parity with iOS.
  - Agents hold a macOS power assertion (`caffeinate -i`) while connected so an unattended/idle Mac doesn't throttle the simulator/emulator. macOS-only; no-op elsewhere.
  - Fixed: the Android scrcpy stream now terminates on socket close, so the agent's pump and its timers no longer leak after a device shuts down.
  - Added: opt-in Android stream throughput metrics (`TAPFLOW_STREAM_METRICS=1`), matching the iOS agent.

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.6.0

## 0.5.1

### Patch Changes

- c469362: Fix Android screen rotation on Android 15+ (API 35+). `AdbWrapper.setRotation` now uses `wm user-rotation lock` instead of the legacy `settings put system user_rotation`, which is silently ignored on newer Android (only a rotation suggestion appears). The bundled scrcpy server is upgraded 3.1 → 3.3, which fixes the locked capture-orientation direction (scrcpy #6010) that left the stream sideways after rotation on API 35+. Verified on API 34 and API 36 emulators.
  - @tapflowio/agent-core@0.5.1

## 0.5.0

### Patch Changes

- 7e4023a: fix(android): landscape rotation and recording via a locked stream + local intent.
- Updated dependencies
  - @tapflowio/agent-core@0.5.0

## 0.4.1

### Patch Changes

- 17b8615: fix: path traversal in /uploads/ and unauthenticated WebSocket access
- Updated dependencies [17b8615]
  - @tapflowio/agent-core@0.4.1

## 0.4.0

### Minor Changes

- feat!: tapflow init redesign, Tailscale tunnel, web onboarding, and UX improvements

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.4.0

## 0.3.1

### Patch Changes

- Fix mcp-server release: add publishConfig for experimental tag and public access
- Updated dependencies
  - @tapflowio/agent-core@0.3.1

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

## 0.2.2

### Patch Changes

- @tapflowio/agent-core@0.2.2

## 0.2.1

### Patch Changes

- fix: WebSocket backpressure, Android pinch via scrcpy multi-touch, dashboard skeleton visibility
- Updated dependencies
  - @tapflowio/agent-core@0.2.1

## 0.2.0

### Minor Changes

- Add typed errors, CLI install banner, and dashboard toast feedback

  - **typed errors** (`agent-core`): `ValidationError`, `PlatformError`, `AuthError` exported from `@tapflowio/agent-core`; key runtime throw sites updated for typed `instanceof` handling (#63)
  - **CLI install banner**: `postinstall` prints success banner after global npm install (suppressed in CI / non-TTY / local workspace); `tapflow` with no args shows version banner and quick-start commands (#90)
  - **dashboard toast feedback**: sonner toasts on all key mutation flows — token create/revoke/copy, workspace/profile/password/app settings, app creation, build upload; `confirm()` replaced with `AlertDialog`; `toast.promise` for upload progress (#91)

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.2.0

## 0.1.0

### Patch Changes

- @tapflowio/agent-core@0.1.0

## 0.1.0-alpha.8

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.2
