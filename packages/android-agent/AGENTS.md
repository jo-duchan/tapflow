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

## HOW

- ADB commands are isolated in `AdbWrapper`, swappable with an `AdbRunner` mock in tests.
- **UI tree** (`queryUITree` / `ui:tree:request`): `AdbWrapper.dumpUiHierarchy` runs `adb exec-out timeout 10 uiautomator dump /dev/tty` — the device-side toybox `timeout` bounds the dump because uiautomator waits for an idle window and can hang on continuous animation; a timed-out dump surfaces as an explicit `PlatformError`, never a silent empty tree. `uiTree.ts` parses the XML into the unified `UIElement[]` schema (agent-core); the screen size comes from the root node bounds, so landscape dumps normalize correctly without a `wm size` round-trip.
- On emulator boot: `EmulatorLauncher.waitForBoot(serial)` — polls `sys.boot_completed=1`.
- **Backend selection** (`pickAndroidBackend`): emulators (serial `emulator-*`) → **gRPC**; real devices → **scrcpy**. `TAPFLOW_ANDROID_BACKEND=grpc|scrcpy` overrides. On any gRPC failure (e.g. an emulator booted externally without `-grpc`), `startVideoStream` falls back to scrcpy so streaming still works.
- **gRPC backend (emulator default)**: `EmulatorGrpcClient` connects to the emulator's gRPC endpoint (`-grpc <port>`, default 8554, unsecured localhost) and reads `streamScreenshot` RGBA8888 frames → `EmulatorVideo` pipes them to the `emulator-encoder` Swift helper (Mac VideoToolbox: baseline, B-frames off, BT.709, force-IDR on demand), **bypassing the emulator's slow guest software H.264 encoder**. Mirrors the ios-agent VideoToolbox path so both platforms share one encode pipeline. The screenshot stream is frame-driven (no frames while static), so no static-skip is needed.
- **scrcpy backend (real devices + fallback)**: `ScrcpySession` → `ScrcpyVideo` pushes the scrcpy server to the device, runs it, and receives an H.264 Annex B stream over TCP. Two connections in order — video socket (1st) + control socket (2nd) — before the server begins streaming. `ScrcpyControl` keeps the control socket open. Pin `OMX.google.h264.encoder` (pure software) on a `google_apis/arm64-v8a` (android-34) image — the verified config; the default `c2.android.avc.encoder` (Codec 2.0) shows silent stalls under GPU load that the pump can't detect, and `google_apis_playstore` is untested (see `contributing/android-video-streaming-diagnosis.md`). This guest-encoder constraint applies to scrcpy only — the gRPC path never touches it.
- **Touch** (`PointerControl`): a backend-agnostic pointer interface satisfied structurally by both `EmulatorGrpcClient` (gRPC) and `ScrcpyControl` (scrcpy) — identical method shapes (sync for scrcpy, async for gRPC; callers fire-and-forget), so input handlers stay backend-agnostic. Falls back to `AndroidTouchHelper` (`adb input tap/swipe`) only when neither video backend is active.
- **Downscale**: the gRPC encode size is capped by `TAPFLOW_ANDROID_MAX_SIZE` (or the cross-platform `TAPFLOW_MAX_SIZE`); the per-session tier (native / 1280 / 1000) comes from the viewer context. 16-aligned so H.264 macroblock cropping doesn't show padding on the WASM decoder.
- **Metrics**: `TAPFLOW_STREAM_METRICS=1` logs the throughput baseline (`stream metrics … fps/KB·s/drop`, every 5 s); gRPC capture fps is set by `TAPFLOW_ANDROID_FPS` (default 30). Full instrumentation surface and the user-facing tuning knobs are in [`contributing/measurement.md`](../../contributing/measurement.md).
- AVD name is the stable key for `Device.id` (`"avd:<name>"`). ADB serial is kept only in the internal `serialMap`.
- `ANDROID_HOME` or `ADB_PATH` environment variable is required. Missing → clear error and immediate exit.
- Apple Silicon Mac: `system-images;android-34;google_apis;arm64-v8a` image required.

## HOW NOT

- Do not hardcode the ADB path — use `$ANDROID_HOME/platform-tools/adb` or `$ADB_PATH`.
- Do not run ADB commands before confirming emulator boot is complete.
- Don't switch to `google_apis_playstore` AVD images without testing — untested, with historical H.264 encoder crashes (odd-width capture). `google_apis` is the verified image. (scrcpy path.)
- Do not revert the scrcpy `video_encoder` to `c2.android.avc.encoder` — it has shown silent stalls / encoder errors under GPU load; the pinned `OMX.google` software encoder is the tested one.
- Do not open only the video socket in `ScrcpySession.start()` and skip the control socket — violates the scrcpy protocol and the server will not start streaming.
- Do not break the `PointerControl` / `AndroidTouchHelper` interfaces to add low-latency touch — replace only the internal implementation.
- Do not pollute the `agent-core` `DeviceAgent` interface with Android-specific methods.
- Do not "correct" stream colors toward the Android emulator window (e.g. patching SPS VUI `transfer_characteristics` / colour metadata). Verified 2026-06-02 (scrcpy stream; the gRPC path also encodes BT.709 / limited-range): the stream is correctly signaled and the browser renders it faithfully — tapflow stays **closer to the design source** while the emulator window **over-saturates**. Measured flat `#FF8000`: source G=128 → tapflow G=119 → emulator G=108 (black/white/pure-RGB identical across all three). This fidelity is intended; see `docs/guide/troubleshooting.md` (#colors-look-different-from-the-emulator).
