# 시스템 요구사항

## 릴레이 서버

- Node.js ≥ 20
- macOS 또는 임의 서버 OS (릴레이는 트래픽 라우팅만 담당)
- RAM 512MB, vCPU 1개로 충분

## iOS 에이전트

- **macOS 필수** — Apple 정책상 iOS 시뮬레이터는 macOS에서만 실행됩니다
- iOS Simulator Runtime이 설치된 Xcode
- Node.js ≥ 20

## Android 에이전트

- macOS
- Android SDK (`adb`가 `$PATH`에 있거나 `ANDROID_HOME` 설정)
- `google_apis/arm64-v8a` 시스템 이미지 (android-34)를 사용하는 AVD
- Node.js ≥ 20

## 브라우저 (QA)

- 최신 브라우저 (Chrome, Firefox, Safari, Edge)
- 별도 확장 프로그램 불필요
