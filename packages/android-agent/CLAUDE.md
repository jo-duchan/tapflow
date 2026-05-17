# android-agent — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`AndroidAgent`: ADB를 통해 Android 에뮬레이터를 제어하고, **scrcpy**로 H.264 화면을 스트리밍한다.
Mac 단일 머신에서 `ios-agent`와 함께 구동한다.

## HOW

- ADB 명령은 `AdbWrapper`로 분리, `AdbRunner` 인터페이스로 테스트 시 mock 교체 가능.
- 에뮬레이터 부팅 시 `EmulatorLauncher.waitForBoot(serial)` — `sys.boot_completed=1` polling.
- 화면 스트리밍: `ScrcpySession` → `ScrcpyVideo` — scrcpy 서버를 기기에 push·실행 후 TCP 소켓으로 H.264 Annex B 스트림 수신. AVD 이미지는 반드시 `google_apis/arm64-v8a`(android-34) 사용 — `google_apis_playstore` 이미지는 H.264 인코더가 crash한다.
- **인코더**: `OMX.google.h264.encoder`(순수 소프트웨어) 고정 사용. 기본값인 `c2.android.avc.encoder`(Codec 2.0)는 Chrome 등 GPU 프로세스가 올라올 때 가상화 GPU 레이어에서 stall — 예외 없이 조용히 멈춰서 scrcpy 서버와 pump loop 모두 감지 불가. 에뮬레이터에서는 어차피 소프트웨어 에뮬이므로 성능 차이 없음.
- scrcpy 프로토콜: video 소켓(1st) + control 소켓(2nd) 순서로 두 번 연결해야 서버가 스트리밍을 시작한다. `ScrcpyControl`은 control 소켓을 열어두는 역할과 미래 바이너리 터치 프로토콜 기반.
- 터치: scrcpy control 소켓(`ScrcpyControl.touchDown/touchMove/touchUp`) 우선 사용 — scrcpy 세션이 활성일 때 저지연 바이너리 프로토콜로 주입. scrcpy 세션이 없는 경우에만 `AndroidTouchHelper`(`adb input tap/swipe`)로 폴백.
- AVD 이름을 `Device.id`의 stable key로 사용 (`"avd:<name>"`). ADB serial은 내부 `serialMap`에만 보관.
- `ANDROID_HOME` 또는 `ADB_PATH` 환경변수 필수. 없으면 명확한 오류로 즉시 종료.
- Apple Silicon Mac: `system-images;android-34;google_apis;arm64-v8a` 이미지 필수.

## HOW NOT

- ADB 경로를 하드코딩하지 않는다 — `$ANDROID_HOME/platform-tools/adb` 또는 `$ADB_PATH`.
- 에뮬레이터 부팅 완료 확인 없이 ADB 명령을 실행하지 않는다.
- `google_apis_playstore` AVD 이미지를 사용하지 않는다 — H.264 인코더 crash.
- `video_encoder=c2.android.avc.encoder`로 되돌리지 않는다 — Chrome 등 GPU 앱에서 stall.
- `ScrcpySession.start()`에서 video 소켓만 열고 control 소켓을 생략하지 않는다 — scrcpy 프로토콜 위반으로 서버가 스트리밍을 시작하지 않는다.
- `AndroidTouchHelper` 인터페이스를 깨는 방식으로 저지연 터치를 추가하지 않는다 — 내부 구현만 교체.
- `agent-core` `DeviceAgent` 인터페이스를 Android 전용 메서드로 오염시키지 않는다.
