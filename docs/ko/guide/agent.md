# 에이전트 설정

에이전트는 Mac에서 실행되며 시뮬레이터·에뮬레이터 화면을 릴레이로 스트리밍합니다. 아웃바운드로 릴레이에 연결하므로 인바운드 방화벽 규칙이 필요 없습니다.

## 에이전트 시작

에이전트와 릴레이가 같은 Mac에서 실행될 때는 별도 플래그가 필요 없습니다. 포트는 `tapflow.config.json`에서 읽습니다 (기본값 `4000`):

```sh
tapflow agent start
```

릴레이가 다른 Mac에서 실행 중이라면 URL을 명시합니다. `192.168.x.x`는 릴레이 Mac의 LAN IP입니다:

```sh
tapflow agent start --relay ws://192.168.x.x:4000
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay` | `ws://localhost:[port]` | 릴레이 WebSocket URL. 포트는 `tapflow.config.json`에서 읽습니다. |
| `--device` | 부팅된 첫 번째 시뮬레이터 | iOS 시뮬레이터 이름 또는 UDID |

::: tip 에이전트와 릴레이는 같은 네트워크에 두세요
에이전트는 릴레이로 영상 프레임을 지속적으로 전송하므로, 릴레이와 같은 LAN에 안정적인 연결로 두어야 합니다 — **유선 이더넷을 권장**하며, 신호가 안정적이라면 Wi-Fi도 괜찮습니다. 서로 다른 네트워크에 연결하거나 불안정한 연결을 사용하면 레이턴시가 높아지고 프레임 드롭이 발생합니다.
:::

## iOS

### 사전 요구사항

- macOS
- iOS Simulator Runtime이 설치된 Xcode
- Node.js ≥ 20

### 시뮬레이터 확인

```sh
tapflow devices
```

### 여러 시뮬레이터 동시 사용

한 Mac에서 RAM에 따라 2–4개의 시뮬레이터를 동시에 실행할 수 있습니다. 에이전트가 사용 가능한 슬롯 수를 자동으로 보고합니다. 더 많은 시뮬레이터가 필요하다면 [Mac 리소스 확장](/ko/guide/scaling)을 참고하세요.

### 트러블슈팅

```
Common
  ✓ Node v20.x

iOS
  ✓ Xcode 26.0
  ✓ xcrun simctl
  ✓ Simulator booted: iPhone 16 Pro
```

## Android

### 사전 요구사항

- Android SDK 설치 (`ANDROID_HOME` 설정 또는 `adb`가 `$PATH`에 있어야 함)
- `google_apis/arm64-v8a` 시스템 이미지 (android-34)를 사용하는 AVD

### AVD 생성

Android Studio의 AVD Manager에서 AVD를 생성합니다. 자세한 방법은 [가상 기기 만들기 및 관리하기](https://developer.android.com/studio/run/managing-avds?hl=ko)를 참고하세요.

AVD를 생성할 때 시스템 이미지 선택에 주의하세요:

::: warning AVD 이미지 선택이 중요합니다
`google_apis/arm64-v8a` 이미지를 사용하세요. 이것이 테스트된 권장 구성입니다. `google_apis_playstore` 이미지는 테스트되지 않았으며 H.264 인코더 문제가 보고되었습니다.
:::

에이전트가 에뮬레이터를 자동으로 부팅하고, `sys.boot_completed`를 기다린 뒤 스트리밍을 시작합니다. Apple Silicon Mac의 에뮬레이터는 Mac 호스트에서 H.264 인코딩(VideoToolbox)을 수행하며, 30fps로 제한됩니다. 에뮬레이터 자체에 GPU 부하가 없습니다.

### 트러블슈팅

```sh
tapflow doctor
# Common
#   ✓ Node v20.x
#
# Android
#   ✓ adb found: /usr/local/bin/adb
#   ✓ AVD: Pixel_8 (android-34 · google_apis/arm64-v8a)
```

더 자세한 문제 해결 방법은 [문제 해결](/ko/guide/troubleshooting)을 참고하세요.

## 스트림 품질

해상도와 디코더는 각 시청자의 연결 방식에 따라 자동으로 선택됩니다 — tapflow는 각 시청자가 릴레이에 어떻게 도달하는지에 따라 **Standard**, **Sharp**, **Remote** 프로파일 중 하나로 스트리밍합니다. 프로파일과 튜닝 방법은 [스트림 품질](/ko/guide/streaming)을 참고하세요.
