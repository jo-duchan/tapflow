# 환경 준비

에이전트를 실행할 Mac은 iOS 시뮬레이터나 Android 에뮬레이터를 띄울 수 있는 환경이 갖춰져 있어야 합니다. `tapflow doctor`로 현재 상태를 진단하고 `tapflow setup`으로 부족한 부분을 설치·구성할 수 있습니다.

## tapflow doctor

`tapflow doctor`는 환경이 준비됐는지 점검합니다.

```sh
tapflow doctor
```

플랫폼을 지정하면 해당 플랫폼만 점검합니다.

```sh
tapflow doctor ios
tapflow doctor android
```

점검 항목은 다음과 같습니다.

| 영역 | 항목 |
|------|------|
| 공통 | Node 버전 |
| iOS | Xcode, `xcrun simctl`, 사용 가능한 시뮬레이터 |
| Android | Android SDK, adb, AVD |

각 항목은 **✓ 준비됨**, **⚠ 주의**, **✗ 설치 필요**로 표시됩니다. 디바이스가 실행 중인지는 보지 않습니다. 부팅은 대시보드에서 세션에 접속할 때 자동으로 이뤄지므로, 부팅할 수 있는 디바이스가 하나라도 있으면 통과로 간주합니다.

자동화나 CI에서 결과를 파싱하려면 `--json` 플래그로 기계 판독용 JSON을 출력할 수 있습니다.

```sh
tapflow doctor --json
```

## tapflow setup

`tapflow setup`은 doctor가 찾아낸 부족한 부분을 직접 설치·구성합니다. 인자 없이 실행하면 환경을 감지해 가능한 플랫폼을 모두 설정합니다.

<VideoPlayer src="/tapflow-setup.mp4" />

```sh
tapflow setup
```

특정 플랫폼만 설정할 수도 있습니다.

```sh
tapflow setup ios
tapflow setup android
```

setup은 한 번에 끝나도록 설계됐습니다. 설치가 필요한 단계에서는 대화형 터미널에서 동의를 구한 뒤 직접 실행합니다. 비대화형(CI 등) 환경에서는 설치 대신 필요한 명령을 안내합니다.

### iOS

- **Xcode**는 App Store에서만 설치할 수 있어, setup이 App Store를 열어 안내합니다. 설치를 마치고 Enter를 누르면 이어집니다.
- **Xcode 활성화** 단계에서는 라이선스 동의와 초기 설정(`xcode-select`, `xcodebuild -runFirstLaunch`)을 동의 후 실행합니다. 이 작업에는 관리자 권한(sudo)이 필요합니다.
- **시뮬레이터 런타임**이 없어 사용 가능한 디바이스가 하나도 없으면 런타임을 내려받습니다.

### Android

- **JDK**: SDK 도구 실행에 필요한 JDK가 없으면 설치합니다.
- **Android SDK**: `~/Library/Android/sdk`에 명령행 도구·platform-tools·에뮬레이터·시스템 이미지를 자기완결 형태로 구성합니다. Android Studio GUI는 설치하지 않아도 됩니다.
- **AVD**: 폼팩터별로 4종(소형 폰·표준 폰·대형 폰·태블릿)을 생성해, 해상도별로 골고루 테스트할 수 있게 합니다.

setup이 `ANDROID_HOME`과 PATH를 셸 설정 파일에 추가하면 현재 터미널에는 바로 반영되지 않습니다. 새 터미널을 열거나 `exec $SHELL`을 실행한 뒤 `tapflow doctor`로 확인하세요.

## 디바이스 부팅은 자동입니다

setup은 부팅할 수 있는 디바이스와 AVD를 준비하는 데까지만 합니다. 실제 부팅은 팀원이 대시보드에서 QA 세션에 접속할 때 릴레이가 자동으로 처리하므로, setup 직후에 디바이스를 직접 띄울 필요는 없습니다.
