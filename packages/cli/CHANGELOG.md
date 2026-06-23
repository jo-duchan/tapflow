# tapflow

## 0.10.0

### Minor Changes

- Build review status is now decoupled from the storage deletion lifecycle (#258). Marking a build **Done** no longer schedules it for deletion — `status_label` is a pure review state, and purge keys off a new nullable `delete_after` timestamp instead of `completed_at`. Deletion is an explicit action via `POST /api/v1/builds/:id/schedule-deletion` (and `DELETE …/schedule-deletion` to cancel); the response and build payloads now include `delete_after`. Migration `012` adds the column and grandfathers builds already on the old `completed_at` clock (`delete_after = completed_at + TTL`) so upgrades keep reclaiming disk. The dashboard shows a deletion-countdown badge separate from the status column with explicit schedule/cancel actions.

### Patch Changes

- 9864d2d: Build-upload validation errors are now returned in English, matching the rest of the API (previously the `.app.zip` format, missing-`.app`-directory, and device-only-slice messages were Korean only). Internal code comments are unchanged.
- `tapflow setup` now reports per-step state — `found` / `created` / `repaired` — instead of a binary result, so you can see which prerequisites were already in place versus newly provisioned. Android SDK environment registration that was already present is now reported as `repaired` rather than `found`.
- c3ea54c: The iOS screen-capture helper now reports a `capture-wait` metric under `TAPFLOW_STREAM_METRICS=1` — the polling gap between an IOSurface change and when the frame is encoded, emitted as `info: capture-wait avg/max/n` per 150-sample window. Diagnostic only; capture behavior is unchanged.
- d1b36a9: The relay now runs a WebSocket heartbeat (ping/pong, 30s) over every socket and terminates one that misses a pong window, so dead agent/browser/stream sockets (Wi-Fi loss, sleep, cable pull) are detected promptly instead of lingering until the TCP timeout. Termination reuses the existing close cleanup, evicting stale sessions and clearing the duplicate "Stale" card.
- Updated dependencies
- Updated dependencies [9864d2d]
- Updated dependencies [c3ea54c]
- Updated dependencies [d1b36a9]
  - @tapflowio/relay@0.10.0
  - @tapflowio/ios-agent@0.10.0
  - @tapflowio/android-agent@0.10.0
  - @tapflowio/agent-core@0.10.0

## 0.9.2

### Patch Changes

- Wire TLS into the all-in-one `tapflow start` so LAN teammates get secure-context streaming (Smooth/WebCodecs) — previously only `relay start` served HTTPS. The co-located agent accepts the localhost `wss://` cert only, while external relays keep full verification.

  Include `--token` in the agent connect hint for remote relays, and unify the stream-quality tier label to "Smooth".

- Updated dependencies
  - @tapflowio/agent-core@0.9.2
  - @tapflowio/android-agent@0.9.2
  - @tapflowio/ios-agent@0.9.2
  - @tapflowio/relay@0.9.2

## 0.9.1

### Patch Changes

- The relay now loads `.tapflow-data/.env` before reading its config, so every secret can live in that file — not just DNS/ACME tokens. `JWT_SECRET`, the SMTP password, and the tunnel token are all picked up from `.env` now. Precedence is shell env > `.env` > config file (a shell variable still overrides the file). `TAPFLOW_DATA_DIR` is the one exception, since it decides where `.env` lives.
- Updated dependencies
  - @tapflowio/relay@0.9.1
  - @tapflowio/android-agent@0.9.1
  - @tapflowio/ios-agent@0.9.1
  - @tapflowio/agent-core@0.9.1

## 0.9.0

### Minor Changes

- LAN HTTPS — terminate TLS in-process with automatic certificates.

  - relay: in-process TLS termination with a disk-backed certificate store and automatic renewal. Two providers: `AcmeCertProvider` (Let's Encrypt via DNS-01) and `ImportCertProvider` (bring your own cert).
  - relay: pluggable `DnsProviderRegistry` for DNS-01 challenges, with `CloudflareDnsProvider` and `VercelDnsProvider` adapters. New DNS providers register without touching relay code.
  - relay: auto-publishes the detected LAN IP to the configured domain's A record and self-heals it on change, so the HTTPS hostname keeps resolving on the local network.
  - relay: DNS/ACME credentials load from a gitignored `.env` file, namespaced under `TAPFLOW_`. Requires Node >= 20.12.0.
  - cli: `tapflow init` gains a guided HTTPS setup step for the LAN path; `tapflow start` wires `--trusted-proxies` / `--cors-origins`.

  This enables WebCodecs-based low-latency streaming, which requires a secure context on the LAN.

### Patch Changes

- da68b9e: Further harden the relay for public exposure:

  - CORS is restricted to the configured origins (public URL + loopback) instead of `*`, so an `Authorization` token can't be used from an unlisted cross-origin script.
  - Cookie-authenticated state-changing requests must come from a same-origin or allowlisted origin (lightweight CSRF guard); PAT-authenticated requests are exempt.
  - Invite links are built from the configured base URL (tunnel public URL / relay URL) instead of the request `Host` header.
  - Uploads that exceed the size limit are rejected and their partial files removed (builds and comment attachments). Limits are configurable via `TAPFLOW_MAX_BUILD_BYTES` / `TAPFLOW_MAX_COMMENT_BYTES`.

- 37f1aae: The relay now logs handler exceptions (method, path, stack) instead of silently swallowing them, so 5xx failures are diagnosable. Response bodies still return only a generic message, and PATs are masked in the logs.
- Updated dependencies
- Updated dependencies [da68b9e]
- Updated dependencies [37f1aae]
  - @tapflowio/relay@0.9.0
  - @tapflowio/android-agent@0.9.0
  - @tapflowio/ios-agent@0.9.0
  - @tapflowio/agent-core@0.9.0

## 0.8.2

### Patch Changes

- 859f9e3: Harden the relay for public and proxied exposure:

  - A per-install JWT secret is generated and persisted automatically when `JWT_SECRET` is unset, replacing the shared development default.
  - Authentication endpoints apply rate limiting with exponential backoff.
  - Bootstrap (`auth/init`) is restricted to localhost — on headless servers, run `tapflow admin init` on the relay host.
  - New `TAPFLOW_TRUSTED_PROXIES` resolves the real client IP from `X-Forwarded-For` when the relay runs behind a same-host reverse proxy.

- Updated dependencies [859f9e3]
  - @tapflowio/relay@0.8.2
  - @tapflowio/android-agent@0.8.2
  - @tapflowio/ios-agent@0.8.2
  - @tapflowio/agent-core@0.8.2

## 0.8.1

### Patch Changes

- 6e4801a: Restore remote agent connections to the relay (#271). The WS auth gate added in 17b8615 closed every non-loopback connection without a cookie/PAT, so no remote agent could register — the agent then hung forever on a silent pre-registration close ("Connecting ios agent…"). Remote agents now connect again, authenticated with a token.

  **Changed — remote agents now require a token.** A relay on a different machine only accepts agents that present a PAT with the new `agent` scope (create one in Settings → Tokens, pass it via `--token` or `TAPFLOW_AGENT_TOKEN`). Agents connecting to a relay on the same machine (`localhost`) stay unauthenticated, so `tapflow start` is unchanged. See [Remote relay authentication](https://github.com/jo-duchan/tapflow/blob/main/docs/guide/agent.md#remote-relay-authentication).

  Details:

  - relay: remote connections presenting a PAT with the new `agent` scope are accepted and roled by their first message (`agent:register` / `stream:register`); the rejection close reason explains the fix and is logged. Token creation API accepts a `scope` field (`agent` scope is Admin-only; default scope unchanged).
  - dashboard: token dialog gains an API/Agent type selector; creating an agent token shows a ready-to-run `tapflow agent start --token` command.
  - agents (iOS/Android): new `token` option sends `Authorization: Bearer` on the control and stream WS; pre-registration closes now reject with the close code/reason instead of hanging; handshake timeout (10s default); reconnect failures log their cause.
  - cli: `tapflow agent start --token` flag (or `TAPFLOW_AGENT_TOKEN` env); a 1008 rejection prints token setup guidance. Local (`localhost`) agents stay unauthenticated — `tapflow start` is unchanged.

- Updated dependencies [80f4d78]
- Updated dependencies [129b5b1]
- Updated dependencies [6e4801a]
  - @tapflowio/ios-agent@0.8.1
  - @tapflowio/relay@0.8.1
  - @tapflowio/agent-core@0.8.1
  - @tapflowio/android-agent@0.8.1

## 0.8.1-next.0

### Patch Changes

- Updated dependencies [80f4d78]
- Updated dependencies [129b5b1]
  - @tapflowio/ios-agent@0.8.1-next.0
  - @tapflowio/relay@0.8.1-next.0
  - @tapflowio/android-agent@0.8.1-next.0
  - @tapflowio/agent-core@0.8.1-next.0

## 0.8.0

### Minor Changes

- 2552e53: feat(cli): add `tapflow doctor --json` and diagnose adb installed-but-not-in-PATH

  - `tapflow doctor --json` emits machine-readable `{ ok, common, ios, android }` with no ANSI color, exiting 1 on failure — usable from CI and automation without screen-scraping.
  - `doctor` now detects adb present in a standard SDK location (`$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`) but missing from PATH, instead of silently dropping the entire Android section. It surfaces an `adb (not in PATH)` warning hinting `tapflow setup android`.

- 5bd3381: fix(cli): `doctor` shows Android even without adb, and adds `doctor [platform]`

  `tapflow doctor` no longer hides the Android section when adb is not found — it surfaces an `adb not found → tapflow setup android` warning so people setting up an Android-only agent can still diagnose it. Added `tapflow doctor ios|android` to check a single platform (mirrors `tapflow setup [platform]`); omit the argument to check all.

- 3991d68: feat(cli): setup android bootstraps a self-contained SDK (JDK + cmdline-tools), no Android Studio

  `tapflow setup android` no longer relies on Android Studio (whose `.app` install doesn't include the SDK, breaking unattended setup). Instead it builds a self-contained SDK at `~/Library/Android/sdk`:

  - installs a JDK via Temurin when missing (required by sdkmanager)
  - bootstraps `cmdline-tools;latest` + `platform-tools` + `emulator` + a `google_apis` system image into the SDK with `sdkmanager --sdk_root`, auto-accepting licenses
  - registers `ANDROID_HOME` and platform-tools/emulator on PATH
  - creates the form-factor AVD set with the SDK's own avdmanager

  Because cmdline-tools live inside the SDK, the avdmanager resolves the SDK root automatically — fixing the "Valid system image paths are: null" failure caused by a brew/SDK path split. Verified end-to-end on a clean Mac.

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

- 3b5b28e: feat(cli): setup completes in one run; doctor reflects on-demand boot

  `tapflow setup` is now an end-to-end interactive wizard instead of stopping to print manual commands:

  - runs sudo steps directly after confirmation (`xcode-select -s`, `xcodebuild -license accept`, `-runFirstLaunch`) — no more "run this and re-run setup" loop.
  - iOS: downloads the simulator runtime when no device exists.
  - Android: when no AVD exists, installs a `google_apis` system image once and creates a set of 4 AVDs across form factors (compact / phone / large / tablet) so the device list is comparable to iOS. Device ids are chosen per-environment from candidates; ABI matches the host arch.
  - no longer boots devices — relay boots on-demand when a QA Session connects, so setup only ensures a bootable device/AVD exists.
  - `tapflow setup` (no argument) offers to set up Android even when adb isn't found, and ends with a `SETUP COMPLETE` / `SETUP INCOMPLETE` summary banner (per-platform ready state).

  `tapflow doctor` now passes when a simulator device or AVD _exists_ (any state) rather than requiring a _running_ one, matching the on-demand boot model.

### Patch Changes

- 4f957e1: fix(cli): doctor reports missing adb as a failure, consistent with Xcode

  `tapflow doctor` now marks a missing adb as a failure (✗) — the same as a missing Xcode — instead of a warning, so a clean machine shows its checks uniformly. `tapflow setup android` resolves it.

- 629741f: fix(cli): doctor AVD is a failure (not a warning) when the SDK/emulator is absent

  On a clean machine, `tapflow doctor` showed Android SDK/adb as ✗ but AVD as ⚠. AVD now mirrors iOS Simulator: a missing SDK/emulator is a failure (✗, `tapflow setup android`), while a present emulator with no AVD stays a warning (⚠). The emulator is resolved from the SDK directory.

- a593b9a: fix(cli): doctor no longer triggers the macOS "install Command Line Tools" popup

  On a Mac without Xcode, `tapflow doctor` called `xcodebuild`/`xcrun`, which makes macOS pop up the Command Line Tools installer. doctor now checks for `/Applications/Xcode.app` first (no popup) and only invokes those tools when Xcode is present — otherwise it reports "Install Xcode / run tapflow setup ios" directly.

- fc98ebd: feat(cli): setup highlights "open a new terminal" after registering ANDROID_HOME/PATH

  When `tapflow setup android` adds `ANDROID_HOME`/PATH to your shell rc, the current shell doesn't pick them up — so running `tapflow doctor` right away showed confusing adb/AVD warnings. setup now prints a clear "open a new terminal (or run `exec zsh`), then `tapflow doctor`" note after the summary banner, only when the env was just registered.

  - @tapflowio/agent-core@0.8.0
  - @tapflowio/ios-agent@0.8.0
  - @tapflowio/android-agent@0.8.0
  - @tapflowio/relay@0.8.0

## 0.8.0-next.4

### Patch Changes

- a593b9a: fix(cli): doctor no longer triggers the macOS "install Command Line Tools" popup

  On a Mac without Xcode, `tapflow doctor` called `xcodebuild`/`xcrun`, which makes macOS pop up the Command Line Tools installer. doctor now checks for `/Applications/Xcode.app` first (no popup) and only invokes those tools when Xcode is present — otherwise it reports "Install Xcode / run tapflow setup ios" directly.

  - @tapflowio/agent-core@0.8.0-next.4
  - @tapflowio/ios-agent@0.8.0-next.4
  - @tapflowio/android-agent@0.8.0-next.4
  - @tapflowio/relay@0.8.0-next.4

## 0.8.0-next.3

### Patch Changes

- 629741f: fix(cli): doctor AVD is a failure (not a warning) when the SDK/emulator is absent

  On a clean machine, `tapflow doctor` showed Android SDK/adb as ✗ but AVD as ⚠. AVD now mirrors iOS Simulator: a missing SDK/emulator is a failure (✗, `tapflow setup android`), while a present emulator with no AVD stays a warning (⚠). The emulator is resolved from the SDK directory.

- fc98ebd: feat(cli): setup highlights "open a new terminal" after registering ANDROID_HOME/PATH

  When `tapflow setup android` adds `ANDROID_HOME`/PATH to your shell rc, the current shell doesn't pick them up — so running `tapflow doctor` right away showed confusing adb/AVD warnings. setup now prints a clear "open a new terminal (or run `exec zsh`), then `tapflow doctor`" note after the summary banner, only when the env was just registered.

  - @tapflowio/agent-core@0.8.0-next.3
  - @tapflowio/ios-agent@0.8.0-next.3
  - @tapflowio/android-agent@0.8.0-next.3
  - @tapflowio/relay@0.8.0-next.3

## 0.8.0-next.2

### Minor Changes

- 3991d68: feat(cli): setup android bootstraps a self-contained SDK (JDK + cmdline-tools), no Android Studio

  `tapflow setup android` no longer relies on Android Studio (whose `.app` install doesn't include the SDK, breaking unattended setup). Instead it builds a self-contained SDK at `~/Library/Android/sdk`:

  - installs a JDK via Temurin when missing (required by sdkmanager)
  - bootstraps `cmdline-tools;latest` + `platform-tools` + `emulator` + a `google_apis` system image into the SDK with `sdkmanager --sdk_root`, auto-accepting licenses
  - registers `ANDROID_HOME` and platform-tools/emulator on PATH
  - creates the form-factor AVD set with the SDK's own avdmanager

  Because cmdline-tools live inside the SDK, the avdmanager resolves the SDK root automatically — fixing the "Valid system image paths are: null" failure caused by a brew/SDK path split. Verified end-to-end on a clean Mac.

### Patch Changes

- 4f957e1: fix(cli): doctor reports missing adb as a failure, consistent with Xcode

  `tapflow doctor` now marks a missing adb as a failure (✗) — the same as a missing Xcode — instead of a warning, so a clean machine shows its checks uniformly. `tapflow setup android` resolves it.

  - @tapflowio/agent-core@0.8.0-next.2
  - @tapflowio/ios-agent@0.8.0-next.2
  - @tapflowio/android-agent@0.8.0-next.2
  - @tapflowio/relay@0.8.0-next.2

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
