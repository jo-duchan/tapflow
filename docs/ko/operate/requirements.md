# 시스템 요구사항

## 릴레이 서버

- Node.js ≥ 22
- macOS 또는 모든 서버 OS (릴레이는 트래픽 라우팅만 담당)
- RAM 512MB, vCPU 1개로 충분

## 에이전트

에이전트는 macOS에서 실행됩니다. iOS와 Android를 한 Mac에서 함께 실행할 수 있습니다. Android만 쓴다면 Windows에서도 실행할 수 있습니다([Windows](#windows)).

- **Apple Silicon**(M 시리즈) macOS
- Node.js ≥ 22

::: warning Intel Mac은 지원하지 않습니다
에이전트가 함께 배포하는 네이티브 헬퍼 바이너리가 arm64 전용이라 Intel(x86_64) Mac에서는 실행되지
않습니다. 빌드를 열면 `spawn unknown error`라는 모호한 오류가 납니다.

tapflow가 개발과 검증에 사용해온 환경이 Apple Silicon입니다. Intel 지원은 가능하고
[#464](https://github.com/jo-duchan/tapflow/issues/464)에서 다루고 있지만 아직 예정에 없습니다.
유니버설 빌드가 필요하고, 메인테이너가 갖고 있지 않은 하드웨어에서 검증해야 합니다.

릴레이에는 이 제약이 없습니다. **에이전트**를 실행하는 머신만 Apple Silicon이어야 합니다.
:::

### iOS

- macOS 26 (26.x) 또는 27 (27.x)
- iOS Simulator Runtime이 설치된 Xcode 26 (26.x) 또는 27 (27.x)

::: tip 새 버전 지원
새로운 메이저 버전(예: Xcode 28)이 출시되면 버전 지원을 최우선으로 작업합니다. 지원이 추가되기 전까지는 위 검증된 버전을 사용해 주세요.
:::

### Android

- Android SDK (`adb`가 `$PATH`에 있거나 `ANDROID_HOME` 설정)
- `google_apis/arm64-v8a` 시스템 이미지 (android-35)를 사용하는 에뮬레이터

### Windows (Android만) {#windows}

Android 에뮬레이터만 쓴다면 에이전트를 Windows에서도 실행할 수 있습니다. 외부 기여로 추가된 커뮤니티 지원이며 메인테이너는 Windows에서 테스트하지 않습니다.

- `tapflow doctor`는 `ANDROID_HOME`과 `%LOCALAPPDATA%\Android\Sdk`에서 Android SDK를 찾습니다.
- `tapflow setup android`는 macOS에서만 동작합니다. Windows에서는 Android SDK와 에뮬레이터(AVD)를 직접 준비해야 합니다.
- iOS 시뮬레이터는 macOS에서만 실행할 수 있습니다.
- x86_64 PC에서는 AVD에 `arm64-v8a`가 아니라 `x86_64` 시스템 이미지가 필요합니다.
- Windows에서 에뮬레이터를 부팅하고 화면을 스트리밍하는 것은 아직 확인되지 않았습니다. 확인된 것은 `tapflow doctor`가 SDK와 AVD를 찾는 것, 그리고 `tapflow start`로 릴레이가 뜨고 에이전트가 등록되는 것까지입니다.

## 대시보드

- 최신 브라우저 (Chrome, Firefox, Safari, Edge)
- 별도 확장 프로그램 불필요

::: tip Tailscale 터널 사용 시
대시보드에 접근하는 모든 기기에 Tailscale을 설치해야 합니다. → [Tailscale 설정](/ko/operate/external-access#tailscale-권장)
:::
