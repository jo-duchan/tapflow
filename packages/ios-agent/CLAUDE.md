# ios-agent — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`IOSAgent`: `xcrun simctl`로 iOS 시뮬레이터를 제어하고, SimulatorKit IOSurface 콜백 기반으로 화면을 스트리밍하며, SimDeviceLegacyHIDClient로 터치·키보드·버튼을 직접 주입한다. WebDriverAgent는 사용하지 않는다.

## HOW

- macOS에서만 실행됨을 가정한다. 비 macOS 환경에서는 명확한 오류를 던진다.
- xcrun/simctl 호출은 래핑 함수로 분리해 테스트 시 mock 교체가 가능하게 한다.
- SimulatorKit IOSurface로 화면을 캡처해 JPEG 프레임을 WebSocket Binary로 스트리밍한다 (≤30fps).

## HOW NOT

- `xcrun` 명령을 비즈니스 로직과 인라인으로 섞지 않는다.
- `DeviceAgent` 인터페이스에 없는 iOS 전용 메서드를 public API로 노출하지 않는다.
- SCStream/ScreenCaptureKit을 다시 도입하지 않는다 — geometry 좌표계 불일치로 이중 프레임 문제가 발생한다.
- WebRTC DataChannel로 JPEG 프레임을 스트리밍하지 않는다 — 대용량 메시지(~200KB+)에서 채널이 조용히 닫히며, relay-intermediary 구조에서는 P2P 이점도 없다.

---

## Compound

### touch-helper 인터페이스

```
touch-helper <udid|booted>
```

`SimDeviceLegacyHIDClient` + IndigoHID로 iOS Simulator에 직접 HID 이벤트를 주입한다.

stdin 프로토콜 (가변 길이 프레임):
- type 1–5, 9 : 9바이트 — `[type:u8][a:u8/f32BE][b:f32BE]`
- type 6–8    : 17바이트 — `[type:u8][x1:f32BE][y1:f32BE][x2:f32BE][y2:f32BE]`

| type | 동작 |
|------|------|
| 1 | touch start (x, y 정규화 0–1) |
| 2 | touch move (x, y) |
| 3 | touch end |
| 4 | HID button (a=usagePage, b=usage) |
| 5 | legacy button (a=code) |
| 6 | pinch start (x1,y1 = finger0, x2,y2 = finger1) |
| 7 | pinch move |
| 8 | pinch end |
| 9 | key press ([0]=modifierBitmap, [4–7]=hidUsage u32BE) |

Swift 소스 변경 시 **반드시 두 곳을 동시에** 수정한다:
1. `src/touch-helper.swift` — stdin 프로토콜 변경
2. `src/TouchHelper.ts` — `write()` 메서드의 byte layout 변경

컴파일 (출력은 `bin/`):
```bash
cd packages/ios-agent && swiftc src/touch-helper.swift -o bin/touch-helper
```

---

### screencapture-helper 인터페이스

```
screencapture-helper <fps> <udid|booted>
```

SimulatorKit IOSurface 콜백으로 `com.apple.framebuffer.display` 포트를 직접 읽는다.  
출력: `[4-byte BE uint32 frame length][JPEG bytes] ...`

Swift 바이너리 인터페이스가 바뀌면 **반드시 두 곳을 동시에** 수정한다:
1. `src/screencapture-helper.swift` — 인자 파싱 변경
2. `src/ScreenCaptureStreamer.ts` — `args` 배열 변경

컴파일 후 TypeScript dist 재빌드가 필요하다:
```bash
cd packages/ios-agent
swiftc src/screencapture-helper.swift -o bin/screencapture-helper \
  -framework CoreVideo -framework ImageIO
pnpm build
```

---

### keyboard-helper 인터페이스

```
keyboard-helper <show|hide> <udid|booted>
```

CoreSimulator.framework을 직접 로드해 `SimDevice.setHardwareKeyboardEnabled(_:keyboardType:error:)`를 호출한다.
macOS 접근성(Accessibility) 권한이 필요 없다.

- `show`: `setHardwareKeyboardEnabled(false)` — 하드웨어 키보드 연결 해제 → 텍스트 필드 포커스 시 소프트웨어 키보드 등장
- `hide`: `setHardwareKeyboardEnabled(true)` — 하드웨어 키보드 연결 → 소프트웨어 키보드 즉시 숨김

컴파일 (출력은 `bin/`):
```bash
swiftc packages/ios-agent/src/keyboard-helper.swift \
  -o packages/ios-agent/bin/keyboard-helper \
  -sdk "$(xcrun --show-sdk-path --sdk macosx)"
```

---

### IOSurface 캡처 — timer-driven 전략

IOSurface 콜백만으로는 화면이 정적일 때 프레임이 오지 않는다.
`DispatchSourceTimer`를 함께 사용해 콜백 유무와 관계없이 일정 FPS를 유지한다.

```swift
// 콜백: latestSurface만 갱신
let onFrame: @convention(block) () -> Void = {
    captureQueue.async { updateLatestSurface() }
}

// 타이머: 매 tick마다 최신 surface를 인코딩
let timer = DispatchSource.makeTimerSource(queue: captureQueue)
timer.schedule(deadline: .now(), repeating: 1.0 / fps)
timer.setEventHandler {
    guard let surf = latestSurface, let jpeg = encodeJPEG(surf) else { return }
    writeFrame(jpeg)
}
```

---

### keyboard HID 경로

키보드 주입은 `IndigoHIDMessageForKeyboardArbitrary(usage, op)` 를 사용한다.  
`IndigoHIDMessageForHIDArbitrary(target=0x32, page=0x07, ...)` 는 digitizer(터치) 경로여서 iOS가 하드웨어 키보드로 인식하지 못해 CapsLock HUD와 한/영 전환이 동작하지 않는다.

→ 상세 분석(target 차이, 증상 패턴, SimKeyboardInputController 심볼): [`internal/simkit-internals.md` §5](../../internal/simkit-internals.md)

---

### DeviceChromeLoader

**device 식별**: `load(typeIdentifier)` 는 인스턴스 이름이 아닌 `typeIdentifier`를 받는다.
- ❌ `"iPhone 16 (tapflow)"` — 사용자 지정 이름, simdevicetype 파일과 불일치
- ✅ `"com.apple.CoreSimulator.SimDeviceType.iPhone-16"` — xcrun simctl이 반환하는 공식 식별자

`SimctlWrapper`는 `deviceTypeIdentifier`를 `Device.typeId`로 파싱해 전달한다.

**버튼 레이아웃**: `PhoneComposite.pdf`에 물리 버튼이 없다. 버튼은 별도 PDF 에셋으로 분리되며, `chrome.json`의 `inputs[]`에 배치 정보가 담겨 있다.

margin 계산 (baguette `computeMargins` 동일 로직):
```
left-anchor 버튼:  margin.left  = max(imgWidth - rollover.x, 0)
right-anchor 버튼: margin.right = max(imgWidth + rollover.x, 0)
```

버튼 center (expanded canvas 기준): `left-anchor: margin.left + rollover.x`  
렌더링 순서: `behindBtns → composite → onTopBtns`  
캐시 키: `tapflow-frame-v2-{chromeName}.png`

**screen corner radius**: `chrome.json`의 `paths.simpleOutsideBorder.cornerRadiusX`에서 outer radius를 읽는다.
```
innerRadius = max(outerRadius - bezelInset, 0)
bezelInset  = max(leftWidth, topHeight)   // chrome.json images.sizing
```
`ChromeData.screenCornerRadius`는 2× px 단위. `SimulatorViewer.tsx`에서 CSS 변환 시 `÷2 × displayScale`.

---

### WebSocket Binary MJPEG — 스트리밍 프로토콜

`ws.send(Buffer)` → Relay → `ws.send(data, { binary: true })` → Browser `e.data instanceof ArrayBuffer`

DataChannel 대신 WebSocket을 사용하는 이유:
1. **DataChannel 불안정**: `@roamhq/wrtc`는 ~236KB 이상 메시지에서 채널을 조용히 닫는다.
2. **GPU 이점 없음**: DataChannel + JPEG는 `createImageBitmap`이 CPU 기반 — WebRTC Video Track이어야 하드웨어 디코딩이 된다.
3. **P2P 이점 없음**: tapflow는 Agent → Relay → Browser 경로가 고정이다.

---

### IOSAgent 테스트 — 스트리밍 시작 전제조건

`startBinaryStream()`은 `handleDeviceBoot()` 내부에서만 호출된다. 스트리밍·TouchHelper 관련 테스트는 반드시 `device:boot` 흐름을 거쳐야 한다.

```typescript
browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
await waitForType(browser, 'session:joined')
browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
await waitForType(browser, 'device:ready')
// MockTouchHelper.mock.results[0].value 이제 접근 가능
```

`mockSimctl(true)` (booted=true) → `device:booting` 없이 즉시 `device:ready`.
