---
title: CI에서 플로우 실행
description: "CI에서 tapflow flow run으로 저장된 플로우를 LLM 호출 없이 재생하고 그 플로우를 AI 에이전트가 MCP로 작성하는 방법입니다."
status: experimental
---

# CI에서 플로우 실행

<a id="ci-cd에서-mcp-활용하기"></a>

AI 에이전트와 플로우 러너를 함께 쓰면 작업이 두 단계로 나뉩니다. AI 에이전트가 앱을 탐색하며 시나리오를 **작성**하고 그 시나리오를 결정적 러너가 **재생**합니다. 핵심 원칙은 이렇습니다. LLM은 작성 시점에만 개입하고 재생은 결정적으로 이루어집니다. [별도 페이지](/ko/ai-agents/exploratory-runs)에서 다루는 탐색적 실행만 예외로, 매 실행마다 LLM이 화면을 읽습니다.

이 구분이 CI를 바꿉니다. 매 실행마다 LLM이 화면을 판단하면 결과가 실행마다 달라지고 API 비용도 매번 듭니다. 반면 검증된 시나리오를 [플로우](/ko/automation/flows)로 저장해두면, CI는 LLM 호출 없이 그 플로우를 재생하기만 하므로 멱등하고 비용이 들지 않습니다.

## 결정적 재생 — CI의 주경로

CI 잡은 저장된 플로우를 `tapflow flow run`으로 재생합니다. 재생 경로에는 LLM이 없으므로 같은 입력에서 항상 같은 결과가 나오고 API 비용도 발생하지 않습니다.

self-hosted Mac 러너에 릴레이와 에이전트가 상시 가동돼 있다면, 잡은 플로우를 실행하고 종료 코드로 성공 여부를 판별합니다.

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

플로우 YAML 문법, 셀렉터 규칙, 종료 코드 계약은 [플로우 레퍼런스](/ko/automation/flows)에서 자세히 다룹니다.

## AI 에이전트로 플로우 작성 {#authoring-flows-with-an-agent}

플로우는 사람이 손으로 처음부터 쓰기보다 AI 에이전트가 앱을 탐색하며 생성하는 산출물입니다. Claude Code 같은 MCP를 지원하는 AI 에이전트에 시나리오를 자연어로 요청하면 AI 에이전트가 tapflow MCP 도구로 앱을 직접 조작해 동작을 확인하고, 검증된 시퀀스를 플로우 YAML로 뽑아 리포지토리에 커밋합니다.

AI 에이전트를 릴레이에 연결하려면 저장소 루트에 `.mcp.json`을 두고 릴레이를 가리키게 합니다.

```json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "${TAPFLOW_RELAY_URL:-ws://localhost:4000}",
        "TAPFLOW_TOKEN": "${TAPFLOW_TOKEN:-}"
      }
    }
  }
}
```

AI 에이전트에게는 단계별 지시가 아니라 결과를 기술하는 요청이 좋습니다.

```text
로그인 화면에서 이메일과 비밀번호를 입력하고 주문 목록까지 확인하는 플로우를 만들어줘.
앱을 실제로 조작해 동작을 확인한 뒤, 검증된 시퀀스를 .tapflow/flows/login-smoke.yaml로 저장해줘.
```

AI 에이전트가 `query_ui_tree`로 화면 요소를 읽고 `tap`·`type_text`로 조작하며 시나리오를 확인한 다음, 셀렉터 기반 플로우로 저장합니다. 이렇게 만든 플로우는 이후 CI에서 결정적으로 재생됩니다.

## 검증된 시나리오는 run_flow로 재생

AI 에이전트 세션 안에서도 결정적 재생을 쓸 수 있습니다. `run_flow` 도구는 저장된 플로우를 같은 결정적 엔진으로 재생하므로 AI 에이전트가 탐색적으로 헤매는 부분은 개별 MCP 도구로, 이미 검증된 시나리오는 `run_flow`로 재생하는 하이브리드가 됩니다.

## 팁

- **회귀 테스트는 플로우로, 탐색은 AI 에이전트로** 나눕니다. CI에서 매번 도는 테스트는 결정적 재생이 적합하고, 새 시나리오 확인은 AI 에이전트가 빠릅니다.
- **`.mcp.json`은 릴레이 주소와 토큰을 환경 변수에서 가져오므로**(`${TAPFLOW_TOKEN:-}`) 시크릿이 저장소에 남지 않습니다. `env`에 값을 그대로 적으면 환경 변수보다 그 값이 우선하므로 자리표시 문자열을 넣지 마세요. `TAPFLOW_TOKEN`이 비어 있으면 MCP 서버는 [토큰 파일](/ko/ai-agents/mcp-server#token-file)에서 읽습니다. 로컬 기본 주소를 쓰려면 `TAPFLOW_RELAY_URL`을 빈 값으로 두지 말고 아예 설정하지 마세요. 빈 값은 그대로 MCP 서버에 전달될 수 있고 MCP 서버는 빈 주소를 받지 않습니다.
- **동시 세션** — 릴레이는 세션 단위로 라우팅하므로, 다른 기기에 연결하는 여러 잡을 같은 릴레이에서 동시에 실행해도 됩니다.

## 옮겨진 섹션 {#moved-sections}

이 페이지에 있던 섹션은 아래 페이지로 옮겨졌습니다.

- [CI에서 탐색적 실행](/ko/ai-agents/exploratory-runs)
  - <a id="탐색적-실행-—-선택-사항" data-moved-to="/ko/ai-agents/exploratory-runs"></a>[CI에서 탐색적 실행](/ko/ai-agents/exploratory-runs)
