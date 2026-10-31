---
title: MCP 서버
description: "@tapflowio/mcp-server를 설치하고 코딩 에이전트에 연결합니다. 코딩 에이전트가 건네주는 링크로 에이전트가 조작하는 기기를 실시간으로 볼 수 있습니다."
---

# MCP 서버

::: warning 실험적 기능
tapflow의 **AI 에이전트**(MCP 서버)와 **자동화**(플로우 러너)는 실험적 기능입니다. tapflow에서 가장 성숙한 부분은 수동 QA 대시보드이고 두 기능은 아직 다듬어지는 중입니다. 특히 셀렉터 매칭과 앱 실행 직후 타이밍에서 거친 부분이 있을 수 있습니다.
:::

`@tapflowio/mcp-server`는 tapflow를 [Model Context Protocol(MCP)](https://modelcontextprotocol.io) 서버로 노출합니다. Claude Code, Codex 등 MCP를 지원하는 LLM 에이전트가 iOS 시뮬레이터와 Android 에뮬레이터를 네이티브 도구로 직접 제어할 수 있습니다. 스크립팅도, 좌표 하드코딩도 필요 없습니다.

세 문서는 이렇게 이어집니다. 여기서 코딩 에이전트를 연결하고, [플로우 레퍼런스](/ko/automation/flows)에서 플로우 YAML 형식을 익힌 뒤, [CI/CD에서 MCP 활용](/ko/automation/mcp-ci)에서 둘을 합칩니다. 에이전트가 플로우를 한 번 작성하면 이후 CI가 그 플로우를 결정적으로 재생합니다.

## 이럴 때 쓰세요

**반복적인 자동화 테스트**에서 진가를 발휘합니다. 단발성 수동 확인은 여전히 직접 하는 게 빠릅니다.

- **CI/CD 회귀 테스트** — 빌드마다 에이전트가 시뮬레이터를 부팅하고, 빌드를 설치하고, 주요 플로우를 순회하고, 스크린샷을 캡처해 회귀를 감지합니다. 사람이 개입할 필요가 없습니다. → [CI/CD에서 MCP 활용하기](/ko/automation/mcp-ci)
- **다중 기기 매트릭스** — iPhone SE (iOS 16), iPhone 15 Pro (iOS 17), Android 에뮬레이터를 직접 전환하지 않고 동일한 플로우를 순차 실행할 수 있습니다.
- **자연어 QA 스크립트** — 개발자가 아닌 QA·PM도 테스트 시나리오를 평문으로 작성하면 에이전트가 실행합니다. 셀렉터나 좌표 매핑이 불필요합니다.

## 연결 구조

```text
LLM 에이전트 (Claude Code 등)
    ↓  MCP 프로토콜 (stdio)
@tapflowio/mcp-server
    ↓  WebSocket + REST
tapflow relay
    ↓  WebSocket
Mac 에이전트 (iOS · Android)
```

MCP 서버는 LLM 에이전트와 자체 호스팅 릴레이를 연결하는 로컬 프로세스입니다. 앱 데이터는 네트워크 밖으로 나가지 않습니다.

## 사전 조건

- tapflow 릴레이가 실행 중이어야 합니다.
- 대시보드에서 **개인 액세스 토큰**(PAT)을 발급받아야 합니다.
  **Settings → Tokens → New token**에서 Type을 **API**로 선택합니다. Tokens 메뉴는 Admin, Developer, QA에게 보입니다.

## 설치

```sh
npm install -g @tapflowio/mcp-server
```

## 설정

### Claude Code

`claude mcp add` 명령어로 바로 등록할 수 있습니다.

```sh
claude mcp add tapflow --scope project \
  --env TAPFLOW_RELAY_URL=ws://localhost:4000 \
  --env TAPFLOW_TOKEN=tflw_pat_your_token_here \
  -- tapflow-mcp
```

`--scope project`로 등록하면 `.mcp.json`에 저장되어 팀과 공유됩니다. 본인만 사용할 경우 `--scope local`(기본값)을 사용하세요.

릴레이가 원격 서버에 있다면 URL을 변경합니다.

```sh
claude mcp add tapflow --scope project \
  --env TAPFLOW_RELAY_URL=wss://your-relay.example.com \
  --env TAPFLOW_TOKEN=tflw_pat_your_token_here \
  -- tapflow-mcp
```

### 다른 MCP 클라이언트 (Cursor, VS Code, Codex)

MCP를 지원하는 클라이언트라면 모두 tapflow를 사용할 수 있습니다. MCP 설정 JSON에 아래를 추가하세요.

```json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "ws://localhost:4000",
        "TAPFLOW_TOKEN": "tflw_pat_your_token_here"
      }
    }
  }
}
```

## 환경 변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `TAPFLOW_RELAY_URL` | 릴레이 WebSocket URL | `ws://localhost:4000` |
| `TAPFLOW_TOKEN` | **API** 유형 PAT(`view, builds:write`). **Settings → Tokens**에서 발급합니다. 비워 두면 [토큰 파일](#token-file)에서 읽습니다 | (없음) |
| `TAPFLOW_TOKEN_FILE` | 토큰 파일 경로 | `~/.config/tapflow/credentials.json` |

## 토큰을 파일에 두기 {#token-file}

`TAPFLOW_TOKEN`을 주지 않으면 MCP 서버는 토큰을 파일에서 읽습니다. 파일에는 `tapflow token set`으로 저장하는 것이 가장 간단합니다. 이 명령은 저장하기 전에 릴레이에 토큰을 확인합니다. `tapflow` CLI가 없는 컴퓨터에서는 아래 형식으로 직접 써도 됩니다. 릴레이가 토큰을 거부하면 파일을 다시 읽어 한 번 더 시도하므로 토큰을 바꿀 때 MCP 서버를 다시 등록하거나 재시작하지 않아도 됩니다.

- 파일은 `~/.config/tapflow/credentials.json`에 둡니다. `XDG_CONFIG_HOME`이 있으면 그 아래 `tapflow/credentials.json`을 쓰고 `TAPFLOW_TOKEN_FILE`이 있으면 그 경로를 씁니다. MCP 서버를 실행하는 컴퓨터의 홈 디렉터리이고 릴레이가 도는 Mac의 홈 디렉터리가 아닙니다.
- 토큰은 릴레이마다 따로 둡니다. 키는 릴레이 주소의 origin이고 `ws://`는 `http://`로, `wss://`는 `https://`로 적습니다.
- 파일에 토큰이 들어 있으므로 권한을 `600`으로 두어 본인만 읽게 합니다. 다른 사용자가 읽을 수 있으면 MCP 서버가 경고합니다(Windows에서는 확인하지 않습니다).

```json
{
  "version": 1,
  "relays": {
    "http://localhost:4000": { "token": "tflw_pat_your_token_here" }
  }
}
```

`TAPFLOW_TOKEN`이 있으면 그 값이 파일보다 우선하고 파일을 다시 읽어도 바뀌지 않습니다. 등록할 때 넣은 `TAPFLOW_TOKEN`을 파일로 옮기려면 MCP 등록에서 그 값을 지우세요.

토큰을 폐기하면 릴레이가 바로 연결을 닫습니다. 새 토큰을 파일에 쓰면 다음 도구 호출에서 새 토큰으로 다시 연결합니다. 이때 릴레이는 이전 연결이 잡고 있던 세션을 놓아주므로 `connect_device`를 다시 불러야 합니다.

릴레이가 도는 Mac에서 릴레이 포트로 바로 접속하면 토큰 없이도 MCP 서버가 시작하고 기기를 조작할 수 있습니다. `screenshot`, `query_ui_tree`, `list_builds`, `list_runs`, `get_run`은 이때도 토큰이 필요합니다. 릴레이가 토큰을 거부하면 어느 릴레이가 어디서 온 토큰을 거부했는지와 고치는 방법을 알려 줍니다.

## 사용 가능한 도구

| 도구 | 설명 |
|------|------|
| `list_builds` | 릴레이의 앱·빌드 목록 조회 (`install_app`·`launch_app`에 넘길 `buildId`의 출처) |
| `list_devices` | 연결된 시뮬레이터·에뮬레이터 목록 조회 |
| `connect_device` | 세션 참여 (제어 전 필수). 기기를 지켜볼 수 있는 대시보드 링크 `watchUrl`을 함께 돌려줌 |
| `disconnect_device` | 세션 종료 |
| `boot_device` | 시뮬레이터·에뮬레이터 부팅 |
| `shutdown_device` | 기기 전원 종료 (리소스 반납·다음 콜드 부팅 강제) |
| `screenshot` | 현재 화면 캡처 (PNG, iOS는 요청 시 JPEG) |
| `query_ui_tree` | 화면 UI를 구조화된 접근성 트리로 조회 (role·label·identifier·frame) |
| `tap` | 좌표 터치 |
| `swipe` | 스와이프 |
| `type_text` | 텍스트 입력 |
| `press_key` | 키보드 키 입력 |
| `press_button` | 하드웨어 버튼 입력 (홈, 잠금 등) |
| `install_app` | 앱 설치 |
| `launch_app` | 앱 실행. `arguments`·`env`로 [실행 인자](/ko/automation/flows#launch-arguments)를 넘길 수 있습니다. 결과의 `applied`에 앱이 받은 키가 [실행 기본값](/ko/reference/configuration#launch-defaults)까지 포함해 남습니다 |
| `run_flow` | YAML 플로우를 결정적으로 재생 (추가 LLM 호출 없음) |
| `list_runs` | `tapflow flow run`이 릴레이에 남긴 실행 기록 목록 조회 (상태·빌드·플로우 이름·CI 여부로 거르기) |
| `get_run` | 실행 기록 하나 조회. 실패한 플로우의 단계(통과한 플로우는 단계 수)·실패 메시지·플로우 파일 경로와 실패한 플로우의 스크린샷(최대 4장) |
| `get_testing_guide` | 이 도구들로 모바일 기능을 테스트하는 방법. 다룰 경우, 여기서 테스트할 수 없는 것, 잘못된 버그 판정을 피하는 법, 검증된 경로를 플로우로 남기는 법, 보고 형식 |

## 일반적인 워크플로우

LLM 에이전트는 보통 아래 순서로 도구를 호출합니다.

```text
get_testing_guide  → 무엇을 다루고 어떻게 보고할지 확인 (테스트 전에 한 번)
list_devices       → 사용 가능한 기기와 sessionId 확인
connect_device     → 세션 참여, 지켜볼 링크를 사람에게 전달
boot_device        → 부팅 대기 (이미 부팅 중이면 생략 가능)
install_app        → 앱 설치
launch_app         → 앱 실행
query_ui_tree      → 화면 읽기 (시각적인 확인에만 screenshot)
tap / swipe / ...  → 조작
query_ui_tree      → 결과 확인 → 반복
run_flow           → 검증한 시나리오를 플로우로 재생
disconnect_device  → 세션 종료, 다른 사람이 기기를 쓸 수 있게 반납
```

::: info 시뮬레이터 이미 부팅된 경우
`list_devices` 응답의 `status` 필드가 `"booted"`이면 `boot_device`를 생략할 수 있습니다.
:::

`list_devices` 응답에는 대시보드에서 정한 `displayName`(Admin이 붙인 이름), `hidden`(Admin이 목록에서 숨김), `favourite`(토큰 주인의 즐겨찾기)이 함께 올 수 있습니다. 대시보드 표시용 값이라 기기 선택에는 영향이 없습니다. 숨긴 기기도 목록에 있고 연결할 수 있으며, 기기를 가리킬 때는 `displayName`이 아니라 `name`을 씁니다. [기기 목록 정리](/ko/testing/qa-session#organize-devices)를 참고하세요.

CI 파이프라인에서 실행하는 방법은 [CI/CD에서 MCP 활용하기](/ko/automation/mcp-ci)를 참고하세요.

## 에이전트가 받는 안내 {#agent-guidance}

MCP 서버는 코딩 에이전트에게 두 가지 안내를 줍니다. 그래서 경우를 하나하나 적지 않고 "로그인 화면 테스트해 줘"라고만 요청해도 꼼꼼히 테스트합니다.

- **서버 instructions**: 에이전트가 연결할 때 한 번 전달됩니다. 도구 호출 순서, 화면은 스크린샷보다 `query_ui_tree`로 읽기, 끝나면 기기 반납하기, 부팅 거절이나 확인되지 않은 입력이 무슨 뜻인지를 담습니다. MCP 서버 instructions를 지원하는 클라이언트가 이 내용을 에이전트 컨텍스트에 넣습니다. Claude Code와 VS Code가 지원하고, Gemini CLI는 신뢰한 폴더에서만 넣습니다. Codex는 tapflow 도구 묶음의 설명으로 보여 줍니다. 지원하지 않는 클라이언트를 위해 가장 중요한 두 규칙은 `connect_device` 설명에도 들어 있습니다.
- **`get_testing_guide`**: 에이전트가 테스트 전에 부르는 도구입니다. 다룰 경우, 이 도구들로 테스트할 수 없는 것, 버그로 판단하기 전에 확인할 것, 검증된 경로를 플로우로 남기는 법, 보고 형식을 돌려줍니다.

instructions는 세션마다 약 400토큰이 듭니다. 테스트 가이드는 약 1,200토큰이고, 에이전트가 부를 때만 듭니다.

## 코딩 에이전트가 조작하는 기기 보기 {#watch-the-device}

`connect_device`는 결과에 `watchUrl`을 함께 돌려줍니다. 이 링크를 브라우저에서 열면 코딩 에이전트가 조작하는 기기 화면을 실시간으로 볼 수 있습니다. 도구 설명에 요청한 사람에게 이 링크를 전달하라는 안내가 들어 있습니다. 그래서 "로그인 화면을 테스트해 줘"처럼 요청하면 코딩 에이전트가 테스트를 시작하면서 링크를 알려 줍니다.

이 화면에는 링크로만 들어갈 수 있습니다. 코딩 에이전트에게 테스트를 맡긴 사람이 자기 작업을 지켜보는 용도라서 대시보드에 따로 목록을 두지 않았습니다. 다른 팀원이 QA 세션의 기기 목록을 열면 그 기기는 사용 중으로 표시되고 이유로 **Coding agent is driving it**이 함께 나옵니다.

- 보기 전용입니다. 화면을 눌러도 기기에는 아무것도 전달되지 않고, 소리도 나오지 않습니다.
- 대시보드에 로그인한 팀원이면 누구나 볼 수 있습니다. 코딩 에이전트가 기기에 입력하는 내용도 화면에 그대로 보이므로, 팀에 보여서는 안 되는 값은 테스트에 쓰지 마세요.
- 세션 하나를 동시에 4명까지 볼 수 있습니다.
- 기기 옆 **Agent activity**에 코딩 에이전트가 한 일이 일어난 순서대로 쌓입니다. 기기 화면 위에는 마지막으로 탭한 위치에 파란 커서가 남고 다음 위치로 옮겨 갈 때 지나온 길이 잠깐 보입니다. `run_flow`나 `tapflow flow run`으로 플로우를 실행하면 스텝마다 한 줄이 생기고 그 아래에 스텝 안에서 한 행동이 보입니다. 스텝은 펼쳐진 채로 나오고 필요하면 접을 수 있습니다. 입력한 글자는 글자 수만 보여 주고 연 URL과 누른 문자 키는 보여 주지 않습니다. 기록은 저장하지 않으므로 페이지를 연 뒤의 행동만 보입니다. 세션이 끝나도 페이지를 닫기 전까지는 마지막 화면과 기록이 남습니다.
- 코딩 에이전트의 연결이 잠깐 끊기면 마지막 화면을 둔 채 돌아오기를 기다립니다. 코딩 에이전트가 세션을 마치거나(`disconnect_device`) 다른 팀원이 그 기기를 이어서 쓰기 시작하면 보기가 끝납니다.

::: details 링크 주소가 정해지는 방식
릴레이에 팀원이 열 수 있는 주소(터널이나 `relay.url`)가 설정되어 있으면 링크는 그 주소를 씁니다. 팀원에게 그대로 공유할 수 있는 주소입니다. 그런 주소가 없으면(`relay.url`이 `localhost`인 경우 포함) MCP 서버가 접속한 `TAPFLOW_RELAY_URL`로 링크를 만듭니다. 예를 들어 `ws://localhost:4000`으로 접속했다면 링크는 `http://localhost:4000/automation/sessions/`로 시작하며 MCP 서버를 실행한 사람의 컴퓨터에서 열립니다. 팀원에게 보낼 주소가 필요하면 [외부 접속](/ko/operate/external-access)을 참고하세요.
:::

## 실패한 실행 고치기 {#fix-a-failed-run}

CI에서 `tapflow flow run`이 실패하면 코딩 에이전트에게 그 실행을 읽고 플로우를 고치게 할 수 있습니다. 예를 들어 "어젯밤 실패한 CI 실행 고쳐 줘"라고 요청하면 코딩 에이전트는 아래 순서로 도구를 씁니다.

```text
list_runs   → status: failed로 실패한 실행 찾기
get_run     → 어느 단계가 왜 실패했는지, 그 순간의 화면, 플로우 파일 경로 확인
(파일 수정)  → 기록된 경로의 YAML을 고침
run_flow    → 고친 플로우를 기기에서 다시 재생해 확인
```

- 기록된 플로우 파일 경로는 러너에 넘긴 그대로라서 러너가 실행된 디렉터리(CI면 그 잡의 작업 디렉터리)가 기준입니다. 코딩 에이전트는 자기 체크아웃에서 그 파일을 찾아 고칩니다.
- 실행 기록은 읽기만 합니다. 다시 실행하는 것은 코딩 에이전트가 `run_flow`로 직접 하고 CI를 다시 돌리지는 않습니다.
- `get_run`은 실패한 플로우의 스크린샷을 최대 4장까지 함께 돌려줍니다. 통과한 플로우의 마지막 화면과 영상은 포함하지 않으니 결과의 `url`로 실행 페이지를 열어 확인하세요.
- `failureKind`가 `environment`인 실패는 앱이나 플로우가 아니라 기기·에이전트·릴레이 문제입니다. 이때는 플로우를 고칠 필요가 없습니다.

결과의 `url`은 MCP 서버가 접속한 `TAPFLOW_RELAY_URL`로 만듭니다. 기기 보기 링크와 달리 릴레이의 공개 주소를 쓰지 않으므로 컨테이너 네트워크 안의 이름(`ws://relay:4000` 등)으로 접속했다면 그 링크는 브라우저에서 열리지 않습니다.

실행 기록이 남는 조건과 대시보드 화면은 [플로우 실행 기록](/ko/automation/runs)을 참고하세요.
