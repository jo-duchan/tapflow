---
title: 플로우 레퍼런스
description: "tapflow flow run이 LLM 호출 없이 결정적으로 재생하는 YAML 플로우 형식입니다. 파일 구조, 스텝 종류, 셀렉터, CI 실행, 실행을 지켜보는 링크를 다룹니다."
---

# 플로우 레퍼런스

::: warning 실험적 기능
tapflow의 **AI 에이전트**(MCP 서버)와 **자동화**(플로우 러너)는 실험적 기능입니다. tapflow에서 가장 성숙한 부분은 수동 QA 대시보드이고 두 기능은 아직 다듬어지는 중입니다. 특히 셀렉터 매칭과 앱 실행 직후 타이밍에서 거친 부분이 있을 수 있습니다.
:::

플로우는 YAML로 작성한 UI 테스트 시나리오이며, `tapflow flow run`이 LLM 호출 없이 결정적으로 재생합니다. 같은 플로우는 같은 입력에서 항상 같은 순서로 실행되므로 멱등하고 CI에서 API 비용이 들지 않습니다.

::: info tapflow를 쓰는 세 가지 방식
tapflow를 쓰는 방식은 세 가지이며 모두 같은 기기와 세션 위에서 동작합니다. 브라우저 대시보드에서 팀원이 직접 손으로 테스트하는 **수동 QA**, LLM 에이전트가 MCP로 기기를 조작하는 **AI 에이전트**, 그리고 여기서 다루는 플로우 러너인 **자동화**입니다. 자동화의 주 무대는 CI/CD입니다.

플로우는 사람이 처음부터 손으로 작성하는 언어가 아니라, 코딩 에이전트가 생성하거나 시연에서 뽑아내는 산출물입니다. 에이전트로 작성하는 방법은 [CI/CD에서 MCP 활용](/ko/automation/mcp-ci)을 참고하세요.
:::

## 플로우 파일 구조

플로우 하나는 아래 최상위 키로 이루어집니다.

```yaml
name: login-smoke
appId: com.example.app
steps:
  - clearState
  - launchApp
  - assertVisible: "로그인"
  - tapOn: { id: "com.example.app:id/email" }
  - inputText: "user@example.com"
  - pressKey: Enter
  - tapOn: "로그인"
  - assertVisible: { label: "주문 목록", timeout: 15 }
```

| 키 | 필수 | 설명 |
|-----|------|------|
| `name` | 아니오 | 리포트에 표시되는 이름. 생략하면 파일명을 씁니다. |
| `appId` | 조건부 | 테스트 대상 앱의 번들 ID. `clearState`를 인자 없이 쓸 때 필요합니다. `--build`로 실행하면 그 빌드의 번들 ID와 비교합니다([실행할 플로우 고르기](#choosing-flows)). |
| `tags` | 아니오 | 플로우에 붙이는 태그 목록. `--include-tags`·`--exclude-tags`로 실행할 플로우를 고를 때 씁니다. 태그에는 쉼표를 쓸 수 없습니다. |
| `steps` | 예 | 위에서 아래로 순서대로 실행되는 스텝 목록. |

좌표는 어디서나 0~1로 정규화합니다. 셀렉터가 화면 요소를 직접 가리키므로 플로우에 픽셀 좌표를 직접 적을 일은 거의 없습니다.

## 스텝

어휘는 의도적으로 작게 유지했습니다. 아래 열세 가지로 대부분의 시나리오를 표현할 수 있습니다.

| 스텝 | 형태 | 동작 |
|------|------|------|
| `clearState` | 키워드 또는 `clearState: <bundleId>` | 앱 데이터를 초기화합니다. 키워드 형태는 최상위 `appId`를 씁니다. |
| `launchApp` | 키워드 또는 `launchApp: { arguments, env }` | 테스트 대상 빌드를 실행한 다음 앱 화면이 자리 잡을 때까지 기다립니다. UI 트리 요소의 역할·라벨·id가 1초 동안 그대로이면 화면이 뜬 것으로 보므로 스플래시를 첫 화면으로 착각하지 않습니다. 게임처럼 UI 트리 요소가 없는 화면도 1초 뒤에 넘어갑니다. 라벨이 계속 바뀌는 화면은 처음 읽힌 뒤 3초가 지나면 넘어가고 화면을 전혀 읽지 못하면 셀렉터 기본 대기 시간이 지나야 넘어갑니다. 이 대기 때문에 스텝이 실패하지는 않습니다. 1초 넘게 그대로 있는 스플래시는 첫 화면으로 잘못 볼 수 있습니다. 실행 인자를 넘기는 방법은 [실행 인자](#launch-arguments)에 있습니다. |
| `tapOn` | 셀렉터 | 매칭된 요소의 중심을 탭합니다. |
| `inputText` | 문자열 | 포커스된 입력 필드에 텍스트를 입력합니다. |
| `pressKey` | 키 이름 | 키보드 키를 누릅니다(`Enter`, `Backspace`, `Escape` 등). |
| `swipe` | `{ from, to, durationMs? }` | 두 지점 사이를 스와이프합니다. 좌표는 0~1. `durationMs`는 밀리초 단위 숫자이며 기본값 300, 최대 2147483647입니다. 소수(예: 250.5)도 허용됩니다. |
| `scroll` | 키워드 또는 `scroll: <방향>` | 화면을 스크롤합니다. 인자 없는 형태는 아래로 스크롤합니다. |
| `openUrl` | URL 문자열 | 딥 링크나 URL을 엽니다. |
| `assertVisible` | 셀렉터 | 요소가 나타날 때까지 기다립니다. 나타나지 않으면 실패합니다. |
| `assertNotVisible` | 셀렉터 | 요소가 사라질 때까지 기다립니다. 사라지지 않으면 실패합니다. |
| `pressButton` | 버튼 이름 | 하드웨어 버튼을 누릅니다. [하드웨어 버튼](#hardware-buttons)을 보세요. |
| `longPressOn` | 셀렉터 또는 `{ on, durationMs? }` | 매칭된 요소의 중심을 누른 채로 유지합니다. 기본 1000ms, 최대 60000ms입니다. 시간을 바꾸려면 셀렉터를 `on` 아래에 둡니다. |
| `pinch` | `{ on, scale, durationMs? }` | 요소나 지점의 중심을 두고 두 손가락으로 핀치합니다. [핀치](#pinch)를 보세요. |

고정된 `sleep` 스텝은 없습니다. 대기는 언제나 조건 기반입니다. 화면 전환을 기다리려면 `assertVisible`에 `timeout`을 주면 됩니다.

### 셀렉터

`tapOn`, `assertVisible`, `assertNotVisible`, `longPressOn`, 그리고 `pinch`의 `on`은 셀렉터로 요소를 지정합니다. 셀렉터는 세 가지 형태로 쓸 수 있습니다.

```yaml
# 문자열 하나 — 아래 순서로 해석합니다
- tapOn: "로그인"

# 식별자로 명시
- tapOn: { id: "com.example.app:id/login" }

# 라벨로 명시 + 대기 시간(초)
- tapOn: { label: "로그인", timeout: 20 }

# 라벨이 겹치면 요소 종류로 좁힘
- tapOn: { label: "New Orders", role: button }

# 라벨 없는 행 — 같은 종류 중 N번째를 지정(0부터)
- tapOn: { role: cell, index: 2 }
```

문자열 하나만 쓴 셀렉터는 **정확한 식별자 → 정확한 라벨 → 부분 라벨 → 정확한 플레이스홀더** 순서로 해석합니다. 앞 단계에서 매칭되면 뒤 단계로 넘어가지 않습니다.

플레이스홀더(placeholder)는 비어 있는 입력 필드에 흐리게 보이는 안내 문구입니다. 라벨도 식별자도 없는 입력 필드는 플레이스홀더로 찾을 수 있습니다. 플레이스홀더는 마지막 단계라서 라벨이 같은 문자열인 요소가 있으면 그 요소가 먼저 매칭됩니다. 플레이스홀더는 일부만 같아서는 매칭되지 않습니다. iOS에서는 값을 입력한 뒤에도 같은 플레이스홀더로 그 필드를 찾을 수 있습니다. `label:`로 쓴 셀렉터는 라벨만 봅니다.

`tapOn`에서 셀렉터가 여러 요소에 매칭되면 후보를 나열하며 즉시 실패합니다. 첫 번째를 임의로 고르지 않으므로 애매한 셀렉터는 조용히 잘못된 곳을 탭하는 대신 눈에 보이게 실패합니다. `assertVisible`은 존재 여부만 보므로 하나 이상 매칭되면 통과합니다.

`tapOn`이 아무 요소에도 매칭되지 않거나 여러 요소에 매칭되어 실패하면 러너는 실패 순간의 화면에서 대신 쓸 만한 줄을 최대 3개까지 `try:` 줄로 출력합니다(예: `try: tapOn: "로그인"`). 각 줄은 그 화면에서 정확히 그 요소 하나를 탭하는지 확인한 셀렉터이고 [실행 기록](#run-records)에도 함께 남습니다. 입력 필드는 입력된 값이 드러나지 않도록 라벨이 아니라 `id`나 플레이스홀더로 제안합니다. 이미지는 대소문자, 공백, 구두점을 빼고 비교한 이름이 셀렉터와 같을 때만 제안합니다. 이미지 이름은 대개 화면에 보이는 글자가 아니라 에셋 이름이기 때문입니다. `assertVisible` 실패에는 제안하지 않습니다. 기대한 문구가 없는 것은 앱이 바뀐 탓일 수도 있어서 비슷한 문구로 고치면 회귀를 놓칠 수 있기 때문입니다.

매칭이 애매하면 객체 형태에 구분자를 더합니다.

- `role` — 요소 종류(`button`·`text`·`cell`·`input` 등)로 좁힙니다. 버튼과 그 안의 텍스트가 라벨을 공유할 때 유용합니다.
- `index` — 0부터 세는 순번으로, 남은 매칭 중 N번째를 고릅니다. 라벨·id가 없어 `role`만으로도 여럿이 잡히는 행에 씁니다.

객체 형태는 `id`·`label`·`role` 중 하나는 있어야 하고, `role`·`index`는 그 집합을 더 좁힙니다.

`timeout`은 초 단위이며 기본값은 10초, 최대 2147483.647초(약 24.8일)입니다. 셀렉터마다 개별로 지정할 수 있습니다. 밀리초로 환산해 0이 되는 값(예: 0.0004초)은 거부됩니다.

### 요소 길게 누르기 {#holding-an-element}

`longPressOn`에 셀렉터만 주면 1000ms 동안 누릅니다. 두 플랫폼 모두 이 정도면 길게 누르기로 인식합니다. 다른 시간 동안 누르려면 셀렉터를 `on` 아래에 둡니다.

```yaml
- longPressOn: "메시지"
- longPressOn: { on: "메시지", durationMs: 2500 }
- longPressOn: { on: { id: "row-3" }, durationMs: 2500 }
```

adb fallback으로 스트리밍하는 Android 기기에서 길게 누르려면 같은 릴리스의 android-agent가 필요합니다. 이전 에이전트는 길게 누르기를 탭으로 보내면서도 성공으로 알리므로 `longPressOn` 뒤에는 길게 눌러야 나타나는 결과를 단언으로 확인하세요.

`durationMs`는 셀렉터 안이 아니라 옆에 둡니다. `{ label: "메시지", durationMs: 2500 }`은 거부됩니다. 문자열 셀렉터를 `label:`로 바꾸면 매칭 방식까지 달라지기 때문입니다. `label:`은 식별자를 보지 않습니다.

### 핀치 {#pinch}

`pinch`는 중심 양쪽에 두 손가락을 놓고 손가락 사이 간격을 `scale`배로 바꿉니다. `scale`이 1보다 크면 손가락을 벌려 확대하고 1보다 작으면 모아서 축소합니다. 0.1부터 10까지 1을 뺀 값을 받습니다.

```yaml
- pinch: { on: "지도", scale: 2 }              # 요소 중심에서 확대
- pinch: { on: [0.5, 0.4], scale: 0.5 }        # 지점(0~1)을 중심으로 축소
- pinch: { on: "사진", scale: 3, durationMs: 800 }
```

`on`에는 셀렉터나 지점을 씁니다. 지도나 캔버스처럼 UI 트리에 가리킬 요소가 없는 화면에서는 지점을 씁니다. 동작 시간은 기본 500ms, 최대 60000ms입니다.

`scale`은 정확히 지키고 손가락 간격을 화면에 맞춥니다. 손가락은 여유가 더 많은 축으로 벌어지고 화면 밖으로 나가지 않습니다. 중심이 모서리에 너무 가까워 가장 좁은 간격도 들어가지 않으면 스텝이 실패하고 그 이유를 알려 줍니다.

gRPC나 scrcpy 포인터 채널 없이 adb fallback으로 스트리밍하는 Android 기기는 핀치를 할 수 없습니다. 이때 스텝은 앱의 실패가 아니라 환경 실패(종료 코드 2)로 끝납니다.

### 하드웨어 버튼 {#hardware-buttons}

`pressButton`은 버튼 이름을 받습니다.

| 이름 | iOS | Android |
|------|-----|---------|
| `home` | 지원 | 지원 |
| `lock`, `power` | 기기에 전원 버튼이 있을 때 | 지원(전원 키) |
| `volume_up`, `volume_down` | 기기에 볼륨 버튼이 있을 때 | 지원 |
| `back`, `recent_apps` | 미지원 | 지원 |

iOS에서는 기기 프레임이 선언한 다른 버튼도 이름으로 누를 수 있습니다(예: `action`).

기기에 없는 버튼을 누르는 플로우는 첫 스텝 전에 실패합니다. 그대로 진행하면 한 스텝 뒤 단언에서 실패하는데 그 실패 메시지로는 원인을 알 수 없기 때문입니다. `flow run`이 기기를 고르기 전에 플랫폼을 알 수 있으면(`--build`의 빌드, 또는 `--parallel`과 함께 쓴 `--platform`), 그 플로우를 위해 기기를 부팅하지 않고 바로 실패시키며 나머지 플로우는 계속 실행합니다. iOS의 `lock`처럼 기기에 따라 다른 버튼은 첫 스텝 전에 그 기기를 기준으로 확인합니다. 어느 쪽이든 앱을 테스트하지 못한 것이므로 환경 실패(종료 코드 2)입니다. iOS에서는 `back` 대신 앱의 뒤로 가기 버튼을 `tapOn`으로 누르거나 플로우에 태그를 달아 그 버튼이 있는 플랫폼에서만 실행하세요.

### 상태 초기화

`clearState`는 앱 데이터를 초기화해 매 실행이 같은 시작 상태에서 출발하도록 합니다. Android에서는 `pm clear`, iOS에서는 앱 데이터 컨테이너를 비우는 방식으로 동작하며 설치된 앱 바이너리는 그대로 유지되므로 `clearState` 다음에 `launchApp`을 이어 쓸 수 있습니다.

`tapflow flow run`은 플로우를 시작하기 전에 기기도 리셋합니다. 그래서 실행이 이전 실행의 데이터, 키체인, 권한을 이어받지 않습니다. 플로우 안에서 스텝 사이에 앱을 초기화할 때는 여전히 `clearState`를 씁니다. 실행이 리셋하는 항목은 [`tapflow flow run`](/ko/reference/cli#tapflow-flow-run)에 있습니다.

`launchApp`은 앱이 이미 실행 중이면 앱을 새로 시작하지 않고 마지막 화면을 그대로 앞으로 가져옵니다. 단, [실행 인자](#launch-arguments)를 넘기는 `launchApp`은 예외입니다. 앞선 실행이나 수동 테스트가 남긴 화면에서 플로우가 시작될 수 있으므로 앱의 첫 화면에서 시작해야 하는 플로우는 `launchApp` 앞에 `clearState`를 둡니다. `clearState`는 데이터를 지우기 전에 앱을 종료합니다.

```yaml
# 최상위 appId를 사용
- clearState

# 다른 번들을 명시
- clearState: com.other.app
```

### 실행 인자 {#launch-arguments}

`launchApp`에 `arguments`를 넘기면 앱을 실행할 때 인자를 함께 전달할 수 있습니다. Firebase DebugView처럼 실행 인자로만 켜지는 디버그 옵션이나 스테이징 서버 주소 같은 앱 자체 플래그를 빌드를 새로 만들지 않고 바꿀 수 있습니다.

```yaml
- launchApp:
    arguments:
      FIRDebugEnabled: true
      apiHost: staging.example.com
      AppleLanguages: [en]
    env:
      API_TOKEN: secret-value
```

| 키 | 값 | iOS | Android |
|----|----|-----|---------|
| `arguments` | 문자열, 정수, `true`/`false`, 문자열 목록 | 번들 ID 뒤에 `-키 값`으로 붙습니다. 앱은 `UserDefaults`와 `ProcessInfo.arguments`로 읽습니다 | intent extra로 넘어갑니다. 앱은 `getIntent().getExtras()`로 읽어야 합니다 |
| `env` | 문자열 | 앱 프로세스의 환경 변수가 됩니다 | 지원하지 않습니다. 넘기면 스텝이 실패합니다 |

- 인자나 환경 변수를 넘기면 앱이 이미 실행 중이어도 종료한 뒤 새로 실행합니다. 이미 떠 있는 앱은 실행 인자를 다시 읽지 않기 때문입니다.
- Android에서는 값의 타입이 extra 타입을 정합니다. 정수는 int(범위를 넘으면 long), `true`/`false`는 boolean, 목록은 문자열 배열입니다. 앱이 문자열로 읽어야 하는 숫자는 `port: "8080"`처럼 따옴표로 감싸세요. iOS에서는 모든 값이 문자열로 들어갑니다.
- 소수는 받지 않습니다. 오래된 Android 이미지에는 double extra가 없기 때문입니다. 소수가 필요하면 따옴표로 감싸 문자열로 넘기세요.
- 키는 iOS에서 붙는 `-` 없이 씁니다. `-FIRDebugEnabled`처럼 쓰면 플로우를 불러올 때 거부됩니다.
- 비밀 값은 `env`에 넣으세요. 실행 기록과 실패 메시지에는 인자 값이 그대로 보이지만 환경 변수 값은 `***`로 가려집니다.
- tapflow가 쓰는 환경 변수 이름(`DYLD_`, `TAPFLOW_`, `SIMULATOR_`로 시작하는 이름, `HOME`, `TMPDIR` 등)은 쓸 수 없습니다.
- 서드파티 SDK의 디버그 옵션은 플랫폼마다 켜는 방법이 다릅니다. 예를 들어 Firebase DebugView는 iOS에서는 `FIRDebugEnabled: true`로 켜지지만 Android에서는 intent extra로 켜지지 않고 기기에서 `adb shell setprop debug.firebase.analytics.app <패키지>`를 실행해야 합니다.
- 릴레이와 실행 기기의 에이전트가 모두 실행 인자를 지원하는 버전이어야 합니다. 둘 중 하나라도 이전 버전이면 인자 없이 실행하지 않고 스텝이 실패합니다.
- 릴레이가 `tapflow.config.json`의 [실행 기본값](/ko/reference/configuration#launch-defaults)을 함께 넘길 수 있습니다. 스텝과 기본값에 같은 키가 있으면 스텝의 값을 씁니다. 실행 기록에는 적용된 기본값의 키가 스텝의 인자 뒤에 붙습니다. 값은 남지 않습니다. 예: `launchApp(apiHost="staging.example.com"; config: FIRDebugEnabled, env API_TOKEN)`.

## 실행

```sh
tapflow flow run .tapflow/flows/login-smoke.yaml
```

여러 파일을 한 번에 넘길 수 있습니다.

```sh
tapflow flow run .tapflow/flows/login.yaml .tapflow/flows/checkout.yaml
```

| 옵션 | 설명 |
|------|------|
| `--relay <url>` | 릴레이 URL (기본값 `ws://localhost:4000`) |
| `--token <token>` | 원격 릴레이용 개인 액세스 토큰(PAT). 대시보드에서 만든 API 유형 토큰(`view, builds:write`)을 쓰세요. `TAPFLOW_TOKEN` 환경변수나 [토큰 파일](/ko/automation/mcp-server#token-file)로도 지정할 수 있습니다 |
| `--device <name>` | 대상 기기를 이름으로 지정. 꺼져 있으면 부팅합니다. |
| `--session <id>` | 대상 기기의 세션 ID. 같은 이름의 기기가 여럿이라 `--device`로 하나를 고를 수 없을 때 씁니다. |
| `--build <id>` | 테스트 대상 빌드. 실행 전 설치되고 `launchApp` 스텝이 이 빌드를 실행합니다. |
| `--no-install` | 실행 전에 `--build` 빌드를 설치하지 않습니다. 이미 설치된 빌드로 다시 실행할 때 씁니다. |
| `--junit <path>` | JUnit XML 리포트를 지정한 경로에 씁니다. |
| `--artifacts <dir>` | 실패 스크린샷 저장 디렉터리 (기본값 `.tapflow/artifacts`) |
| `--timeout <seconds>` | 셀렉터 기본 대기 시간 (기본값 10, 최대 2147483.647) |
| `--no-record` | 이 실행을 릴레이에 기록하지 않습니다. |
| `--include-tags <tags>` | 이 태그 중 하나라도 있는 플로우만 실행합니다(쉼표로 구분). |
| `--exclude-tags <tags>` | 이 태그 중 하나라도 있는 플로우는 건너뜁니다(쉼표로 구분). `--include-tags`보다 우선합니다. |

`launchApp` 스텝은 빌드 ID 없이 `--build`로 지정한 빌드를 실행합니다. 덕분에 플로우 파일에 빌드 ID를 하드코딩하지 않아도 되고 CI 실행마다 새 빌드에 그대로 재사용할 수 있습니다.

실행을 시작하면 러너가 `watch this run:` 줄에 대시보드 링크를 출력합니다. 이 링크를 열면 플로우가 기기를 조작하는 모습을 실시간으로 볼 수 있고 실행이 끝나면 보기도 끝납니다. CI 환경에서는 출력하지 않습니다(`CI` 환경 변수, Jenkins의 `JENKINS_URL`, Azure Pipelines의 `TF_BUILD`로 판단합니다). 링크에 릴레이 주소가 그대로 드러나서 공개 저장소의 로그에 남기 때문입니다. 링크 주소가 정해지는 방식과 보기 조건은 [MCP 서버 문서](/ko/automation/mcp-server#watch-the-device)와 같고 여기서는 `TAPFLOW_RELAY_URL` 대신 `--relay` 주소를 씁니다.

### 실행할 플로우 고르기 {#choosing-flows}

넘긴 플로우 파일 가운데 이번 실행에 맞지 않는 플로우는 실행하지 않고 건너뜁니다. 건너뛰는 경우는 두 가지입니다.

- **다른 앱의 플로우**: `--build`로 실행하면 각 플로우의 `appId`를 그 빌드의 번들 ID와 비교하고 다르면 `– login (skipped: flow is for com.example.app, build 42 is com.example.app.debug)`처럼 두 ID를 출력하고 건너뜁니다. 여러 앱의 플로우가 섞인 디렉터리를 한 번에 넘겨도 빌드에 맞는 플로우만 실행됩니다. `appId`가 없는 플로우는 어느 빌드에서나 실행합니다.
- **태그에 걸러진 플로우**: `--include-tags smoke,login`은 두 태그 중 하나라도 있는 플로우만 실행합니다. `--exclude-tags flaky`는 그 태그가 있는 플로우를 건너뛰고 두 옵션이 겹치면 `--exclude-tags`가 이깁니다.

건너뛴 플로우는 실패로 세지 않고 마지막 줄에 `1/1 flows passed, 1 skipped`처럼 따로 셉니다. 실행된 플로우가 하나도 없으면 아무것도 테스트하지 않은 실행이 통과로 보이지 않도록 기기를 고르기 전에 종료 코드 `2`로 멈춥니다. 빌드 ID가 릴레이에 없을 때도 같습니다.

`appId` 비교에는 빌드 정보를 읽을 수 있는 API 유형 토큰(`view, builds:write`)이 필요합니다. 토큰이 없거나 `view`만 있으면 `app check skipped` 줄을 출력하고 `appId`와 상관없이 모든 플로우를 실행합니다. 디버그 빌드처럼 번들 ID에 접미사가 붙는 빌드(`com.example.app.debug`)에서 돌리는 플로우는 `appId`를 그 빌드의 ID로 맞추거나 지우세요.

### 실행 기록 {#run-records}

토큰을 주고 실행하면 러너가 실행 결과를 릴레이에 기록합니다. 플로우별 성공·실패·건너뜀과 건너뛴 이유, 스텝, 각 플로우가 실패하거나 끝난 화면의 스크린샷, 실행한 기기와 그 기기에서 리셋한 항목, `--build`로 준 빌드가 남고 CI에서는 제공자와 브랜치, 커밋, CI 실행 링크도 함께 남습니다. 릴레이가 기록을 만들었으면 실행이 끝날 때 `recorded as run` 줄에 실행 ID를 출력하고 CI가 아니면 그 실행의 대시보드 링크도 함께 출력합니다. 기록은 대시보드의 [Flow Runs](/ko/automation/runs) 페이지에서 봅니다.

- 기록은 실행 결과와 종료 코드를 바꾸지 않습니다. 릴레이가 응답하지 않거나 기록을 거부하면 경고를 한 줄 출력하고 그 실행의 나머지는 기록하지 않습니다. 스크린샷을 릴레이가 받지 못하면(예: 5MB 초과) 따로 경고하고 나머지는 계속 기록합니다. 실행이 끝난 뒤 기록을 마저 보내는 데 최대 10초를 기다립니다. 통과한 플로우의 끝난 화면을 캡처하느라 다음 플로우를 시작하기 전에 스크린샷 한 장만큼, 최대 5초가 걸립니다.
- 기록하는 동안 러너는 플로우마다 영상도 함께 보냅니다. 러너가 이미 받고 있는 기기 화면 스트림을 잘라서 보내므로 플로우 실행이 영상 전송을 기다리지 않습니다. iOS에서는 이를 위해 에이전트에 H.264 스트림을 요청하고 에이전트가 JPEG로 보내도록 설정되어 있으면(`TAPFLOW_IOS_CODEC=jpeg`) 영상을 남기지 않습니다. 영상을 보내지 못하면 경고를 한 줄 출력하고 기록은 그대로 이어집니다. 실행이 끝나면 기록을 먼저 보내고 10초 가운데 남은 시간 안에서 영상을 마저 보냅니다. 릴레이는 통과한 플로우의 영상을 기본 3일 보관하고 영상 전체가 20 GB를 넘으면 통과한 플로우의 영상부터 오래된 순서로 지웁니다.
- 기록하려면 토큰에 `builds:write` 스코프가 있어야 하고 토큰 주인이 Viewer가 아니어야 합니다. API 유형 토큰이면 됩니다.
- 토큰 없이 같은 Mac의 릴레이로 실행하면 기록하지 않고 그렇다고 한 줄 알립니다.
- 빌드에 딸린 기록은 그 빌드가 지워질 때 함께 지워지고 빌드 없이 실행한 기록은 7일 뒤 지워집니다.

### 종료 코드

CI가 결과를 판별할 수 있도록 종료 코드를 계약으로 고정했습니다.

| 코드 | 의미 |
|------|------|
| `0` | 모든 플로우 통과 |
| `1` | 하나 이상의 제품 실패. 제품과 환경 실패가 섞인 실행도 포함 |
| `2` | 실행 전 환경·설정 오류 또는 모든 실패 플로우가 환경 문제인 경우 |
| `130` | `SIGINT`로 취소됨(Ctrl+C, GitHub Actions 잡 취소) |
| `143` | `SIGTERM`으로 취소됨(`kill`의 기본 신호) |

`1`과 `2`를 구분하는 것이 중요합니다. 제품 실패(`1`)와 인프라 문제(`2`)는 CI 대시보드에서 다르게 다뤄야 합니다. 두 종류가 함께 발생하면 회귀를 인프라 문제에 가리지 않도록 `1`을 반환합니다.

플로우를 실행하는 중에 취소된 실행은 세션을 놓고 기록이 있으면 취소됐다고 남긴 뒤 종료합니다. 신호를 한 번 더 보내면 기다리지 않고 바로 종료합니다.

실패한 플로우는 실패 시점의 스크린샷을 아티팩트 디렉터리에 남기고, `--junit`을 주면 각 플로우가 하나의 `testcase`로 기록됩니다. 건너뛴 플로우는 `<skipped>`가 붙은 `testcase`가 됩니다.

## 파일 위치 규약

플로우 파일은 앱 리포지토리의 `.tapflow/flows/`에 두기를 권장합니다. 러너는 임의 경로를 받으므로 강제는 아니지만, CI 예시와 문서는 이 경로를 기본으로 삼습니다.

```text
your-app/
├── .tapflow/
│   └── flows/
│       ├── login-smoke.yaml
│       └── checkout.yaml
└── ...
```

에디터 자동완성을 위한 JSON Schema는 `@tapflowio/flow-runner` 패키지의 `schema/tapflow-flow.schema.json`에 함께 배포됩니다.

## CI에서 실행

self-hosted Mac 러너에서 릴레이와 에이전트가 항상 켜져 있다면, CI 잡은 플로우를 재생하기만 하면 됩니다. 재생 경로에는 LLM이 개입하지 않으므로 API 비용이 들지 않습니다.

```yaml
name: Flow smoke test

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: [self-hosted, macos]

    steps:
      - uses: actions/checkout@v4

      - name: Run flows
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
        run: |
          tapflow flow run .tapflow/flows/*.yaml \
            --relay "$TAPFLOW_RELAY_URL" \
            --device "iPhone 16 Pro" \
            --build "$BUILD_ID" \
            --junit report.xml

      - name: Publish report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flow-results
          path: |
            report.xml
            .tapflow/artifacts/
```

종료 코드 계약 덕분에 스텝이 실패하면(`1` 또는 `2`) 잡도 실패합니다. `if: always()`로 실패 스크린샷과 JUnit 리포트를 실패한 실행에서도 수집합니다.

## run_flow와의 관계

같은 플로우 엔진을 MCP `run_flow` 도구로도 실행할 수 있습니다. 코딩 에이전트가 앱을 탐색하며 시나리오를 한 번 작성해두면, 이후에는 그 플로우를 결정적으로 재생하는 방식입니다. 탐색적으로 헤매는 작업은 개별 MCP 도구로, 검증된 시나리오는 `run_flow`로 재생하는 하이브리드가 됩니다.

작성은 에이전트가, 재생은 결정적 러너가 맡는 구조는 [CI/CD에서 MCP 활용](/ko/automation/mcp-ci)에서 더 자세히 다룹니다.
