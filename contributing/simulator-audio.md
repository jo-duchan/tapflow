# Simulator audio capture (device → browser) — design & rejected approaches

> How tapflow captures an Android emulator's / iOS simulator's audio and streams it to the browser, why the two platforms use different mechanisms, and — importantly — the iOS approaches we tried and **rejected**, with reasons, so nobody re-walks the dead ends. Manual-testing feature, opt-in. Tracking: [#259](https://github.com/jo-duchan/tapflow/issues/259) (output), [#334](https://github.com/jo-duchan/tapflow/issues/334) (input, out of scope here).

---

## Shared pipeline (both platforms)

Capture is platform-specific; everything downstream is shared and lives on `main`:

```
<platform capture> → S16LE / 44100 / Stereo → CODEC_AUDIO envelope → sendAudioYieldingToVideo
                   → relay (CODEC_AUDIO routing) → browser (Web Audio playback)
```

- **Canonical format**: 44100 / Stereo / S16LE. Each platform normalizes to this; the dashboard plays a fixed format (no per-frame format negotiation).
- **`CODEC_AUDIO`** (`agent-core/src/utils/envelope.ts`): an independent envelope bit, so audio rides the *same* stream socket as video without touching the JPEG/H.264 layout.
- **`sendAudioYieldingToVideo`** (`agent-core/src/utils/stream.ts`): audio uses the yielding sender, never the keyframe-aware video sender — **audio must never inflate the socket buffer enough to trip video's backpressure**. A dropped audio frame is a brief glitch; a stalled video is not. This is the no-degradation contract (audio is additive, never harms the manual-testing video path).
- **Opt-in**: `TAPFLOW_ANDROID_AUDIO=1` / `TAPFLOW_IOS_AUDIO=1`. Default off leaves the video path byte-for-byte unchanged.

## Android — emulator gRPC `streamAudio`

The Android emulator is a **single process** that emulates the whole device, including audio. It exposes a gRPC `streamAudio` endpoint that hands us the emulator's mixed system audio (S16/44100/Stereo). Per-emulator, system-level (any app — Chrome/YouTube included), already isolated by the emulator-process boundary. `AndroidAgent.pumpAudio` wraps it in `CODEC_AUDIO`. Straightforward — the emulator does the hard part.

## iOS — macOS Core Audio process taps (`AudioHardwareCreateProcessTap`, macOS 14.2+)

The key insight that unlocked iOS:

> **Simulator apps are host macOS processes.** `xcrun simctl launch` returns a host PID; `ps` shows the app's host binary. The simulator's audio doesn't go through a single tappable device — each app (and its children) plays to the host's CoreAudio directly.

So we capture per-process with a **Core Audio process tap**: translate the sim's process PIDs → process objects (`kAudioHardwarePropertyTranslatePIDToProcessObject`) → `CATapDescription(stereoMixdownOfProcesses:)` → `AudioHardwareCreateProcessTap` → a private aggregate device (`kAudioAggregateDeviceTapListKey`, with the host default output as the clock sub-device) → an IOProc reads the tapped PCM. `muteBehavior = .unmuted` so the apps still play normally; we capture a copy. No device routing, no dylib injection, no host-output hijack, and it works on **any signed build**.

This gives the Android-symmetric properties on one Mac: **per-sim isolation** (tap only that sim's PIDs), **whole-sim** (tap the sim's process tree incl. WebKit `WebContent` → WebView audio works), **headless**, **no build modification**.

### Whole-sim dynamic tap

The tap set is the sim's whole process tree, kept current as processes come and go and as they start/stop audio:

- **Enumerate** (`SimProcessTree.enumerateSimPids`): every sim process is a descendant of one `launchd_sim` whose command line embeds the device UDID; walk that tree. `IOSAgent` taps this set at `device:boot` — **not** per-`app:launch`.
- **Poll for new processes** (1.5s): a launched app or a freshly spawned `WebContent` is a *new* PID → push the updated set to the helper. `open`-launched helpers have no stdin, so pid updates ride the **same loopback socket** the helper streams PCM on (it's bidirectional). Dead PIDs need no rebuild — they resolve to no audio object, so the helper just stops mixing them; we only rebuild on additions (avoids daemon-churn glitches).
- **React to audio start** (helper's `kAudioHardwarePropertyProcessObjectList` listener): `TranslatePIDToProcessObject` only resolves a process *currently producing audio*, so a PID already in the set (e.g. `WebContent` when a YouTube tab starts) becomes tappable only at that moment — which pid polling can't see (the PID never changes). The listener rebuilds the tap when the audio-object list changes.
- **Queue separation (critical)**: the listener and the IOProc run on **separate** dispatch queues. Sharing one deadlocks `AudioDeviceStop` (in tap teardown) against the live IOProc on a video switch's stop/start audio churn — audio drops permanently and the helper can't even exit on SIGTERM. (Found via the "first video plays, the next is silent forever" bug.)

### Simulator volume

The process tap captures audio *before* the simulator applies its own media volume, so the captured signal ignores the sim volume (only the browser's `<audio>` volume would change it). The sim's current volume is exposed at `…/Devices/<udid>/data/var/run/simulatoraudio/audiosettings.plist` as `sim_volume` (0–100, updated live as the user changes it). `readSimVolume()` reads it (there is no `simctl` volume subcommand) and `applyGain()` multiplies it into the captured PCM, per session — so concurrent sims keep independent volume. The curve is currently linear (`v/100`); matching iOS's perceptual (log) curve is a follow-up.

### Two non-obvious constraints

1. **TCC: the capture must be a `.app` launched via LaunchServices.** A process tap returns *silence* unless the **responsible process** holds the audio-recording TCC grant. A CLI helper the Node agent spawns inherits the agent/terminal's (ungranted) responsibility → silence (verified). So the capture runs in a small signed bundle — `audiotap-helper.app` — launched via `open -g`; it becomes its own responsible process with its own **one-time** grant (like Screen Recording). The helper streams PCM back over **loopback TCP** (`open` detaches it, so stdout isn't an option). Steady-state (unchanged helper binary) reuses the same ad-hoc cdhash, so the grant persists; only a helper change re-prompts. **Priming the grant**: the prompt otherwise appears at first `device:boot`, which an unattended agent operator would miss — so `tapflow setup ios` runs the helper's `--request-permission` mode (a global tap whose *capture start*, not tap creation, raises the prompt — needing no port/pid/booted sim) to grant it up front while the operator is present.
2. **macOS 14.2+** (Core Audio process taps). Older macOS → iOS audio is unsupported (no fallback; the dylib path C was rejected, see below).

### Code map (iOS)

| File | Role |
|---|---|
| `ios-agent/src/audiotap-helper.swift` | The tap helper: PIDs → process tap → aggregate → IOProc → Float32→S16/44100 → loopback TCP frames. Bidirectional socket (receives pid-set updates → rebuilds the tap), `kAudioHardwarePropertyProcessObjectList` listener (rebuild on audio start), separate control/IOProc queues, and a `--request-permission` priming mode. |
| `ios-agent/src/AudioCaptureStreamer.ts` | `ensureHelperApp()` (mtime build + ad-hoc sign of the `.app`), `launchAudioHelper()` (`open -g`), `updatePids()` (push the tap set), the loopback TCP server → `ReadableStream<AudioFrame>`; plus `isAudioSupported()`, `readSimVolume()`, `applyGain()`, `requestAudioPermission()`. |
| `ios-agent/src/SimProcessTree.ts` | `enumerateSimPids(udid)` — the sim's host PIDs via its `launchd_sim` descendant tree. |
| `ios-agent/src/IOSAgent.ts` | Opt-in + macOS-14.2 gate; boot-time whole-sim tap + 1.5s process-tree poll; per-session sim-volume gain; `pumpAudio` → `CODEC_AUDIO`. |
| `cli/src/lib/setup.ts` | `tapflow setup ios` primes the audio-capture TCC grant up front via `requestAudioPermission()`. |

## Why the platforms are asymmetric

Android = **one** emulator process with a built-in audio stream (tap it directly). iOS = **many** host processes per sim, each playing to host CoreAudio independently — there is no single per-sim audio stream at the simulator layer. iOS audio is therefore captured at the **macOS** layer (process taps), not the simulator layer. The simulator deliberately exposes audio only as *routing* (which host device the guest plays to), never as a tappable stream — unlike video, which has a per-device framebuffer port (`com.apple.framebuffer.display`, tapped via SimulatorKit IOSurface).

## Rejected iOS approaches (do not re-explore without new facts)

All four were tried against headless `simctl`-booted sims. Full evidence is in the `.work/` plans — the rejected-approach detail in `.work/archive/2026-06-25-ios-audio-output-impl-plan.md`, the approach-E design in `.work/2026-06-26-ios-audio-process-tap-plan.md` (local only).

| # | Approach | Why rejected |
|---|---|---|
| **A** | **`routeGuest` / per-device routing** — bind the guest's output to a virtual host device (`SimAudioHostRoutable.routeGuestDeviceScope:toHostDeviceUID:`, or SimulatorKit's `SimDeviceAudioClient`). | Headless **no-op**. The call is accepted (err=nil) and even updates `guestOutputHostDeviceUID` + the per-device plist when the client is kept alive, but `effectiveDefaultOutputDevice` never re-binds — the actual audio HAL is not switched. Re-binding is gated behind the **authoritative audio-route controller**, which only Simulator.app's owning session holds; a headless agent can't be it. Proven across exact UID / all scopes / while-playing / the full `SimDeviceAudioClient`. |
| **B** | **Default-output redirect** — set the host's default output to a virtual device (BlackHole) and capture there. | Works (captures the whole sim, incl. Safari) but is **host-global + single-sim**: every sim follows the one host default → all sims mix into one capture, no per-sim isolation. This is the only documented method (appium, QuickTime) and what cloud services use with **one-sim-per-VM**. tapflow runs multiple sims per Mac, so it can't isolate. Also hijacks the host's default output. |
| **C** | **Guest dylib injection** — inject a dylib via `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` into the launched app, interpose CoreAudio (`AudioQueueEnqueueBuffer` + the v2 `MultiChannelMixer` render for AVAudioEngine) and tap PCM at the source. | Worked and was fully built (PR #337). But it only captures the **one launched app** — `WKWebView` audio renders in the separate `WebContent` process, which the injection doesn't reach (so hybrid/brownfield apps miss web audio). Superseded by E, which is per-process at the host layer (covers WebView) and needs no injection. Kept only as a historical note; **dropped** in favor of E. |
| **D** | **Inject `SimAudioProcessorService`** — tap the per-device audio XPC the guest PCM "passes through". | The service is injectable (no library validation) but is a **routing/device-management service only** — it imports no PCM-playback CoreAudio API (`AudioObjectGetPropertyData` only). The guest PCM does **not** flow through it; it just tells the guest which host device to use. No PCM to tap there. |

**Why E won**: it's the only approach that is simultaneously per-sim-isolated, whole-sim (incl. WebView), headless, host-non-hijacking, and works on unmodified signed builds — on one Mac with multiple sims. Cost: macOS 14.2+ and a one-time audio-recording permission grant.
