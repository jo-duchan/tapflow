# MCP 서버

`@tapflowio/mcp-server`는 tapflow를 [Model Context Protocol(MCP)](https://modelcontextprotocol.io) 서버로 노출합니다. Claude Code, Codex 등 MCP를 지원하는 LLM 에이전트가 tapflow를 네이티브 도구로 직접 호출할 수 있습니다.

```
LLM 에이전트 (Claude Code 등)
    ↓  MCP 프로토콜 (stdio)
@tapflowio/mcp-server
    ↓  WebSocket + REST
tapflow relay
    ↓  WebSocket
Mac 에이전트 (iOS · Android)
```

## 사전 조건

- tapflow relay가 실행 중이어야 합니다.
- 대시보드에서 **Personal Access Token(PAT)** 을 발급받아야 합니다.
  Settings → Tokens → Create Token

## 설치

```sh
npm install -g @tapflowio/mcp-server
```

## Claude Code 설정

프로젝트의 `.claude/mcp.json`에 추가합니다.

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

릴레이가 원격 서버에 있는 경우 `TAPFLOW_RELAY_URL`을 해당 주소로 변경합니다.

```json
{
  "TAPFLOW_RELAY_URL": "wss://your-relay.example.com"
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
| `screenshot` | 현재 화면 캡처 (PNG 또는 JPEG) |
| `tap` | 좌표 터치 |
| `swipe` | 스와이프 |
| `type_text` | 텍스트 입력 |
| `press_key` | 키보드 키 입력 |
| `press_button` | 하드웨어 버튼 입력 (홈, 잠금 등) |
| `install_app` | 앱 설치 |
| `launch_app` | 앱 실행 |

## 일반적인 워크플로우

LLM 에이전트는 보통 아래 순서로 도구를 호출합니다.

```
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

## 예시 프롬프트

Claude Code에서 아래와 같이 자연어로 지시할 수 있습니다.

```
시뮬레이터를 열고 샌드박스 앱의 로그인 화면을 캡처해줘.
이메일 필드에 test@example.com을 입력하고 로그인 버튼을 탭한 다음
결과 화면을 캡처해서 오류가 있는지 확인해줘.
```
