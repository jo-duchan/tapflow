# ios-agent — CLAUDE.md

> Common rules: [CLAUDE.md](../../CLAUDE.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`IOSAgent`: controls iOS simulators via `xcrun simctl`, streams frames using SimulatorKit IOSurface callbacks, and injects touch / keyboard / button events directly via SimDeviceLegacyHIDClient. No WebDriverAgent.

## HOW

- Assume macOS only. Throw a clear error on non-macOS environments.
- Wrap all xcrun/simctl calls in dedicated functions so they can be swapped with mocks in tests.
- Capture frames via SimulatorKit IOSurface and stream JPEG frames as WebSocket binary messages (≤30 fps).

## HOW NOT

- Do not inline `xcrun` commands with business logic.
- Do not expose iOS-specific methods as public API if they are not in the `DeviceAgent` interface.
- Do not reintroduce SCStream/ScreenCaptureKit — geometry coordinate mismatches cause double-frame issues.
- Do not stream JPEG frames over WebRTC DataChannel — the channel silently closes on large messages (~200KB+), and there is no P2P benefit in a relay-intermediary architecture.

---

## Compound

### touch-helper interface

```
touch-helper <udid|booted>
```

Injects HID events directly into the iOS Simulator via `SimDeviceLegacyHIDClient` + IndigoHID.

stdin protocol (variable-length frames):
- types 1–5, 9 : 9 bytes — `[type:u8][a:u8/f32BE][b:f32BE]`
- types 6–8    : 17 bytes — `[type:u8][x1:f32BE][y1:f32BE][x2:f32BE][y2:f32BE]`

| type | action |
|------|--------|
| 1 | touch start (x, y normalized 0–1) |
| 2 | touch move (x, y) |
| 3 | touch end |
| 4 | HID button (a=usagePage, b=usage) |
| 5 | legacy button (a=code) |
| 6 | pinch start (x1,y1 = finger0, x2,y2 = finger1) |
| 7 | pinch move |
| 8 | pinch end |
| 9 | key press ([0]=modifierBitmap, [4–7]=hidUsage u32BE) |

When changing the Swift source, **always update both locations simultaneously**:
1. `src/touch-helper.swift` — stdin protocol changes
2. `src/TouchHelper.ts` — byte layout in the `write()` method

Compile (output to `bin/`):
```bash
cd packages/ios-agent && swiftc src/touch-helper.swift -o bin/touch-helper
```

---

### screencapture-helper interface

```
screencapture-helper <fps> <udid|booted> [jpeg|h264]
```

Reads the `com.apple.framebuffer.display` port directly via SimulatorKit IOSurface callbacks. The 3rd arg picks the codec (default `jpeg`); `h264` uses VideoToolbox (`VTCompressionSession`, baseline, B-frames off, periodic IDR, BT.709).

Output framing (length-prefixed):
- **jpeg**: `[4-byte BE len][JPEG bytes] ...`
- **h264**: `[4-byte BE len][flags:u8][Annex B NAL] ...` — `len` counts the flags byte; flags bit0 = keyframe (IDR). Keyframes carry SPS+PPS prepended.

**stdin commands** (h264 only): a single `0x01` byte forces an IDR on the next frame. The relay sends this (via `stream:request-idr` → `ScreenCaptureStreamer.requestKeyframe()`) for drop-to-keyframe recovery, so the stream resyncs fast instead of waiting for the periodic IDR. JPEG ignores stdin.

**Env**:
- `TAPFLOW_JPEG_QUALITY` (0–1, default `0.8`) — JPEG quality; the LAN bandwidth ↔ design-QA fidelity trade-off. Lower = fewer relay→browser drops on LAN, but more artifacts.
- `TAPFLOW_IOS_CODEC=h264` (default `jpeg`) — opt into H.264 (only on the IOSurface path, not the MjpegStreamer fallback). Set on the agent process. The codec is signalled per frame in the TFFE envelope (byte5 bit0).
- `TAPFLOW_IOS_H264_BITRATE` (bits/s, default `8_000_000`) — H.264 `AverageBitRate` (soft target). Reduces scroll bandwidth to fit a WiFi LAN and avoid sustained relay backpressure; matches the Android scrcpy 8 Mbps cap. Lower = fewer LAN drops, more motion blockiness. **Do not add `DataRateLimits` (hard cap)** — it corrupts frames (tearing) under high motion.

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

### keyboard-helper interface

```
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

```
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

### Keyboard HID path

Keyboard injection uses `IndigoHIDMessageForKeyboardArbitrary(usage, op)`.  
`IndigoHIDMessageForHIDArbitrary(target=0x32, page=0x07, ...)` is the digitizer (touch) path — iOS does not recognize it as a hardware keyboard, so the CapsLock HUD and Korean/English toggle do not work.

→ Detailed analysis (target differences, symptom patterns, SimKeyboardInputController symbols): [`internal/simkit-internals.md` §5](../../internal/simkit-internals.md)

---

### DeviceChromeLoader

**Device identification**: `load(typeIdentifier)` takes a `typeIdentifier`, not an instance name.
- ❌ `"iPhone 16 (tapflow)"` — user-assigned name, does not match simdevicetype files
- ✅ `"com.apple.CoreSimulator.SimDeviceType.iPhone-16"` — the canonical identifier returned by xcrun simctl

`SimctlWrapper` parses `deviceTypeIdentifier` into `Device.typeId` and passes it through.

**Button layout**: `PhoneComposite.pdf` contains no physical buttons. Buttons are separate PDF assets; placement data is in `chrome.json`'s `inputs[]`.

Margin calculation (same logic as baguette `computeMargins`):
```
left-anchor button:  margin.left  = max(imgWidth - rollover.x, 0)
right-anchor button: margin.right = max(imgWidth + rollover.x, 0)
```

Button center (expanded canvas): `left-anchor: margin.left + rollover.x`  
Render order: `behindBtns → composite → onTopBtns`  
Cache key: `tapflow-frame-v2-{chromeName}.png`

**Screen corner radius**: outer radius is read from `paths.simpleOutsideBorder.cornerRadiusX` in `chrome.json`.
```
innerRadius = max(outerRadius - bezelInset, 0)
bezelInset  = max(leftWidth, topHeight)   // chrome.json images.sizing
```
`ChromeData.screenCornerRadius` is in 2× px units. CSS conversion in `IOSViewer.tsx`: `÷2 × displayScale`.

---

### WebSocket Binary MJPEG — streaming protocol

`ws.send(Buffer)` → Relay → `ws.send(data, { binary: true })` → Browser `e.data instanceof ArrayBuffer`

Why WebSocket instead of DataChannel:
1. **DataChannel instability**: `@roamhq/wrtc` silently closes the channel on messages ~236KB+.
2. **No GPU benefit**: DataChannel + JPEG uses `createImageBitmap` which is CPU-based — hardware decoding requires a WebRTC Video Track.
3. **No P2P benefit**: tapflow has a fixed Agent → Relay → Browser path.

---

### IOSAgent tests — streaming prerequisites

`startBinaryStream()` is called only inside `handleDeviceBoot()`. Any test involving streaming or TouchHelper must go through the `device:boot` flow first.

```typescript
browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
await waitForType(browser, 'session:joined')
browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
await waitForType(browser, 'device:ready')
// MockTouchHelper.mock.results[0].value is now accessible
```

`mockSimctl(true)` (booted=true) → skips `device:booting` and delivers `device:ready` immediately.
