# Android 비디오 스트리밍 진단 — 인사이트

> 이 문서는 Android 에뮬레이터 스트리밍 과정에서 만난 문제들의 진단·해결 기록이다. 이슈별로 섹션을 추가한다.

---

## 핵심 결론 (먼저 읽어라)

scrcpy 방식 자체는 **옳다.** 문제는 특정 AVD 이미지(`google_apis_playstore/arm64-v8a`)에서  
`c2.android.avc.encoder`가 크래시하는 것이고, 이는 AVD 환경 문제이지 아키텍처 한계가 아니다.

---

## 진단 과정

### 1단계 — 증상 관찰

- `screenrecord --output-format=h264 -`: ~200ms 만에 종료, 영상 없음
- scrcpy 서버 소켓 연결은 성공했지만 비디오 프레임 수신 불가
- 대시보드에서 "Starting device..." 고착

### 2단계 — 로그 분석

```
Abort message: 'Codec2BufferUtils.cpp:214] Check failed: (src.width() & 1) == 0'
E CCodec: Codec2 component "c2.android.avc.encoder" died.
E MediaCodec: Codec reported err 0xffffffe0
W ScreenRecord: dequeueOutputBuffer returned INVALID_OPERATION
```

`c2.android.avc.encoder`가 abort 후 죽는다.  
exit code 218 (`Encoder failed (err=-38)`).

### 3단계 — 인코더 목록 확인 (scrcpy 서버 `list_encoders=true`)

```
Device: [unknown] Android Android SDK built for arm64 (Android 9)
List of video encoders:
    --video-codec=h264 --video-encoder=c2.android.avc.encoder
```

**비디오 인코더가 하나뿐이고, 그 하나가 죽는다.**  
H.265, AV1, VP9 인코더 없음.

### 4단계 — AVD 식별

대상 에뮬레이터가 Android 9 (API 28)로 인식됐다.  
실제로 연결된 에뮬레이터는 `flutter_emulator` (API 28, `android-28/google_apis_playstore/arm64-v8a`).  
`Galaxy_S23_API_35` (API 35, `android-35/google_apis_playstore/arm64-v8a`)는 다른 포트에서 실행 중이었다.

---

## `c2.android.avc.encoder`는 무엇인가

| 항목 | 내용 |
|---|---|
| 전체 이름 | Codec2 framework 기반 소프트웨어 H.264 인코더 |
| 하드웨어인가 | **아니다.** `c2.android.*`은 AOSP 소프트웨어 구현 (libavc 기반) |
| ARM64 가상화와의 관계 | **직접 없다.** 소프트웨어 인코더이므로 CPU에서 실행되며 ARM64에서 이론상 작동 |
| 크래시 원인 | 그래픽 버퍼 홀수 너비 체크 실패(`src.width() & 1 == 0`) 또는 SurfaceControl 내부 상태 불일치 |

---

## scrcpy FAQ의 동일 에러

공식 FAQ에 이 에러가 명시되어 있다:

> `java.lang.IllegalStateException at android.media.MediaCodec.native_dequeueOutputBuffer(Native Method)`  
> → **"then try with another encoder"**

즉, 알려진 문제이며 해결책은 **다른 인코더 사용**이다.  
하지만 이 AVD에는 대안 인코더가 없다 → AVD 이미지 교체가 필요하다.

---

## AVD 이미지 선택 가이드

| 이미지 태그 | 특징 | 미디어 코덱 |
|---|---|---|
| `google_apis_playstore` | Google Play 포함. AVD Manager 기본 추천. | 불안정할 수 있음 (진단 결과) |
| `google_apis` | Play Store 없음. 시스템 API 완전 지원. | 더 안정적 (검증 예정) |
| `default` (AOSP) | 구글 서비스 없음. 최소 구성. | 미디어 스택 최소화 |

**scrcpy 연동 목적이라면 `google_apis/arm64-v8a` 권장.**

---

## scrcpy 서버 인코더 목록 확인 방법

```bash
# 서버를 에뮬레이터에 push
adb push scrcpy-server.jar /data/local/tmp/scrcpy-server.jar

# list_encoders=true로 실행 (logcat에서 결과 확인)
adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
  app_process / com.genymobile.scrcpy.Server 3.1 \
  scid=00000000 list_encoders=true video=true audio=false control=false &

sleep 2
adb logcat -d | grep -i "encoder\|scrcpy"
```

---

## screenrecord vs scrcpy 방식 비교

| 기준 | screenrecord | scrcpy |
|---|---|---|
| 인코더 | 내부 MediaProjection → MediaCodec (H.264 고정) | SurfaceControl → MediaCodec (코덱 선택 가능) |
| 코덱 선택 | 불가 (`--size`만 가능) | `video_codec=h264/h265/av1` 선택 가능 |
| 대안 코덱 | **없음** → H.264 실패하면 끝 | H.265, AV1 폴백 가능 |
| 지연 | 높음 (~1-2s, 파일 경유) | 낮음 (소켓 직접 스트림) |
| 재연결 | 매번 새 프로세스 | 세션 유지 가능 |
| **결론** | 코덱 실패 시 탈출구 없음 | **선호해야 하는 방식** |

---

## 체크리스트 (AVD 교체 시 검증)

```bash
# 1) 인코더 목록 확인 (scrcpy 서버 list_encoders)
adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
  app_process / com.genymobile.scrcpy.Server 3.1 \
  scid=00000000 list_encoders=true video=true audio=false control=false &
sleep 2
adb logcat -d | grep "encoder\|scrcpy" | tail -20

# 2) screenrecord 직접 테스트
adb shell screenrecord --time-limit 3 /sdcard/test.mp4 2>&1
adb shell ls -la /sdcard/test.mp4   # 0바이트면 인코더 실패

# 3) scrcpy CLI 직접 테스트 (brew install scrcpy 필요)
scrcpy -s <serial> --print-fps
```

---

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

```bash
emulator -avd <name> -grpc 8554 -gpu host
# 이후 grpcurl로 streamScreenshot 호출 후 FPS 측정
```
