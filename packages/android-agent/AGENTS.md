---
type: rules
topics: [android, emulator, adb]
status: living
---

# android-agent — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`AndroidAgent`: controls Android emulators/devices via ADB and streams H.264 video over two backends — **gRPC host-encode** (emulators, the default) and **scrcpy** (real devices, and the fallback when gRPC is unavailable). Runs alongside `ios-agent` on the same Mac.

It also toggles **airplane mode** per device (#607) — the Android half of the network control. Unlike iOS, the device has a radio, so `cmd connectivity airplane-mode` is the whole mechanism — but `AdbWrapper.setAirplaneMode` writes and then **reads back**, and the read-back is the load-bearing half: it is what produces `confirmed`, and an unconfirmed write is reported as unavailable rather than as success. An image that accepts the command and does nothing looks exactly like one that worked, until you ask.

## HOW

- ADB commands are isolated in `AdbWrapper`, swappable with an `AdbRunner` mock in tests.
- **UI tree** (`queryUITree` / `ui:tree:request`): `AdbWrapper.dumpUiHierarchy` runs `adb exec-out timeout 10 uiautomator dump /dev/tty` — the device-side toybox `timeout` bounds the dump because uiautomator waits for an idle window and can hang on continuous animation; a timed-out dump surfaces as an explicit `PlatformError`, never a silent empty tree. `uiTree.ts` parses the XML into the unified `UIElement[]` schema (agent-core); the screen size comes from the root node bounds, so landscape dumps normalize correctly without a `wm size` round-trip.
- On emulator boot: `EmulatorLauncher.waitForBoot(serial)` — polls `sys.boot_completed=1`, bounded by
  `EmulatorLauncher.BOOT_READY_TIMEOUT_MS` (120s). Named and exported because a relay client that gives up
  first turns this agent's own answer into a bare timeout (#549); the relationship is held across packages
  by `scripts/__tests__/bootDeadlineOutlivesAgent.test.mjs`.
- **A boot this agent stops running is answered** (#526), with the same three rules as iOS — the reason is
  keyed by the seq that lost it, the answer goes only to a request that carries a correlator, and a boot
  abandoned with no open control channel stays silent because the answer has nowhere to go. The shared
  vocabulary and prose live in `agent-core` (`bootAbandonMessage`) precisely so the two platforms cannot
  drift apart on what a tester is told.
  **Losing the relay mid-boot invalidates the boot here too, which it did not before.** Both agents clear
  `deviceStates` on reconnect, but a running `handleDeviceBoot` holds its own reference to one — so this
  agent used to finish, stand up a video stream and announce `device:ready` for a session that no longer
  exists. iOS has invalidated since its helper-leak fix; the bump lives in the reconnect path rather than
  inside `cleanupDeviceState`, because this agent calls that cleanup from inside `handleDeviceBoot` and a
  bump there would make every boot supersede itself.
- **Backend selection** (`pickAndroidBackend`): emulators (serial `emulator-*`) → **gRPC**; real devices → **scrcpy**. `TAPFLOW_ANDROID_BACKEND=grpc|scrcpy` overrides. On any gRPC failure (e.g. an emulator booted externally without `-grpc`), `startVideoStream` falls back to scrcpy so streaming still works.
- **gRPC backend (emulator default)**: `EmulatorGrpcClient` connects to the emulator's gRPC endpoint (`-grpc <port>`, default 8554, unsecured localhost) and reads `streamScreenshot` RGBA8888 frames → `EmulatorVideo` pipes them to the `emulator-encoder` Swift helper (Mac VideoToolbox: baseline, B-frames off, BT.709, force-IDR on demand), **bypassing the emulator's slow guest software H.264 encoder**. Mirrors the ios-agent VideoToolbox path so both platforms share one encode pipeline. The screenshot stream is frame-driven (no frames while static), so no static-skip is needed.
- **scrcpy backend (real devices + fallback)**: `ScrcpySession` → `ScrcpyVideo` pushes the scrcpy server to the device, runs it, and receives an H.264 Annex B stream over TCP. Two connections in order — video socket (1st) + control socket (2nd) — before the server begins streaming. `ScrcpyControl` keeps the control socket open. Pin `OMX.google.h264.encoder` (pure software) on a `google_apis/arm64-v8a` (android-34) image — the verified config; the default `c2.android.avc.encoder` (Codec 2.0) shows silent stalls under GPU load that the pump can't detect, and `google_apis_playstore` is untested (see `contributing/android-video-streaming-diagnosis.md`). This guest-encoder constraint applies to scrcpy only — the gRPC path never touches it.
- **Touch** (`PointerControl`): a backend-agnostic pointer interface satisfied structurally by both `EmulatorGrpcClient` (gRPC) and `ScrcpyControl` (scrcpy) — identical method shapes (sync for scrcpy, async for gRPC), so input handlers stay backend-agnostic. Falls back to `AndroidTouchHelper` (`adb input tap/swipe`) when neither video backend is active — and for **buttons on every backend**, which makes it the adb path that actually runs in production.

### Input acks answer with a reason, and the three paths fail differently

Terminal inputs used to ack on a proxy — a channel reference, a serial that resolved, or `state.touchHelper !== null`, which is a constant because that helper has no process. Every one of them reported success for input that never reached the device. The acks now answer on what the dispatch reported, in the vocabulary of `inputOutcome.ts`.

One interface, three unrelated failure signals — this is the part that is easy to get wrong:

| path | dispatch | how failure shows | client-side cancellation |
|---|---|---|---|
| `EmulatorGrpcClient` | promise | rejects; input RPCs carry a deadline | yes, of *our wait* — see the caveat below |
| `ScrcpyControl` | `socket.write()`, returns `void` | **nothing**. `write()` does not throw for a dead peer, so `isReady()` (`socket.writable`) is the only signal | n/a |
| `AndroidTouchHelper` | `adb shell input …` | promise rejects | no — the child is not killed |

Measured against a killed emulator: the gRPC RPC rejects in **4ms** with `14 UNAVAILABLE … ECONNREFUSED`, so an unreachable emulator answers on its own and the deadline never comes into it. `isReady()` stays `true` through that, because for this backend it only reports "we closed it"; the rejection carries the rest.

**What the deadline does and does not buy.** It cancels *our* call, not a request the emulator already applied. Since an unreachable emulator rejects immediately, the only case the deadline actually fires in is a client still connected but not responding — and there we cannot know whether the input landed, so a caller that retries on the error can double it. That is the same hazard that argued against bounding the adb path; it is accepted here only because the window is much narrower (1500ms of silence from a connected emulator, versus every stuck `adb` call). If it turns out to matter, the answer is a distinct outcome meaning "unknown, do not retry", not a shorter deadline.

- **`isReady()` is not a liveness probe.** `socket.writable` is a local-end flag: it goes false after our own destroy, after a FIN (`allowHalfOpen` defaults false, so node ends our writable side), or after an error was already observed. Edge-triggered and one turn late, so the first input after a silent death still reads ready. It cannot see a live socket whose guest stopped consuming. The ack promises delivery, not landing, so that is consistent — do not read more into it.
- **The adb path is deliberately unbounded.** Racing a timer would not help: the child cannot be killed (`bounded()` records why — killing `input` mid-write can leave the guest worse off), so a timeout would answer failure while the input was still on its way, invite a retry, and land it twice. Unbounded means a wedged guest produces no ack and the caller falls back to its own timeout, which is what happened before this change. One child per input the user actually made is the honest ceiling.
  Measured on a booted emulator (Pixel_6_tapflow): **86ms for the first tap** — it pays the `wm size` lookup, cached after — and **26–29ms steady state**. That is 23× under the MCP client's 2s window on the worst measured call and ~70× on a warm one, so a bound could only ever fire on a guest that is genuinely stuck, which is the one case where firing does harm.
- **The vocabulary is not identical to iOS's, and only part of that is a decision.** A *decision*: `unsupported` for an unmapped button, because iOS's unmapped case means the device genuinely has no such button (#484) while ours means we do not know the name. **Not** a decision, and no longer a difference: `no-session`. iOS's four terminal handlers used to `break` silently on a missing state — that was an asymmetry, closed in #490, and both sides now answer it as `channel-unavailable`. `channel-down` is still narrower on this side than on iOS's, because the situations iOS folds into it get their own reasons here. `not-booted` and `channel-down` keep their exact wording for the meanings that do overlap. Android also answers `failed`, `malformed` and `no-gesture`, none of which iOS distinguishes.
- `stream:request-idr` (`AndroidAgent.ts`, `scrcpySession.control.resetVideo()`) writes to the same control socket with no check. It is not an ack surface, so it was left alone — but it shares `isReady()`'s limits.
- **Downscale**: the gRPC encode size is capped by `TAPFLOW_ANDROID_MAX_SIZE` (or the cross-platform `TAPFLOW_MAX_SIZE`); the per-session tier (native / 1280 / 1000) comes from the viewer context. 16-aligned so H.264 macroblock cropping doesn't show padding on the WASM decoder.
- **Metrics**: `TAPFLOW_STREAM_METRICS=1` logs the throughput baseline (`stream metrics … fps/KB·s/drop`, every 5 s); gRPC capture fps is set by `TAPFLOW_ANDROID_FPS` (default 30). Full instrumentation surface and the user-facing tuning knobs are in [`contributing/measurement.md`](../../contributing/measurement.md).
- AVD name is the stable key for `Device.id` (`"avd:<name>"`). ADB serial is kept only in the internal `serialMap`.
- `ANDROID_HOME` or `ADB_PATH` environment variable is required. Missing → clear error and immediate exit.
- Apple Silicon Mac: `system-images;android-34;google_apis;arm64-v8a` image required.

### An entry point with no session refuses rather than choosing

The members that take no session id — `screenshot`, `installApp`, `launchApp`, `queryUITree`,
`stream`, the three touch methods, `openUrl`, and `NetworkControlCapability`'s two — go through
`soleLiveOrNone()`. It **throws when more than one device is live**, naming the count.

`IOSAgent.soleOf` has done this since #607 and its comment carries the reason: *"Refusing beats
guessing: this interface has no way to say which device is meant, and picking one silently is the whole
defect being fixed here."* This class did not, and eleven members each took
`deviceStates.values().next().value` — the entry the relay happened to register first — because each was
written from the one above it. For a read that answers about a device nobody asked about; for
`setNetworkOffline` it takes a device off the network while somebody else is testing on it (#617).

**Liveness is `adb` reporting the emulator attached, and ownership is what narrows it.** `deviceStates`
holds one entry per *registered* AVD and a Mac reports every AVD it has, so registration is not
liveness — but neither is having a serial, quite: `AdbWrapper.listDevices` syncs that map from
`adb devices` on every call, so a developer's own emulator is in it too. (`IOSAgent.soleDeviceState`
says this map is "only populated on launch"; that is wrong, and it is the claim this change was first
written on.) `ownedDevices` records the AVDs tapflow launched and is preferred when more than one is
live, so the common desk — your emulator plus a tester's — resolves instead of refusing.
`IOSAgent.soleLiveDeviceState` narrows the same way, after a version that did not made every caller
refuse on a two-simulator desk.

Two things stay as they were, deliberately:

- **`sessionId`** still takes the first entry. A read's worst case is naming the wrong device, and it
  answers *before* a device is chosen — refusing would make "which session am I on" an error on a
  healthy two-emulator Mac. `IOSAgent.sessionId` is identical.
- **Absence stays a no-op for the touch methods.** They have always been silent without a device, and
  `touchStart` returns `void` so a throw is the only signal it could give. `soleLive()` is the variant
  that demands a device; `soleLiveOrNone()` is the one they use.

**Ambiguity is an error even for input, and there this class diverges from iOS on purpose.**
`IOSAgent.liveDeviceState` returns `undefined` when it cannot choose, so a tap on a two-simulator desk
silently does nothing. Silence is the failure mode this repo keeps removing — a tester taps, nothing
moves, and no channel says why. `touchMove` was made `async` for the same reason: it declared
`Promise<void>` and could not throw before, so a caller that wrote `.catch()` on that signature would
have been broken by the one path this change added.

**None of this touches the wire path.** Anything carrying a session resolves through
`serialFor(sessionId)` and always has — the browser names its session on every message.

`scripts/__tests__/agentEntryPointsRefuse.test.mjs` holds it for the twelfth member, and names the one
exemption rather than pattern-matching it, so the next exemption has to be a decision.

### A screenshot reply names what was produced, never what was asked for

`screencap -p` produces PNG and takes no format argument, so `screenshot:done` answers `format: 'png'`
unconditionally — including for a JPEG request. The request's `format` is a **preference** and this
platform cannot honour it; only the reply describes an outcome (see `ScreenshotRequest` in protocol).

Echoing the request is #508: the relay writes that field into the HTTP `Content-Type`, so PNG bytes went
out as `image/jpeg`, and `mcp-server` picked a JPEG parser for the dimensions it hands the LLM as
`tap`'s divisors. The type system cannot see it — `'png' | 'jpeg'` is correct on both sides — so the
test that pins a jpeg request to a `png` answer is the whole enforcement.

### Mapping internal reasons onto the wire

`inputOutcome.ts` keeps this agent's seven internal reasons; `wireReason()` maps them onto the closed
set in `@tapflowio/protocol`. One collapses, and it is recorded rather than assumed:

- `no-session` → `channel-unavailable`. The consumer's move is the same, and promoting it to its own
  wire reason would add a surface whose reachability is disputed — `sessionRebind.test.ts` records
  that a restarted agent is re-seeded from `agent:registered`, though that message carries one entry
  per *device* while one device can now sit behind two sessions. iOS answers the same way, so the two
  agents no longer differ here.

`no-gesture` passes through rather than collapsing into `malformed`, which was the first attempt: its
advice differs. `malformed` tells a caller to fix the call and never retry; a terminal frame with no
gesture behind it is well-formed on a channel that may be healthy, and the caller's move is to open a
new gesture. iOS reaches the same reason by a different route (its gesture-ownership guard).

**This agent produces no `channel-starting`.** iOS has a measured window where its helper is up but
not yet injecting; here a path either has a channel or does not. Written down so the gap is a fact
about the platform rather than an oversight.

## HOW NOT

- Do not hardcode the ADB path — use `$ANDROID_HOME/platform-tools/adb` or `$ADB_PATH`.
- Do not run ADB commands before confirming emulator boot is complete.
- Don't switch to `google_apis_playstore` AVD images without testing — untested, with historical H.264 encoder crashes (odd-width capture). `google_apis` is the verified image. (scrcpy path.)
- Do not revert the scrcpy `video_encoder` to `c2.android.avc.encoder` — it has shown silent stalls / encoder errors under GPU load; the pinned `OMX.google` software encoder is the tested one.
- Do not open only the video socket in `ScrcpySession.start()` and skip the control socket — violates the scrcpy protocol and the server will not start streaming.
- Do not break the `PointerControl` / `AndroidTouchHelper` interfaces to add low-latency touch — replace only the internal implementation. (Both did gain members for input-ack truthfulness — `isReady()`, and outcomes instead of `void` — which is a different reason and is documented above.)
- Do not pollute the `agent-core` `DeviceAgent` interface with Android-specific methods.
- Do not "correct" stream colors toward the Android emulator window (e.g. patching SPS VUI `transfer_characteristics` / colour metadata). Verified 2026-06-02 (scrcpy stream; the gRPC path also encodes BT.709 / limited-range): the stream is correctly signaled and the browser renders it faithfully — tapflow stays **closer to the design source** while the emulator window **over-saturates**. Measured flat `#FF8000`: source G=128 → tapflow G=119 → emulator G=108 (black/white/pure-RGB identical across all three). This fidelity is intended; see `docs/troubleshooting/android-emulator.md` (#colors-look-different-from-the-emulator-less-saturated).
