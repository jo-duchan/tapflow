# CLI 레퍼런스

## 설치

::: code-group

```sh [npm]
npm install -g tapflow
```

```sh [yarn]
yarn global add tapflow
```

```sh [pnpm]
pnpm add -g tapflow
```

:::

업데이트:

```sh
npm update -g tapflow
```

## `tapflow doctor`

환경 문제를 진단합니다. 플랫폼을 생략하면 전체를, `ios` / `android`를 지정하면 해당 플랫폼만 검사합니다.

```sh
tapflow doctor
tapflow doctor ios
tapflow doctor android
```

검사 항목은 다음과 같습니다(디바이스/AVD는 *존재*하기만 하면 됩니다. 부팅은 릴레이가 필요할 때 처리합니다).

- **Common**: Node.js 버전
- **iOS** (macOS만): Xcode, `xcrun simctl`, 사용 가능한 시뮬레이터
- **Android**: Android SDK, adb, AVD

`--json`으로 기계 판독용 출력을 얻을 수 있습니다. 문제가 하나라도 있으면 종료 코드 `1`을 반환합니다.

| 옵션 | 설명 |
|------|------|
| `[platform]` | `ios` 또는 `android`. 생략하면 전체 검사 |
| `--json` | `{ ok, common, ios, android }`를 JSON으로 출력 (ANSI 없음) |

전체 흐름은 [환경 준비](/ko/guide/environment-setup)를 참고하세요.


## `tapflow setup`

플랫폼을 실행할 수 있도록 로컬 환경을 설치·구성합니다. 플랫폼을 생략하면 자동 감지하며 `ios` / `android`를 지정할 수도 있습니다.

```sh
tapflow setup
tapflow setup ios
tapflow setup android
```

한 번 실행으로 끝까지 진행하면서 설치 단계마다 동의를 구합니다(대화형 터미널만 해당. 비대화형에서는 실행 대신 명령을 안내합니다).

- **iOS**: App Store에서 Xcode 설치를 안내하고 라이선스 동의·초기 설정을 실행하며(sudo 필요) 시뮬레이터 런타임을 내려받습니다.
- **Android**: JDK를 설치하고 `~/Library/Android/sdk`에 자기완결 SDK(명령행 도구·platform-tools·에뮬레이터·시스템 이미지 — Android Studio GUI 불필요)를 구성한 뒤 폼팩터별 AVD를 생성합니다.

setup은 부팅 가능한 디바이스/AVD를 준비하는 데까지만 하며 실제 부팅은 세션 접속 시 릴레이가 처리합니다. `ANDROID_HOME`/PATH를 등록한 뒤에는 새 터미널을 열거나 `exec $SHELL`을 실행하고 `tapflow doctor`를 돌리세요.

| 옵션 | 설명 |
|------|------|
| `[platform]` | `ios` 또는 `android`. 생략하면 자동 감지 |

전체 흐름은 [환경 준비](/ko/guide/environment-setup)를 참고하세요.


## `tapflow init`

`tapflow.config.json`을 인터랙티브하게 생성합니다. `tapflow start` 전에 한 번 실행합니다.

`tapflow.config.json`이 이미 존재하면 `--force` 없이는 오류로 종료합니다.

터널 플래그 없이 대화형 터미널에서 실행하면 터널 선택 화면이 표시됩니다. 비대화형 환경에서 `--tunnel` 없이 실행하면 터널 없는 기본 설정 파일이 생성됩니다.

```sh
tapflow init
```

| 옵션 | 설명 |
|------|------|
| `--tunnel <provider>` | 터널 프로바이더: `tailscale` 또는 `rathole` |
| `--force` | 기존 `tapflow.config.json` 덮어쓰기 |

Tailscale 예시:

```sh
tapflow init --tunnel tailscale
# ✓ tapflow.config.json created.
# Tunnel: tailscale
# → Next: tapflow start
```

터널 없이 기본 설정 생성:

```sh
tapflow init
# ✓ tapflow.config.json created.
# → Next: tapflow start
```


## `tapflow admin init`

CLI에서 최초 관리자 계정을 생성합니다. 브라우저를 사용할 수 없는 환경(헤드리스 서버, CI)에서 폴백으로 사용합니다.

이 명령어 실행 전에 릴레이가 먼저 구동 중이어야 합니다.

```sh
tapflow admin init
```

| 옵션 | 설명 |
|------|------|
| `--relay <url>` | 릴레이 URL (기본값: config의 `relay.url`, 없으면 `http://localhost:4000`) |

실행 예시:

```
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

비밀번호는 최소 8자 이상이어야 합니다.

::: tip 웹 온보딩
최초 실행 시 대시보드가 `/setup` 페이지로 자동 이동하며, 브라우저에서 관리자 계정을 생성할 수 있습니다. CLI가 필요 없습니다. 브라우저를 사용할 수 없는 경우에만 `tapflow admin init`을 사용하세요.
:::


## `tapflow start`

**로컬 개발 전용 shortcut.** 릴레이와 에이전트를 같은 Mac에서 한 번에 시작합니다.

```sh
tapflow start
```

| 옵션 | 설명 |
|------|------|
| `--platform <ios\|android\|all>` | 시작할 플랫폼 (기본값: 자동 감지) |
| `--device <name>` | iOS 시뮬레이터 이름 또는 UDID (기본값: 첫 번째 부팅된 것) |

::: info 팀 운영 환경에서는
릴레이를 서버에 따로 배포한다면 `tapflow relay start`와 `tapflow agent start`를 사용하세요.
:::


## `tapflow relay start`

릴레이 서버만 시작합니다. 서버 배포 시 사용합니다.

```sh
tapflow relay start
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--port <n>` | `4000` | 리슨 포트 |
| `--tunnel <provider>` | — | 사용할 터널 프로바이더 (`tailscale` 또는 `rathole`). `tapflow.config.json`의 `tunnel` 섹션이 필요합니다 |

**Tailscale (권장)**

```sh
tapflow relay start
```

`tapflow.config.json`:

```json
{
  "tunnel": {
    "provider": "tailscale"
  }
}
```

tapflow가 Tailscale MagicDNS 호스트명을 자동으로 읽어 URL을 구성합니다. `"publicUrl"`을 설정하면 자동 감지 URL을 덮어씁니다.

**VPS + rathole**

```sh
TAPFLOW_TUNNEL_TOKEN=your-secret tapflow relay start
```

`tapflow.config.json`:

```json
{
  "tunnel": {
    "provider": "rathole",
    "serverAddr": "your-vps.com:2333",
    "publicUrl": "https://your-vps.com",
    "ssh": {
      "host": "your-vps.com",
      "user": "ubuntu",
      "keyPath": "~/.ssh/id_ed25519"
    }
  }
}
```

`ssh` 섹션을 설정하면 tapflow가 SSH로 VPS에 접속해 rathole 서버를 자동으로 관리합니다 — 첫 실행 시 다운로드·설치·시작까지 처리합니다. `ssh`를 생략하면 VPS에 rathole 서버가 이미 실행 중인 것으로 간주합니다.

터널이 연결되면 배너에 공개 URL이 출력됩니다. 터널 연결에 실패해도 릴레이는 계속 동작합니다 — 터널만 사용 불가 상태가 됩니다.

전체 세팅 방법은 [릴레이 배포](/ko/guide/self-hosting)를 참고하세요.


## `tapflow agent start`

에이전트만 시작해 릴레이에 연결합니다. 로컬 릴레이를 띄우지 않습니다.

```sh
tapflow agent start --relay ws://192.168.x.x:4000
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | config의 `relay.url`, 없으면 `ws://localhost:4000` | 릴레이 WebSocket URL. `tapflow.config.json`에 `relay.url`이 있으면 생략 가능. |
| `--platform <ios\|android\|all>` | 자동 감지 | 시작할 플랫폼 |
| `--device <name>` | 첫 번째 부팅된 시뮬레이터 | iOS 시뮬레이터 이름 또는 UDID |


## `tapflow devices`

사용 가능한 시뮬레이터·에뮬레이터 목록을 표시합니다.

```sh
tapflow devices
```


## `tapflow boot`

이름 또는 UDID로 시뮬레이터 또는 에뮬레이터를 부팅합니다. iOS 시뮬레이터를 먼저 검색한 뒤 Android 에뮬레이터를 검색합니다.

```sh
# iOS
tapflow boot "iPhone 16 Pro"
tapflow boot 822F00B0-D9CF-4B78-8EDD-6322974E4079

# Android (에뮬레이터 이름)
tapflow boot Pixel_8
```

Android 에뮬레이터는 백그라운드에서 시작됩니다. `tapflow devices`로 상태를 확인하세요.


## `tapflow reset`

모든 시뮬레이터와 에뮬레이터를 종료합니다.

```sh
tapflow reset
```

실행 전에 확인 프롬프트가 표시됩니다 (`y/N`). `y`를 입력해야 종료가 진행됩니다.


## `tapflow status`

연결된 에이전트, 디바이스, 활성 세션을 표시합니다.

```sh
tapflow status
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | config의 `relay.url`, 없으면 `ws://localhost:4000` | 릴레이 WebSocket URL. `tapflow.config.json`에 `relay.url`이 있으면 생략 가능. |

::: info 연결 방식
`tapflow status`는 릴레이에 WebSocket으로 연결해 정보를 가져옵니다. 5초 안에 응답이 없으면 타임아웃됩니다. 원격 릴레이를 사용한다면 `--relay` 옵션이 필요합니다.
:::

출력 예시:

```
  ● mac-mini-office
      ◉  iPhone 16 Pro   ← qa@company.com
      ○  iPhone 15

  1 agent(s) · 2 device(s) · 1 active session(s)
```


## `tapflow logs`

릴레이의 최근 로그를 출력합니다 (기본값: 최근 100줄).

```sh
tapflow logs
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | config의 `relay.url`, 없으면 `http://localhost:4000` | 릴레이 URL. `tapflow.config.json`에 `relay.url`이 있으면 생략 가능. |
| `--lines <n>` | `100` | 표시할 로그 줄 수 (최대 500) |
