# android-agent — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`AndroidAgent`: controls Android emulators via ADB and streams H.264 video via **scrcpy**.
Runs alongside `ios-agent` on the same Mac.

## HOW

- ADB commands are isolated in `AdbWrapper`, swappable with an `AdbRunner` mock in tests.
- On emulator boot: `EmulatorLauncher.waitForBoot(serial)` — polls `sys.boot_completed=1`.
- Screen streaming: `ScrcpySession` → `ScrcpyVideo` — pushes the scrcpy server to the device, runs it, and receives an H.264 Annex B stream over a TCP socket. Use a `google_apis/arm64-v8a` (android-34) image — the tested/recommended config; `google_apis_playstore` is untested (see `contributing/android-video-streaming-diagnosis.md`).
- **Encoder**: `OMX.google.h264.encoder` (pure software) is pinned — the tested encoder. The default `c2.android.avc.encoder` (Codec 2.0) has shown silent stalls / encoder errors under GPU load (e.g. Chrome) on the virtualized GPU layer that neither the scrcpy server nor the pump loop can detect; the software encoder avoids that, with no emulator perf difference since everything is software-emulated anyway. Encoder availability and config success vary by image/environment — `google_apis` is the verified one.
- scrcpy protocol: two connections in order — video socket (1st) + control socket (2nd) — before the server begins streaming. `ScrcpyControl` keeps the control socket open and serves as the foundation for the binary touch protocol.
- Touch: `ScrcpyControl.touchDown/touchMove/touchUp` takes priority when a scrcpy session is active (low-latency binary protocol). Falls back to `AndroidTouchHelper` (`adb input tap/swipe`) only when no scrcpy session is running.
- AVD name is the stable key for `Device.id` (`"avd:<name>"`). ADB serial is kept only in the internal `serialMap`.
- `ANDROID_HOME` or `ADB_PATH` environment variable is required. Missing → clear error and immediate exit.
- Apple Silicon Mac: `system-images;android-34;google_apis;arm64-v8a` image required.

## HOW NOT

- Do not hardcode the ADB path — use `$ANDROID_HOME/platform-tools/adb` or `$ADB_PATH`.
- Do not run ADB commands before confirming emulator boot is complete.
- Don't switch to `google_apis_playstore` AVD images without testing — untested, with historical H.264 encoder crashes (odd-width capture). `google_apis` is the verified image.
- Do not revert to `video_encoder=c2.android.avc.encoder` — it has shown silent stalls / encoder errors under GPU load; the pinned `OMX.google` software encoder is the tested one.
- Do not open only the video socket in `ScrcpySession.start()` and skip the control socket — violates the scrcpy protocol and the server will not start streaming.
- Do not break the `AndroidTouchHelper` interface to add low-latency touch — replace only the internal implementation.
- Do not pollute the `agent-core` `DeviceAgent` interface with Android-specific methods.
- Do not "correct" stream colors toward the Android emulator window (e.g. patching SPS VUI `transfer_characteristics` / colour metadata). Verified 2026-06-02: the scrcpy stream is correctly signaled BT.709 / limited-range and the browser renders it faithfully — tapflow stays **closer to the design source** while the emulator window **over-saturates**. Measured flat `#FF8000`: source G=128 → tapflow G=119 → emulator G=108 (black/white/pure-RGB identical across all three). This fidelity is intended; see `docs/guide/troubleshooting.md` (#colors-look-different-from-the-emulator).
