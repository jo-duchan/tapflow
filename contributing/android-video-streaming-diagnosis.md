# Android Video Streaming Diagnosis — Insights

> This document records the diagnosis and resolution of problems encountered while streaming the Android emulator. Add a section per issue.

---

## Issue 1 — c2.android.avc.encoder crash (google_apis_playstore)

### Conclusion

On the `google_apis_playstore/arm64-v8a` image, `c2.android.avc.encoder` crashes. The scrcpy approach itself is correct. **Fix: switch to the `google_apis/arm64-v8a` image.**

### Cause

`c2.android.avc.encoder` is a Codec2-based software H.264 encoder (AOSP libavc). On the `google_apis_playstore` image it aborts due to a failed odd-width graphics-buffer check or a SurfaceControl state mismatch.

Diagnostic log:
```
Abort message: 'Codec2BufferUtils.cpp:214] Check failed: (src.width() & 1) == 0'
E CCodec: Codec2 component "c2.android.avc.encoder" died.
E MediaCodec: Codec reported err 0xffffffe0
```

The scrcpy official FAQ documents the same error ("then try with another encoder"). The `google_apis_playstore` image has no alternative encoder (H.265/AV1), so swapping the image is the only fix.

### AVD image selection guide

| Image tag | Media codec | tapflow recommendation |
|---|---|---|
| `google_apis_playstore` | `c2.android.avc.encoder` — crashes | ❌ |
| `google_apis` | stable, H.264 works correctly | ✅ |
| `default` (AOSP) | minimal configuration | - |

Apple Silicon: use `system-images;android-34;google_apis;arm64-v8a`.

### Re-verification (2026-06-06, scrcpy 3.3)

Re-tested the 2×2 (encoder × image) on current emulators with scrcpy 3.3 at native 1080×2424:

| Image | `c2.android.avc.encoder` | `OMX.google.h264.encoder` (pinned) |
|---|---|---|
| `google_apis_playstore` (android-36) | STREAMS | STREAMS |
| `google_apis` (android-34) | STREAMS | STREAMS |

All four stream with no crash. The original crash is the H.264 **even-width requirement** (`(src.width() & 1) == 0`) — a general encoder constraint triggered by an **odd capture width**, not a playstore-specific defect; it did not reproduce at native even width. `OMX.google` can itself fail MediaCodec config in some environments (scrcpy [#6275](https://github.com/genymobile/scrcpy/issues/6275)).

**Takeaway**: `google_apis` stays the tested/recommended image (CI). Playstore isn't fundamentally broken on current images, but it's untested. The real risk to guard is **odd-width capture** (rotation / `max_size`) — keep capture dimensions even.

### Command to list available encoders

```bash
adb push scrcpy-server.jar /data/local/tmp/scrcpy-server.jar
adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
  app_process / com.genymobile.scrcpy.Server 3.1 \
  scid=00000000 list_encoders=true video=true audio=false control=false &
sleep 2
adb logcat -d | grep -i "encoder\|scrcpy"
```

---

## Issue 2 — FPS drop from macOS window occlusion (resolved 2026-05-18)

### Key conclusion (read this first)

Launching the emulator with the `-no-window -gpu host` combination resolves it.
With no emulator window, macOS has nothing to judge an occlusion state against, and
`-gpu host` keeps Metal acceleration even when used together with `-no-window`.

```bash
emulator -avd <name> -no-window -gpu host -no-audio -no-snapshot
```

Verification:
```bash
adb shell getprop ro.hardware.egl     # "emulation" → goldfish GL (host Metal), not SwiftShader
adb shell getprop debug.hwui.renderer # "skiagl"    → properly accelerated
```

---

### Symptoms

- When the emulator window is completely hidden behind the browser window, FPS drops to ~7–9 within tens of seconds.
- Placing browser and emulator side-by-side shows no FPS drop.
- Touching the emulator directly temporarily restores FPS.
- Unrelated to idle — even if the emulator screen does not change, it stays normal as long as it is not occluded.

### Root cause

macOS deliberately throttles GPU rendering of fully occluded windows via the `NSWindowOcclusionState` API. Because the emulator (QEMU) is synchronized to Metal swap-buffer / vsync:

```text
Fewer macOS Metal callbacks
  → QEMU Choreographer VSYNC slowdown
    → SurfaceFlinger can't sustain 60Hz
      → fewer frames reaching scrcpy's MediaCodec
```

This is neither a scrcpy problem nor an encoder problem. It is a design conflict: **QEMU produces fewer frames when its window is occluded.**

### Approaches tried that failed

| Approach | Result | Why |
|---|---|---|
| `event tap 0 0` (emulator console keepalive, every 3s) | **screen freeze** side effect | conflicts with the scrcpy touch-input pipeline |
| `repeat-previous-frame-after:long=33333` codec option | no effect | a missing SurfaceFlinger frame can't be fixed at the encoder layer |
| `stay_awake=true` (already applied) | no effect | a separate problem from display sleep |
| `-gpu swiftshader_indirect` (SW rendering) | too slow | CPU-only, no Metal |
| moving the window off-screen, minimizing | no effect | macOS treats it as occluded all the same |

### Characteristics of macOS occlusion (important)

Per Apple's official docs, all of the following are **treated as occluded**:
- fully hidden behind another window
- minimized to the Dock
- on a different Space (desktop)
- moved to off-screen coordinates

`NSWindowOcclusionState` is **read-only**, so it cannot be forced into an "always visible" state from the outside.

### Why `-no-window -gpu host` works

- `-no-window`: the emulator creates no macOS window → there is no occlusion-judgment target at all.
- `-gpu host`: Metal hardware acceleration is preserved (Metal rendering keeps running, decoupled from the window's swap).

**Common misconception**: "Using `-no-window` automatically switches to SwiftShader."
→ That's behavior of old emulators (before v28.x) spread by word of mouth. False on recent emulators (v33+).

### Code

`EmulatorLauncher.ts` — `launch()` method:

```typescript
const proc = spawn(getEmulatorPath(), [
  '-avd', avdName,
  '-no-audio',
  '-no-snapshot',
  '-no-window',   // avoid macOS occlusion
  '-gpu', 'host', // keep Metal acceleration
], { detached: true, stdio: 'ignore' })
```

### Reference notes gathered during research

- pupil-labs solved the same symptom in their own app (PyOpenGL) with a single line, `glfw.swap_interval(0)`. Applying the same patch to QEMU/emulator would require forking the source, and given that cost `-no-window` is far more practical.
- Google's `android-emulator-webrtc` (emulator streaming over gRPC + WebRTC) was archived in September 2025 and was Linux + NVIDIA only from the start. Even Google avoided this problem on macOS by going to Linux.
- There is no plist key or system API to disable `NSWindowOcclusionState` (deliberate Apple design).
- `-gpu angle_indirect`, `-gpu auto-no-window`, etc. are unsupported on macOS or are non-existent options.

### Alternative approach (if `-no-window` conflicts with a requirement)

You can use the emulator gRPC API's `streamScreenshot` RPC to replace scrcpy entirely. Because frames are produced directly inside the emulator process, it may bypass SurfaceFlinger's vsync path. Not yet verified.

---

## Issue 3 — SDK skin overlay attempt and rollback (PR #110 → revert PR #113)

### Conclusion

We attempted to render the Android SDK skin (`back.webp` + `mask.webp`) as a device-frame overlay, but rolled it back entirely due to a **structural limitation of the `google_apis` emulator**.

**Key point**: with any corner-masking approach, status-bar icons get clipped. This is not a code problem but an emulator-image limitation.

### Root cause

Real Pixel device firmware sets `ro.surface_flinger.rounded_corner_radius` on SurfaceFlinger so that the Android OS is aware of the screen's corner curvature. SystemUI (the status bar) reads this value via `WindowInsets.getRoundedCorner()` and automatically insets icons and the clock inside the corners.

The `google_apis/arm64-v8a` emulator image lacks this property. Therefore:

```
Emulator framebuffer → SystemUI draws the status bar against a rectangular baseline, without rounded-corner inset
→ WiFi / battery / clock sit at the outermost screen corners
→ any corner masking (border-radius / mask.webp / back.webp overlay) hides those pixels
```

Applying the same skin to Android Studio's standalone emulator window (the `emulator` binary) clips it identically.

### Fix methods tried that failed

| Method | Result |
|---|---|
| `adb shell settings put secure sysui_rounded_size 87` | ignored — the sysui secure setting is not applied on the `google_apis` image |
| `adb shell settings put secure sysui_rounded_content_padding 24` | ignored the same way |
| `adb shell am crash com.android.systemui` (restart SystemUI) | even after SystemUI restarts, the setting is not reflected |
| `adb shell settings put secure sysui_display_cutout corner` (simulate a display cutout) | a camera-notch simulation setting, unrelated to rounded-corner inset; no effect |
| `stop surfaceflinger && start surfaceflinger` (**forbidden**) | causes an emulator boot loop — never run this |

### Why it's fine without a skin

- Most emulator-mirroring tools (scrcpy on desktop, Genymotion, etc.) do not provide a device frame by default.
- tapflow is a QA tool, so status-bar visibility matters more than dressing up the device's appearance.
- The scrcpy stream itself is a raw rectangular framebuffer; corner masking is a pure visual effect of the display layer.

### Conditions for a future retry

We can revisit this if AOSP/Google updates the `google_apis` image to set `ro.surface_flinger.rounded_corner_radius`, or if an official way appears to inject a rounded-corner inset into SystemUI from outside.

---

## Issue 4 — FPS drop from macOS system idle throttle (resolved 2026-06-06)

### Key conclusion (read this first)

This is a **second, distinct** throttle from [Issue 2](#issue-2--fps-drop-from-macos-window-occlusion-resolved-2026-05-18). Issue 2 is **window occlusion** (the emulator window hidden behind the browser), fixed by `-no-window`. Issue 4 is **system idle sleep** of the *host Mac itself*, fixed by holding a `caffeinate -i` power assertion while an agent is connected (shipped v0.6.1). Both can apply at once and are unrelated.

### Symptoms

- Reported in the cross-Mac LAN setup: the agent Mac (e.g. an unattended Mac mini) streams Android at an erratic ~4–18fps; iOS on the same Mac stays at a steady 30fps.
- Worse the longer the Mac is unattended, on battery, or backgrounded; recovers when the Mac is actively used.

### Root cause

`EmulatorLauncher` already passes `-no-window`, so Issue 2's occlusion throttle does not apply. The remaining throttle is plain **macOS idle/system sleep**: with no local user activity (the reviewer is on another Mac over the LAN), the host idles and macOS down-clocks / suspends background work, starving the **software** H.264 encoder (`OMX.google.h264.encoder`) that scrcpy drives. The iOS path is less affected because it encodes via **hardware** VideoToolbox.

```text
Unattended host Mac idles
  → macOS reduces background CPU / heads toward sleep
    → software H.264 encoder can't sustain 30fps
      → fewer frames reach the relay → erratic / low fps
```

### Fix

`agent-core` `createSleepBlocker()` spawns `caffeinate -i` (prevents idle/system sleep). Both agents acquire it on connect and release on disconnect, held across reconnects. macOS-only; a complete no-op elsewhere (and under vitest). Verified: with `caffeinate -i pnpm dev`, Android stays fast even with the host's display off.

### Limits (what caffeinate does NOT cover)

| Not covered | Why |
|---|---|
| **Battery CPU scaling** | macOS lowers peak CPU on battery regardless of the assertion — caffeinate prevents sleep, not down-clocking. |
| **Clamshell sleep** | Closing a laptop lid sleeps the Mac; `caffeinate -i` cannot prevent it. |

User-facing guidance lives in `docs/guide/troubleshooting.md` (#emulator-is-slow-when-the-mac-is-unattended).

### Approaches considered

| Approach | Result | Why |
|---|---|---|
| macOS Energy setting "prevent sleeping when display off" | works but manual | `caffeinate -i` does the same automatically while the agent runs (works on battery too, unlike AC-only `-s`; still does not override battery CPU scaling) — no user setup needed |
| `caffeinate -d` (display) | unnecessary | the display can sleep; only system idle matters (verified: fast with display off) |
