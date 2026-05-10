# ios-agent — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`IOSAgent`: `xcrun simctl`로 iOS 시뮬레이터를 제어하고, WebDriverAgent로 터치를 인젝션하며, SimulatorKit IOSurface 콜백 기반으로 화면을 스트리밍한다.

## HOW

- macOS에서만 실행됨을 가정한다. 비 macOS 환경에서는 명확한 오류를 던진다.
- xcrun/WDA 호출은 모두 래핑 함수로 분리해 테스트 시 목(mock) 교체가 가능하게 한다.
- SimulatorKit IOSurface로 화면을 캡처해 JPEG 프레임을 WebSocket Binary로 스트리밍한다 (≤30fps).

## HOW NOT

- `xcrun` 명령을 비즈니스 로직과 인라인으로 섞지 않는다.
- WDA가 없는 환경에서 무한 대기하지 않는다 — 타임아웃을 설정한다.
- `DeviceAgent` 인터페이스에 없는 iOS 전용 메서드를 public API로 노출하지 않는다.
- fallback 값으로 디바이스 해상도를 하드코딩하지 않는다 — WDA나 simctl로 실제 값을 읽는다.
- SCStream/ScreenCaptureKit을 다시 도입하지 않는다 — geometry 좌표계 불일치로 이중 프레임 문제가 발생한다.
- WebRTC DataChannel로 JPEG 프레임을 스트리밍하지 않는다 — 대용량 메시지(~200KB+)에서 채널이 조용히 닫히며, relay-intermediary 구조에서는 P2P 이점도 없다. WebRTC Video Track은 별도로 검토할 수 있다.

---

## Compound

### touch-helper 인터페이스

```
touch-helper <udid|booted>
```

`SimDeviceLegacyHIDClient` + IOHIDEvent 계층으로 iOS Simulator에 직접 HID 터치 이벤트를 주입한다.
WDA W3C Actions API 대신 사용 — 요청 직렬화 없이 실시간 스트리밍 가능.
WDA는 물리 버튼(`pressButton`)과 키보드(`type`)에 계속 사용된다.

stdin 프로토콜: `[type:uint8][x:float32BE][y:float32BE]` (9바이트/이벤트)
- type 1 = start, 2 = move, 3 = end
- x, y: **정규화 좌표 (0.0–1.0)** — WDA getWindowSize 불필요

**내부 동작 (Xcode 26+):**
```
IndigoHIDMessageForMouseNSEvent(
    position=(x,y),   ← 정규화 0-1
    delta=zero,
    target=0x32,      ← digitizer IndigoHIDTarget
    NSEventType,      ← 1=down, 6=drag, 2=up
    size=(1.0,1.0),   ← 정규화 좌표 공간 선언
    edge=0
)
→ SimDeviceLegacyHIDClient.sendWithMessage:freeWhenDone:YES:
```

- `target=0x32` — `0x35`(trackpad)는 `IndigoHIDMessageForTrackpadEventFromHIDEventRef`용이고,
  이 함수는 IOHIDEvent 자식 타입 0xB를 처리하지 않아 nil 반환 → 리스프링
- `SimDeviceLegacyHIDClient`는 `initWithDevice:error:`로 직접 생성
- baguette (tddworks/baguette) 분석에서 확인한 패턴

컴파일:
```bash
cd packages/ios-agent/src
swiftc touch-helper.swift -o touch-helper
```

Swift 소스 변경 시 **반드시 두 곳을 동시에** 수정한다:
1. `src/touch-helper.swift` — stdin 프로토콜 변경
2. `src/TouchHelper.ts` — `write()` 메서드의 byte layout 변경

---

### screencapture-helper 인터페이스

```
screencapture-helper <fps> <udid|booted>
```

SimulatorKit IOSurface 콜백 기반으로 `com.apple.framebuffer.display` 포트를 직접 읽는다.
geometry 계산 불필요. SCStream/ScreenCaptureKit 의존 없음.
출력: `[4-byte big-endian uint32 frame length][JPEG bytes] ...`

Swift 바이너리 인터페이스가 바뀌면 **반드시 두 곳을 동시에** 수정한다:
1. `src/screencapture-helper.swift` — 인자 파싱 변경
2. `src/ScreenCaptureStreamer.ts` — `args` 배열 변경

변경 후 **빌드 순서**:
```bash
# 1. Swift 바이너리 재컴파일
cd packages/ios-agent/src
swiftc screencapture-helper.swift -o screencapture-helper \
  -framework CoreVideo -framework ImageIO

# 2. TypeScript dist 재빌드
npm run build --workspace=@tapflow/ios-agent

# 3. dashboard 변경이 있으면
npm run build --workspace=@tapflow/dashboard
```

**dist 빌드 없이 소스만 수정하면 런타임에 바이너리↔TS 인자 불일치**로 프레임이 오지 않는다.

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

- ❌ 콜백만 사용: 정적 화면에서 1프레임 이후 전송 중단
- ✅ 타이머 + 콜백: 화면 변화 없어도 안정적 fps 유지

---

### DeviceChromeLoader — device 식별 방법

`DeviceChromeLoader.load(typeIdentifier)` 는 **device 인스턴스 이름이 아닌 typeIdentifier**를 받는다.

- ❌ `"iPhone 16 (tapflow)"` — 사용자 지정 이름, simdevicetype 파일과 불일치
- ✅ `"com.apple.CoreSimulator.SimDeviceType.iPhone-16"` — xcrun simctl이 반환하는 공식 식별자

`SimctlWrapper`는 `deviceTypeIdentifier`를 `Device.typeId`로 파싱해 전달한다.
`IOSAgent.sendChromeData()`는 `booted.typeId ?? booted.name` 순서로 조회한다.

---

### DeviceChromeLoader — 버튼 레이아웃 베이킹

`PhoneComposite.pdf`에는 물리 버튼(볼륨/전원/액션)이 포함되지 않는다.
버튼은 별도 PDF 에셋(`Mute BTN.pdf`, `Vol BTN.pdf`, `X_Power BTN.pdf` 등)으로 분리되어 있다.
`chrome.json`의 `inputs[]` 배열에 각 버튼의 배치 정보가 담겨있다.

**margin 계산 (baguette `computeMargins` 동일 로직)**:
```
left-anchor 버튼:  margin.left  = max(imgWidth - rollover.x, 0)
right-anchor 버튼: margin.right = max(imgWidth + rollover.x, 0)
```

버튼 center 위치 (expanded canvas 기준):
```
left-anchor:  centerX = margin.left + rollover.x
right-anchor: centerX = margin.left + compositeWidth + rollover.x
```

렌더링 순서: `behindBtns → composite → onTopBtns`
캐시 키: `tapflow-frame-v2-{chromeName}.png` (v2: 버튼 포함 버전 구분)

---

### WebSocket Binary MJPEG — 스트리밍 프로토콜 선택 기준

**언제**: 화면 스트리밍 전송 방식을 결정할 때

**방법**: `ws.send(Buffer)` → Relay → `ws.send(data, { binary: true })` → Browser `e.data instanceof ArrayBuffer`

**이유**:
1. **DataChannel 불안정**: `@roamhq/wrtc`의 RTCDataChannel은 ~236KB 이상 메시지에서 채널을 조용히 닫는다. 브라우저 측 `onclose`가 발화하지 않아 fallback 없이 화면이 첫 프레임에서 멈춘다.
2. **GPU 이점 없음**: WebRTC 하드웨어 인코딩은 Video Track + H.264/VP9에만 적용된다. DataChannel + JPEG는 `createImageBitmap`이 CPU 기반이어서 WebRTC로 바꿔도 GPU 이점이 없다.
3. **P2P 이점 없음**: tapflow는 relay-always-intermediary 구조다. Agent → Relay → Browser 경로가 고정이므로 WebRTC의 P2P 지연 이점을 얻을 수 없다.
4. **상용 서비스도 동일**: Appetize, BrowserStack 등 모두 WebSocket Binary 기반이다.

---

### IOSAgent 테스트 — 스트리밍 시작 전제조건

**언제**: `IOSAgent`의 스트리밍 관련 동작을 테스트할 때

**방법**:
```typescript
// 스트리밍은 device:boot 핸들러 안에서만 시작된다
browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
await waitForType(browser, 'session:joined')
browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
await waitForType(browser, 'device:ready')
// 이제부터 바이너리 프레임이 온다
```
`mockSimctl(true)` (booted=true)를 쓰면 `device:booting` 없이 즉시 `device:ready`가 온다.

**이유**: `startBinaryStream()`은 `handleDeviceBoot()` 내부에서만 호출된다. 세션 연결만으로는 스트리밍이 시작되지 않는다. `MockTouchHelper.mock.results[0]`도 마찬가지로 `device:boot` 이후에야 생성된다.

---

### DeviceChromeLoader — screen corner radius 계산

`chrome.json`의 `paths.simpleOutsideBorder.cornerRadiusX`에서 outer radius를 읽어 계산한다.

```
innerRadius = max(outerRadius - bezelInset, 0)
bezelInset  = max(leftWidth, topHeight)   // chrome.json images.sizing
```

`ChromeData.screenCornerRadius`는 2× px 단위로 반환한다.
`SimulatorViewer.tsx`에서 CSS `borderRadius`로 변환:
```tsx
const cssCornerRadius = chrome ? Math.round((chrome.screenCornerRadius / 2) * displayScale) : 0
```

PDF 경로 데이터에서 직접 추출할 필요 없음 — `chrome.json` 값이 정확하다.
