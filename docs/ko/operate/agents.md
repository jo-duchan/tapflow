# 에이전트 설정

에이전트는 Mac에서 실행되며 시뮬레이터·에뮬레이터 화면을 릴레이로 스트리밍합니다. 아웃바운드로 릴레이에 연결하므로 인바운드 방화벽 규칙이 필요 없습니다.

## 에이전트 시작

에이전트와 릴레이가 같은 Mac에서 실행될 때는 별도 플래그가 필요 없습니다. 포트는 `tapflow.config.json`에서 읽습니다 (기본값 `4000`):

```sh
tapflow agent start
```

릴레이가 다른 머신에서 실행 중이라면 URL과 인증 토큰을 함께 명시합니다. `192.168.x.x`는 릴레이 머신의 LAN IP입니다. 토큰 발급 방법은 [원격 릴레이 인증](#원격-릴레이-인증)을 참고하세요:

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay` | `relay.url` 또는 `ws://localhost:[port]` | 릴레이 WebSocket URL. `ws://` 또는 `wss://`로 시작해야 합니다. 생략하면 `tapflow.config.json`의 `relay.url`(또는 `TAPFLOW_RELAY_URL`)을 쓰고 둘 다 없으면 설정 파일의 포트로 `ws://localhost`에 연결합니다. `relay.url`이 `http://`·`https://` 주소라면 에이전트가 시작을 거부하므로 `--relay`를 명시하세요. |
| `--platform` | 자동 감지 | 실행할 플랫폼: `ios`, `android`, `all`. 생략하면 이 Mac에서 쓸 수 있는 플랫폼을 모두 실행합니다. |
| `--device` | 전체 기기 | 릴레이에 노출할 기기를 이름 또는 ID가 일치하는 것으로 한정합니다. iOS 시뮬레이터와 Android AVD 모두 이름 또는 ID가 정확히 일치해야 합니다. |
| `--token` | 없음 | 원격 릴레이 인증용 `agent` 스코프 토큰. `TAPFLOW_AGENT_TOKEN` 환경변수로도 전달할 수 있습니다. |

::: tip 유선 LAN 권장
에이전트와 릴레이는 같은 유선 LAN에 두세요. Wi-Fi도 동작하지만 Mac에서는 신호 세기와 무관하게 AWDL(채널 hopping) 때문에 끊길 수 있습니다. 원인과 완화법은 [스트림 지연·끊김](/ko/troubleshooting/streaming#stream-lag)을 참고하세요.
:::

## 원격 릴레이 인증

에이전트가 같은 머신의 릴레이(`localhost`)에 연결할 때는 인증이 필요 없습니다. 릴레이가 다른 머신에서 실행 중이라면 `agent` 스코프 토큰을 제시한 에이전트만 받아들입니다. 같은 네트워크의 임의 기기가 에이전트로 위장해 테스트 세션에 화면을 공급하는 것을 막기 위한 보호 장치입니다.

릴레이는 릴레이 포트에 loopback으로 들어온 연결만 인증 없이 받고, 나머지 모든 연결에는 인증을 요구합니다. 이 섹션은 그중 에이전트 쪽을 다룹니다. 같은 Mac을 LAN 주소로 접속하면 원격으로 취급되고, 터널 클라이언트도 마찬가지입니다. 터널 클라이언트는 다른 사람을 대신해 loopback으로 연결하므로, 인증이 반드시 필요한 별도의 터널 포트를 씁니다. 브라우저가 사무실 밖에서 릴레이에 접근하는 방법(터널)은 [외부 접속](/ko/operate/external-access)을 참고하세요.

### 토큰 발급

대시보드에서 **Settings → Tokens → New token**으로 이동해 Type을 **Agent**로 선택하고 토큰을 생성합니다. `agent` 스코프 토큰은 Admin 권한이 있는 계정만 발급할 수 있고 발급한 팀원이 Admin이 아니게 되거나 팀에서 제거되면 더 이상 쓸 수 없습니다. 그때 이 토큰으로 연결된 에이전트는 바로 끊기므로 현재 Admin이 새 토큰을 발급해야 합니다. 생성 직후 화면에 에이전트 실행 커맨드가 함께 표시되므로 그대로 복사해 에이전트 머신에서 실행하면 됩니다.

### 토큰 전달

`--token` 플래그로 전달합니다:

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

셸 히스토리에 토큰을 남기고 싶지 않다면 `TAPFLOW_AGENT_TOKEN` 환경변수를 사용합니다. 둘 다 지정하면 플래그가 우선합니다:

```sh
export TAPFLOW_AGENT_TOKEN=tflw_pat_xxxxxxxx
tapflow agent start --relay ws://192.168.x.x:4000
```

토큰 없이(또는 만료·폐기된 토큰으로) 원격 릴레이에 연결하면 에이전트는 거부 사유와 발급 절차 안내를 출력하고 종료합니다.

## iOS

### 사전 요구사항

- macOS
- iOS Simulator Runtime이 설치된 Xcode
- Node.js ≥ 22

### 시뮬레이터 확인

```sh
tapflow devices
```

### 여러 시뮬레이터 동시 사용

한 Mac에서 RAM에 따라 2–4개의 시뮬레이터를 동시에 실행할 수 있습니다. 에이전트가 사용 가능한 슬롯 수를 자동으로 보고합니다. 더 많은 시뮬레이터가 필요하다면 [Mac 리소스 확장](/ko/operate/scaling)을 참고하세요.

### 트러블슈팅

```
  ✓  Node v22.x
  ✓  Port 4000

  iOS
  ✓  Xcode 26.0
  ✓  xcrun simctl
  ✓  Simulator available (8)
  …
```

## Android

### 사전 요구사항

- Android SDK 설치 (`ANDROID_HOME` 설정 또는 `adb`가 `$PATH`에 있어야 함)
- `google_apis/arm64-v8a` 시스템 이미지 (android-35)를 사용하는 AVD

### AVD 생성

`tapflow setup android`가 android-35 `google_apis/arm64-v8a` 이미지로 폼팩터별 AVD 4개(`tapflow-compact`, `tapflow-phone`, `tapflow-large`, `tapflow-tablet`)를 만듭니다. 자세한 내용은 [환경 준비](/ko/operate/environment-setup)를 참고하세요. AVD를 직접 만들려면 Android Studio의 AVD Manager를 쓰세요. 방법은 [가상 기기 만들기 및 관리하기](https://developer.android.com/studio/run/managing-avds?hl=ko)를 참고하세요.

AVD를 직접 만들 때는 시스템 이미지 선택에 주의하세요:

::: warning AVD 이미지 선택이 중요합니다
`google_apis/arm64-v8a` 이미지를 사용하세요. 이것이 테스트된 권장 구성입니다. `google_apis_playstore` 이미지는 테스트되지 않았으며 H.264 인코더 문제가 보고되었습니다.
:::

에이전트가 에뮬레이터를 자동으로 부팅하고, `sys.boot_completed`를 기다린 뒤 스트리밍을 시작합니다. Apple Silicon Mac의 에뮬레이터는 Mac 호스트에서 H.264 인코딩(VideoToolbox)을 수행하며, 기본 30fps로 제한됩니다(`TAPFLOW_ANDROID_FPS`로 변경 가능). 에뮬레이터 자체에 GPU 부하가 없습니다.

### 트러블슈팅

```sh
tapflow doctor
#   ✓  Node v22.x
#   ✓  Port 4000
#
#   Android
#   ✓  Android SDK: /Users/you/Library/Android/sdk
#   ✓  adb found: /Users/you/Library/Android/sdk/platform-tools/adb
#   ✓  aapt (build-tools): /Users/you/Library/Android/sdk/build-tools/35.0.0/aapt
#   ✓  AVD available: tapflow-compact
#   ✓  Lean mode (Android): off
```

더 자세한 문제 해결 방법은 [문제 해결](/ko/troubleshooting)을 참고하세요.

## 스트림 품질

해상도와 디코더는 각 시청자의 연결 방식에 따라 자동으로 선택됩니다 — tapflow는 각 시청자가 릴레이에 어떻게 도달하는지에 따라 **Standard**, **Smooth**, **Remote** 프로파일 중 하나로 스트리밍합니다. 프로파일과 튜닝 방법은 [스트림 품질](/ko/operate/streaming-quality)을 참고하세요.

## 호스트 디스플레이와 절전

에이전트가 연결돼 있는 동안에는 macOS 전력 어서션을 잡아 세션 중에 호스트가 잠들지 않게 합니다. 기본값은 디스플레이까지 깨어 있게 유지합니다(`caffeinate -di`). 디스플레이가 꺼지면 macOS가 GPU를 저전력으로 묶어 시뮬레이터 렌더와 인코딩을 늦추고 이게 스트림이 느려지는 원인이 됩니다. 에이전트를 돌린다는 건 그 Mac을 tapflow 전용으로 쓰는 셈이라 이를 기본으로 둡니다.

`TAPFLOW_ALLOW_DISPLAY_SLEEP=1`으로 디스플레이가 평소처럼 꺼지게 둘 수 있습니다(시스템 절전은 여전히 막습니다).
