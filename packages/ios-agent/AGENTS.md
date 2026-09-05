---
type: rules
topics: [ios, simulator, macos, network]
status: living
---

# ios-agent — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`IOSAgent`: controls iOS simulators via `xcrun simctl`, streams frames using SimulatorKit IOSurface callbacks, and injects touch / keyboard / button events directly via SimDeviceLegacyHIDClient. No WebDriverAgent.

It also takes **one** simulator off the network and puts it back (#607), which on a device with no radio takes three mechanisms rather than one — a host system extension, an injected library, and the status bar. That is its own section at the end of this file, and none of the three is safe to touch alone.

## HOW

- Assume macOS only. Throw a clear error on non-macOS environments.
- Wrap all xcrun/simctl calls in dedicated functions so they can be swapped with mocks in tests.
- Capture frames via SimulatorKit IOSurface and stream H.264 (default) or JPEG frames as WebSocket binary messages (≤30 fps).
- `connect` only registers devices with the relay — it never boots one. Booting is on-demand via `device:boot` (dashboard / MCP). The `deviceFilter` option (CLI `--device`) narrows which devices are exposed to the relay (parity with android-agent), not a boot target.
- **`device:ready` means the device is up, not that the boot was accepted.** `simctl boot` returns on
  *initiation* and the device reaches `Booted` seconds later — measured 7.6s on an iPhone 17 Pro / iOS 26.5 —
  so `handleDeviceBoot` awaits `SimctlWrapper.waitUntilBooted` before it sends anything (#486). Android has
  always waited (`EmulatorLauncher.waitForBoot`), and a caller that acts on `ready` immediately is the one that
  notices: #440's *No devices are booted* was this half of the race. A boot that never finishes ends at a 90s
  deadline as `device:boot-error`. Four details are load-bearing, and three of them are holes the first draft
  of that wait shipped:
  - **Every status other than `booted` counts as still coming up, `shutdown` included.** `toDeviceStatus`
    collapses `Booting` into `unknown`, and the wait only ever runs after a `boot` was accepted, so a
    `shutdown` reading is the transition not yet observed. A draft gave it a 3s grace and failed early on it;
    that was reverted, because the reading is indistinguishable from a slow machine's healthy boot.
  - **The boot is issued on every path, including when the list already said `booted`** — which is what makes
    the sentence above true. The original on-demand boot skipped it there as an obvious economy; that skip
    became the one route into the wait with *nothing bringing the device up*, so a tester who quit the
    simulator inside one `xcrun` round trip paid the whole deadline. `SimctlWrapper.boot` swallows
    `Unable to boot device in current state: Booted`, so the skip bought one no-op subprocess.
  - **A failed reading is not a reading.** This spawns `xcrun simctl list` up to 180 times where the old code
    spawned it once, each one a chance to kill a healthy boot while CoreSimulator is busiest. Failures are
    swallowed and retried, and the last is reported with the deadline — but only if it is genuinely the last,
    which is why the success path clears it. Android has always swallowed them; the claim of parity with
    `waitForBoot` was false until this did too.
  - **`isStale` cancels the poll from inside.** The handler is fire-and-forget and its `bootSeq` check runs
    only once the wait *returns*, so a shutdown mid-wait would otherwise leave a process spawning twice a
    second against a device that is deliberately off. The check after the wait stays as well — it covers the
    microtask-thin case where the wait has resolved and the seq moves before the handler resumes.

  Closed since, by #549: both relay clients wait `BOOT_DEADLINE_MS`, which clears the slowest agent poll
  (Android's 120s) by a stated margin, and `scripts/__tests__/bootDeadlineOutlivesAgent.test.mjs` holds the
  relationship rather than the numbers. The margin is not decoration — `BOOT_READY_TIMEOUT_MS` bounds *the
  wait for the device to report itself up*, one stage of a boot rather than the request (and
  `BOOT_POLL_READ_TIMEOUT_MS` is narrower again: one reading inside that wait). A boot also lists devices,
  may shut down and erase, boots, and opens a stream, none of which has a ceiling anywhere. A client inside
  those was giving the caller a bare timeout for a boot that was proceeding normally, and whose explanation
  was already on its way. **The margin is an allowance, not a ceiling** — no total exists to enforce, which
  is #588.

- **A boot this agent stops running is answered** (#526). Every checkpoint that abandons one —
  superseded by a newer boot, abandoned by a shutdown, invalidated by losing the relay — sends
  `device:boot-error` for *that request's* correlator, where it used to `return` with nothing said in
  either direction and let the caller discover it by waiting out its own deadline. Three details are
  decisions rather than mechanics:
  - **The reason is keyed by the seq that lost it**, not held in one slot on the state. Boot A, boot B,
    then a shutdown leaves a single slot saying `shut-down` — which is what *B* lost to. A lost to B.
  - **Only when the request carries a correlator.** A reply nobody waits for is not an answer, and the
    dashboard reports every uncorrelated `device:boot-error` (see #426 there), so inventing one would put
    a failure on a tester's screen for a device that is booting normally. Same rule as `ackInput`'s (#489).
  - **No open control channel is the one abandonment that stays silent**, because the answer's own
    channel is what is missing. The caller learns from the relay instead, which declares the agent away
    and terminates the session inside its grace window. `sendMsg` now checks `readyState` rather than
    `this.ws != null`: `ws.send` on a closing socket buffers the payload and neither throws nor emits, so
    an answer sent there is indistinguishable from a delivered one at the call site.

### Input acks carry a reason

`ackInput` answers `'delivered'` or an `InputErrorReason` from `@tapflowio/protocol` (the contract and
the consumer rules are documented there). The mapping is small but two parts are easy to get wrong:

- **`channel-starting` is not `channel-unavailable`.** `TouchHelper.inputState()` separates them, and
  the difference is the measured 186–247ms in which the helper is up and injecting nothing. Telling a
  caller the channel is gone there sends it to reconnect when it only had to wait.
- **A refusal from a *ready* helper is `no-gesture`, not a channel error.** That is the
  gesture-ownership guard, and the reason carries its own advice: open a new gesture.
- **Ownership is asked before readiness, and the order is the whole point.** The two are decided at
  different times — readiness is about now, ownership was settled when the gesture opened. A gesture
  whose opening frame was refused inside the start-up window owns nothing, so by the time its terminal
  frame arrives the helper reads `ready` and a readiness-first derivation answered `malformed`
  ("never retry") for exactly the sequence `channel-starting` exists to serve. MCP's `swipe` defaults
  to 300ms, comfortably past the measured 247ms, so it lands there.
  A consequence worth knowing: `channel-starting` is **unreachable for a continuation frame**. Owning
  a gesture requires an opening frame to have landed, which requires readiness — so only standalone
  inputs (a key, a button) are ever refused merely because the channel is coming up.

`TouchHelper`'s write methods still return `boolean` **on purpose**. Every member of a string union is
truthy, so converting them would silently invert `this.gestureProc = sent ? this.proc : null` — the
guard that two reviews already fought over — and neither `tsc` nor eslint would say a word
(`no-unnecessary-condition` is not enabled, and tests are excluded from both). The reason is derived
at the ack site instead, which is safe because writes here are synchronous.

- **A terminal input for a session this agent has no state for answers too** (#489). It used to
  `break` silently in all four terminal handlers, so nothing answered at all and the caller waited out
  its own timeout — which MCP's fallback then reports as success. It maps to `channel-unavailable`,
  the same reason Android's `wireReason()` gives it. Reachability is disputed and deliberately not
  claimed: `relay/src/__tests__/sessionRebind.test.ts` records that a restarted agent is re-seeded
  from `agent:registered`, which argues it never fires — but that message carries one entry per
  *device* (`RelayServer.ts`, `byDeviceId`) and the relay's own comment there notes one device can now
  sit behind two sessions, which would leave the second unseeded. The answer costs four lines and the
  silence costs a swallowed input reported as success, so the asymmetry in cost decided it.
  **Opening** frames stay silent: they carry no ack obligation, and answering them would invent a
  reply the caller is not waiting for.

An unmapped **button** still answers success: the device genuinely has no such button (#484). An
unmapped **key code** answers `unsupported` and keeps its existing prose, which names the code. That
asymmetry is a decision, and it is why iOS never sends `unsupported` for a button while Android does.

## HOW NOT

- Do not expose iOS-specific methods as public API if they are not in the `DeviceAgent` interface.
- Do not reintroduce SCStream/ScreenCaptureKit — geometry coordinate mismatches cause double-frame issues.
- Do not stream JPEG frames over WebRTC DataChannel — the channel silently closes on large messages (~236KB+; details in "WebSocket Binary streaming — transport choice" below).

---

## Compound

### touch-helper interface

```bash
touch-helper <udid|booted>
```

Injects HID events directly into the iOS Simulator via `SimDeviceLegacyHIDClient` + IndigoHID.

stdin protocol (variable-length frames). Note the payload is **not** one layout: two of the four
rows carry integers and two carry floats, so reading the whole table as "two floats" is how a frame
ends up carrying garbage:

| types | size | payload |
|-------|------|---------|
| 1–3 | 9 bytes | `[type:u8][x:f32BE][y:f32BE]` |
| 4, 5, 10, 11 | 9 bytes | `[type:u8][a:u32BE][b:u32BE]` |
| 9 | 9 bytes | `[type:u8][modifiers:u8][pad:u8 ×3][usage:u32BE]` |
| 6–8 | 17 bytes | `[type:u8][x1:f32BE][y1:f32BE][x2:f32BE][y2:f32BE]` |

The **gesture role** column decides how a frame is treated when the helper process has been
replaced — see "Helper death and recovery" below. A frame that *continues* a gesture is delivered
only to the process that received the frame that opened it, and never revives a dead helper.

| type | action | gesture role |
|------|--------|--------------|
| 1 | touch start (x, y normalized 0–1) | opens |
| 2 | touch move (x, y) | continues — a move with no preceding down is not the gesture the tester made, and on the digitizer path the injected message is identical to a touch start's (`mask`/`contact` derive only from `isUp`), so a lone move lands as a fresh tap |
| 3 | touch end | continues — **injects `lastX/lastY`, ignoring the coordinates in the frame** |
| 4 | HID button (a=usagePage, b=usage) | self-contained — down→50ms→up completes inside the helper |
| 5 | legacy button (a=code) | self-contained — same |
| 6 | pinch start (x1,y1 = finger0, x2,y2 = finger1) | opens |
| 7 | pinch move | continues — as with type 2, a move with no preceding down is not the gesture the tester made, and that is the whole reason. Unlike type 2 the injected message *does* differ from a down (`injectTwoFinger` passes `direction` separately as well as deriving `eventType`), so the "reads as a fresh tap" argument does not apply here |
| 8 | pinch end | continues — **injects `pinchLast*`; `TouchHelper.pinchEnd()` sends all-zero coordinates precisely because the helper does not read them** |
| 9 | key press | self-contained — modifier down/up completes inside the frame |
| 10 | button down (a=usagePage, b=usage) | self-contained |
| 11 | button up (a=usagePage, b=usage) | self-contained — the helper keeps no record of which buttons are down, so a paired down is not a precondition |

When changing the Swift source, **always update both locations simultaneously**:
1. `src/touch-helper.swift` — stdin protocol changes
2. `src/TouchHelper.ts` — byte layout in the frame builders (`coordFrame` / `buttonFrame` / `twoFingerFrame`) and in `sendKey`, which builds its own

---

### Helper death and recovery

`touch-helper` can die on its own, and when it did the session accepted no further input for the
rest of its life while the stream kept flowing — the viewer tapped a screen that updated normally
and nothing happened (#482). `TouchHelper` now replaces the process **when it dies** rather than on
the next input — immediately, when the spawn budget below allows it — so the first tap after a death
does not pay the helper's start-up cost (`xcode-select -p`, two `dlopen`s, a `SimServiceContext`
device lookup).

Five things about it are easy to undo by accident:

- **Running is not usable, and the helper says which it is.** It announces itself on stderr once it
  holds its HID client and is about to read stdin (the `info: touch-helper ready` line it writes to
  stderr in `touch-helper.swift`). Measured on a real
  simulator: **186–247ms** after spawn (n=5), and a gesture written before that announcement lands
  **nothing** — the frames sit in the pipe and are drained in one go when it finally starts reading,
  collapsing a swipe into microseconds. So `isReady()` requires the announcement and `isRunning()`
  does not, and they answer different questions: writes are gated on the first, replacement
  decisions on the second. Gating replacement on readiness would spawn a second helper while the
  first was still starting.
  This window is not only reached after a death. `sendChromeData` starts the helper and
  `device:ready` follows a local socket connect later — tens of ms — so **an MCP caller that taps
  as soon as `boot_device` returns lands inside it**, which is how it was found.
  A helper that never announces itself is replaced after `READY_DEADLINE_MS`. Without that,
  running-but-never-ready has no exit at all: nothing asks for a replacement because it is running,
  and every input is refused because it is not ready, so a wedge in the CoreSimulator device lookup
  would strand the session until the device was rebooted. The replacement goes through the same
  death path, so the rolling window bounds it.
- **A pid is what says the exec succeeded.** When the binary is missing, non-executable, or the
  wrong architecture (#464), libuv still returns an open stdin pipe and reports the failure a tick
  later. Measured: `stdin.writable` is `true` on a process that does not exist, and
  `stdin.write()` returning `false` is indistinguishable from ordinary backpressure. `spawnHelper`
  checks `proc.pid` and is the only gate — a process without one never becomes the active helper,
  and recovery from an exec failure is therefore lazy — the next self-contained frame retries.
  Not because node stays silent (it does emit `'error'`, which is why that branch attaches its own
  logger) but because the branch returns before wiring `handleDeath`, so nothing eagerly replaces
  a process that never lived.
- **A gesture belongs to the process that *received* its opening frame.** Because replacement is
  eager, a mid-gesture death normally leaves a healthy process standing by — so checking liveness
  is not enough. `TouchHelper` records the process that took the opening frame and refuses the rest
  of the gesture if it is no longer the current one. Writing a touch end to a fresh process would
  release the touch at (0,0), because that process's latches are zero, **and report it as
  delivered**.
  The ownership is recorded **only when the opening frame was actually delivered**, and that
  condition is load-bearing rather than defensive. Recording it unconditionally looks equivalent —
  "if the open failed there is nothing live to record" — and stops being equivalent the moment
  readiness exists: during the start-up window the open is refused while the process is alive and
  about to become ready, so identity would then pass and the continuation would reach a process
  that never saw the down. This was removed once as untestable and put back after a review found
  the case.
- **Replacing is bounded by a rolling window** — at most 3 spawns in any 30s. Deliberately not a
  count of consecutive fast failures: the helper's start-up is expensive, so "died too fast" cannot
  be separated from "died slowly" without guessing how long start-up takes, and a helper that
  reliably dies just past that guess would reset such a counter every time and churn a process
  every few seconds for the life of the agent, with no input and no user involved. The window
  bounds it whatever the lifetime, and it self-clears, so a session that briefly could not start a
  helper is not left without input until the device is rebooted.
- **A helper must never outlive the reference to it.** `sendChromeData` stops the outgoing helper,
  and `cleanupDeviceState` bumps `bootSeq` so a boot still awaiting simctl cannot install one onto
  a state that reconnect has already dropped. Both used to leak a single child process; a
  self-reviving one would respawn for the life of the agent with nothing left to stop it.

Every write reports whether it reached a helper that is ready to inject — not whether the device
acted on it, which HID is fire-and-forget about — and `IOSAgent.ackInput` answers on that rather
than on `state.touchHelper !== null`. The wrapper object outlives its process, which is what made
the original failure silent.

Verified on a real simulator (iPhone 17 Pro, iOS 26.5), with an idle screenshot pair byte-identical
as the control: killing the helper while idle and swiping again opens Spotlight, so input recovers
without a reconnect; a gesture attempted inside the start-up window reports failure on every frame
and indeed changes nothing; and killing it mid-gesture leaves `isReady()` true — the replacement is
genuinely up — while the terminal frame is still refused, after which a fresh gesture works, so no
touch is left held.

Compile (output to `bin/`):
```bash
cd packages/ios-agent && swiftc src/touch-helper.swift -o bin/touch-helper
```

---

### screencapture-helper interface

```bash
screencapture-helper <fps> <udid|booted> [jpeg|h264]
```

Reads the `com.apple.framebuffer.display` port directly via SimulatorKit IOSurface callbacks. The 3rd arg picks the codec (default `jpeg`); `h264` uses VideoToolbox (`VTCompressionSession`, baseline, B-frames off, periodic IDR, BT.709).

Output framing (length-prefixed):
- **jpeg**: `[4-byte BE len][JPEG bytes] ...`
- **h264**: `[4-byte BE len][flags:u8][Annex B NAL] ...` — `len` counts the flags byte; flags bit0 = keyframe (IDR). Keyframes carry SPS+PPS prepended.

**stdin commands** (h264 only): a single `0x01` byte forces an IDR on the next frame. The relay sends this (via `stream:request-idr` → `ScreenCaptureStreamer.requestKeyframe()`) for drop-to-keyframe recovery, so the stream resyncs fast instead of waiting for the periodic IDR. JPEG ignores stdin.

**Env**:
- `TAPFLOW_JPEG_QUALITY` (0–1, default `0.8`) — JPEG quality; the LAN bandwidth ↔ design-QA fidelity trade-off. Lower = fewer relay→browser drops on LAN, but more artifacts.
- `TAPFLOW_IOS_CODEC` (default `h264`) — H.264 is the default on the IOSurface path; set `TAPFLOW_IOS_CODEC=jpeg` to opt out (force JPEG). H.264 also requires the browser to report it can decode it (`device:boot` `acceptH264`, from `canDecodeH264()`); old/unsupported browsers (~5%, no WebGL2) fall back to JPEG automatically (this fallback is iOS-only — see [`contributing/legacy-browser-fallback-ios-only.md`](../../contributing/legacy-browser-fallback-ios-only.md)). The MjpegStreamer fallback is always JPEG — it asks `simctl io … --type jpeg` explicitly, having
produced PNG under a `CODEC_JPEG` stamp until that argument was added. No in-repo entrypoint passes
`intervalMs`, which is what selects it, but it is a public export and a consumer can. Set on the agent process. The codec is signalled per frame in the TFFE envelope (byte5 bit0).
- `TAPFLOW_IOS_H264_BITRATE` (bits/s, default `8_000_000`) — H.264 `AverageBitRate` (soft target). Reduces scroll bandwidth to fit a WiFi LAN and avoid sustained relay backpressure; matches the Android 8 Mbps cap (scrcpy and the emulator gRPC encoder). Lower = fewer LAN drops, more motion blockiness. **Do not add `DataRateLimits` (hard cap)** — it corrupts frames (tearing) under high motion.

When the Swift binary interface changes, **always update both locations simultaneously**:
1. `src/screencapture-helper.swift` — argument parsing changes
2. `src/ScreenCaptureStreamer.ts` — `args` array + frame parsing

Requires a TypeScript dist rebuild after compilation:
```bash
cd packages/ios-agent
swiftc src/screencapture-helper.swift -o bin/screencapture-helper \
  -framework CoreVideo -framework ImageIO -framework VideoToolbox -framework CoreMedia
pnpm build
```

---

### XCUITest tree runner (UI tree backend)

The iOS UI tree comes from a resident **XCUITest runner** that runs *inside* the simulator and serves the accessibility tree over HTTP. It is window-agnostic — no Simulator.app window is required — which matches tapflow's headless simulator operation (`simctl boot` does not auto-open a window in current Xcode, and streaming reads the IOSurface directly). This replaced the macOS AXUIElement helper, which needed a Simulator.app window and so failed on the headless path (the AX bridge only exists while the window is on screen). Still no WebDriverAgent — this is a self-hosted XCTest target.

- Source: `xctest-runner/` — xcodegen `project.yml` → **committed `.xcodeproj`** (no xcodegen at runtime).
  - `TreeHost` — minimal host app the UI-test target attaches to.
  - `TreeRunner` — the UI-test target: `TreeServer.swift` opens an `NWListener` HTTP server; `TreeServerTest.swift` starts it and blocks so the process stays resident.
- Protocol: `GET /health` → `ok` (readiness); `GET /tree?bundleId=<id>` → the app's `XCUIApplication.debugDescription` (text). Port via `TAPFLOW_TREE_PORT` env (default `22087`). The simulator shares `localhost` with the host (WDA pattern), so the host reaches the in-simulator server directly.
- `XCUITreeReader.ts` builds the runner once (`build-for-testing`, cached under `xctest-runner/build/`, gitignored), launches it (`test-without-building`, resident), polls `/health`, then fetches `/tree`. `xcuiTree.ts` parses the debugDescription text into the unified schema — kept a **pure function** so it stays unit-testable against the `xcuiTree.test.ts` fixture (Open Q9: a future Xcode format change fails there).
- Queries by bundleId: the reader needs the foreground app's bundleId, tracked as `DeviceState.currentBundleId` on `app:launch`. `readUITree` throws an actionable `PlatformError` if no app has been launched — never a silent empty tree.
- Frames: debugDescription frames are points; the parser normalizes them 0-1 against the `Window` frame (same coordinate space as the touch path).
- Lifecycle: **lazy** — the runner starts on the first UI-tree query (so the manual QA / streaming path never pays the build/launch cost) and is killed on device shutdown / disconnect.
- `enabled`: debugDescription does not expose it, so elements default to `enabled: true`. If fidelity needs it, switch to the private snapshot API (plan Open Q9).

When changing the tree output shape, **update both locations simultaneously**:
1. `xctest-runner/TreeRunner/TreeServer.swift` — server / debugDescription source
2. `src/xcuiTree.ts` — the parser + refresh the `xcuiTree.test.ts` fixture

After editing runner sources, regenerate the committed project (the runner binary itself is built on first use by `XCUITreeReader`):
```bash
cd packages/ios-agent/xctest-runner && xcodegen generate
```

---

### keyboard-helper interface

```bash
keyboard-helper <show|hide> <udid|booted>
```

Loads `CoreSimulator.framework` directly and calls `SimDevice.setHardwareKeyboardEnabled(_:keyboardType:error:)`.
No macOS Accessibility permission required.

- `show`: `setHardwareKeyboardEnabled(false)` — disconnects the hardware keyboard → software keyboard appears on text field focus
- `hide`: `setHardwareKeyboardEnabled(true)` — connects the hardware keyboard → software keyboard hides immediately

Compile (output to `bin/`):
```bash
swiftc packages/ios-agent/src/keyboard-helper.swift \
  -o packages/ios-agent/bin/keyboard-helper \
  -sdk "$(xcrun --show-sdk-path --sdk macosx)"
```

---

### rotation-helper interface

```bash
rotation-helper <portrait|landscapeLeft|landscapeRight|portraitUpsideDown> <udid|booted>
```

Acquires the `PurpleWorkspacePort` mach port via `SimDevice.lookup:error:` and sends a `GSEventTypeDeviceOrientationChanged` event directly.
**No Simulator.app required. No Accessibility permission required.**

UIDeviceOrientation rawValues: `portrait=1`, `portraitUpsideDown=2`, `landscapeRight=3`, `landscapeLeft=4`

Unlike the legacy `osascript` approach (bringing Simulator.app to the foreground and pressing Cmd+Arrow), this sets the absolute orientation directly, so it works regardless of the current state.

Compile (output to `bin/`):
```bash
swiftc packages/ios-agent/src/rotation-helper.swift \
  -o packages/ios-agent/bin/rotation-helper \
  -sdk "$(xcrun --show-sdk-path --sdk macosx)"
```

---

### IOSurface capture — timer-driven strategy

IOSurface callbacks alone do not deliver frames when the screen is static.
Use `DispatchSourceTimer` alongside callbacks to maintain a consistent FPS regardless of callback activity.

```swift
// callback: only updates latestSurface
let onFrame: @convention(block) () -> Void = {
    captureQueue.async { updateLatestSurface() }
}

// timer: encodes the latest surface every tick
let timer = DispatchSource.makeTimerSource(queue: captureQueue)
timer.schedule(deadline: .now(), repeating: 1.0 / fps)
timer.setEventHandler {
    guard let surf = latestSurface, let jpeg = encodeJPEG(surf) else { return }
    writeFrame(jpeg)
}
```

---

### Tear-free framebuffer snapshot (`copySurfaceStable`)

**When**: reading the framebuffer IOSurface to encode (both the H.264 and JPEG paths go through it).

**How**: don't encode the live surface. `copySurfaceStable` memcpys it into a private, reused
buffer and brackets the copy with `IOSurfaceGetSeed`; if the seed moved, the simulator drew
during the copy (possibly sheared) → retry (budget 4). `encodeH264`/`encodeJPEG` then read that
snapshot.

**Why** (not obvious from the code):
- The simulator draws into a **single IOSurface in place** (the static-skip seed relies on that),
  asynchronously to our 30fps timer. Reading it mid-draw bakes a **horizontal tear** — top = old
  frame, bottom = new — into the encoded frame. It shows on **every tier and decoder** (native:
  VTEncode reads the surface directly; downscale: vImage reads it) and recovers on the next frame,
  so it reads as "intermittent scroll tearing." Measured during heavy scroll: **~40% of frames
  raced** a write; all resolved within the retry budget.
- `IOSurfaceLock(.readOnly)` (and `CVPixelBufferLockBaseAddress`, which calls it) is **cooperative**
  — it does not block the sim's GPU writes, so locking alone does **not** prevent the tear. The
  seed check is what makes the snapshot coherent. **Do not "simplify" the copy back to reading the
  live surface.**
- This is distinct from the relay/agent **keyframe-aware backpressure** fix (orphan P-frames under
  drop): that is a transport-drop artifact; this is a source-pixel tear. Both can look like scroll
  tearing; they need separate fixes.
- Reuse safety: downscale reads the snapshot synchronously (vImage) before the next tick; native
  hands it to VTEncode but full-res encode is far slower than the frame interval, so the in-flight
  encode never overlaps the next copy. `TAPFLOW_STREAM_METRICS=1` logs the retry/exhausted counts
  (and the per-frame `capture-wait` poll gap) — formats and the full instrumentation surface are in
  [`contributing/measurement.md`](../../contributing/measurement.md).

---

### Keyboard HID path

Keyboard injection uses `IndigoHIDMessageForKeyboardArbitrary(usage, op)`.  
`IndigoHIDMessageForHIDArbitrary(target=0x32, page=0x07, ...)` is the digitizer (touch) path — iOS does not recognize it as a hardware keyboard, so the CapsLock HUD and Korean/English toggle do not work.

→ Detailed analysis (target differences, symptom patterns, SimKeyboardInputController symbols): [`contributing/simkit-internals.md` §5](../../contributing/simkit-internals.md)

---

### DeviceChromeLoader

**Device identification**: `load(typeIdentifier)` takes a `typeIdentifier`, not an instance name.
- ❌ `"iPhone 16 (tapflow)"` — user-assigned name, does not match simdevicetype files
- ✅ `"com.apple.CoreSimulator.SimDeviceType.iPhone-16"` — the canonical identifier returned by xcrun simctl

`SimctlWrapper` parses `deviceTypeIdentifier` into `Device.typeId` and passes it through.

**Button layout**: `PhoneComposite.pdf` contains no physical buttons. Buttons are separate PDF assets; placement data is in `chrome.json`'s `inputs[]`.

Margin calculation (same logic as baguette `computeMargins`):
```text
left-anchor button:  margin.left  = max(imgWidth - rollover.x, 0)
right-anchor button: margin.right = max(imgWidth + rollover.x, 0)
```

Button center (expanded canvas): `left-anchor: margin.left + rollover.x`  
Render order: `behindBtns → composite → onTopBtns`  
Cache key: `tapflow-frame-v2-{chromeName}.png`

**Screen corner radius**: outer radius is read from `paths.simpleOutsideBorder.cornerRadiusX` in `chrome.json`.
```text
innerRadius = max(outerRadius - bezelInset, 0)
bezelInset  = max(leftWidth, topHeight)   // chrome.json images.sizing
```
`ChromeData.screenCornerRadius` is in 2× px units. CSS conversion in `IOSViewer.tsx`: `÷2 × displayScale`.

---

### WebSocket Binary streaming — transport choice

`ws.send(Buffer)` → Relay → `ws.send(data, { binary: true })` → Browser `e.data instanceof ArrayBuffer`. The codec is negotiated per frame via the TFFE envelope (H.264 default, JPEG fallback).

Why WebSocket instead of a WebRTC DataChannel:
1. **DataChannel instability**: `@roamhq/wrtc` silently closes the channel on messages ~236KB+.
2. **No P2P benefit**: tapflow has a fixed Agent → Relay → Browser path.
3. **HW decode doesn't need a Video Track here**: the browser decodes WebSocket frames directly — H.264 via WebCodecs (see dashboard), JPEG via `createImageBitmap`.

---

### Zombie simulator auto-recovery

A simulator's data dir can vanish from disk (an Xcode/macOS update prunes its runtime)
while `simctl list` still reports it `isAvailable: true` — the loss only surfaces when
`boot` runs, failing with "cannot be located on disk" / "data is no longer present".

`handleDeviceBoot` recovers in place via `bootWithZombieRecovery`: when
`isDeviceMissingError(e)` matches that signature it `erase`s the device (regenerating the
data dir) and retries `boot` once. Bounded — a second failure surfaces as
`device:boot-error`, never a loop.

**Why the guard matters**: `erase` wipes a device, so it runs *only* on the missing-data
signature — an unrelated boot failure (timeout, etc.) never erases a healthy device,
locked down by a negative test. Keep the match text-only and conservative; widen the
signature only with evidence.

---

### IOSAgent tests — streaming prerequisites

`startBinaryStream()` is called only inside `handleDeviceBoot()`. Any test involving streaming or TouchHelper must go through the `device:boot` flow first.

```typescript
browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
await waitForType(browser, 'session:joined')
// `requestId` is **required** on device:boot and the relay drops a boot without one at the door —
// silently, since an uncorrelatable request gets no reply. Omit it and this wait simply times out.
browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, requestId: 'rq-1', payload: { deviceId: 'dev-1' } }))
await waitForType(browser, 'device:ready')
// device:ready alone does not mean the mock exists yet — see below. Sync on the mock itself.
await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0))
const touchHelper = MockTouchHelper.mock.results[0].value
```

`mockSimctl(true)` (booted=true) reaches `device:ready` fastest, but it takes the same path as any other
boot — `device:booting` goes out before the handler's `try` on every call, and since #486 `simctl boot` is
issued for a device the list called `booted` too. Nothing short-circuits on the device already being up.

**`device:ready` is not a sync point.** It is sent as soon as the stream is handed off, before the helpers a test is usually about to read are observable — so `waitForType(browser, 'device:ready')` returning does not mean `MockCapture` or `MockTouchHelper` has been constructed. Always `vi.waitFor` on the mock you are about to read, never on the message alone.

There used to be a second reason: the relay replayed `device:ready` on `session:start` for any session whose device was up at registration, so the wait could latch an ack that belonged to no boot at all — that is what made the codec-negotiation test flake at ~2/10 suite runs. The replay now keys off whether the session announced a stream (relay `Session.readySent`), so a freshly registered `mockSimctl(true)` session no longer produces one. The `vi.waitFor` rule stands on the first reason alone.

---

### Network on/off — three layers, and none of them ships alone (#607)

A simulator has no radio to switch off. It is host processes sharing the Mac's network stack, so
"offline" is assembled by `SimulatorNetwork`, and the reason that class exists is that **each
mechanism alone produces a result a tester would sign off on and be wrong about**:

| | what it does | what it alone gets wrong |
|---|---|---|
| **1. host content filter** (`ios-netfilter`) | drops that simulator's flows at the kernel, **except name resolution** | the app still believes it is online — measured: traffic dead, `NWPathMonitor` reporting `satisfied` for the life of the process — and a pooled connection keeps working |
| **2. injected dylib** (`bin/libtapflow-nethook.dylib`) | fakes the path status and **cuts the sockets the app already holds** | blocks nothing: faking `nw_path_get_status` does not stop `URLSession`, which reads the kernel's real path |
| **3. status bar** | stops showing service | pixels |

**Layer 1 leads in both directions, and the order is measured rather than chosen.** Going offline,
the dylib cuts open sockets the moment the condition file appears; if the filter were not already
dropping new flows at that instant the app simply reconnects — reproduced exactly that way, and the
reconnected socket then survived the rest of the session. Coming back, the filter has to stop
dropping *before* the app is told the path is satisfied, or the first thing it does with the good
news is fail.

#### It is a content filter, not a transparent proxy

`NETransparentProxyProvider` was built first and sees **zero** simulator traffic: 217 flows reached
its handler and every one was a host process. `NEFilterDataProvider` sees them. Do not re-propose
the proxy.

**A flow carries a bundle id and never a device**, so `Provider.swift` walks the flow's process up to
its `launchd_sim` and reads the UDID out of that process's **arguments** — not its executable path,
which is shared by every simulator on the runtime. The cache is keyed on `(pid, start time)`, not a
bare pid: `launchd_sim`'s pid is reused readily, and a bare key attributes flows to simulators that
no longer exist, which cuts a device nobody asked to cut with every log line agreeing it was right.
`asid` looks like a cheaper key and is not one — two simulators share an asid.

#### Layer 1 lets name resolution through, and that is the difference between 2 seconds and 35

**A dropped UDP flow tells its sender nothing.** No error, no reset — so a resolver whose query is
dropped waits out its own timeout, and the tester watches a spinner. Measured on an offline
simulator: a name already in the resolver's cache failed its connection in **6ms**, while a name that
had to be resolved took **25 seconds** in `curl` and left Safari on a white screen past **35**. That
is the symptom this whole section exists for — it reads as the toggle not working.

So `handleNewFlow` allows **outbound UDP** to port 53 whatever the rule says, which turns every case
into the fast one: the name resolves, and the connection that follows is dropped at 6ms. **After the
change, a request costs whatever its lookup costs** — `curl` between 0.3 and 0.6 seconds across runs,
Safari's error page at 2. The range is the measurement: a single number here would not reproduce,
because what varies is the lookup.

**It costs less fidelity than it looks like — but more than the first draft of this paragraph said.**
Layer 2 hooks POSIX `getaddrinfo`, so an app resolving that way still fails the way a real device
would. **`URLSession` does not resolve that way.** It goes through Network.framework, which layer 2
does not reach — measured in this session: the probe's `URLSession` timed out at `-1001` with layer 2
armed, which is what proved the POSIX hook is not on its path. So a `URLSession` app now resolves the
name and fails at connect, where a device with no signal would have failed the lookup.

That matters for one shape of app: one that treats "the name resolved" as "I am online". It will draw
an online banner over a device that can reach nothing. `network-hook.m` says of that hook that "the
specific failure is unobservable, so nothing is claimed about it" — this paragraph is what keeps the
rest of the tree from claiming it anyway.

What is unambiguously true is the other half: the traffic of processes layer 2 cannot reach at all —
WebKit, other apps in the simulator — used to hang for 25 to 35 seconds and now fails in about two.

**TCP/53 and inbound flows are not allowed**, and each exclusion is the reason rather than caution.
A dropped TCP flow already fails in 6ms, so opening TCP/53 would buy none of the fix while letting a
device reported offline hold a bidirectional connection to anything listening there — the shape a DNS
tunnel takes. And on an inbound flow the remote port is the *sender's*, so a peer sending from source
port 53 would otherwise reach a device the tester was told is offline.

**The port comes from `NEFilterSocketFlow.remoteEndpoint`, and that it can be read at all was the
question the change was gated on.** Measured on iOS 26.4: every flow reported a port, none
`unreadable`. The log records which property answered (`remoteEndpoint` or `remoteFlowEndpoint`), so
a future OS emptying one shows up as the channel changing rather than as a port that silently stops
being readable. The decision itself is a pure function in `Extension/FlowIdentity.swift` with Swift
tests and mutations behind it.

**Counted apart from `dropped`.** The state file carries `dnsAllowed`, because folding it into
`dropped` would blur the one number that says the filter is enforcing. A device whose app has
resolved a name and not yet connected shows `dropped: 0` with `dnsAllowed` rising, which is a normal
state rather than a failure.

**Encrypted DNS is not covered, deliberately.** DoT has a port of its own (853) and could be added;
DoH shares 443 and could not. Neither is there because nothing has measured whether a simulator whose
host is configured for either actually uses it, and widening the hole on a guess is the failure mode
this file keeps recording.

#### The host cannot revoke a connection it allowed

`handleNewFlow`'s `.drop()` reaches new flows only, and `URLSession` keeps one connection for a whole
session. Keeping every flow under a data verdict instead was built and measured unusable —
`peekInboundBytes: 8192` produced **0** data callbacks, `1` produced **815,869** in forty seconds
(one byte each) and still never an outbound callback on the app's reused connection. Apple is
explicit that allowing a flow is one-way. So the cut happens **inside the app**, in the dylib, with
`shutdown` rather than `close`: the owner sees the connection go away, which is what losing signal
looks like, and the descriptor's number is not handed back for something else to be opened onto.

#### Hooking is an inline patch, and it refuses more than it handles

`fishhook` rewrites indirect symbol pointers and so reaches only images **outside** the dyld shared
cache. Measured in a real `.app`: system frameworks call their neighbours with direct branches inside
the cache, so neither the socket layer nor the path layer was reachable — the hooks that appeared to
work were our own dylib's imports, which is also what made the first self-check a false positive.
`inline-hook.c` patches the target function's own body instead.

Four rules there are load-bearing, and each is a hole something already fell into:

- **`connect`/`sendto` are refused by design.** They share a 16K libsystem_kernel page with
  `mach_vm_protect`, so changing that page's protection un-maps the code performing the change — an
  instruction abort, measured three times, killing the app in its dyld initialisers.
- **The way back is published before the patch goes live.** `tf_hook_install` takes `original` as a
  parameter for that reason; a caller storing it afterwards leaves a window where another thread
  enters the replacement and tail-calls address zero.
- **Every hook, or none — enforced, not just stated, and there are now two sets.** There is no
  uninstall, so a refusal on the second target cannot undo the first. The replacements are neutered by
  `g_hooks_live` (the path set) or `g_reach_live` (the reachability set) until their own set is in.
  `nw_path_monitor_set_queue` is in the first for a reason of its own: without it a replayed handler
  has nowhere correct to run. **The two sets are not all-or-none with each other** — the section below
  is why.
- **A replayed handler runs on the queue its owner chose**, recorded from
  `nw_path_monitor_set_queue` (#640). Firing on tapflow's own queue instead could run a third-party
  handler concurrently with the framework's, and put UI work off the main thread — a crash in the app
  under test, blamed on tapflow.
- **Cutting a socket reads the descriptor twice and cannot pin it**, so the cut re-checks afterwards
  and logs a mismatch (#643). `ENOTCONN` there is the cut having worked, not a race — the first
  version of that check did not know the difference and flagged all four connections on its first
  real run.
- **No `SIMULATOR_UDID`, no activation.** Everything this library writes is keyed by it, and the
  host's `/tmp` is the same `/tmp` inside every simulator on the Mac.

#### `NWPathMonitor` is not the only API an app asks, and the other one needed its own set

`SCNetworkReachability` is what Alamofire's `NetworkReachabilityManager` and the older
`Reachability.swift` read, and **the path hooks do not cover it.** SystemConfiguration's modern
implementation does sit on Network.framework, but it gets there through the
`nw_path_create_evaluator_for_*` family rather than `nw_path_get_status`, so the hook that fakes the
path for `NWPathMonitor` leaves this API answering truthfully. (The family is
`nw_path_create_evaluator_for_endpoint` and its siblings — there is no bare
`nw_path_create_evaluator`, and an earlier draft of this paragraph named one.) An app built on either library showed **no offline banner at
all** — traffic dead, and the app never told.

**Faking the getter alone moves a number nobody reads**, which is the same lesson `nw_path_monitor`
taught and is measured here too. A consumer does not poll: it registers a callback, caches what the
callback last told it, and recomputes only inside that callback. Before `SCNetworkReachabilitySetCallback`
was hooked, `netprobe/` recorded the getter flipping to NOT-reachable within a tick while the listener
sat on `reachable` for the whole offline period, `fires=1` throughout.

So the set is five: `GetFlags`, `SetCallback`, and **both** ways a consumer can say where its callback
runs — `SetDispatchQueue` and `ScheduleWithRunLoop`/`UnscheduleFromRunLoop`.
`tf_push_reachability_update` replays each registered callout **where its owner asked for it**, on a
queue with `dispatch_async` or on a run loop with `CFRunLoopPerformBlock` plus a wake-up. Same #640
discipline as the path push, for the same reason.

**The run-loop half was nearly left out on a reason that was false.** A draft covered only the queue
and said the run-loop case could not be re-fired because we cannot know which run loop a callback
belongs to. `SCNetworkReachabilityScheduleWithRunLoop` is handed the run loop *and* the mode and
passes both through — the claim described a symbol nobody had looked up, and it had already reached a
limitation note in the user guide before anyone checked. It is written here because the shape recurs:
an unchecked "we cannot" is how a gap becomes documentation instead of a fix.

**The app's callout is wrapped rather than registered, and the reason is narrower than it looks.**
A review predicted that handing the app's own function to the framework would leave SC's *own*
callbacks unmasked, breaking the case a tester reaches first — device offline, *then* launch the app,
where the watcher records `last = tf_offline()` at start and never pushes. **Measured, that does not
happen**: with only the getter patched, SC's registration callback in exactly that scenario carried
`flags=0x0`. The inference is that SC computes the flags it delivers through the public getter this
file patches. The trampoline is kept for the weaker reason that survives — that behaviour is an
undocumented internal, nothing promises it holds, and the failure if it changes is a consumer told it
is online while its traffic is dead. The rationale beside the code says the same; it is written down
because a prediction that measurement refutes is worth keeping visible.

**The `info` pointer is retained, and so is the target, across a replay.** The framework retains
`info` for as long as the registration lives, so this must too — Alamofire hands over itself. And the
push takes its own references before dispatching: the path version snapshots into an `NSArray` which
retains what it replays, while here the target and `info` are raw pointers, and an unregister landing
between the snapshot and the async call would free both. That is reachable on the *correct* path — a
consumer told it is offline, tearing down the screen it showed, calls `stopListening()` from exactly
there.

**Why this set is separate from the path set, and in which direction.** The path set is
interdependent — faking the status without capturing the handlers tells an app a lie it is never
corrected about — and that argument holds *within* this set as well. It does not hold *between* them:
if these three cannot be patched, an `NWPathMonitor` app still gets a correct banner, where folding
them into one set would let one unpatchable symbol take layer 2 down for the apps it already served.

**The independence runs one way, and reading it as mutual is wrong.** These replacements read
`tf_blocking`, which is gated on the path set — so the reachability set additionally *requires* it,
and `tf_install` does not even attempt these patches when the path set failed. Patching them over a
dead layer 2 would take references on the app's objects and keep a target alive past the point the
framework would have destroyed it, in exchange for a replay that could never happen.

One gap is open and recorded rather than closed: **the agent cannot see this set fail.** The verdict
file is one boolean and, by the decision above, a reachability refusal does not make it false — so a
tester whose app reads this API gets no signal. That is no worse than before the set existed, but
whether the verdict should speak per set is undecided.

#### `netprobe/` is how any of this is checked

`packages/ios-agent/netprobe/` is a simulator app that reports the four mechanisms **separately** —
`NWPathMonitor`, `SCNetworkReachability` (getter and listener as two different lines), `URLSession`,
and `getaddrinfo`. Every number in this section came from it.

```bash
packages/ios-agent/netprobe/build.sh <booted-udid>
xcrun simctl launch --console <udid> dev.tapflow.netprobe
```

**Flip the device with the condition file, not the filter rule**, when the agent is running:
`touch /tmp/tapflow-offline-<udid>` exercises layer 2 alone and leaves layer 1's rule — and therefore
a running agent's view of the world — untouched. The arming steps are in the header of
`netprobe/build.sh`.

It is committed because the last one was not. `TFNetProbe` was built during #607, every measurement in
that program came from it, and it survived only as an unsigned binary on one Mac — so none of those
numbers could be reproduced by anyone else.

#### What the agent trusts, and what it must not

`state()` decides `available` from **three things, in order, and layer 1 is asked first**. Between
layer 1 and the verdict sits the plainest question of the three: **is the library on disk at all.**
It is `stat`ed rather than remembered, because `DYLD_INSERT_LIBRARIES` naming a path that does not
exist is ignored by dyld without a word — so a damaged install arms cleanly, launches the app
unhooked, and leaves `state()` asking for an app that is already running. The dylib's verdict
file answers for layer 2 — only the target app writes it, and the file is keyed by udid alone, so any
other process writing it would answer for an app that never ran (since #635 no other process
activates at all: the library is delivered simulator-wide, but the gate admits one bundle id).

What layer 1 is doing cannot be read there at all, and `state()` is synchronous — every re-join,
every `device:ready`, every capability `networkState()` — so it **remembers** the last judgment instead. Without
that memory one re-join repaints a Mac that cannot take devices offline as a healthy one, and the
tester's toast is the only trace left that anything went wrong.

`awaiting-app` is not an edge case: it is the state every iOS session is in between the device
booting and its app launching, because the library is armed at boot and can only name its target at
launch.

**A hybrid app's web half is not told it is offline**, and that is a limitation rather than an
unfound bug. WebKit's processes were measured never to load the library — dyld drops `DYLD_*` for
them — so a WebView renders no `navigator.onLine` banner. Its traffic still fails, because layer 1
works at the kernel for every process.

The container app's **exit 0 means the save was accepted and nothing more.** The framework hands
`vendorConfiguration` to the running provider afterwards with no acknowledgement, and the whole run
returns in 27ms. Each failure has its own code (1 activation, 2 load, 3 save, 4 approval timed out,
5 needs a reboot, 7 could not confirm) — `ios-netfilter/README.md` has the table.

**So the rule is written and then confirmed** (#639). `--confirm` asks the running provider over XPC
what it is holding — 0.26–0.74ms, measured — and `setOffline` refuses unless the answer says
`enforcing` and names this device. Refusing matters more than it sounds: layers 2 and 3 work without
layer 1 and neither blocks traffic, so applying them alone tells the app it is offline while every
request it makes succeeds, which is the sign-off this feature exists to prevent.

**The confirmation's timeout is the mechanism, not a backstop.** A call made while the provider is
dead does not fail — measured 3/3, it blocks to the caller's own deadline, because launchd holds the
mach name while the process is away. One second: about thirty times a healthy round trip and an
eighth of the dashboard's request deadline.

**And after a replace that channel is simply gone, so there is a second one.** The retired extension
sits `[terminated waiting to uninstall on reboot]` still owning the mach name, so the new provider's
`NSXPCListener.resume()` fails with `Operation not permitted` — silently, because `resume()` returns
void — and `--confirm` answers `no listener` in 9ms while the filter is enforcing normally and
publishing a fresh state file. Measured 2026-09-03, on the ordinary upgrade path: every release does
this. The listener is vended once per process and the provider survives `--off`/`--install` on the
same pid, so nothing retries it.

Reading that as "not confirmed" is what put `filter-unavailable` in front of a tester whose filter was
working. `confirmEnforcement` now asks first and **falls back to the provider's state file** when the
ask fails — the channel `net-filter.ts` already preferred, for its own reason. The fallback answers
when the published rule matches what was asked for, or when the file was published after the write and
disagrees; a file that predates the write is not an answer, because that is the ordinary state for
about a pulse after every toggle. A stale file is never an answer, which is what keeps a dead
provider's last publication from reading as success.

**And enforcement can stop after the fact**, which no confirmation can cover. Measured: killing the
provider leaves the kernel passing that simulator's traffic for about 5.8 seconds before launchd has
it back, 23–27 requests getting through each time. `SimulatorNetwork` watches the provider's state
file while anything is offline and reports `enforcement-lost` — the one reason that invalidates work
already done, so the dashboard interrupts rather than re-colours.

#### Two things that will bite

- **`booted` on `DeviceState` is a cache, not the truth.** `initDeviceStates` clears it on
  `agent:registered`, which is every *reconnect*. Reading it as liveness shipped a regression twice
  in one PR. The wire path uses `deviceFor` and the capability path `soleLiveDeviceId`; both ask
  simctl before believing a device is down. The other six capability entry points still do not (#646).
- **Tests must never reach the real filter.** `arm()` runs on every boot, so a suite that boots a
  mock device was rewriting the host's live filter configuration once per boot test on any machine
  with tapflow's extension installed — silently, because the class *reports* a missing container app
  rather than failing. `IOSAgent` points its `SimulatorNetwork` at a nonexistent host binary under
  vitest, and `options.network` injects one.

#### The filter's Swift has tests, and CI runs them

```bash
pnpm --filter @tapflowio/ios-agent test:netfilter            # run them
packages/ios-agent/ios-netfilter/run-tests.sh --mutate       # run them, then prove they hold
```

**Not part of `pnpm test`, on purpose.** That is vitest on `ubuntu-latest`, and wiring Swift into it
would break the suite everywhere else. It has its own job instead: `test-swift` on `macos-15` runs
`--mutate` and is part of the `ci` rollup, so the mutations are a required check rather than a
courtesy a Mac contributor performs. **This paragraph used to say CI could not run these at all**,
which was true until #759 and then stayed on the page — the same sentence survived in `run-tests.sh`'s
header and in `ci.yml` until a review went looking for copies of it.

**What is testable is what does not read the kernel or the filesystem.** Attribution walks the
process tree with `sysctl`, reads `KERN_PROCARGS2`, calls `proc_pidpath`; the heartbeat writes a file
as root; `NEFilterSocketFlow` cannot be constructed. None of that stands up in a unit test. Peel it
away and two files are left — `Extension/FlowIdentity.swift` for the flow half (the udid parse, the
DNS classifier, the audit-token readers, the attribution cache, the drop-count prune, the pulse rate)
and `Host/RuleArguments.swift` for the host binary's half (its flag vocabulary, the mode it selects,
the rule delta, and the branch that erases the rule). Both exist to be seams, which is why their
declarations are `internal` rather than `private` — `tests.yml` compiles them **into** the test
bundle, because neither target can be linked by one.

**`--mutate` is the half that matters.** Many of the tests assert that something is *not* found or
*not* allowed, and a test asserting absence passes when nothing happens — that is its definition, so
a green run is not evidence it holds anything
([contributing/test-and-guard-coverage.md](../../contributing/test-and-guard-coverage.md) rule 2).
The flag breaks the sources forty-one ways and requires each one to fail a test. Its first draft could
not have done that: `run()` piped `xcodebuild` into `grep` and returned *grep's* status, so a mutation
that did not even compile would have been reported as killed.

**Every mutation is a cost paid on every push**, now that CI runs the flag — one `xcodebuild` each.
Count them with `grep -cE '^mutate "'`, not `grep -c '^mutate '`, which counts the function
definition; a comment in `ci.yml` said thirty-six for exactly that reason.

**And it has found something.** A mutation deleting `.filter { !$0.isEmpty }` from `parseUDIDs`
survived — not because the test was decoration but because the filter was: `split(separator:)`
defaults to `omittingEmptySubsequences: true`, so the line could never remove anything. A green suite
would not have said so.

**The spec is `tests.yml`, deliberately separate from `project.yml`.** `project.yml` is one of the
four enumerated inputs to the extension's version stamp, so a test target declared there would make
every test-only edit bump `CFBundleVersion` — and that replaces the system extension on every
self-hoster's Mac, stopping all new connections while it happens. A new file at `ios-netfilter/`'s top
level is not an input unless `EXT_SOURCE_FILES` names it, so this spec is free. The generated
`TapflowNetFilterTests.xcodeproj` is gitignored, unlike the shipping one.

**Do not run bare `xcodegen generate` to check a build.** It rewrites both `Info.plist`s with the
literal `CURRENT_PROJECT_VERSION` from `project.yml` — `1` — discarding the committed
`CFBundleVersion` that `shipped.json` records. `build.sh` patches them back immediately, so the
release path is safe and only a hand-run generate leaves it wrong. Check `git status` afterwards.
`run-tests.sh` generates from `tests.yml` alone and does not touch them.

#### Building the system extension

Needs a paid Apple Developer account. Ad-hoc and self-signed builds do **not** load (measured
`code=4`), and un-notarized Developer ID is Gatekeeper-rejected.

```bash
export DEVELOPMENT_TEAM=<10-character Team ID>
packages/ios-agent/ios-netfilter/build.sh     # xcodegen → build → sign → notarize → staple
```

**The `CFBundleVersion` bump in `build.sh` is not decoration.** `OSSystemExtension` activation skips
the replacement when the version matches — keeping the old bundle and the running provider — and
returns success while nothing changed. xcodegen bakes the version in as a literal, which is why the
script patches both `Info.plist`s after generating.

**A replacement that goes unanswered is a released delegate, and it cost most of a day to find.**
`submitRequest` returns and no delegate method is ever called — not an error, not a refusal, not an
approval prompt. The host binary bounds it at 45s and exits 6, which is the only reason it is visible.

`OSSystemExtensionRequest` holds its `delegate` **weakly**. Replacing an installed extension makes
`sysextd` ask the app which one to keep — visible in the log as `initial activation decision:
requestAppReplaceAction` followed by `notifying client of activation conflict` — and if the delegate
has been collected by then, nothing answers and the framework cancels the connection. **A first
install never shows it**, because there is no existing entry to ask about, so this appears only once
you start iterating.

```bash
# what the failing case looks like
log show --last 5m --debug --predicate 'process == "sysextd"' | grep -i conflict
```

Two guesses are recorded because they were wrong and cost time: accumulated versions
`terminated waiting to uninstall on reboot` looked like the cause, but a restart cleared the list to
one and the next replacement stalled identically; `lsregister -f` changed nothing. Neither could have
helped — nothing was wrong with the system's state.

Every replacement does still leave the displaced version pending until reboot, so batching changes
into one build is worth doing regardless. **And that pending entry is not inert** — it keeps the mach
service name, so the replacement's `NSXPCListener.resume()` fails and `--confirm` answers `no listener`
until the Mac restarts (measured 2026-09-03; see the confirmation section above). That is a different
failure from the stalled activation this section is about, and the guess recorded as wrong up there
stays wrong: nothing about the pending entry stalls a *replacement*. **A self-hoster meets none of this** — they install once
per release. A contributor touching `ios-netfilter` meets it the same afternoon, which is why it is
here rather than only in an issue.

tapflow does not distribute this yet; #647 is that decision and the install documentation behind it.
Until then an agent without the extension reports the control unavailable rather than failing.
