---
title: CI에서 탐색적 실행
description: "CI에서 매 실행마다 코딩 에이전트가 앱 화면을 판단하게 합니다. 결정적이지 않고 API 비용이 들며 아직 플로우로 고정하지 않은 시나리오에 씁니다."
---

# CI에서 탐색적 실행

::: warning 실험적 기능
tapflow의 **AI 에이전트**(MCP 서버)와 **자동화**(플로우 러너)는 실험적 기능입니다. tapflow에서 가장 성숙한 부분은 수동 QA 대시보드이고 두 기능은 아직 다듬어지는 중입니다. 특히 셀렉터 매칭과 앱 실행 직후 타이밍에서 거친 부분이 있을 수 있습니다.
:::

새 화면을 탐색하거나 플로우를 디버깅할 때는 CI에서 LLM이 직접 판단하게 할 수도 있습니다. 이 방식은 매 실행마다 LLM이 화면을 읽으므로 결정적이지 않고 API 비용이 들지만, 아직 플로우로 고정하지 않은 시나리오를 빠르게 확인하는 데 유용합니다.

이때는 사전 조건이 더 필요합니다.

| 항목 | 설명 |
|------|------|
| tapflow 릴레이 (상시 가동) | Mac 에이전트가 연결된 릴레이. LAN에 있는 Mac mini 한 대면 충분합니다. |
| `TAPFLOW_TOKEN` | **API** 유형 개인 액세스 토큰(PAT, `view, builds:write`). **Settings → Tokens**에서 발급하며 이 메뉴는 Admin, Developer, QA에게 보입니다. CI 시크릿으로 저장하세요. |
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
            사용 가능한 기기를 조회하고 부팅된 iOS 시뮬레이터에 연결하세요.
            $WORKSPACE/MyApp.app.zip 빌드를 설치하고 앱을 실행하세요.
            스크린샷을 찍어 메인 화면이 정상적으로 로드됐는지 확인하세요.
            오류 메시지나 빈 화면이 있으면 문제를 설명하고 실패로 종료하세요.
          "
```

탐색적 프롬프트는 결과를 기술하는 방식이 좋습니다. "목록의 세 번째 항목을 탭하세요" 같은 단계 지시 대신 "홈 화면이 로드됐는지 확인하세요"처럼 목표를 쓰면 UI가 바뀌어도 잘 깨지지 않습니다. 다만 반복 실행할 회귀 테스트라면 확인된 시나리오를 플로우로 고정하는 편이 결정적이고 비용도 들지 않습니다.

이 예시는 [코딩 에이전트로 플로우 작성](/ko/automation/ci#authoring-flows-with-an-agent)의 `.mcp.json`을 씁니다.

## 관련 문서

- [CI에서 플로우 실행](/ko/automation/ci): 저장된 플로우를 LLM 호출 없이 재생하는 결정적 CI 경로
- [MCP 서버](/ko/ai-agents/mcp-server): 설치, 코딩 에이전트 연결, 도구 목록
