# 문제 해결

## 에이전트 연결 문제

### 에이전트가 릴레이에 연결되지 않음

1. 릴레이가 실행 중인지 확인합니다.
2. `--relay` 옵션의 URL이 `ws://`인지 확인합니다. 에이전트는 항상 내부 네트워크로 연결합니다.
3. `tapflow doctor`를 실행해 환경을 점검합니다.

### 리버스 프록시(nginx 등) 사용 시 연결이 끊김

tapflow는 에이전트와 브라우저 모두 WebSocket을 사용합니다. nginx 등의 리버스 프록시는 기본적으로 HTTP upgrade를 처리하지 않습니다.

nginx 설정에 아래 헤더가 포함되어 있는지 확인합니다:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
```

설정 예시는 [릴레이 배포](/ko/guide/self-hosting#nginx-예시)를 참고하세요.

## iOS 시뮬레이터 서비스 버전 불일치 {#ios-simulator-service-version-mismatch}

Xcode를 업데이트한 후 다음과 같은 macOS 알림이 표시될 수 있습니다:

> "Loaded CoreSimulatorService is no longer valid for this process … Service version (X) does not match expected service version (Y)."

tapflow는 이 오류를 자동으로 감지해 서비스를 재시작합니다. 자동 복구에 실패하면 (재시도 후에도 알림이 계속 표시되면) 아래 명령어를 직접 실행하세요:

```sh
killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

`launchd`가 즉시 서비스를 재시작합니다. 이후 `tapflow start`를 다시 실행하면 됩니다.

::: details 발생 원인
Xcode 업데이트 시 새 버전의 `CoreSimulator.framework`가 설치되지만, 이전 세션에서 기동한 `CoreSimulatorService` 데몬은 그대로 남아 있습니다. `xcrun simctl`이 버전 불일치를 감지하면 tapflow가 데몬을 강제 종료해 `launchd`가 새 버전으로 재시작하도록 유도합니다. 데몬이 멈춰 있어 첫 번째 시도에 종료되지 않으면 위의 수동 명령어가 필요합니다.
:::

## iOS 17 이하 — 한글 입력 시 자모 분리

iOS 17 이하 시뮬레이터에서 한글을 입력하면 음절로 조합되지 않고 자모가 분리됩니다 (예: "안녕" → "ㅇㅏㄴㄴㅕㅇ").

이는 iOS 시뮬레이터의 IME 처리 버그로, tapflow가 아닌 iOS 시뮬레이터 자체의 문제입니다. 시스템 앱(메시지 등)에서도 동일하게 재현됩니다.

**iOS 18 이상 시뮬레이터 런타임으로 업그레이드하세요.**  
Xcode → Settings → Platforms에서 iOS 18+ 런타임을 설치합니다.

::: details 레퍼런스
- [React Native #41494](https://github.com/facebook/react-native/issues/41494)
- [Flutter #135825](https://github.com/flutter/flutter/issues/135825)
:::

## iOS 빌드 업로드 오류

### 업로드 시 `400` 오류

| 원인 | 해결 방법 |
|------|-----------|
| `.ipa` 파일 업로드 | `.ipa`는 실제 기기용입니다. `xcodebuild -sdk iphonesimulator`로 빌드 후 `.app` 폴더를 zip으로 압축하세요 |
| `.app`이 ZIP 루트에 없음 | 압축 해제 시 `MyApp.app`이 바로 나와야 합니다. 상위 폴더로 감싸면 파싱에 실패합니다 |
| 디바이스용 슬라이스만 포함 | 시뮬레이터용 빌드인지 확인합니다. `lipo -info MyApp.app/MyApp` 출력에 `x86_64` 또는 `arm64`(시뮬레이터)가 있어야 합니다 |

## Android 에뮬레이터 문제

### 스트림이 시작되지 않거나 인코더 크래시

AVD가 `google_apis_playstore` 이미지를 사용하고 있는 경우 발생합니다. `google_apis/arm64-v8a` 이미지로 AVD를 다시 생성하세요.

```sh
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n Pixel_8 -k "system-images;android-34;google_apis;arm64-v8a"
```

### `INSTALL_FAILED_NO_MATCHING_ABIS` — Apple Silicon 에뮬레이터와 호환되지 않는 APK

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

## `tapflow doctor` 실패

### iOS 항목이 모두 실패함

iOS 에이전트는 macOS에서만 실행됩니다 (Apple 정책). Linux나 Windows에서는 iOS 에이전트를 시작할 수 없습니다.

### `Xcode not found` 또는 `xcrun simctl not found`

Xcode가 설치되어 있어도 커맨드라인 도구가 설정되지 않으면 발생합니다:

```sh
xcode-select --install
# 또는
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

### `adb not found`

Android SDK의 `platform-tools`가 `$PATH`에 없는 경우입니다. `ANDROID_HOME`을 설정합니다:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

## 세션 관련

### 세션이 자동으로 종료됨

30분 동안 브라우저 입력이 없으면 세션이 자동 종료됩니다. 현재 이 값은 설정에서 변경할 수 없습니다. 대시보드에서 재연결하면 됩니다.

### FPS가 낮거나 스트림이 끊김

- 릴레이와 에이전트 사이의 네트워크 품질을 확인합니다.
- 대시보드 **Mac Resources** 탭에서 해당 Mac의 CPU·RAM 사용량을 확인합니다.
- 한 Mac에서 동시에 실행하는 디바이스 수를 줄입니다.

## 인증 관련

### `tapflow init` 실패 (`ALREADY INITIALIZED`)

현재 디렉토리에 `tapflow.config.json`이 이미 존재합니다. `--force` 옵션을 사용해 덮어쓰거나, 기존 파일을 직접 편집하세요.

### `tapflow admin init` 실패 (`Already initialized`)

릴레이에 이미 관리자 계정이 존재합니다. 대시보드에 로그인한 뒤 **Settings → Team**에서 팀원을 초대하세요.

### 초대 링크가 만료됨

초대 링크는 **7일** 후 만료됩니다. Admin이 **Settings → Team**에서 새 초대를 발송해야 합니다. SMTP가 설정되지 않은 경우 API 응답의 `token` 값을 직접 복사해 링크를 공유할 수 있습니다.

### 비밀번호 재설정 링크가 만료됨

비밀번호 재설정 링크는 **2시간** 후 만료됩니다. Admin이 **Settings → Team → 회원 선택 → 비밀번호 재설정 발송**으로 새 링크를 요청할 수 있습니다.

## 로그 확인

릴레이의 동작 로그를 확인하려면:

```sh
tapflow logs
tapflow logs --lines 200
```
