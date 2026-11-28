---
title: AI 에이전트 Flow Capture
description: AI 에이전트가 MCP로 기기에서 확인한 경로를 플로우 YAML로 남깁니다. MCP 서버가 AI 에이전트의 탭과 입력을 기록하면 capture_flow가 CI처럼 기기를 초기화해 재생한 뒤 통과한 플로우만 돌려줍니다.
status: experimental
---

# AI 에이전트 Flow Capture

Claude Code 같은 AI 에이전트가 [MCP 서버](/ko/ai-agents/mcp-server)로 기기를 조작하며 확인한 경로를 [플로우](/ko/automation/flows) YAML로 남길 수 있습니다. MCP 서버가 AI 에이전트의 탭, 스와이프, 입력을 기록하면 `capture_flow`가 `tapflow flow run`과 같은 방식으로 기기를 초기화한 뒤 플로우를 재생합니다. YAML은 재생이 통과해야만 돌려주며 재생에는 AI 모델을 쓰지 않습니다. 팀원이 대시보드에서 쓰는 [Flow Capture](/ko/testing/flow-capture)와 같은 일을 AI 에이전트가 합니다. 캡처는 AI 에이전트가 `connect_device`에 `capture: true`를 줄 때만 열립니다.

## 사용 방법 {#how-to-use}

AI 에이전트에게 "로그인 화면을 테스트하고 확인한 경로를 플로우로 남겨줘"처럼 부탁하면 됩니다. AI 에이전트는 `get_testing_guide`에서 아래 순서를 배웁니다.

```text
connect_device (capture: true) → 캡처를 연다
install_app / launch_app       → 앱을 실행한다 (캡처 중에 한 번은 필수)
query_ui_tree, tap, type_text  → 경로를 따라간다 (모두 기록됨)
list_captured_steps            → 번호 붙은 단계와 기대할 수 있는 요소를 본다
capture_flow                   → 고른 단계로 기기를 초기화해 재생하고, 통과하면 YAML을 받는다
```

### 1. 캡처 열기 {#start}

`connect_device`에 `capture: true`를 주면 그 세션에서 캡처가 열립니다. 결과의 `capture.observing`은 좌표로 한 탭이 무엇에 닿았는지 기기가 알려 주는지 말합니다. `capture.note`는 그 조건을 설명합니다([단계 이름이 정해지는 방식](#how-steps-are-named)).

- MCP 서버 하나에는 캡처가 하나만 열립니다. 새 캡처를 열면 어느 기기의 것이든 이전 캡처는 버립니다.
- 캡처 중에 앱을 한 번은 실행해야 합니다(`launch_app`, 또는 `buildId`를 준 `run_flow`). 모든 플로우는 앱 실행으로 시작하므로, 실행한 빌드가 없으면 `capture_flow`가 거절합니다.

### 2. 경로 따라가기 {#walk-the-path}

캡처가 열려 있는 동안 MCP 서버는 그 세션에서 AI 에이전트가 한 일을 기록합니다.

- `tap`에 `element`를 준 탭은 AI 에이전트가 지정한 셀렉터로 기록합니다.
- 좌표로 한 `tap`과 `swipe`는 좌표와 함께, 기기가 알려 준 닿은 요소를 기록합니다.
- `type_text`로 입력한 텍스트, `query_ui_tree`로 읽은 화면, 키, 버튼, 앱 설치와 실행을 기록합니다.
- `run_flow`로 실행한 단계는 AI 에이전트가 직접 쓴 단계 묶음으로 기록합니다.

캡처가 열려 있으면 입력하는 도구가 다르게 동작합니다. 입력한 텍스트가 비밀번호일 수 있어서입니다.

- `type_text`는 입력한 텍스트를 결과로 돌려주지 않습니다. 길이와 입력한 칸(`into`: 칸의 identifier, identifier가 없으면 `(no id)`, 포커스된 칸이 없었으면 `null`)과 그 칸이 내용을 가리는지(`secure`)만 돌려줍니다.
- `run_flow`는 `inputText` 단계가 있는 플로우를 실행하지 않습니다. 텍스트는 `type_text`로 입력해야 캡처가 비밀번호와 일반 텍스트를 구분할 수 있습니다.
- `press_key`와 `run_flow`의 `pressKey`는 문자를 입력하지 않는 키만 받습니다: `Enter`, `Return`, `Backspace`, `Delete`, `Escape`, `Tab`, 방향키, `Home`, `End`, `PageUp`, `PageDown`.

### 3. 단계 고르기 {#choose-steps}

`list_captured_steps`는 기록한 단계에 1부터 번호를 붙여 보여 줍니다. 단계마다 플로우에 들어갈 모양(`step`), 이름이 어디서 왔는지(`origin`), 위치로 재생되는 이유(`fragile`), 그 단계 뒤에 확인할 수 있는 요소(`expect`)가 있습니다.

`expect`에는 그 단계가 화면에 새로 가져온 요소만 나옵니다. 단계 전에 이미 화면에 있던 요소는 터치의 결과를 증명하지 못하므로 빼고 뺀 개수를 `alreadyShown`으로 알려 줍니다. 새로 나온 요소가 하나도 없는 단계는 전부를 `before` 경고와 함께 보여 줍니다. 이 경고가 붙은 요소만 고르면 터치의 결과를 확인하는 기대값이 없는 것으로 보고 머리 주석에 그 경고를 남깁니다.

AI 에이전트는 `capture_flow`에 아래 값만 고를 수 있습니다. YAML을 직접 쓰는 선택지는 없으므로 플로우의 모든 단계는 AI 에이전트가 실제로 했거나 기기가 본 것입니다.

| 인자 | 뜻 |
|---|---|
| `sessionId` | 검증할 세션. 캡처한 세션이나 같은 플랫폼의 다른 세션 |
| `name` | 플로우 이름 |
| `from`, `to` | 플로우에 넣을 단계 범위(번호). 생략하면 처음부터 끝까지 |
| `drop` | 뺄 단계 번호 |
| `expect` | 단계 뒤에 확인할 요소. `{ step, candidate }`로 `list_captured_steps`가 보여 준 후보를 고릅니다 |
| `secrets` | 비밀 값으로 입력한 단계의 이름. `{ step, name }`, 예: `APP_PASSWORD` |

### 4. 검증하기 {#verify}

`capture_flow`는 고른 단계로 플로우를 만들고 기기를 `tapflow flow run`이 실행 전에 하는 것과 같은 방식으로 초기화한 뒤([Flow Capture의 초기화](/ko/testing/flow-capture#range)), CI와 같은 엔진으로 재생합니다.

- 통과하면 `verified: true`와 함께 YAML(`yaml`)과 그 머리 주석의 내용(`notes`)을 돌려줍니다.
- 실패하면 YAML 없이 `verified: false`, 실패한 단계 번호(`failedStep`, `list_captured_steps`의 번호), 실패 메시지, 실패 종류(`failureKind`)를 돌려줍니다. 탭할 요소를 못 찾았으면 그 화면에서 찾았을 셀렉터(`suggestions`)도 함께 돌려줍니다. 캡처는 그대로 남아 있으므로 AI 에이전트는 그 단계를 빼고 다시 검증하거나 경로를 다시 캡처합니다. 실패한 단계를 빼면 그 사실이 YAML 머리 주석에 남습니다.
- 검증하는 동안 기기에 보낸 입력은 캡처에 기록하지 않습니다.
- 기기의 에이전트(시뮬레이터와 에뮬레이터를 다루는 Mac 쪽 tapflow 프로세스)가 실행 전 초기화를 지원하지 않는 버전이면 앱 데이터만 지우고 재생합니다. 결과의 `resetNote`가 그 사실을 알려 줍니다.

### 5. 플로우 저장하기 {#save}

AI 에이전트가 받은 YAML을 앱 저장소에 `.tapflow/flows/<name>.yaml`처럼 저장하면 CI가 `tapflow flow run`으로 실행합니다. 받은 YAML은 이미 재생을 통과한 것이므로 그대로 둡니다. 비밀 값이 있는 플로우는 실행할 때 `--secret`으로 값을 넘깁니다([비밀 값](#secrets)).

## YAML 머리 주석 읽기 {#header-comment}

`capture_flow`가 돌려주는 YAML은 어디서 왔는지와 무엇을 뺐는지를 머리 주석에 적습니다. AI 에이전트가 받은 답은 PR에서 파일을 리뷰하는 사람에게 보이지 않으므로, 리뷰에 필요한 내용은 파일에 남깁니다.

```yaml
# Captured from an AI agent's session over MCP, verified on try 1: 8 steps recorded.
# Left out by the agent: #2, #3

name: sign-in
appId: com.example.app
steps:
  - clearState
  - launchApp
  - tapOn:
      id: email
  - inputText: qa@example.com
  - tapOn:
      id: password
  - inputText:
      secret: APP_PASSWORD
  - tapOn:
      id: sign_in
  - assertVisible:
      label: Welcome back
      exact: true
```

| 주석 | 뜻 |
|---|---|
| `Captured from an AI agent's session over MCP, verified on try N: M steps recorded.` | 몇 번째 검증에서 통과했는지와 기록한 단계 수 |
| `Outside the range (a–b): ...` | 고른 범위 밖이라 들어가지 않은 단계 |
| `Left out by the agent: ...` | AI 에이전트가 뺀 단계 |
| `Left out after they failed in an earlier Verify (dropped-after-verify-failure): ...` | 앞선 검증에서 실패해서 뺀 단계 |
| `Fragile: #N reason` | 요소가 아니라 화면 위치로 재생되는 단계와 그 이유 |
| `The touch was seen to hit another element than the agent named: ...` | AI 에이전트가 지정한 요소와 기기가 본 닿은 요소가 다른 단계. 보이지 않는 오버레이가 덮고 있을 수 있습니다 |
| `Written by the agent (run_flow), not observed: N blocks` | AI 에이전트가 `run_flow`로 직접 쓴 단계 묶음의 수 |
| `Not named by an element whose name holds a typed secret: ...` | 비밀 값을 보여 주는 요소 대신 다른 방법으로 이름을 붙인 단계 |
| `Left out, a step holding a typed secret: ...` | 비밀 값을 담고 있어서 뺀 단계 |
| `Warning: no expectation — the flow checks only that each step could be done` | 기대값이 하나도 없어서 각 단계를 할 수 있었는지만 확인하는 플로우 |
| `Warning: N of M steps left out` | 단계를 3개 이상, 또는 동작하는 단계의 절반 이상 뺐음 |

플로우를 읽을 때는 주석을 무시합니다. 주석은 리뷰를 위해 남깁니다.

## 단계 이름이 정해지는 방식 {#how-steps-are-named}

각 단계의 이름은 그 단계를 할 때 알던 사실로 정합니다. 검증 전에 따로 재생해서 이름을 알아내지 않습니다.

1. **요소를 지정한 탭**은 AI 에이전트가 지정한 셀렉터를 씁니다. 기기가 다른 요소에 닿았다고 알려 주면 셀렉터는 그대로 두고 머리 주석에 그 사실을 남깁니다.
2. **좌표로 한 탭**은 기기가 알려 준 닿은 요소를 씁니다. 그 요소가 탭 직전에 읽은 화면에서 하나만 찾히고 그 중앙이 그 요소일 때만입니다.
3. 그렇지 않으면 탭 직전에 읽은 화면에서 그 좌표에 있는 요소를 씁니다.
4. 그것도 안 되면 화면 위치로 남기고 `fragile`로 표시합니다. 위치 단계가 있는 플로우에는 캡처한 기기의 화면 크기가 `viewport`로 들어가, 다른 크기의 기기에서는 실행 전에 거절됩니다.

스와이프는 다음 탭할 요소를 화면에 가져온 경우 `scroll { until }`로 바뀌어 거리와 상관없이 재생됩니다. 그 밖의 스와이프는 위치 단계로 남습니다.

입력한 텍스트는 입력 직전에 읽은 화면에서 포커스된 칸이 하나이고 그 칸이 내용을 가리지 않을 때(`secure: false`)만 플로우에 그대로 적습니다. 화면을 읽지 않았거나, 포커스된 칸이 없거나, 칸이 내용을 가린다고 하거나, 텍스트에 Tab이나 Return이 들어 있으면 비밀 값으로 다룹니다. 그래서 칸을 누른 뒤 `query_ui_tree`로 화면을 읽고 입력해야 일반 텍스트가 일반 텍스트로 남습니다.

## 비밀 값 {#secrets}

비밀 값으로 다루는 텍스트는 플로우 파일에 적지 않습니다. 플로우에는 `inputText: { secret: NAME }` 단계만 남고 `tapflow flow run`을 실행할 때 `--secret NAME`으로 값을 넘깁니다([플로우 레퍼런스의 비밀 값](/ko/automation/flows#secrets)).

- 이름은 `capture_flow`의 `secrets`로 정합니다. 정하지 않으면 칸이 내용을 가린다고 한 경우 `PASSWORD`, 그렇지 않으면 `SECRET`이 되며 두 번째부터 번호가 붙습니다.
- 이름은 영문자나 `_`로 시작하고 영문자, 숫자, `_`만 씁니다. 한 이름에는 한 값만 쓸 수 있어, 다른 값을 입력한 두 단계에 같은 이름을 주면 거절합니다.
- 비밀 값은 검증할 때만 쓰고 YAML에도 AI 에이전트가 받는 결과에도 들어가지 않습니다.
- 비밀 값을 화면에 보여 주는 요소(방금 입력한 토큰을 보여 주는 복사 버튼 같은 것)는 기대값 후보로 나오지 않고 탭의 이름으로도 쓰지 않습니다. 그런 단계는 다른 방법으로 이름을 붙이거나 빼고 머리 주석에 남깁니다.

## 캡처한 플로우 고치기 {#edit-a-captured-flow}

캡처가 탭과 입력으로 만들 수 없는 것을 더할 때(사라져야 할 로딩 표시나 오류를 확인하는 `assertNotVisible`, 느린 단계의 `timeout`)나 CI에서 실패한 플로우를 고칠 때는 YAML을 직접 고칩니다.

1. `connect_device`에 `capture: false`를 줘서 캡처를 닫습니다. 캡처가 열려 있으면 `run_flow`가 텍스트 입력 단계를 실행하지 않습니다.
2. YAML을 고칩니다.
3. `run_flow`로 두 번 재생해 두 번 모두 통과할 때만 남깁니다.

`run_flow`는 비밀 값을 받지 않으므로 비밀 값을 입력하는 플로우는 재생할 수 없습니다. 그런 플로우는 고치지 말고 다시 캡처합니다.

## 플랫폼 지원 {#platform-support}

좌표로 한 탭이 무엇에 닿았는지 기기가 알려 주는 기능(관찰)은 릴레이와 에이전트가 0.34 이상이어야 합니다. 관찰이 안 되면 `connect_device`의 `capture.observing`이 `false`입니다. 이때 좌표 탭은 탭 직전에 읽은 화면으로 이름을 붙이거나 위치로 남습니다.

| | iOS | Android |
|---|---|---|
| 캡처와 검증 | 지원 | 지원 |
| 좌표 탭 관찰 | 캡처를 연 뒤 시작한 앱 프로세스에서만 | 에뮬레이터의 gRPC 경로로 보낸 탭. adb fallback으로 보낸 터치는 관찰하지 않음 |

iOS 앱은 시작할 때 접근성 설정을 읽으므로 캡처를 열기 전부터 실행 중인 앱의 탭은 관찰되지 않습니다. 캡처를 연 뒤 앱을 새로 설치하거나 실행 인자를 주고 `launch_app`으로 다시 실행하면 관찰됩니다. 관찰이 안 된 탭도 탭 직전에 읽은 화면으로 이름을 붙일 수 있습니다. 검증은 어느 경우든 초기화한 기기에서 시작합니다.

## 제한 사항 {#limits}

- 캡처는 MCP 서버 프로세스의 메모리에만 있고 디스크나 로그에 쓰지 않습니다. 릴레이도 캡처를 저장하지 않습니다.
- 캡처는 기기를 잡고 있는 동안 남습니다. `disconnect_device`로 기기를 놓으면 1시간 뒤에 버립니다. 그 전에 같은 기기에 다시 연결하면 그 시간은 다음에 놓을 때부터 다시 셉니다. 새 캡처를 열거나 `capture: false`로 닫거나 MCP 서버 프로세스가 끝나도 버립니다.
- 검증은 재생하기 전에 기기를 초기화합니다. iOS에서는 기기에 있는 모든 앱의 키체인, 개인정보 보호 권한, 클립보드, 위치가 초기화되므로 다른 앱의 로그인을 유지해야 하는 기기에서는 쓰지 마세요.
- Android에서는 관찰하는 동안 AI 에이전트의 탭이 무엇에 닿았는지 알 때까지 손가락을 떼는 것을 최대 0.25초 늦춥니다. 사람의 탭, 드래그, 플링은 늦추지 않습니다.
- 캡처가 탭과 입력으로 만든 단계에는 `assertNotVisible`과 `timeout`이 들어가지 않습니다. `run_flow`로 실행한 단계는 쓴 그대로 남으므로, AI 에이전트가 그 둘을 넣어 쓴 단계에는 들어갑니다. 그 밖의 곳에는 [캡처한 플로우 고치기](#edit-a-captured-flow)대로 더합니다.
- 실행 인자를 주고 앱을 실행했다면 플로우의 `launchApp`에는 그 인자가 들어가지 않습니다. `list_captured_steps`가 이 사실을 알려 줍니다.

## 문제 해결 {#troubleshooting}

| 증상 | 원인과 해결 |
|---|---|
| `no capture is open — connect_device with capture: true, then use the device` | 열린 캡처가 없습니다. 캡처를 연 적이 없거나, 기기를 놓고 1시간이 지났거나, 새 캡처나 `capture: false`로 버려졌거나, MCP 서버가 다시 시작됐습니다. 캡처를 열고 경로를 다시 따라갑니다. |
| `the flow launches the app, and no build was launched while capturing` | 캡처 중에 앱을 실행하지 않았습니다. `launch_app`으로 실행한 뒤 다시 검증합니다. |
| `cannot reset the app of build ... so it was not verified` | 릴레이가 그 빌드의 bundle id를 알려 주지 못해 앱을 초기화할 수 없었습니다. 초기화 없이 통과한 플로우는 CI에서 실패할 수 있어 검증하지 않습니다. |
| `the device's reset failed for ..., so the flow was not verified` | 초기화가 일부 실패했습니다. 다시 시도하거나 기기를 재부팅합니다. |
| `verified: false`, `refused: [...]` | 고른 값이 맞지 않습니다. `bad-range`(범위가 목록 밖), `out-of-range`(없는 단계 번호), `failed-block`(`run_flow`가 실패한 지점 뒤의 단계), `no-candidate`(보여 주지 않은 기대값이거나 뺀 단계의 기대값), `not-secret`(비밀 값이 아닌 단계에 이름을 줌), `bad-secret-name`, `secret-name-taken`(다른 값에 같은 이름), `nothing-done`(앱 실행 말고 하는 일이 없음). |
| `run_flow`가 `while a capture is open, type with type_text` 로 거절 | 캡처 중에는 `type_text`로 입력합니다. 고친 플로우를 재생하려면 먼저 `capture: false`로 캡처를 닫습니다. |
| `press_key` 가 `while a capture is open, only keys that type no character are pressed` 로 거절 | 문자는 `type_text`로 입력합니다. |

## 관련 문서 {#related}

- [MCP 서버](/ko/ai-agents/mcp-server): 설치, AI 에이전트 연결, 도구 목록
- [Flow Capture](/ko/testing/flow-capture): 팀원이 대시보드에서 자기 동작을 플로우로 저장하는 방법
- [플로우 레퍼런스](/ko/automation/flows): 플로우 파일 형식, `tapflow flow run`, 비밀 값
- [플로우 실행 기록](/ko/automation/runs): CI에서 실행한 플로우의 결과
