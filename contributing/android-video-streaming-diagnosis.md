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

### 대안 접근 (만약 `-no-window`가 요구사항과 충돌할 경우)

emulator gRPC API의 `streamScreenshot` RPC를 사용해 scrcpy를 완전히 대체하는 방법이 있다. emulator 프로세스 내부에서 프레임을 직접 생성하므로 SurfaceFlinger의 vsync 경로를 우회할 가능성이 있다. 검증은 아직 미진행.

---

## Issue 3 — SDK 스킨 오버레이 시도 및 롤백 (PR #110 → revert PR #113)

### 결론

Android SDK 스킨(`back.webp` + `mask.webp`)을 디바이스 프레임 오버레이로 렌더링하는 작업을 시도했으나 **`google_apis` 에뮬레이터의 구조적 한계**로 인해 전면 롤백했다.

**핵심**: 어떤 코너 마스킹 방식을 써도 status bar 아이콘이 잘린다. 코드 문제가 아닌 에뮬레이터 이미지 한계다.

### 근본 원인

실제 Pixel 디바이스 펌웨어는 SurfaceFlinger에 `ro.surface_flinger.rounded_corner_radius`를 설정해 Android OS가 화면 모서리 곡률을 인식하게 한다. SystemUI(status bar)는 `WindowInsets.getRoundedCorner()`로 이 값을 읽어 아이콘·시간 표시를 모서리 안쪽으로 자동 inset한다.

`google_apis/arm64-v8a` 에뮬레이터 이미지에는 이 프로퍼티가 없다. 따라서:

```
에뮬레이터 프레임버퍼 → SystemUI가 rounded corner inset 없이 status bar를 직사각형 기준으로 그림
→ WiFi·배터리·시계가 화면 최외각 모서리에 위치
→ 어떤 코너 마스킹(border-radius / mask.webp / back.webp 오버레이)을 씌워도 해당 픽셀이 가려짐
```

Android Studio 단독 에뮬레이터 창(`emulator` 바이너리)도 같은 스킨을 씌우면 동일하게 잘린다.

### 시도했지만 실패한 수정 방법

| 방법 | 결과 |
|---|---|
| `adb shell settings put secure sysui_rounded_size 87` | 무시됨 — `google_apis` 이미지에서 sysui secure setting이 적용되지 않음 |
| `adb shell settings put secure sysui_rounded_content_padding 24` | 동일하게 무시됨 |
| `adb shell am crash com.android.systemui` (SystemUI 재시작) | SystemUI가 재시작되어도 설정값 반영 없음 |
| `adb shell settings put secure sysui_display_cutout corner` (Display Cutout 시뮬레이션) | 카메라 노치 시뮬레이션용 설정으로 rounded corner inset과 무관, 효과 없음 |
| `stop surfaceflinger && start surfaceflinger` (**금지**) | 에뮬레이터 부팅 루프 발생 — 절대 실행하지 말 것 |

### 왜 스킨 없이도 괜찮은가

- scrcpy(데스크탑), Genymotion 등 대부분의 에뮬레이터 미러링 도구는 디바이스 프레임을 기본 제공하지 않는다.
- tapflow는 QA 도구이므로 status bar 가시성이 디바이스 외형 연출보다 중요하다.
- scrcpy 스트림 자체는 원시 직사각형 프레임버퍼이며 코너 마스킹은 표시 레이어의 순수 시각 효과다.

### 향후 재시도 조건

`google_apis` 이미지가 `ro.surface_flinger.rounded_corner_radius`를 설정하도록 AOSP/Google이 업데이트하거나, SystemUI에 rounded corner inset을 외부에서 주입하는 공식 방법이 생기면 재검토할 수 있다.
