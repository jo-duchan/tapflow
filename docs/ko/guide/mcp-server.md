# MCP 서버

::: warning 실험적 기능
tapflow의 **AI 자동화 축**인 MCP 서버와 플로우 러너는 실험적 기능입니다. 성숙한 정식 경로는 수동 QA 대시보드이며, 이 축은 부가 기능으로서 아직 다듬어지는 중입니다. 특히 셀렉터 매칭과 앱 실행 직후 타이밍에서 거친 부분이 있을 수 있습니다.
:::

`@tapflowio/mcp-server`는 tapflow를 [Model Context Protocol(MCP)](https://modelcontextprotocol.io) 서버로 노출합니다. Claude Code, Codex 등 MCP를 지원하는 LLM 에이전트가 iOS 시뮬레이터와 Android 에뮬레이터를 네이티브 도구로 직접 제어할 수 있습니다. 스크립팅도, 좌표 하드코딩도 필요 없습니다.

세 문서는 이렇게 이어집니다. 여기서 에이전트를 연결하고, [플로우 레퍼런스](/ko/guide/writing-flows)에서 플로우 YAML 형식을 익힌 뒤, [CI/CD에서 MCP 활용](/ko/guide/mcp-ci)에서 둘을 합칩니다. 에이전트가 플로우를 한 번 작성하면 이후 CI가 그 플로우를 결정적으로 재생합니다.

## 이럴 때 쓰세요

**반복적인 자동화 테스트**에서 진가를 발휘합니다. 단발성 수동 확인은 여전히 직접 하는 게 빠릅니다.

- **CI/CD 회귀 테스트** — 빌드마다 에이전트가 시뮬레이터를 부팅하고, 빌드를 설치하고, 주요 플로우를 순회하고, 스크린샷을 캡처해 회귀를 감지합니다. 사람이 개입할 필요가 없습니다. → [CI/CD에서 MCP 활용하기](/ko/guide/mcp-ci)
- **다중 디바이스 매트릭스** — iPhone SE (iOS 16), iPhone 15 Pro (iOS 17), Android 에뮬레이터를 직접 전환하지 않고 동일한 플로우를 순차 실행할 수 있습니다.
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

MCP 서버는 LLM 에이전트와 자체 호스팅 relay를 연결하는 로컬 프로세스입니다. 앱 데이터는 네트워크 밖으로 나가지 않습니다.

## 사전 조건

- tapflow relay가 실행 중이어야 합니다.
- 대시보드에서 **Personal Access Token(PAT)** 을 발급받아야 합니다.
  Settings → Tokens → Create Token

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
| `TAPFLOW_TOKEN` | Personal Access Token | (필수) |

## 사용 가능한 도구

| 도구 | 설명 |
|------|------|
| `list_devices` | 연결된 시뮬레이터·에뮬레이터 목록 조회 |
| `connect_device` | 세션 참여 (제어 전 필수) |
| `disconnect_device` | 세션 종료 |
| `boot_device` | 시뮬레이터·에뮬레이터 부팅 |
| `shutdown_device` | 기기 전원 종료 (리소스 반납·다음 콜드 부팅 강제) |
| `screenshot` | 현재 화면 캡처 (PNG 또는 JPEG) |
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
list_devices       → 사용 가능한 디바이스와 sessionId 확인
connect_device     → 세션 참여
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

CI 파이프라인에서 실행하는 방법은 [CI/CD에서 MCP 활용하기](/ko/guide/mcp-ci)를 참고하세요.
