# 시스템 요구사항

## 릴레이 서버

- Node.js ≥ 20
- macOS 또는 모든 서버 OS (릴레이는 트래픽 라우팅만 담당)
- RAM 512MB, vCPU 1개로 충분

## 에이전트

에이전트는 macOS에서 실행됩니다. iOS와 Android를 한 Mac에서 함께 실행할 수 있습니다.

- macOS
- Node.js ≥ 20

### iOS

- iOS Simulator Runtime이 설치된 Xcode

### Android

- Android SDK (`adb`가 `$PATH`에 있거나 `ANDROID_HOME` 설정)
- `google_apis/arm64-v8a` 시스템 이미지 (android-34)를 사용하는 에뮬레이터

## 대시보드

- 최신 브라우저 (Chrome, Firefox, Safari, Edge)
- 별도 확장 프로그램 불필요
