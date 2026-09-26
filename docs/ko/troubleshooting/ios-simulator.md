---
title: iOS 시뮬레이터
description: "`spawn unknown error`, CoreSimulator 서비스 버전 불일치, 디스크에서 찾을 수 없는 시뮬레이터, iOS 17 이하의 한글 입력 문제를 해결합니다."
---

# iOS 시뮬레이터

## 빌드를 열면 `spawn unknown error`가 납니다 {#spawn-unknown-error}

먼저 Mac의 아키텍처를 확인하세요.

```bash
uname -m        # arm64면 Apple Silicon, x86_64면 Intel
```

`x86_64`가 나오면 **Intel Mac이고 에이전트가 지원하지 않는 환경**입니다. 네이티브 헬퍼 바이너리가
arm64 전용이라 macOS가 실행을 거부하고(`EBADARCH`), Node가 그것을 `Unknown system error -86`으로
올려보내면 대시보드에 `spawn unknown error`로 표시됩니다.

현재 에이전트 쪽 우회 방법은 없습니다. 에이전트를 Apple Silicon Mac에서 실행하세요. 릴레이와
대시보드에는 이 제약이 없으므로 시뮬레이터를 구동하는 머신만 바꾸면 됩니다.

Intel 지원은 가능하고 [#464](https://github.com/jo-duchan/tapflow/issues/464)에서 다루고 있습니다.
유니버설 빌드가 필요하고 메인테이너가 갖고 있지 않은 하드웨어에서 검증해야 해서 예정에는 없습니다.
[시스템 요구사항](/ko/operate/requirements#에이전트)도 참고하세요.

`uname -m`이 `arm64`를 출력하면 다른 문제입니다. 헬퍼 파일이 없거나 실행 권한이 없을 때도 같은
메시지가 나오므로, 에이전트 패키지가 온전히 설치됐는지 확인하세요.

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

## iOS 시뮬레이터가 부팅되지 않음 — "cannot be located on disk" {#simulator-data-missing}

Xcode나 macOS 업데이트가 오래된 런타임을 정리하면, 시뮬레이터가 목록에는 남아 있지만 디스크의 데이터 디렉터리는 사라진 상태가 될 수 있습니다. `simctl list`에는 여전히 사용 가능으로 표시되지만 부팅은 실패합니다:

> Unable to boot device because it cannot be located on disk. The device's data is no longer present …

tapflow는 이 상황을 자동으로 복구합니다. 대시보드에서 해당 기기를 열면 에이전트가 깨진 시뮬레이터를 erase해 데이터를 다시 생성한 뒤 부팅을 한 번 재시도합니다. 정상 시뮬레이터는 절대 erase하지 않습니다.

자동 복구로 해결되지 않으면 남아 있는 기기를 직접 정리하세요. 아래 명령은 런타임이 사라진 시뮬레이터를 삭제합니다:

```sh
xcrun simctl delete unavailable
```

특정 시뮬레이터만 계속 실패하면 UDID로 삭제한 뒤 Xcode가 새로 만들도록 둡니다:

```sh
xcrun simctl delete 822F00B0-D9CF-4B78-8EDD-6322974E4079
```

## iOS 17 이하 — 한글 입력 시 자모 분리

iOS 17 이하 시뮬레이터에서 한글을 입력하면 음절로 조합되지 않고 자모가 분리됩니다 (예: "안녕" → "ㅇㅏㄴㄴㅕㅇ").

이는 iOS 시뮬레이터의 IME 처리 버그로, tapflow가 아닌 iOS 시뮬레이터 자체의 문제입니다. 시스템 앱(메시지 등)에서도 동일하게 재현됩니다.

**iOS 18 이상 시뮬레이터 런타임으로 업그레이드하세요.**  
Xcode → Settings → Platforms에서 iOS 18+ 런타임을 설치합니다.

::: details 레퍼런스
- [React Native #41494](https://github.com/facebook/react-native/issues/41494)
- [Flutter #135825](https://github.com/flutter/flutter/issues/135825)
:::
