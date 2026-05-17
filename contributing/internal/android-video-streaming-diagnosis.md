# Android 비디오 스트리밍 진단 — 인사이트

> 작성 배경: scrcpy 방식으로 전환하는 과정에서 ARM64 에뮬레이터 환경의 H.264 인코더 문제를 만나 진단한 기록.

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
