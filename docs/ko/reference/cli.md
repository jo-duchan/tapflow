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

---

## `tapflow init`

릴레이에 최초 관리자 계정을 생성합니다. 계정이 하나도 없을 때만 실행 가능합니다.

```sh
tapflow init
```

| 옵션 | 설명 |
|------|------|
| `--relay <url>` | 릴레이 URL (기본값: `http://localhost:4000`) |

실행 예시:

```
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

비밀번호는 최소 8자 이상이어야 합니다.

---

## `tapflow start`

**로컬 개발 전용 shortcut.** 릴레이와 에이전트를 같은 Mac에서 한번에 시작합니다.

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

---

## `tapflow relay start`

릴레이 서버만 시작합니다. 서버 배포 시 사용합니다.

```sh
tapflow relay start
```

| 옵션 | 설명 |
|------|------|
| `--port <n>` | 포트 (기본값: `4000`) |

---

## `tapflow agent start`

에이전트만 시작해 릴레이에 연결합니다. 로컬 릴레이를 띄우지 않습니다.

```sh
tapflow agent start --relay wss://relay.myteam.example.com
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | `ws://localhost:4000` | 릴레이 WebSocket URL |
| `--platform <ios\|android\|all>` | 자동 감지 | 시작할 플랫폼 |
| `--device <name>` | 첫 번째 부팅된 시뮬레이터 | iOS 시뮬레이터 이름 또는 UDID |

---

## `tapflow doctor`

환경 문제를 진단합니다.

```sh
tapflow doctor
```

사용 가능한 플랫폼을 자동 감지하고 해당 항목만 검사합니다:

- **Common**: Node.js 버전
- **iOS** (macOS만): Xcode, xcrun simctl, 부팅된 시뮬레이터
- **Android** (`adb`가 PATH에 있는 경우): adb 경로, 실행 중인 AVD

문제가 하나라도 있으면 종료 코드 `1`을 반환합니다.

---

## `tapflow devices`

사용 가능한 시뮬레이터·에뮬레이터 목록을 표시합니다.

```sh
tapflow devices
```

---

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

---

## `tapflow reset`

모든 시뮬레이터와 에뮬레이터를 종료합니다.

```sh
tapflow reset
```

실행 전에 확인 프롬프트가 표시됩니다 (`y/N`). `y`를 입력해야 종료가 진행됩니다.

---

## `tapflow status`

연결된 에이전트, 디바이스, 활성 세션을 표시합니다.

```sh
tapflow status
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | `ws://localhost:4000` | 릴레이 WebSocket URL |

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

---

## `tapflow logs`

릴레이의 최근 로그를 출력합니다 (기본값: 최근 100줄).

```sh
tapflow logs
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay <url>` | `http://localhost:4000` | 릴레이 URL |
| `--lines <n>` | `100` | 표시할 로그 줄 수 (최대 500) |
