---
title: 빌드와 업로드
description: iOS 업로드 오류(.ipa와 .app.zip), Apple Silicon의 INSTALL_FAILED_NO_MATCHING_ABIS, Unversioned로 표시되거나 다른 앱에 병합되는 APK를 해결합니다.
---

# 빌드와 업로드

빌드 업로드가 실패하거나 업로드한 빌드가 엉뚱한 앱에 붙을 때의 해결 방법입니다.

## iOS 빌드 업로드 오류

### 업로드 시 `400` 오류

| 원인 | 해결 방법 |
|------|-----------|
| `.ipa` 파일 업로드 | `.ipa`는 실제 기기용입니다. `xcodebuild -sdk iphonesimulator`로 빌드 후 `.app` 폴더를 zip으로 압축하세요 |
| `.app`이 ZIP 루트에 없음 | 압축 해제 시 `MyApp.app`이 바로 나와야 합니다. 상위 폴더로 감싸면 파싱에 실패합니다 |
| 실기기용 슬라이스만 포함 | 시뮬레이터용 빌드인지 확인합니다. `lipo -info MyApp.app/MyApp` 출력에 `x86_64` 또는 `arm64`(시뮬레이터)가 있어야 합니다 |

## `INSTALL_FAILED_NO_MATCHING_ABIS` — Apple Silicon 에뮬레이터와 호환되지 않는 APK

```
INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113
```

Apple Silicon Mac(M1/M2/M3)의 Android 에뮬레이터는 네이티브 ARM64 환경에서 동작합니다. APK에 `arm64-v8a` ABI가 포함되어 있어야 합니다.

APK가 지원하는 ABI를 확인합니다:

```sh
aapt dump badging your-app.apk | grep native-code
```

| 결과 | 호환 여부 |
|------|-----------|
| `native-code: 'arm64-v8a'` | ✅ |
| `native-code: 'armeabi-v7a' 'arm64-v8a'` | ✅ |
| `native-code: 'armeabi-v7a' 'x86'` | ❌ |
| `native-code: 'x86' 'x86_64'` | ❌ |

`arm64-v8a`가 없다면 32비트 ARM 또는 Intel 에뮬레이터용으로 빌드된 APK입니다. 개발팀에 ABI split 설정에 `arm64-v8a`를 추가해 달라고 요청하세요.

::: details ABI 참고

| ABI | 아키텍처 | Apple Silicon 에뮬레이터 |
|-----|---------|------------------------|
| `arm64-v8a` | 64비트 ARM | ✅ 필수 |
| `armeabi-v7a` | 32비트 ARM | ❌ |
| `x86_64` | 64비트 Intel | ❌ |
| `x86` | 32비트 Intel | ❌ |

:::

## APK 업로드가 'Unversioned'로 표시되거나 다른 앱에 병합됨

APK의 앱 이름·버전·패키지 이름은 릴레이가 Android build-tools의 `aapt`로 읽습니다. build-tools가 없으면 이 정보를 읽지 못해 빌드가 버전·패키지 없이 저장됩니다.

- `app_id`를 지정한 업로드는 이 경우 `400`으로 거절됩니다. 정체를 알 수 없는 빌드가 지정한 앱에 섞여 들어가지 않도록 막는 것입니다.
- `tapflow doctor`의 Android 항목에서 `aapt (build-tools)`가 경고로 표시되면 이 상태입니다.

릴레이를 실행하는 머신에 build-tools를 설치하면 해결됩니다.

```sh
tapflow setup android
```

`tapflow setup`을 이미 돌린 적이 있다면 다시 실행해 build-tools를 채웁니다. 수동으로 설치할 때는 `sdkmanager --sdk_root="$ANDROID_HOME" "build-tools;35.0.0"`을 씁니다.

build-tools가 이미 있는데도 지정 업로드가 계속 `400`이면, APK 자체가 손상됐거나 올바른 패키지가 아닐 가능성이 큽니다. 다시 빌드하거나 재추출하세요. 정상 APK라면 `aapt dump badging your-app.apk`가 `package: name=...` 줄을 출력합니다.
