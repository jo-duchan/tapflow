# Android 에이전트 설정

Android 에이전트는 ADB와 scrcpy를 사용해 에뮬레이터 화면을 스트리밍합니다.

## 사전 요구사항

- Android SDK 설치 (`ANDROID_HOME` 설정 또는 `adb`가 `$PATH`에 있어야 함)
- `google_apis/arm64-v8a` 시스템 이미지 (android-34)를 사용하는 AVD

::: warning AVD 이미지 선택이 중요합니다
`google_apis/arm64-v8a`를 사용하세요. **`google_apis_playstore` 이미지는 사용하지 마세요.** Play Store 이미지는 H.264 인코더가 조용히 크래시합니다.
:::

## AVD 생성

```sh
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n Pixel_8 -k "system-images;android-34;google_apis;arm64-v8a"
```

## 에이전트 시작

```sh
tapflow agent start --platform android --relay wss://your-relay-url
```

에이전트가 에뮬레이터를 자동으로 부팅하고, `sys.boot_completed`를 기다린 뒤 스트리밍을 시작합니다.

iOS와 Android 에이전트를 함께 시작하려면:

```sh
tapflow agent start --relay wss://your-relay-url
```

## 트러블슈팅

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
