# CI/CD에서 MCP 활용하기

자동 QA 축은 두 단계로 나뉩니다. LLM 에이전트가 앱을 탐색하며 시나리오를 **작성**하고 그 시나리오를 결정적 러너가 **재생**합니다. 핵심 원칙은 이렇습니다. LLM은 작성 시점에만 개입하고 재생은 결정적으로 이루어집니다.

이 구분이 CI를 바꿉니다. 매 실행마다 LLM이 화면을 판단하면 결과가 실행마다 달라지고 API 비용도 매번 듭니다. 반면 검증된 시나리오를 [플로우](/ko/guide/writing-flows)로 저장해두면, CI는 LLM 호출 없이 그 플로우를 재생하기만 하므로 멱등하고 비용이 들지 않습니다.

## 결정적 재생 — CI의 주경로

CI 잡은 저장된 플로우를 `tapflow flow run`으로 재생합니다. 재생 경로에는 LLM이 없으므로 같은 입력에서 항상 같은 결과가 나오고 API 비용도 발생하지 않습니다.

self-hosted Mac 러너에 relay와 에이전트가 상시 가동돼 있다면, 잡은 플로우를 실행하고 종료 코드로 성공 여부를 판별합니다.

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
```

플로우 YAML 문법, 셀렉터 규칙, 종료 코드 계약은 [플로우 레퍼런스](/ko/guide/writing-flows)에서 자세히 다룹니다.

## 에이전트로 플로우 작성

플로우는 사람이 손으로 처음부터 쓰기보다, 에이전트가 앱을 탐색하며 생성하는 산출물입니다. Claude Code 같은 MCP 지원 에이전트에 시나리오를 자연어로 요청하면, 에이전트가 tapflow MCP 도구로 앱을 직접 조작해 동작을 확인하고, 검증된 시퀀스를 플로우 YAML로 뽑아 리포지토리에 커밋합니다.

에이전트를 relay에 연결하려면 저장소 루트에 `.mcp.json`을 두고 relay를 가리키게 합니다.

```json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "ws://localhost:4000",
        "TAPFLOW_TOKEN": "INJECTED_AT_RUNTIME"
      }
    }
  }
}
```

에이전트에게는 단계별 지시가 아니라 결과를 기술하는 요청이 좋습니다.

```text
로그인 화면에서 이메일과 비밀번호를 입력하고 주문 목록까지 확인하는 플로우를 만들어줘.
앱을 실제로 조작해 동작을 확인한 뒤, 검증된 시퀀스를 .tapflow/flows/login-smoke.yaml로 저장해줘.
```

에이전트가 `query_ui_tree`로 화면 요소를 읽고 `tap`·`type_text`로 조작하며 시나리오를 확인한 다음, 셀렉터 기반 플로우로 저장합니다. 이렇게 만든 플로우는 이후 CI에서 결정적으로 재생됩니다.

## 검증된 시나리오는 run_flow로 재생

에이전트 세션 안에서도 결정적 재생을 쓸 수 있습니다. `run_flow` 도구는 저장된 플로우를 같은 결정적 엔진으로 재생하므로, 에이전트가 탐색적으로 헤매는 부분은 개별 MCP 도구로, 이미 검증된 시나리오는 `run_flow`로 재생하는 하이브리드가 됩니다.

## 탐색적 실행 — 선택 사항

새 화면을 탐색하거나 플로우를 디버깅할 때는 CI에서 LLM이 직접 판단하게 할 수도 있습니다. 이 방식은 매 실행마다 LLM이 화면을 읽으므로 결정적이지 않고 API 비용이 들지만, 아직 플로우로 고정하지 않은 시나리오를 빠르게 확인하는 데 유용합니다.

이때는 사전 조건이 더 필요합니다.

| 항목 | 설명 |
|------|------|
| tapflow relay (상시 가동) | Mac 에이전트가 연결된 relay. LAN에 있는 Mac mini 한 대면 충분합니다. |
| `TAPFLOW_TOKEN` | Developer 이상 권한의 PAT. CI 시크릿으로 저장하세요. |
| `ANTHROPIC_API_KEY` | `claude`를 비대화형으로 실행하는 데 필요합니다. CI 시크릿으로 저장하세요. |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |

```yaml
      - name: Exploratory check
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          WORKSPACE: ${{ github.workspace }}
        run: |
          claude --mcp-config .mcp.json -p "
            사용 가능한 디바이스를 조회하고 부팅된 iOS 시뮬레이터에 연결하세요.
            $WORKSPACE/MyApp.app.zip 빌드를 설치하고 앱을 실행하세요.
            스크린샷을 찍어 메인 화면이 정상적으로 로드됐는지 확인하세요.
            오류 메시지나 빈 화면이 있으면 문제를 설명하고 실패로 종료하세요.
          "
```

탐색적 프롬프트는 결과를 기술하는 방식이 좋습니다. "목록의 세 번째 항목을 탭하세요" 같은 단계 지시 대신 "홈 화면이 로드됐는지 확인하세요"처럼 목표를 쓰면 UI가 바뀌어도 잘 깨지지 않습니다. 다만 반복 실행할 회귀 테스트라면 확인된 시나리오를 플로우로 고정하는 편이 결정적이고 비용도 들지 않습니다.

## 팁

- **회귀 테스트는 플로우로, 탐색은 에이전트로** 나눕니다. CI에서 매번 도는 테스트는 결정적 재생이 적합하고, 새 시나리오 확인은 에이전트가 빠릅니다.
- **`.mcp.json`의 `env` 값은 런타임에 셸 환경 변수로 덮어써지므로** 시크릿이 저장소에 남지 않습니다.
- **동시 세션** — relay는 세션 단위로 라우팅하므로, 다른 디바이스에 연결하는 여러 잡을 같은 relay에서 동시에 실행해도 됩니다.
