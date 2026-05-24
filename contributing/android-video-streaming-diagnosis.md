# Android 비디오 스트리밍 진단 — 인사이트

> 이 문서는 Android 에뮬레이터 스트리밍 과정에서 만난 문제들의 진단·해결 기록이다. 이슈별로 섹션을 추가한다.

---

## Issue 1 — c2.android.avc.encoder crash (google_apis_playstore)

### 결론

`google_apis_playstore/arm64-v8a` 이미지에서 `c2.android.avc.encoder`가 크래시한다. scrcpy 방식 자체는 옳다. **해결: `google_apis/arm64-v8a` 이미지로 교체.**

### 원인

`c2.android.avc.encoder`는 Codec2 기반 소프트웨어 H.264 인코더(AOSP libavc). `google_apis_playstore` 이미지에서 그래픽 버퍼 홀수 너비 체크 실패 또는 SurfaceControl 상태 불일치로 abort.

진단 로그:
```
Abort message: 'Codec2BufferUtils.cpp:214] Check failed: (src.width() & 1) == 0'
E CCodec: Codec2 component "c2.android.avc.encoder" died.
E MediaCodec: Codec reported err 0xffffffe0
```

scrcpy 공식 FAQ에도 동일 에러가 명시됨 ("then try with another encoder"). `google_apis_playstore` 이미지에는 대안 인코더(H.265/AV1)가 없으므로 이미지 교체가 유일한 해결책.

### AVD 이미지 선택 가이드

| 이미지 태그 | 미디어 코덱 | tapflow 권장 |
|---|---|---|
| `google_apis_playstore` | `c2.android.avc.encoder` — crash 발생 | ❌ |
| `google_apis` | 안정적, H.264 정상 동작 | ✅ |
| `default` (AOSP) | 최소 구성 | - |

Apple Silicon: `system-images;android-34;google_apis;arm64-v8a` 사용.

### 인코더 목록 확인 커맨드

```bash
adb push scrcpy-server.jar /data/local/tmp/scrcpy-server.jar
adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
  app_process / com.genymobile.scrcpy.Server 3.1 \
  scid=00000000 list_encoders=true video=true audio=false control=false &
sleep 2
adb logcat -d | grep -i "encoder\|scrcpy"
```

---

## Issue 2 — macOS 윈도우 오클루전으로 인한 FPS 저하 (2026-05-18 해결)

### 핵심 결론 (먼저 읽어라)

`-no-window -gpu host` 조합으로 에뮬레이터를 기동하면 해결된다.  
에뮬레이터 창이 없으면 macOS가 오클루전 상태를 판정할 대상이 사라지고,  
`-gpu host`는 `-no-window`와 함께 써도 Metal 가속을 그대로 유지한다.

```bash
emulator -avd <name> -no-window -gpu host -no-audio -no-snapshot
```

검증:
```bash
adb shell getprop ro.hardware.egl     # "emulation" → goldfish GL (host Metal), SwiftShader 아님
adb shell getprop debug.hwui.renderer # "skiagl"    → 정상 가속 상태
```

---

### 증상

- 에뮬레이터 창이 브라우저 창 뒤에 완전히 가려지면 수십 초 내로 FPS가 7~9 수준으로 떨어짐
- 브라우저와 에뮬레이터를 나란히 놓으면(side-by-side) FPS 저하 없음
- 에뮬레이터를 직접 터치하면 FPS가 일시 회복
- idle과는 무관 — 에뮬레이터 화면이 바뀌지 않아도 가려지지만 않으면 정상

### 근본 원인

macOS는 `NSWindowOcclusionState` API를 통해 완전히 가려진 윈도우의 GPU 렌더링을 의도적으로 스로틀링한다. 에뮬레이터(QEMU)가 Metal swap buffer / vsync에 동기화되어 있으므로:

```
macOS Metal 콜백 감소
  → QEMU Choreographer VSYNC 슬로우다운
    → SurfaceFlinger 60Hz 유지 불가
      → scrcpy MediaCodec에 도달하는 프레임 수 감소
```

이것은 scrcpy 문제도, 인코더 문제도 아니다. **QEMU가 창이 가려졌을 때 프레임을 덜 만든다**는 설계 충돌이다.

### 시도했지만 실패한 방법들

| 접근 | 결과 | 이유 |
|---|---|---|
| `event tap 0 0` (emulator 콘솔 keepalive, 3초마다) | **화면 동결** 부작용 | scrcpy 터치 입력 파이프라인과 충돌 |
| `repeat-previous-frame-after:long=33333` codec 옵션 | 효과 없음 | SurfaceFlinger 프레임 부재를 인코더 레이어에서 해결 불가 |
| `stay_awake=true` (이미 적용 중) | 효과 없음 | 디스플레이 sleep과 별개 문제 |
| `-gpu swiftshader_indirect` (SW 렌더링) | 너무 느림 | CPU 전용, Metal 미사용 |
| 윈도우 off-screen 이동, minimize | 효과 없음 | macOS가 동일하게 occluded로 처리 |

### macOS 오클루전의 특성 (중요)

Apple 공식 문서에 따르면 다음은 **모두 occluded로 처리**된다:
- 다른 창에 완전히 가려진 경우
- Dock으로 최소화된 경우
- 다른 Space(데스크탑)에 있는 경우
- 화면 밖 좌표로 이동한 경우

`NSWindowOcclusionState`는 **read-only**이므로 외부에서 강제로 "항상 visible" 상태로 만들 수 없다.

### 왜 `-no-window -gpu host`가 작동하는가

- `-no-window`: 에뮬레이터가 macOS 창을 생성하지 않음 → 오클루전 판정 대상 자체가 없어짐
- `-gpu host`: Metal 하드웨어 가속 유지 (금속 렌더링이 창의 swap과 분리되어 계속 동작)

**흔한 오해**: "`-no-window`를 쓰면 자동으로 SwiftShader로 전환된다."  
→ 오래된 emulator(v28.x 이전)의 동작이 입소문으로 퍼진 것. 최신 emulator(v33+)에서는 거짓.

### Code

`EmulatorLauncher.ts` — `launch()` 메서드:

```typescript
const proc = spawn(getEmulatorPath(), [
  '-avd', avdName,
  '-no-audio',
  '-no-snapshot',
  '-no-window',   // macOS 오클루전 회피
  '-gpu', 'host', // Metal 가속 유지
], { detached: true, stdio: 'ignore' })
```

### 리서치 과정에서 얻은 참고 정보

- pupil-labs는 자신들의 앱(PyOpenGL)에서 동일 증상을 `glfw.swap_interval(0)` 한 줄로 해결했다. QEMU/emulator에 같은 패치를 적용하려면 소스 fork가 필요하고 그 비용 대비 `-no-window`가 훨씬 현실적이다.
- Google의 `android-emulator-webrtc`(gRPC + WebRTC로 emulator 스트리밍)는 2025년 9월 archive 처리됐고, 처음부터 Linux + NVIDIA 전용이었다. Google조차 macOS에서 이 문제를 해결하지 않고 Linux로 회피한 것.
- `NSWindowOcclusionState`를 끄는 plist 키나 system API는 존재하지 않는다 (Apple 의도적 설계).
- `-gpu angle_indirect`, `-gpu auto-no-window` 등은 macOS에서 미지원이거나 존재하지 않는 옵션이다.
---

## Issue 3 — 디바이스 회전 시 scrcpy 스트림 해상도 변경 (2026-05-24 해결)

### 핵심 결론

`capture_orientation=@0` 서버 옵션을 추가해 스트림을 portrait로 고정한다.
디바이스가 회전해도 스트림 해상도가 변하지 않으므로 대시보드는 CSS rotation만으로 landscape 뷰를 전환할 수 있다.

```typescript
// ScrcpySession.ts — scrcpy 서버 인수
'capture_orientation=@0',  // lock stream to portrait
```

### 원인

`sdk_gphone64_arm64` (google_apis/arm64-v8a, android-34) AVD에서 디바이스를 회전하면 scrcpy 스트림 해상도가 실시간으로 바뀐다.

```
rotation 0 → 1: stream 1080×2400 → 2400×1080  (H.264 SPS 변경 + 디코더 재초기화)
rotation 1 → 2: stream 2400×1080 → 1080×2400
rotation 2 → 3: stream 1080×2400 → 2400×1080
```

이 때문에:
- `videoSize` 상태가 비동기로 업데이트 → 스킨 프레임 방향과 스트림 방향이 잠깐 불일치
- rotation=2(upside-down portrait)에서 스트림이 landscape로 유지 → portrait 프레임 안에 landscape 스트림 → letterbox 발생

### `capture_orientation=@0`의 동작 원리

scrcpy 서버가 display orientation을 0(portrait)으로 고정한다. 물리 회전은 Android 시스템이 감지하지만, 스크린 렌더링은 portrait 기준으로 유지되므로 스트림 해상도가 변하지 않는다.

scrcpy는 회전 이벤트(`DEVICE_MSG_TYPE_ROTATION_CHANGED`)는 여전히 물리 회전 기준으로 전송하므로 대시보드가 현재 방향을 정확히 알 수 있다.

### 스킨 렌더링 단순화 (iOS 패턴 통일)

스트림이 항상 portrait로 고정되면, iOS viewer와 동일한 방식으로 렌더할 수 있다:
- composite(back.webp) 전체를 portrait 기준으로 유지
- landscape 전환 시 inner div에 `rotate(90deg)` CSS 한 줄
- canvas 위치: `skinScreenRect`의 퍼센트 기반 좌표 (픽셀 계산 불필요)

### 회전 방향 선택 — landscape(3) 고정

`capture_orientation=@0` 적용 후 CSS `rotate(90deg)` CW가 scrcpy 보정과 상쇄되는 방향은 `rotation=3`(CW landscape)이다. `rotation=1`(CCW landscape)에서는 scrcpy 보정 방향이 반대라 CSS rotation을 더하면 180° 뒤집힘이 발생한다.

따라서 rotate 버튼은 **portrait(0) ↔ landscape(3)** 2방향 토글로 구현한다:

```typescript
// AndroidAgent.ts
const target = isLandscape ? 0 : 3
this.adb.disableAutoRotate(serial)       // accelerometer_rotation=0
this.adb.setUserRotation(serial, target) // user_rotation=0 or 3
```

### 관련 코드

| 파일 | 변경 |
|------|------|
| `android-agent/src/scrcpy/ScrcpySession.ts` | `capture_orientation=@0` 추가 |
| `android-agent/src/AdbWrapper.ts` | `disableAutoRotate`, `setUserRotation` 추가 |
| `android-agent/src/AndroidAgent.ts` | `input:rotate` → 0↔3 토글 |
| `dashboard/components/device/AndroidViewer.tsx` | 스킨 모드 iOS 패턴으로 단순화 |

---

## Issue 4 — status bar 양끝 잘림: CSS border-radius / back.webp 이중 레이어 한계 (2026-05-25 분석 완료)

### 핵심 결론

`mask.webp`를 스크린 영역에 CSS `mask-image`(또는 `<img>` 오버레이)로 적용해야 한다. `corner_radius` 기반 CSS border-radius는 근본 해결책이 아니다. 구현 계획: `.work/2026-05-25-android-skin-mask-plan.md`.

### 증상

1. **canvas에 `border-radius: skinCornerRadiusCss` 적용 상태**: status bar 우측 wifi/배터리 아이콘이 canvas의 곡률 클리핑에 잘림. 좌측 시간도 일부 잘림.
2. **canvas border-radius 제거 시도**: 우측 아이콘은 보임. 그러나 좌측 시간은 여전히 `.32`처럼 앞 글자가 잘림.

### 잘못된 가정

**Phase 2 구현 시 판단**: `mask.webp` 기반 `corner_radius` 자동 감지로 충분 → **틀렸음**.

실제로 두 가지 문제가 겹쳐 있었다:

1. **canvas CSS border-radius** → canvas DOM element를 직접 클리핑하므로, status bar 모서리 픽셀이 잘림. 실제 Android OS는 `WindowInsets`로 앱 콘텐츠를 모서리 곡률 안쪽으로 inset 시키므로 화면이 잘리지 않는다. 에뮬레이터는 직사각형 화면 인식이라 inset 없음 → CSS 클리핑이 이 차이를 부각.

2. **back.webp 이중 레이어(zIndex 5) 오버레이** → 동일한 composite back.webp를 canvas 위에 한 번 더 깔아 canvas 가장자리 아티팩트를 가린다. 그런데 back.webp 자체의 불투명 베젤이 스크린 좌상단 모서리(시계 아이콘 영역)를 살짝 덮는다.

### `corner_radius=87`의 정확한 의미

공식 스킨 파일 포맷(ANDROID-SKIN-FILES.TXT)과 실제 스킨 파일 분석 결과:

- `corner_radius`는 **외부 유리(outer glass)의 곡률 힌트** — display 경계의 inner corner radius가 아님.
- 오래된 에뮬레이터의 화면 클리핑 fallback 용도. 실제 Android Studio는 이것으로 클리핑하지 않는다.
- `Pixel_6` 스킨: rounded 스크린이지만 `corner_radius` 속성이 없음 → 이 값이 주된 마스킹 메커니즘이 아님을 직접 증명.

### `mask.webp`의 정확한 의미

```
mask.webp (신형 스킨 구조):
  - 크기: display 해상도 (예: Pixel 9 = 1080 × 2424)
  - 내용: 불투명(검정) 베젤 + 투명 스크린 영역 + 투명 카메라 펀치홀
  - 위치: composite에서 스크린 영역(screenPctLeft, screenPctTop)에 1:1 오버레이
```

**back.webp와의 역할 분리**:
- `back.webp` (composite 크기: 1198×2531) = 디바이스 외형(베젤, 버튼, 프레임)
- `mask.webp` (display 크기: 1080×2424) = 스크린 경계의 정밀 마스킹 (카메라 홀, 모서리 곡률)

### Android Studio가 이 문제를 회피하는 방법

Android Studio 에뮬레이터 창 렌더링 파이프라인:
1. `back.webp` → OpenGL 텍스처로 그림 (composite 크기)
2. 스크린 OpenGL 뷰포트에 에뮬레이터 프레임버퍼 직접 렌더
3. `mask.webp` → OpenGL 알파 마스크로 스크린 영역에 합성

CSS `border-radius`를 사용하지 않음 → 클리핑 없음. `mask.webp`의 알파 채널이 곡률 마스킹을 정확히 처리.

### 올바른 해결 방법

**canvas `border-radius` 제거** + **second back.webp 제거** + **mask.webp를 스크린 영역에 오버레이**:

```tsx
// 현재 (잘못된 구현)
<canvas style={{ borderRadius: skinCornerRadiusCss }} />
<img src={back.webp} style={{ zIndex: 5 }} />  {/* second overlay hack */}

// 올바른 구현
<canvas />  {/* border-radius 없음 */}
<img
  src={`data:image/webp;base64,${skinMaskPng}`}
  style={{
    position: 'absolute',
    left: `${screenPctLeft}%`, top: `${screenPctTop}%`,
    width: `${screenPctW}%`,  height: `${screenPctH}%`,
    zIndex: 5,
  }}
/>
```

### 변경이 필요한 파일

| 파일 | 변경 내용 |
|------|-----------|
| `android-agent/src/SkinLoader.ts` | `mask.webp` 파일 읽기 → base64 |
| `dashboard/lib/types.ts` | `AndroidChrome`에 `skinMaskPng?: string` 추가 |
| `android-agent/src/AndroidAgent.ts` | `session:chrome` 페이로드에 `skinMaskPng` 포함 |
| `dashboard/components/device/DeviceViewer.tsx` | `skinMaskPng` prop 전달 |
| `dashboard/components/device/AndroidViewer.tsx` | canvas `borderRadius` 제거, second back.webp → mask.webp 오버레이 교체 |
