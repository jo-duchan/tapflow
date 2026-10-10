---
title: MCP 서버
description: "@tapflowio/mcp-server를 설치하고 코딩 에이전트에 연결합니다. 코딩 에이전트가 조작하는 기기는 대시보드에서 팀원이 실시간으로 볼 수 있습니다."
---

# MCP 서버

::: warning 실험적 기능
tapflow의 **AI 자동화 축**인 MCP 서버와 플로우 러너는 실험적 기능입니다. 성숙한 정식 경로는 수동 QA 대시보드이며, 이 축은 부가 기능으로서 아직 다듬어지는 중입니다. 특히 셀렉터 매칭과 앱 실행 직후 타이밍에서 거친 부분이 있을 수 있습니다.
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
claude mcp add --scope project \
  --env TAPFLOW_RELAY_URL=ws://localhost:4000 \
  --env TAPFLOW_TOKEN=tflw_pat_your_token_here \
  tapflow -- tapflow-mcp
```

`--scope project`로 등록하면 `.mcp.json`에 저장되어 팀과 공유됩니다. 본인만 사용할 경우 `--scope local`(기본값)을 사용하세요.

릴레이가 원격 서버에 있다면 URL을 변경합니다.

```sh
claude mcp add --scope project \
  --env TAPFLOW_RELAY_URL=wss://your-relay.example.com \
  --env TAPFLOW_TOKEN=tflw_pat_your_token_here \
  tapflow -- tapflow-mcp
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
| `TAPFLOW_TOKEN` | **API** 유형 PAT(`view, builds:write`). **Settings → Tokens**에서 발급합니다 | (필수) |

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
| `launch_app` | 앱 실행 |
| `run_flow` | YAML 플로우를 결정적으로 재생 (추가 LLM 호출 없음) |

## 일반적인 워크플로우

LLM 에이전트는 보통 아래 순서로 도구를 호출합니다.

```text
list_devices       → 사용 가능한 기기와 sessionId 확인
connect_device     → 세션 참여, 지켜볼 링크를 사람에게 전달
boot_device        → 부팅 대기 (이미 부팅 중이면 생략 가능)
install_app        → 앱 설치
launch_app         → 앱 실행
screenshot         → 화면 캡처 → LLM이 분석
tap / swipe / ...  → 조작
screenshot         → 결과 확인 → 반복
disconnect_device  → 세션 종료
```

::: info 시뮬레이터 이미 부팅된 경우
`list_devices` 응답의 `status` 필드가 `"booted"`이면 `boot_device`를 생략할 수 있습니다.
:::

CI 파이프라인에서 실행하는 방법은 [CI/CD에서 MCP 활용하기](/ko/automation/mcp-ci)를 참고하세요.

## 코딩 에이전트가 조작하는 기기 보기 {#watch-the-device}

`connect_device`는 결과에 `watchUrl`을 함께 돌려줍니다. 이 링크를 브라우저에서 열면 코딩 에이전트가 조작하는 기기 화면을 실시간으로 볼 수 있습니다. 도구 설명에 요청한 사람에게 이 링크를 전달하라는 안내가 들어 있습니다. 그래서 "로그인 화면을 테스트해 줘"처럼 요청하면 코딩 에이전트가 테스트를 시작하면서 링크를 알려 줍니다.

링크가 없어도 대시보드 사이드바의 **AI Sessions**에서 지금 코딩 에이전트가 조작 중인 기기를 찾을 수 있습니다. QA 세션의 기기 목록에서도 그런 기기에는 **Coding agent is driving it · Watch**(플로우 러너라면 **Flow runner is driving it · Watch**)가 표시되고 누르면 같은 화면이 열립니다.

- 보기 전용입니다. 화면을 눌러도 기기에는 아무것도 전달되지 않고, 소리도 나오지 않습니다.
- 대시보드에 로그인한 팀원이면 누구나 볼 수 있습니다. 코딩 에이전트가 기기에 입력하는 내용도 화면에 그대로 보이므로, 팀에 보여서는 안 되는 값은 테스트에 쓰지 마세요.
- 세션 하나를 동시에 4명까지 볼 수 있습니다.
- 코딩 에이전트의 연결이 잠깐 끊기면 마지막 화면을 둔 채 돌아오기를 기다립니다. 코딩 에이전트가 세션을 마치거나(`disconnect_device`) 다른 팀원이 그 기기를 이어서 쓰기 시작하면 보기가 끝납니다.

::: details 링크 주소가 정해지는 방식
릴레이에 팀원이 열 수 있는 주소(터널이나 `relay.url`)가 설정되어 있으면 링크는 그 주소를 씁니다. 팀원에게 그대로 공유할 수 있는 주소입니다. 그런 주소가 없으면(`relay.url`이 `localhost`인 경우 포함) MCP 서버가 접속한 `TAPFLOW_RELAY_URL`로 링크를 만듭니다. 예를 들어 `ws://localhost:4000`으로 접속했다면 링크는 `http://localhost:4000/automation/sessions/`로 시작하며 MCP 서버를 실행한 사람의 컴퓨터에서 열립니다. 팀원에게 보낼 주소가 필요하면 [외부 접속](/ko/operate/external-access)을 참고하세요.
:::
