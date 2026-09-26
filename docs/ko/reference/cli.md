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

검사 항목은 다음과 같습니다(기기/AVD는 *존재*하기만 하면 됩니다. 부팅은 릴레이가 필요할 때 처리합니다).

- **Common**: Node.js 버전, 포트 4000 사용 가능 여부. 이 Mac에서 릴레이가 4000 포트로 실행 중이면 이 항목이 실패합니다.
- **iOS** (macOS만): Xcode, `xcrun simctl`, 사용 가능한 시뮬레이터, 네트워크 필터, 네트워크 훅, 네트워크 훅 심볼, Lean mode
- **Android**: Android SDK, adb, aapt(build-tools), AVD, Lean mode

네트워크 필터는 두 항목으로 나뉩니다. 실패하는 이유가 다르기 때문입니다 — **설치·승인·켜져 있는가**, 그리고 이 맥의 버전들이 이 tapflow가 싣고 온 것과 같은가. 켜져 있는지는 자기 버전이 없는 세 번째 조건입니다. 필터를 꺼도 확장은 활성 상태로 남으므로, 버전은 전부 맞는데 아무것도 필터링하지 않는 상태가 생깁니다.

**버전은 두 개이고, 검사는 뒤처진 쪽을 지목합니다.** `/Applications`의 앱과 그 안의 시스템 확장은 따로 버전을 갖습니다. 앱만 바뀐 릴리즈가 돌아가는 필터를 교체할 이유는 없기 때문입니다. 앱은 에이전트가 직접 실행하는 바이너리라서 그 자체로 중요합니다. 낡은 앱은 이해하지 못하는 요청을 받게 됩니다. 뒤의 것은 앞의 것으로 알 수 없습니다. 확장 교체는 맥을 재시작해야 끝나므로, 디스크의 앱은 최신인데 필터링은 옛 것이 하고 있는 상태가 생깁니다. 둘 다 실패가 아니라 경고입니다. 확장이 없어도 세션은 정상 동작하고 iOS 네트워크 제어만 안 됩니다. [네트워크 제어](/ko/testing/network-control)를 참고하세요.

네트워크 훅은 앱에 오프라인이라고 알리는 주입 라이브러리입니다. tapflow와 함께 오므로 없다면 설치가 손상된 것이고, 재설치가 복구입니다. 따로 표시하는 이유는 없을 때 조용하기 때문입니다. macOS는 존재하지 않는 주입 경로를 아무 말 없이 무시하므로, 앱은 훅 없이 뜨고 네트워크 제어는 계속 앱을 실행하라고 안내합니다. 실행한 앱이 눈앞에서 돌고 있는데도 세션 내내 그렇습니다.

`--json`으로 기계 판독용 출력을 얻을 수 있습니다. 문제가 하나라도 있으면 종료 코드 `1`을 반환합니다. 경고만 있는 항목은 실패로 세지 않습니다.

| 옵션 | 설명 |
|------|------|
| `[platform]` | `ios` 또는 `android`. 생략하면 전체 검사 |
| `--json` | `{ ok, common, ios, android }`를 JSON으로 출력 (ANSI 없음) |

전체 흐름은 [환경 준비](/ko/operate/environment-setup)를 참고하세요.


## `tapflow setup`

플랫폼을 실행할 수 있도록 로컬 환경을 설치·구성합니다. 플랫폼을 생략하면 자동 감지하며 `ios` / `android`를 지정할 수도 있습니다.

```sh
tapflow setup
tapflow setup ios
tapflow setup android
```

한 번 실행으로 끝까지 진행하면서 설치 단계마다 동의를 구합니다(대화형 터미널만 해당. 비대화형에서는 실행 대신 명령을 안내합니다). 두 플랫폼 모두 Homebrew가 없으면 먼저 설치합니다.

- **iOS**: App Store에서 Xcode 설치를 안내하고 라이선스 동의·초기 설정을 실행하며(sudo 필요) 시뮬레이터 런타임을 내려받습니다.
- **Android**: JDK를 설치하고 `~/Library/Android/sdk`에 자기완결 SDK(명령행 도구·platform-tools·에뮬레이터·시스템 이미지 — Android Studio GUI 불필요)를 구성한 뒤 폼팩터별 AVD를 생성합니다.

모든 단계가 준비되면 종료 코드 `0`, `SETUP INCOMPLETE`를 출력하면 `1`을 반환합니다. `doctor`는 경고만 있는 항목을 통과시키므로 setup 쪽이 더 엄격합니다. setup은 Mac을 쓸 수 있는지가 아니라 요청받은 작업이 끝났는지를 보고합니다.

macOS에서 `setup ios`는 iOS 네트워크 제어에 필요한 네트워크 필터도 설치하는데, 다른 설치와 마찬가지로 먼저 동의를 구합니다. 이 맥에 승인된 확장이 없으면 macOS가 승인을 물을 때 승인 화면을 열어줄지도 묻습니다. 그 제안을 거절하지 않았다면 승인이 2분 안에 오지 않아도 켜질 때까지 더 기다렸다가 설치를 마칩니다. 설치를 거절했거나 그 기능이 나오기 전에 설정한 맥이라면 [`tapflow migrate net-filter`](#tapflow-migrate-net-filter)로 따로 설치합니다.

설치 마지막에 필터가 돌기 시작했는지를 최대 30초까지 기다리므로 그 단계에서 멈춘 것처럼 보일 수 있습니다. 아무것도 보고하지 않으면 완료로 표시하지 않고 그렇게 말합니다. 자세한 것은 [`migrate net-filter`의 같은 동작](#tapflow-migrate-net-filter)을 보세요.

setup은 부팅 가능한 기기/AVD를 준비하는 데까지만 하며 실제 부팅은 세션 접속 시 릴레이가 처리합니다. `ANDROID_HOME`/PATH를 등록한 뒤에는 새 터미널을 열거나 `exec $SHELL`을 실행하고 `tapflow doctor`를 돌리세요.

| 옵션 | 설명 |
|------|------|
| `[platform]` | `ios` 또는 `android`. 생략하면 자동 감지 |

전체 흐름은 [환경 준비](/ko/operate/environment-setup)를 참고하세요.


## `tapflow init`

이 머신의 tapflow를 설정합니다. `tapflow.config.json`, 코딩 에이전트가 읽는 `AGENTS.md`와 `CLAUDE.md`, 그리고 DNS 자동 발급을 선택하면 자격 증명 `.env`까지 만듭니다. 어느 디렉터리에서 실행해도 됩니다. 설치 디렉터리에 쓰고, 기본값은 `~/.tapflow`이며 `TAPFLOW_HOME`이나 현재 디렉터리의 기존 설치가 있으면 그쪽입니다([명령이 쓰는 설치 디렉터리](/ko/operate/configure#명령이-쓰는-설치-디렉토리)). 디렉터리가 없으면 만듭니다.

다시 실행하면 설정은 그대로 두고 `AGENTS.md`의 tapflow 섹션만 갱신하므로, 기존 설치도 이 문서를 받을 수 있습니다. 설정을 새로 만들려면 `--force`를 씁니다. 이미 설정이 있는데 `--tunnel`을 주면 오류로 멈춥니다. 설정을 유지하면 그 플래그를 무시하게 되기 때문입니다.

터널 플래그 없이 대화형 터미널에서 실행하면 터널 선택 화면이 표시됩니다. 터널을 고르지 않으면 스트리밍 성능(HTTPS)도 묻습니다. 시뮬레이터나 에뮬레이터가 있는 머신에서는 어떤 터널을 고르든 Lean mode도 묻습니다. 답은 설정 파일의 `tls`와 `agent.lean`에 적힙니다. 비대화형 환경에서 `--tunnel` 없이 실행하면 터널 없는 기본 설정 파일이 생성됩니다.

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
# ✓ CONFIG CREATED
# Install dir: /Users/you/.tapflow (default)
# tapflow.config.json created.
# AGENTS.md created for your coding agent.
# Tunnel: tailscale
# → Next: tapflow start
```

터널 없이 기본 설정 생성:

```sh
tapflow init
# ✓ CONFIG CREATED
# → Next: tapflow start
```

다른 디렉터리에 설치를 만들 때:

```sh
TAPFLOW_HOME=/var/lib/tapflow tapflow init
```


## `tapflow admin init`

CLI에서 최초 관리자 계정을 생성합니다. 브라우저를 사용할 수 없는 서버에서 폴백으로 사용합니다.

이 명령어 실행 전에 릴레이가 먼저 구동 중이어야 합니다. 이메일과 비밀번호를 물어보므로 대화형 터미널이 필요하고 터미널이 없으면(CI 등) 종료 코드 `1`로 끝납니다. 릴레이는 같은 머신(localhost)에서 온 요청으로만 첫 계정을 만들기 때문에 `--relay`로 원격 릴레이를 가리키면 `403`을 받습니다. 릴레이가 실행 중인 머신에서 실행하세요.

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

릴레이와 에이전트를 같은 Mac에서 한 번에 시작합니다. Mac 한 대로 운영할 때 쓰는 명령입니다. 실행할 수 있는 플랫폼이 없으면 릴레이만 시작합니다.

```sh
tapflow start
```

| 옵션 | 설명 |
|------|------|
| `--platform <ios\|android\|all>` | 시작할 플랫폼 (기본값: 자동 감지) |
| `--device <name>` | 릴레이에 노출할 기기를 한정합니다(기본값: 전체). iOS 시뮬레이터는 이름 또는 UDID, Android 에뮬레이터는 AVD 이름 또는 기기 ID로 지정합니다. 부팅은 대시보드에서 필요할 때 이뤄집니다. |

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
| `--port <n>` | `local.port` (기본 `4000`) | 리슨 포트 |
| `--tunnel <provider>` | — | `tailscale` 또는 `rathole`. `tapflow.config.json`에 `tunnel` 섹션이 없으면 오류로 멈춥니다. 실제로 띄우는 터널은 이 값과 관계없이 `tunnel` 섹션이 정합니다. `tunnel` 섹션이 있으면 이 플래그 없이도 터널을 띄웁니다. |

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

`TAPFLOW_TUNNEL_TOKEN`을 데이터 디렉터리의 `.env`(기본값 `~/.tapflow/data/.env`)에 적은 뒤 실행합니다:

```sh
tapflow relay start
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

`tunnel` 키 전체는 [설정 파일](/ko/reference/configuration#터널)에 있습니다. 전체 세팅 방법은 [외부 접속](/ko/operate/external-access)을 참고하세요.


## `tapflow agent start`

에이전트만 시작해 릴레이에 연결합니다. 로컬 릴레이를 띄우지 않습니다.

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | config의 `relay.url`, 없으면 `ws://localhost:4000` | 릴레이 WebSocket URL. `tapflow.config.json`에 `relay.url`이 있으면 생략 가능. |
| `--platform <ios\|android\|all>` | 자동 감지 | 시작할 플랫폼 |
| `--device <name>` | 전체 기기 | 릴레이에 노출할 기기를 한정. iOS 시뮬레이터는 이름 또는 UDID, Android 에뮬레이터는 AVD 이름 또는 기기 ID |
| `--token <pat>` | `TAPFLOW_AGENT_TOKEN` 환경변수 | 원격 릴레이가 요구하는 `agent` 스코프 토큰. [에이전트 설정](/ko/operate/agents#원격-릴레이-인증)을 참고하세요. |

`--relay`는 `ws://` 또는 `wss://`로 시작해야 합니다. Mac 한 대에서는 플랫폼마다 에이전트를 하나만 실행할 수 있습니다. 같은 플랫폼의 에이전트가 이미 실행 중이면 `AGENT ALREADY RUNNING`을 출력하고 종료합니다. 실행할 수 있는 플랫폼이 없으면 종료 코드 `1`로 끝납니다.


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

연결된 에이전트, 기기, 활성 세션을 표시합니다.

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
  ● mac-mini-office  (iOS)
      ◉  iPhone 16 Pro   ← qa@company.com
      ○  iPhone 15

  1 agent(s) · 2 device(s) · 1 active session(s)
```


## `tapflow logs`

릴레이가 메모리에 보관하는 최근 로그 항목을 출력합니다(기본값: 최근 100줄). 이 버퍼에 기록되는 이벤트는 많지 않습니다. 릴레이의 전체 로그는 릴레이를 실행한 터미널에 출력됩니다.

```sh
tapflow logs
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | config의 `relay.url`, 없으면 `http://localhost:4000` | 릴레이 URL. `tapflow.config.json`에 `relay.url`이 있으면 생략 가능. |
| `--lines <n>` | `100` | 표시할 로그 줄 수 (최대 500) |

## `tapflow flow run`

저장된 플로우 파일을 LLM 없이 재생합니다. 플로우 작성법은 [플로우 레퍼런스](/ko/automation/flows)를 참고하세요.

```sh
tapflow flow run .tapflow/flows/login-smoke.yaml
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | `ws://localhost:4000` | 릴레이 WebSocket URL. `relay.url` 설정을 읽지 않습니다. |
| `--token <token>` | `TAPFLOW_TOKEN` 환경변수 | 원격 릴레이에 접속할 개인 액세스 토큰(PAT) |
| `--session <id>` | — | 대상 세션 ID(MCP 서버의 `list_devices`로 확인) |
| `--device <name>` | — | 대상 기기 이름. 꺼져 있으면 부팅합니다. |
| `--build <id>` | — | 테스트할 빌드 ID. 실행 전에 설치하고 `launchApp` 스텝이 이 빌드를 실행합니다. |
| `--no-install` | — | `--build`를 설치하지 않고 실행 |
| `--junit <path>` | — | JUnit XML 리포트를 쓸 경로 |
| `--artifacts <dir>` | `.tapflow/artifacts` | 실패 스크린샷을 저장할 디렉터리 |
| `--timeout <seconds>` | `10` | 셀렉터마다 기다리는 기본 시간(초) |

`--session`과 `--device`를 모두 생략하면 부팅된 기기가 정확히 하나일 때 그 기기를 씁니다. 부팅된 기기가 없거나 여러 대면 환경 오류로 멈춥니다.

| 종료 코드 | 의미 |
|-----------|------|
| `0` | 모든 플로우 통과 |
| `1` | 하나 이상의 플로우가 제품 문제로 실패 |
| `2` | 환경·설정 오류, 또는 실패한 플로우가 모두 환경 문제 |

## `tapflow migrate`

업그레이드 후 이 설치에 필요한 마이그레이션을 한 번에 실행합니다.

```sh
tapflow migrate
```

아래 마이그레이션을 하나씩 확인해서 해당하는 것만 목록으로 보여 줍니다.

- `data-dir`: 설치 폴더에 데이터가 든 `.tapflow-data/`가 있을 때.
- `net-filter`: macOS에서 iOS 네트워크 필터가 설치돼 있는데 지금 tapflow 버전보다 오래됐거나, 설치돼 있는데 동작하지 않을 때. 필터는 선택 기능이라서 설치한 적 없는 맥은 건드리지 않습니다.

터미널에서는 목록을 보여 주고 한 번 묻습니다. 터미널이 없으면(CI, 프로비저닝 스크립트) 목록을 출력하고 묻지 않고 실행합니다. 각 서브커맨드를 따로 실행할 때와 같습니다. 단, `net-filter` 단계는 macOS 승인 때문에 한 번 더 물을 수 있습니다.

마이그레이션은 순서대로 실행하고 하나가 실패하면 나머지는 실행하지 않고 exit code 1로 끝납니다. 할 일이 없으면 exit 0입니다. `.tapflow-data/`와 `.tapflow/data/`가 둘 다 있으면 `data-dir`은 알리기만 하고 건너뜁니다. 어느 쪽에 데이터가 있는지는 사용자만 알 수 있기 때문입니다. 필터 앱은 지워졌는데 확장이 아직 돌고 있을 때도 `net-filter`를 같은 방식으로 건너뜁니다. 이 상태는 `tapflow doctor ios`가 설명합니다.

여기서는 `--ignore-running-devices`를 받지 않습니다. 필요하면 `tapflow migrate net-filter --ignore-running-devices`로 실행하세요.

## `tapflow migrate data-dir`

구 `.tapflow-data/`를 통합 `.tapflow/data/` 레이아웃으로 옮깁니다. 업그레이드 후 한 번 실행하면 되고, 멱등이라 다시 돌려도 안전합니다.

먼저 릴레이를 멈추세요. 릴레이 포트(`local.port` 또는 `TAPFLOW_PORT`)를 무언가 쓰고 있으면 아무것도 옮기지 않고 거부합니다. 옮기는 동안 릴레이가 돌고 있으면 그 뒤에 올라온 빌드가 다시 `.tapflow-data/`에 쌓이기 때문입니다. `tapflow relay start --port`로 다른 포트에 띄운 릴레이는 감지하지 못하므로 직접 멈춰야 합니다.

```sh
tapflow migrate data-dir
```

하는 일:

- `.tapflow-data/`를 `.tapflow/data/`로 원자적 rename 합니다. 파일시스템 rename 한 번이라 복사도, 절반만 옮겨진 상태도 없습니다.
- `tapflow.config.json`의 `local.dataDir`이 구 기본값 `.tapflow-data`를 가리키면 다시 써줍니다. 커스텀 경로는 건드리지 않습니다.
- `.tapflow/data/`와 `.tapflow/artifacts/`를 `.gitignore`에 추가해 옮긴 비밀이 git에 올라가지 않게 합니다.

이 명령을 안 돌려도 기존 설치는 그대로 동작합니다. 지정된 `local.dataDir`은 존중되고, config 없는 기본 설치는 `.tapflow-data/`를 계속 읽습니다. 두 경로가 서로 다른 파일시스템에 있거나 둘 다 이미 존재하면, 명령은 추측하지 않고 멈춘 뒤 수동 단계를 안내합니다. config는 옮기기 전에 먼저 고치고 옮기기에 실패하면 되돌립니다. 되돌리지도 못하면 원래대로 적어야 할 값을 출력합니다.

## `tapflow migrate net-filter`

tapflow가 iOS 네트워크 필터를 싣기 전에 설정한 맥에 그 필터를 설치합니다. macOS 전용입니다.

```sh
tapflow migrate net-filter
```

`tapflow setup ios`도 필터를 설치하지만, setup은 맥을 새로 준비할 때 돌리는 명령입니다. 이미 설정을 마친 맥은 setup을 다시 돌릴 이유가 없어서, 확장이 `node_modules`에만 들어오고 맥에는 올라가지 않습니다. 이 명령이 그 자리를 맡고, setup에서 필터 설치를 거절한 경우에도 같습니다.

`@tapflowio/ios-agent`와 함께 온 서명된 확장을 `/Applications`로 복사하고 macOS에 활성화를 요청합니다. 승인은 그 맥 앞에서 **시스템 설정 → 일반 → 로그인 항목 및 확장 프로그램 → 네트워크 확장**에서 합니다. macOS가 명령행 대체를 제공하지 않으므로, 승인을 기다리는 중이면 명령이 그렇게 알려줍니다.

**승인 화면은 설치 전에 묻고 기다리는 동안 엽니다.** 이 맥에 승인된 tapflow 확장(`[activated enabled]`)이 없으면 macOS가 승인을 물을 것이므로 대화형 터미널에서는 설치를 시작하기 전에 승인 화면을 열어줄지 묻습니다. 질문에는 필터를 켤 때 맥에 이미 열려 있던 연결이 끊길 수 있다는 내용도 들어 있습니다. SSH 세션도 여기 포함됩니다. 동의하면 `systemextensionsctl list`에 요청이 `waiting for user`로 나타나는 즉시 화면을 엽니다. 이미 대기 중인 요청에는 macOS가 승인 창을 다시 띄우지 않으므로 다시 실행할 때는 이 화면이 유일한 안내입니다. 기기 확인은 이 질문 뒤에 합니다. 이 질문에서 Ctrl-C나 Esc를 누르면 아무것도 설치하지 않고 멈춥니다.

**승인이 늦어도 같은 실행에서 끝까지 갑니다.** 설치는 승인을 2분까지 기다리고 그 안에 켜지면 그대로 끝납니다. 켜지지 않았으면 명령이 최대 2분 더 기다립니다. 그 안에 켜지면 필터를 켜고 실제로 도는지 확인합니다. 미리 묻지 않았다면 이때 화면을 열지 묻습니다. 이미 승인된 확장을 교체할 때처럼 macOS가 묻지 않을 것으로 보인 경우입니다. 켤 때 macOS가 네트워크 콘텐츠 필터링을 허용할지 물으면 허용하세요.

**화면이 열렸다고 말하지 않습니다.** 창이 떴는지 명령이 알 방법이 없어서 경로를 함께 보여줍니다. 아무것도 뜨지 않으면 그 경로로 직접 가세요.

**명령이 직접 켤 때는 켜기 직전에 기기를 다시 확인합니다.** 더 기다린 2분 동안 누군가 시뮬레이터를 부팅했을 수 있기 때문입니다. 찾으면 필터를 켜지 않고 멈추며 필터가 꺼진 상태라면 그것도 알려줍니다. `--ignore-running-devices`를 줬다면 다시 확인하지 않습니다. 처음 2분 안에 승인되면 확장이 스스로 필터를 켜므로 기기 확인은 설치를 시작할 때의 한 번뿐입니다.

대화형 터미널이 아니면 묻지 않습니다. stdin과 stdout이 모두 터미널이어야 대화형으로 봅니다. 이때와 제안을 거절했을 때는 처음 2분 안에 직접 승인하지 않는 한 승인 대기 상태로 끝납니다. 거절한 제안은 다시 묻지 않습니다. 더 기다린 2분 안에 켜지지 않았을 때도 같습니다. 그러면 승인한 뒤 명령을 다시 실행하라고 안내하고 다시 실행하면 필터가 켜집니다.

**자기가 싣고 온 것보다 새 필터는 교체하지 않고 거부합니다.** `/Applications`의 앱은 맥 전역에 하나인데 각 설치는 자기 의존성 기준으로 판단하므로, 옛 체크아웃이 새 에이전트가 기대는 필터를 덮어쓰는 일을 막습니다.

**기기를 쓰고 있으면 거부합니다.** 필터를 교체하는 동안 맥의 새 연결이 끊기는데, 그 영향을 받는 사람이 명령을 실행한 사람과 같으리라는 보장이 없습니다. 부팅된 시뮬레이터, 붙어 있는 에뮬레이터, `:4000`에서 서비스 중인 릴레이가 모두 여기 해당합니다. 무엇을 찾았는지 알려주고 멈춥니다.

```sh
tapflow migrate net-filter --ignore-running-devices
```

이러면 그래도 교체합니다. 이 옵션은 `net-filter` 것입니다. `tapflow migrate data-dir`은 무시하지 않고 거부합니다.

**필터를 먼저 껐다가 끝나면 다시 켭니다.** 콘텐츠 필터는 시뮬레이터 것만이 아니라 맥의 모든 새 연결 앞에 있습니다. 필터가 켜져 있는 상태에서 멈추면 macOS는 검사받지 않은 트래픽을 흘려보내는 대신 전부 막습니다. 새 연결은 즉시 `No route to host`로 실패합니다. 필터를 먼저 경로에서 빼면 그 상태가 생기지 않습니다.

앱을 `/Applications`로 복사하기 **전에** 끕니다. 확장을 활성화하기 전만이 아닙니다. 두 단계 모두 필터를 멈추기 때문입니다. 앱을 복사하면 macOS가 알아서 필터 세션을 다시 시작합니다. 복사가 끝나면 방금 복사한 바이너리로 한 번 더 끕니다. 활성화를 막는 관문은 그쪽입니다.

명령이 도중에 실패하면 필터가 꺼진 채로 남았는지 알려줍니다. 그 상태에서 맥의 네트워크는 정상이고 iOS 네트워크 제어만 안 됩니다. 명령을 다시 돌리면 켜집니다.

**필터가 실제로 돌기 시작했는지 확인한 뒤에 성공을 말합니다.** 확장을 설치할 때 macOS가 답하는 것은 "거절하지 않았다"이지 "동작한다"가 아닙니다. 설정은 그 뒤에 필터에게 전달되고 아무것도 돌아오지 않습니다. 그래서 최대 30초까지 지켜보다가 필터가 나타나면 바로 끝냅니다. `tapflow setup ios`가 필터를 설치할 때도 같습니다.

나타나지 않으면 그렇게 말하고 **0이 아닌 코드로 종료합니다.** 설정은 켜져 있는데 아무도 답하지 않는 상태이기 때문입니다. 대개는 아직 기동 중이고 잠시 뒤 `tapflow doctor ios`가 정상이라고 답합니다. 맥의 새 연결이 멈췄다면 [문제 해결](/ko/operate/network-extension#network-lost-on-replace)을 보세요. 해법은 `--off`로 필터를 경로에서 빼는 것입니다.

끝나고 `tapflow doctor ios`로 맥이 어떤 상태가 됐는지 확인하세요.
