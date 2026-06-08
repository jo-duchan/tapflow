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
에이전트는 릴레이로 영상 프레임을 지속적으로 전송합니다. 최적의 스트리밍 품질을 위해 에이전트와 릴레이를 같은 Mac 또는 같은 LAN에서 실행하세요. 서로 다른 네트워크에 연결하면 레이턴시가 높아지고 프레임 드롭이 발생할 수 있습니다.
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
  ✓ Xcode 16.2
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

tapflow는 세 가지 프로파일 중 하나로 스트리밍합니다. 사용자가 직접 고르는 것이 아니라, 각 시청자가 어떻게 접속했는지에 따라 에이전트가 해상도와 디코더 부하의 균형을 맞춰 프로파일을 자동으로 선택합니다.

| 프로파일 | 연결 유형 | 해상도 | 디코더 | 체감 |
|---------|-----------|--------|--------|------|
| **Standard** *(권장)* | LAN + HTTP | 1280px | WASM (tinyh264) | localhost에 준하는 반응 속도 |
| **Sharp** | LAN + HTTPS *(또는 localhost)* | 원본 해상도 | WebCodecs (하드웨어) | localhost급 |
| **Remote** | 외부 + HTTPS | 1000px | WebCodecs (하드웨어) | QA 가능한 임계 수준 |

**Standard**는 대부분의 팀이 일상적으로 쓰는 환경으로, LAN의 평문 HTTP 릴레이입니다. 브라우저가 WASM 소프트웨어 디코더로 H.264를 디코딩하기 때문에, tapflow는 디코딩 부하를 낮게 유지하면서도 반응 속도를 localhost에 가깝게 유지하기 위해 해상도를 1280px로 제한합니다.

**Sharp**는 tapflow가 제공할 수 있는 가장 나은 환경입니다. [secure 컨텍스트](https://developer.mozilla.org/ko/docs/Web/Security/Secure_Contexts)(LAN의 HTTPS 또는 localhost)에서는 브라우저가 WebCodecs를 사용할 수 있어 하드웨어로 디코딩하므로, 에이전트가 낮은 CPU 부하로 원본 해상도를 전송합니다. 공유 LAN을 Standard에서 Sharp로 올리려면 **릴레이를 HTTPS로 제공**하세요 — [릴레이 배포](/ko/guide/self-hosting) 참고.

**Remote**는 LAN 외부(공인 IP)에서 접속하는 시청자를 위한 환경입니다. HTTPS이므로 하드웨어 디코딩은 유지되지만, 대역폭이 제한적이라 해상도를 1000px로 낮춥니다. QA에는 충분하지만 쾌적함의 경계 수준입니다.

::: tip HTTPS가 하드웨어 디코딩을 여는 이유
WebCodecs는 [secure 컨텍스트](https://developer.mozilla.org/ko/docs/Web/Security/Secure_Contexts)에서만 사용할 수 있습니다. LAN의 평문 HTTP는 secure가 아니므로 브라우저가 WASM 디코더로 폴백합니다. 그래서 **Standard**는 해상도를 제한하고, **Sharp**(HTTPS)는 제한하지 않습니다.
:::

### 환경변수 오버라이드

프로파일은 자동으로 선택되지만, 해상도 제한값은 직접 재정의할 수 있습니다. 에이전트가 실행되는 Mac에서 아래 환경변수를 설정하세요.

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| `TAPFLOW_MAX_SIZE` | *(프로파일별)* | 전 플랫폼 공통 해상도 제한 (px, 가장 긴 변). `0`으로 설정하면 모든 연결에서 원본 해상도를 강제합니다. |
| `TAPFLOW_MAX_SIZE_LAN` | `1280` | Standard(LAN HTTP) 제한값 |
| `TAPFLOW_MAX_SIZE_EXTERNAL` | `1000` | Remote(외부) 제한값 |
| `TAPFLOW_IOS_MAX_SIZE` | *(프로파일별)* | iOS 전용 오버라이드. `TAPFLOW_MAX_SIZE`보다 우선 적용됩니다. |
| `TAPFLOW_ANDROID_MAX_SIZE` | *(프로파일별)* | Android 전용 오버라이드. `TAPFLOW_MAX_SIZE`보다 우선 적용됩니다. |
