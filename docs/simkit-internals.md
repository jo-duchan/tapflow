# SimulatorKit 내부 구조 역공학 노트

> 이 문서는 tapflow의 iOS 터치 주입 구현 과정에서 수행한 SimulatorKit 역공학 결과를 기록한 참고 자료다.
> Xcode 26 (SimulatorKit 버전 기준) 기반이며, 향후 Xcode 업그레이드 시 변경될 수 있다.

---

## 1. 바이너리 개요

**경로:** `$DEVELOPER_DIR/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit`

- **형식:** Fat binary (Universal)
  - slice 0: x86_64, file offset `0x4000`, size `0x113e70`
  - slice 1: ARM64e, file offset `0x118000`, size `0x133740`
- **언어:** Swift + ObjC 혼합 (Swift 클래스는 mangled name으로 노출)
- **공개 헤더:** 없음 — `nm`, `otool`, `strings`로 심볼 추출

심볼 추출 기본 명령:

```bash
# ARM64e thin slice 추출
lipo -thin arm64e $SIMKIT -output /tmp/simkit_arm64e

# 심볼 목록
nm -U /tmp/simkit_arm64e | grep <keyword>

# 디스어셈블
otool -tv /tmp/simkit_arm64e | awk '/^FunctionName:/{found=1} found{print; if(/ret$/) exit}'

# 문자열
strings /tmp/simkit_arm64e | grep <keyword>
```

---

## 2. 터치 주입 아키텍처 (Xcode 26)

### 2-1. 구버전 방식 (Xcode 25 이전, 삭제됨)

```
SimDevice.sendHIDEvent:(IOHIDEventRef)
```

Xcode 26에서 `SimDevice`에 해당 셀렉터가 존재하지 않는다. `responds(to:)` 체크 없이 `class_getMethodImplementation`으로 IMP를 얻으면 NULL이 아닌 **포워딩 트램펄린**이 반환되어, 호출 시 `unrecognized selector` crash가 발생한다.

> **교훈:** `class_getMethodImplementation`은 셀렉터 존재 여부 확인에 사용하면 안 된다. 반드시 `responds(to:)` + `class_getInstanceMethod`를 함께 사용해야 한다.

### 2-2. 신버전 방식 (Xcode 26+) — 실제 동작 확인

```
IndigoHIDMessageForMouseNSEvent(position, delta=zero, target=0x32, NSEventType, size=(1,1), edge=0)
  └─ SimDeviceLegacyHIDClient.sendWithMessage:freeWhenDone:completionQueue:completion:
```

- **좌표**: 정규화된 0.0–1.0 값. `NSSize(1.0, 1.0)`을 size로 전달해 좌표 공간을 선언.
- **target**: `0x32` (digitizer) — `0x35`(trackpad)가 아님.
- **NSEventType**: `1`=leftMouseDown, `2`=leftMouseUp, `6`=leftMouseDragged
- IOHIDEvent 계층(parent/child) 불필요 — 이 함수가 직접 IndigoHIDMessageStruct를 생성한다.

#### ⚠️ 실패한 접근: IndigoHIDMessageForTrackpadEventFromHIDEventRef

```
IOHIDEventCreate(parent: type=0xB Digitizer)
  └─ IOHIDEventCreateDigitizerFingerEvent (child finger, type=0xB)  ← 여기가 문제
       └─ IOHIDEventAppendEvent(parent, finger, 0)
            └─ IndigoHIDMessageForTrackpadEventFromHIDEventRef(parent, target=0x35)  ← nil 반환
```

`IndigoHIDMessageForTrackpadEventFromHIDEventRef`는 자식 이벤트 타입이 `0x2`(Button) 또는 `0x11`(Collection)인 경우만 처리한다.
`IOHIDEventCreateDigitizerFingerEvent`는 타입 `0xB`(Digitizer) 자식을 생성하므로 루프에서 스킵되어 nil이 반환된다.
결과: IndigoHIDMessageStruct가 count=1이지만 유효한 자식 데이터 없는 상태로 시뮬레이터에 전달 → **리스프링(respring)**.

**참고**: tddworks/baguette 분석에서 `IndigoHIDMessageForMouseNSEvent` + target=`0x32` 패턴 확인.

---

## 3. 핵심 클래스: SimDeviceLegacyHIDClient

### 심볼명

Swift mangled: `_TtC12SimulatorKit24SimDeviceLegacyHIDClient`  
ObjC 노출: `NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient")`

### 주요 메서드

| 메서드 | 설명 |
|--------|------|
| `-initWithDevice:error:` | SimDevice로 클라이언트 생성 |
| `-initWithDevice:sessionResetQueue:error:sessionResetHandler:` | 세션 리셋 핸들러 포함 생성 |
| `-sendWithMessage:freeWhenDone:completionQueue:completion:` | IndigoHIDMessageStruct 전송 |
| `-resetHIDSession` | HID 세션 리셋 |

### 생성 방법 (ObjC 런타임)

```swift
let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient")!

// +alloc
let metaCls = object_getClass(cls)!
let allocImp = class_getMethodImplementation(metaCls, NSSelectorFromString("alloc"))!
typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject
let allocated = unsafeBitCast(allocImp, to: AllocFn.self)(cls, NSSelectorFromString("alloc")) as! NSObject

// -initWithDevice:error:
let initSel = NSSelectorFromString("initWithDevice:error:")
let initImp = class_getMethodImplementation(type(of: allocated), initSel)!
typealias InitFn = @convention(c) (NSObject, Selector, NSObject,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> NSObject?
var err: NSError?
let client = unsafeBitCast(initImp, to: InitFn.self)(allocated, initSel, simDevice, &err)
```

### sendWithMessage: 호출

```swift
let sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
let sendImp = class_getMethodImplementation(type(of: client), sendSel)!
typealias SendFn = @convention(c) (NSObject, Selector, UnsafeMutableRawPointer, Bool,
                                   AnyObject?, AnyObject?) -> Void
// freeWhenDone:YES → SimulatorKit이 메시지 버퍼 메모리를 직접 해제
unsafeBitCast(sendImp, to: SendFn.self)(client, sendSel, msgPtr, true, nil, nil)
```

---

## 4. IndigoHIDMessage 함수들

SimulatorKit이 내부적으로 사용하는 C 함수들. `dlsym`으로 접근 가능.

| 함수 | 입력 | 용도 |
|------|------|------|
| `IndigoHIDMessageForTrackpadEventFromHIDEventRef` | `(IOHIDEventRef, IndigoHIDTarget)` | Digitizer(0xB) 이벤트 → 터치 |
| `IndigoHIDMessageForPointerEventFromHIDEventRef` | `(IOHIDEventRef, IndigoHIDTarget)` | Collection(0x11) 이벤트 → 포인터 |
| `IndigoHIDMessageForScrollEventFromHIDEventRef` | `(IOHIDEventRef, IndigoHIDTarget)` | 스크롤 |
| `IndigoHIDMessageForTrackpadMoveEvent` | `(CGPoint, IndigoHIDTarget)` | 트랙패드 이동 (IOHIDEvent 불필요) |
| `IndigoHIDMessageForMouseNSEvent` | `(CGPoint*, CGPoint*, IndigoHIDTarget, NSEventType, NSSize, IndigoHIDEdge)` | 마우스 |
| `IndigoHIDMessageForKeyboardArbitrary` | `(UInt32, IndigoHIDButtonOp)` | 키보드 |
| `IndigoHIDMessageForButton` | `(IndigoHIDButtonKeyCode, IndigoHIDButtonOp, IndigoHIDTarget)` | 물리 버튼 |

모든 함수는 `calloc`으로 할당한 `IndigoHIDMessageStruct*`를 반환한다.  
`sendWithMessage:freeWhenDone:YES`로 전달하면 SimulatorKit이 해제를 담당한다.

### IndigoHIDMessageForTrackpadEventFromHIDEventRef 내부 동작

```
1. IOHIDEventGetType(event) == 0xB 확인 (아니면 nil 반환)
2. GetChildrenForHIDEventRef(event, ...) — 자식 IOHIDEvent 배열 수집
3. calloc(1, (childCount + 1) * 0xa0 + 0x20) — 구조체 할당
4. 부모 헤더 채우기 (type=0xB, timestamp, childCount+1)
5. 각 자식 이벤트에서 IOHIDEventGetFloatValue로 x,y,z,pressure 읽기
6. IndigoHIDMessageStruct의 자식 슬롯에 저장
```

---

## 5. IndigoHIDTarget

`UInt32` 타입. 입력 디바이스 유형과 스크린을 인코딩한다.

### 값 목록 (역공학으로 확인)

| 값 | 의미 | 출처 |
|----|------|------|
| `0x35` (53) | 트랙패드 (Digitizer 이벤트) | `_hidEventFilterCallback`: `cinc w25, #0x35, ne` |
| `0x36` (54) | 마우스 / 기타 | `_hidEventFilterCallback`: `ne` 조건으로 increment |

### 버튼/스크린 타겟

```swift
func IndigoHIDTargetForScreen(_ screenID: UInt32) -> UInt32 {
    return screenID | 0x40000000
}
// 메인 스크린(ID=0) → target = 0x40000000
```

이 함수는 바이너리에서 딱 2줄로 구현되어 있다:
```asm
_IndigoHIDTargetForScreen:
    orr w0, w0, #0x40000000
    ret
```

`SimDeviceScreen.buttonTarget` 프로퍼티가 이 값을 반환한다.

### _hidEventFilterCallback 흐름 요약

```
이벤트 타입 확인 (w23)
  ├─ 0x11 (Collection): IndigoHIDMessageForPointerEventFromHIDEventRef(event, x25)
  │                      x25 = trackpadSenders 포함이면 0x35, mouseSenders면 0x36
  ├─ 0xB  (Digitizer):  IndigoHIDMessageForTrackpadEventFromHIDEventRef(event, 0x35) ← 하드코딩
  └─ 0x6  (Scroll):     IndigoHIDMessageForScrollEventFromHIDEventRef(event, x25)
```

---

## 6. IOHIDEvent 계층 구조

터치 주입에 필요한 계층:

```
Parent: IOHIDEventCreate(type=kIOHIDEventTypeDigitizer=11=0xB)
  └─ Child: IOHIDEventCreateDigitizerFingerEvent(...)
             → IOHIDEventAppendEvent(parent, child, 0)
```

### 사용 가능한 IOHIDEvent 함수 (IOKit + SimulatorKit 모두)

```swift
// 모두 SimulatorKit에서 dlsym으로 접근 가능
IOHIDEventCreate(allocator, type, timestamp, options)
IOHIDEventCreateDigitizerFingerEvent(alloc, ts, index, identity, transducerType,
                                     inRange, eventMask, options,
                                     x, y, z, tipPressure, twistAngle, inTouch, childCount)
IOHIDEventAppendEvent(parentEvent, childEvent, options)
```

### IOHIDEventCreateDigitizerFingerEvent 파라미터 (15개)

```swift
typealias IOHIDCreateFingerFn = @convention(c) (
    CFAllocator?,   // 1. allocator
    UInt64,         // 2. timestamp (mach_absolute_time())
    UInt32,         // 3. index (0 = 첫 번째 손가락)
    UInt32,         // 4. identity (고유 터치 ID, 보통 1)
    UInt32,         // 5. transducerType (kIOHIDDigitizerTransducerTypeFinger = 2)
    Bool,           // 6. inRange (터치 중이면 true)
    UInt32,         // 7. eventMask (Range|Touch = 0x3, 종료 시 0)
    UInt32,         // 8. options (0)
    Double,         // 9. x
    Double,         // 10. y
    Double,         // 11. z (0.0)
    Double,         // 12. tipPressure (터치 중 1.0, 종료 시 0.0)
    Double,         // 13. twistAngle (0.0)
    Bool,           // 14. inTouch (false 권장)
    UInt32          // 15. childCount (0)
) -> AnyObject?
```

---

## 7. ROCK Remote Proxy 이슈

`com.apple.CoreSimulator.HID.LegacyHID` IO 포트의 descriptor를 얻으면 ROCK 프록시가 반환된다:

```
ROCKRemoteProxy-{UUID}-ROCKImpersonateable-SimDeviceIOPortDescriptorInterface-SimLegacyHIDDescriptor-SimEnvironmentProvider
```

**ROCK(Remote Objects Communications Kit)**은 Mach port 기반 XPC 유사 IPC 프레임워크로, 프록시 객체가 메시지를 원격 프로세스로 포워딩한다.

### 문제점

`responds(to:)` 가 ROCK 프록시에서 항상 `false`를 반환한다.  
→ 기존의 셀렉터 탐색 방식(`trySelectors`)으로는 메서드를 찾을 수 없다.

### 결론

ROCK 프록시 대신 `SimDeviceLegacyHIDClient`를 직접 생성해서 사용하는 것이 올바른 접근이다. ROCK 프록시는 Simulator.app 내부의 뷰 레이어에서 사용하는 구조이며, 외부 프로세스에서 직접 사용하는 공개 경로가 아니다.

---

## 8. SimDeviceScreen (참고)

터치가 아닌 **버튼 입력**(음량, 전원 등)에 필요할 경우를 위한 참고.

```
-[_TtC12SimulatorKit15SimDeviceScreen initWithDevice:screenID:]
-[_TtC12SimulatorKit15SimDeviceScreen screenID]
-[_TtC12SimulatorKit15SimDeviceScreen isDefault]
-[_TtC12SimulatorKit15SimDeviceScreen isCarPlay]
```

`buttonTarget` 프로퍼티 → `IndigoHIDTarget` (= `IndigoHIDTargetForScreen(screenID)`)

---

## 9. 미확인 항목

| 항목 | 현황 |
|------|------|
| 터치 좌표계 | 정규화(0.0–1.0) + `NSSize(1,1)` 전달. `IndigoHIDMessageForMouseNSEvent`가 내부적으로 시뮬레이터 해상도로 매핑하는 것으로 추정. |
| 멀티터치 | 미테스트 — `IndigoHIDMessageForMouseNSEvent`의 `p2`(delta) 또는 별도 finger ID 파라미터 활용 가능성 미검증 |
| 스크롤 | `IndigoHIDMessageForScrollEventFromHIDEventRef` 경로 확인됨, 미구현 |
| 물리 버튼 | `IndigoHIDMessageForButton` + `IndigoHIDTargetForScreen` 경로 확인됨, 미구현 |
| Xcode 버전 호환성 | `SimDeviceLegacyHIDClient` + `IndigoHIDMessageForMouseNSEvent`는 Xcode 26 기준. 이전 버전에서는 `SimDevice.sendHIDEvent:` 사용 |

---

## 10. 탐색 방법론

향후 SimulatorKit 변경 시 재탐색할 때 참고하는 순서:

```bash
# 1. 핵심 클래스/함수 존재 확인
lipo -thin arm64e $SIMKIT -output /tmp/simkit_arm64e
nm -U /tmp/simkit_arm64e | grep <keyword>

# 2. 함수 signature 파악 (인자 수, 타입)
otool -tv /tmp/simkit_arm64e | awk '/^_FunctionName:/{found=1} found{print; ...}'

# 3. ObjC 프로토콜 메서드 목록
otool -oV /tmp/simkit_arm64e | grep -A 20 <ProtocolName>

# 4. 실제 호출 흐름 추적
# — 어떤 함수가 다른 함수를 호출하는지 역으로 추적
otool -tv /tmp/simkit_arm64e | grep <target_function>
# → 호출하는 함수명 확인 → 그 함수 디스어셈블

# 5. 런타임 검증 (Swift 테스트 바이너리)
# dlopen + dlsym으로 심볼 존재 확인 후 호출 테스트
```
