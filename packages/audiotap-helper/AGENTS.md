# audiotap-helper — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

Shared macOS Core Audio process-tap helper. `audiotap-helper.swift` taps host processes by PID; this package owns the helper's **build, launch, and permission-priming** — not the per-platform capture/stream logic. Two consumers:

- **ios-agent** — `launchAudioHelper(port, pids)`: capture a simulator's audio and stream it to the browser.
- **android-agent** — `launchMuteOnlyTap(pids)`: hold a `.muted` tap on the emulator's qemu PID to silence its host output (Android host-mute, #341); gRPC does the capture. `--mute-only` mode: no port, no socket, no streaming — the helper self-exits when the target PID is gone.

Both share **one** signed `.app`, so they share **one** audio-capture TCC grant (keyed on the cdhash).

## HOW

- `ensureHelperApp()` mtime-gates a `swiftc` + `codesign` build and returns the `.app` path; npm ships the prebuilt, ad-hoc-signed `.app` so users need no build.
- A `.app` (not a bare binary) is required: a process tap returns silence unless the **responsible process** holds the grant, and only a LaunchServices-launched (`open`) bundle becomes its own responsible process. `-n` forces a fresh instance per launch (two sims / a sim + an emulator must not share one helper).
- `isAudioSupported()` gates on macOS 14.2+ (Darwin 23.2+) — the process-tap minimum.
- `requestAudioPermission(wait)` primes the grant up front (`tapflow setup ios` blocking, `tapflow agent start` non-blocking).

## HOW NOT

- Do not change `CFBundleIdentifier` / Info.plist casually — it shifts the cdhash and re-prompts for the TCC grant.
- Do not add capture/stream/volume logic here — that's per-platform (`ios-agent` `AudioCaptureStreamer`). This package is build/launch/permission only.
- Do not make this depend on `ios-agent` or `android-agent` — the dependency direction is agents → this package.

Design rationale and the rejected approaches: [contributing/simulator-audio.md](../../contributing/simulator-audio.md).
