# tapflow

## 0.8.0-next.1

### Minor Changes

- 5bd3381: fix(cli): `doctor` shows Android even without adb, and adds `doctor [platform]`

  `tapflow doctor` no longer hides the Android section when adb is not found — it surfaces an `adb not found → tapflow setup android` warning so people setting up an Android-only agent can still diagnose it. Added `tapflow doctor ios|android` to check a single platform (mirrors `tapflow setup [platform]`); omit the argument to check all.

- 3b5b28e: feat(cli): setup completes in one run; doctor reflects on-demand boot

  `tapflow setup` is now an end-to-end interactive wizard instead of stopping to print manual commands:

  - runs sudo steps directly after confirmation (`xcode-select -s`, `xcodebuild -license accept`, `-runFirstLaunch`) — no more "run this and re-run setup" loop.
  - iOS: downloads the simulator runtime when no device exists.
  - Android: when no AVD exists, installs a `google_apis` system image once and creates a set of 4 AVDs across form factors (compact / phone / large / tablet) so the device list is comparable to iOS. Device ids are chosen per-environment from candidates; ABI matches the host arch.
  - no longer boots devices — relay boots on-demand when a QA Session connects, so setup only ensures a bootable device/AVD exists.
  - `tapflow setup` (no argument) offers to set up Android even when adb isn't found, and ends with a `SETUP COMPLETE` / `SETUP INCOMPLETE` summary banner (per-platform ready state).

  `tapflow doctor` now passes when a simulator device or AVD _exists_ (any state) rather than requiring a _running_ one, matching the on-demand boot model.

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.1
- @tapflowio/ios-agent@0.8.0-next.1
- @tapflowio/android-agent@0.8.0-next.1
- @tapflowio/relay@0.8.0-next.1

## 0.8.0-next.0

### Minor Changes

- 2552e53: feat(cli): add `tapflow doctor --json` and diagnose adb installed-but-not-in-PATH

  - `tapflow doctor --json` emits machine-readable `{ ok, common, ios, android }` with no ANSI color, exiting 1 on failure — usable from CI and automation without screen-scraping.
  - `doctor` now detects adb present in a standard SDK location (`$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`) but missing from PATH, instead of silently dropping the entire Android section. It surfaces an `adb (not in PATH)` warning hinting `tapflow setup android`.

- 78743d4: feat(cli): add `tapflow setup android` — guided Android environment setup

  `tapflow doctor` diagnoses problems; `tapflow setup android` fixes them. It walks through the required Android dependencies and applies fixes where safe:

  - **Homebrew** — checks `which brew`, prints the install URL if missing (cannot auto-install).
  - **adb** — if present in PATH it passes; if found in a standard SDK location but missing from PATH it registers the `platform-tools` directory in your shell rc (`.zshrc`/`.bashrc`) inside an idempotent marker block; if absent it runs `brew install android-platform-tools`.
  - **Android Studio** — checks `/Applications/Android Studio.app`; since the cask is large (~1GB+) it asks for confirmation before `brew install --cask android-studio`, and skips with guidance in non-interactive shells.
  - **Emulator** — reports running emulators and hints how to start an AVD.

  Each step is idempotent — re-running on a configured machine prints ✓ and makes no changes.

- e21902e: feat(cli): `tapflow setup` can install Homebrew after confirmation

  When Homebrew is missing, `tapflow setup android` (and upcoming `setup ios`) now offers to install it via the official script after an explicit confirmation prompt, instead of only printing the install URL. In non-interactive shells it still just prints guidance — no remote script runs without consent. This makes Homebrew the shared first step for all platform setups.

- 64d9a59: feat(cli): add `tapflow setup ios` and unify the setup command

  `tapflow setup ios` guides iOS environment setup: Homebrew → Xcode → Xcode activation → Simulator.

  - **Xcode** — since Xcode is App-Store-only, an interactive flow opens the App Store and waits for you to finish installing, then re-checks. Non-interactive shells print the App Store link instead.
  - **Xcode activation** — detects the "installed but not usable" case (active developer dir on CommandLineTools, missing license, or first-launch) and prints the exact `sudo xcode-select -s …` / `xcodebuild -license accept` / `-runFirstLaunch` commands (these need sudo, so setup guides rather than auto-runs them).
  - **Simulator** — boots the first available simulator if none is running.

  The `setup` command now takes an optional platform: `tapflow setup ios`, `tapflow setup android`, or `tapflow setup` to auto-detect and run every supported platform (iOS on macOS, Android when adb is found).

  Closes #144 (and completes #142 together with `setup android`).

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.0
- @tapflowio/ios-agent@0.8.0-next.0
- @tapflowio/android-agent@0.8.0-next.0
- @tapflowio/relay@0.8.0-next.0

## 0.7.0

### Minor Changes

- Low-latency render pipeline.

  - **Android host-encode**: emulators now capture over gRPC and encode H.264 on the Mac host (VideoToolbox). The gRPC backend is the default for emulators, with a 30fps cap and automatic scrcpy fallback; real devices continue to use scrcpy.
  - **Unified downscale**: per-session resolution is chosen from the viewer's connection context (native on a secure context, 1280px on LAN-HTTP, 1000px external) and is tunable via `TAPFLOW_MAX_SIZE` and the per-platform / `_LAN` / `_EXTERNAL` overrides.
  - **Relay IDR-on-rejoin**: the relay requests an IDR keyframe when a browser (re)joins a booted device, so a late joiner paints immediately.
  - **iOS**: static-frame skip, tear-free framebuffer snapshots, and keyframe-aware backpressure on the agent→relay stream.
  - **Android**: keyframe-aware backpressure and 16-aligned encode sizing to avoid macroblock padding on the WASM decoder.

  The dashboard unifies iOS/Android decoding and perf telemetry behind a single `useDecoderStream` hook (hardware WebCodecs on a secure context, WASM fallback otherwise).

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.7.0
  - @tapflowio/ios-agent@0.7.0
  - @tapflowio/android-agent@0.7.0
  - @tapflowio/relay@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies
  - @tapflowio/android-agent@0.6.1
  - @tapflowio/agent-core@0.6.1
  - @tapflowio/ios-agent@0.6.1
  - @tapflowio/relay@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.6.0
  - @tapflowio/android-agent@0.6.0
  - @tapflowio/ios-agent@0.6.0
  - @tapflowio/relay@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [c469362]
  - @tapflowio/android-agent@0.5.1
  - @tapflowio/agent-core@0.5.1
  - @tapflowio/ios-agent@0.5.1
  - @tapflowio/relay@0.5.1

## 0.5.0

### Minor Changes

- H.264 streaming pipeline with automatic codec negotiation.

  - iOS streams H.264 by default (VideoToolbox encoder), cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
  - The browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers.
  - Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.

  Backward compatible: the envelope codec/keyframe marker reuses a previously zero flag byte, so older clients read frames as JPEG and the relay forwards payloads untouched. Agents without `acceptH264` (version skew) default to JPEG. Opt out of H.264 anytime with `TAPFLOW_IOS_CODEC=jpeg`.

- 267447c: feat(cli): `tapflow start` now reads the tunnel config from `tapflow.config.json` and prints the public URL in the startup banner.

  Previously only `tapflow relay start` brought up the tunnel (Tailscale/rathole). Now the local all-in-one `tapflow start` starts the tunnel too, auto-detecting the Tailscale MagicDNS hostname (or tailnet IP) and showing a `Public :` URL in the banner. Tunnel startup logic was consolidated into `lib/tunnel-runner.ts`.

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
