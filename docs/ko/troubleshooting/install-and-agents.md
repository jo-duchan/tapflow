---
title: 설치와 에이전트
description: 에이전트가 시작되지 않거나 연결되지 않을 때, `tapflow doctor`가 실패할 때, 릴레이가 예상과 다른 설정을 쓸 때의 해결 방법입니다.
---

# 설치와 에이전트

## 에이전트 연결 문제

### 이미 에이전트가 실행 중이라고 나옴 {#agent-already-running}

`tapflow agent start`가 **AGENT ALREADY RUNNING**으로 멈추면, 그 맥에서 같은 플랫폼의 tapflow 에이전트가 이미 돌고 있다는 뜻입니다.

에이전트 하나가 그 맥의 시뮬레이터를 **전부** 관리합니다. 시뮬레이터를 여러 대 띄우고 팀원 여럿이 각자 하나씩 잡고 동시에 테스트하는 것은 에이전트 하나로 하는 일이고, 지금도 그대로 됩니다. 두 번째 에이전트를 띄우는 것은 그것과 다른 일입니다. 같은 기기 목록과 같은 네트워크 필터를 두고 첫 번째와 다투게 되고, 릴레이도 둘을 같은 에이전트로 봅니다.

돌고 있는 쪽을 멈추거나, 그쪽이 이미 제공하는 세션을 쓰세요.

### 에이전트가 릴레이에 연결되지 않음

1. 릴레이가 실행 중인지 확인합니다.
2. `--relay` 옵션의 URL 스킴을 확인합니다. 릴레이가 평문 HTTP면 `ws://`, 릴레이에 `tls`가 설정되어 HTTPS로 동작하면 `wss://`여야 합니다. `tapflow relay start`가 출력하는 에이전트 연결 명령(이 Mac에서 에이전트를 띄우지 않을 때는 `tapflow start`도 출력)과 **Agent** 토큰 다이얼로그의 명령에는 맞는 스킴이 들어 있습니다.
3. `tapflow doctor`를 실행해 환경을 점검합니다. 같은 Mac에서 릴레이가 실행 중이면 릴레이가 포트를 쓰고 있어서 `Port 4000` 항목이 실패로 나옵니다. 이 항목은 무시해도 됩니다.

## `tapflow doctor` 실패

### iOS 항목이 모두 실패함

iOS 에이전트는 macOS에서만 실행됩니다 (Apple 정책). Linux나 Windows에서는 iOS 에이전트를 시작할 수 없습니다.

### `Xcode not found` — Xcode가 설치되어 있지 않은 경우

Mac App Store 또는 Apple Developer 사이트에서 Xcode를 설치한 뒤 아래 명령어를 실행합니다:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

### `Xcode not found` — Xcode는 설치되어 있지만 `xcode-select`가 설정되지 않은 경우

Mac App Store에서 Xcode를 설치한 후 흔히 발생합니다. Xcode는 있지만 개발자 도구 경로가 등록되지 않은 상태입니다:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

이후 `tapflow doctor`를 다시 실행해 체크가 통과되는지 확인합니다.

### 실행 중인 시뮬레이터가 없는 경우

`tapflow doctor`는 시뮬레이터 부팅 여부로 통과와 실패를 가르지 않습니다. 사용 가능한 시뮬레이터가 하나라도 있으면 통과하고 하나도 없을 때만 경고를 표시합니다. 시뮬레이터는 세션을 시작할 때 에이전트가 필요에 따라 부팅합니다.

시작 전에 시뮬레이터를 미리 부팅하려면:

```sh
tapflow devices        # 사용 가능한 시뮬레이터 목록 확인
tapflow boot "iPhone 16 Pro"
```

### `adb not found`

Android Studio는 설치되어 있지만 `adb`가 `$PATH`에 없는 경우입니다. 셸 프로필에 Android SDK `platform-tools` 경로를 추가합니다:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

`~/.zshrc`(또는 `~/.bashrc`)에 위 내용을 추가하면 영구적으로 적용됩니다. 추가 후 `source ~/.zshrc`를 실행합니다.

## `tapflow init`이 `CONFIG KEPT`라고 합니다

설치에 `tapflow.config.json`이 이미 있어서 설정은 그대로 두고 `AGENTS.md`의 tapflow 섹션만 갱신했습니다. 설정을 새로 만들려면 `--force`를 쓰거나 기존 파일을 직접 편집하세요.

## 릴레이가 예상과 다른 설정이나 DB를 씁니다

`tapflow start`와 `tapflow relay start`는 시작할 때 설치 디렉터리, 설정 파일, 데이터 디렉터리를 출력합니다. 명령은 `TAPFLOW_HOME`, 그다음 현재 디렉터리가 이미 설치인 경우, 마지막으로 `~/.tapflow` 순으로 찾습니다([명령이 쓰는 설치 디렉터리](/ko/operate/configure#명령이-쓰는-설치-디렉토리)). 예전 설치가 있는 디렉터리에서 실행하면 그 설치를 쓰게 되므로, 분명히 하려면 `TAPFLOW_HOME`을 설정하세요.
