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
        run: |
          set -o pipefail
          # MCP 서버는 릴레이의 ws:// 주소를 받고, 업로드 API는 같은 릴레이의 http 주소를 씁니다.
          RELAY_HTTP="${TAPFLOW_RELAY_URL/#ws/http}"
          BUILD_ID=$(curl -sf -X POST "$RELAY_HTTP/api/v1/builds" \
            -H "Authorization: Bearer $TAPFLOW_TOKEN" \
            -F "file=@MyApp.app.zip" | jq -er '.id')
          [[ "$BUILD_ID" =~ ^[0-9]+$ ]]

          claude --mcp-config .mcp.json --allowedTools "mcp__tapflow" -p "
            사용 가능한 기기를 조회하고 부팅된 iOS 시뮬레이터에 연결하세요.
            빌드 $BUILD_ID를 설치하고 앱을 실행하세요.
            화면을 읽어 메인 화면이 정상적으로 로드됐는지 확인하세요.
            끝나면 기기 연결을 해제하세요.
            답의 마지막 줄에 TAPFLOW_VERDICT: pass 또는 TAPFLOW_VERDICT: fail과 그 이유를 쓰세요.
          " | tee claude-output.txt

          tail -n 1 claude-output.txt | grep -Eq '^TAPFLOW_VERDICT: pass[[:space:]]*$'
```

이 단계에서 눈여겨볼 곳은 세 군데입니다.

- `install_app`은 러너에 있는 파일이 아니라 릴레이에 이미 있는 빌드를 ID로 설치합니다. 그래서 이 단계는 만든 빌드(여기서는 `MyApp.app.zip`)를 먼저 [빌드 API](/ko/operate/ci-distribution)로 올리고 돌려받은 ID를 코딩 에이전트에게 줍니다. `TAPFLOW_TOKEN`은 API 유형 토큰이라 업로드할 수 있습니다. 업로드가 실패하면 `pipefail`과 ID 확인이 `claude`를 실행하기 전에 단계를 멈춥니다.
- `claude -p` 실행에는 도구 사용을 승인할 사람이 없어서 승인이 필요한 호출은 거부됩니다. `--allowedTools "mcp__tapflow"`는 tapflow MCP 서버의 도구를 미리 승인합니다. 다른 도구를 더 허용하지는 않으므로 승인이 필요한 도구는 여전히 거부됩니다.
- `claude`는 답을 마치면 종료 코드 `0`으로 끝납니다. 답에 앱이 망가졌다고 써도 마찬가지입니다. 그래서 단계의 성패는 마지막 줄이 정합니다. 출력의 마지막 줄이 `TAPFLOW_VERDICT: pass`일 때만 통과하므로 중간에 끝났거나 판정을 쓰지 않았거나 fail로 끝난 실행은 실패합니다.

탐색적 프롬프트는 결과를 기술하는 방식이 좋습니다. "목록의 세 번째 항목을 탭하세요" 같은 단계 지시 대신 "홈 화면이 로드됐는지 확인하세요"처럼 목표를 쓰면 UI가 바뀌어도 잘 깨지지 않습니다. 다만 반복 실행할 회귀 테스트라면 확인된 시나리오를 플로우로 고정하는 편이 결정적이고 비용도 들지 않습니다.

이 예시는 [코딩 에이전트로 플로우 작성](/ko/automation/ci#authoring-flows-with-an-agent)의 `.mcp.json`을 씁니다. 이 파일이 단계의 `TAPFLOW_RELAY_URL`과 `TAPFLOW_TOKEN`을 MCP 서버에 넘기므로 코딩 에이전트는 빌드를 올린 릴레이에 연결됩니다.

## 관련 문서

- [CI에서 플로우 실행](/ko/automation/ci): 저장된 플로우를 LLM 호출 없이 재생하는 결정적 CI 경로
- [MCP 서버](/ko/ai-agents/mcp-server): 설치, 코딩 에이전트 연결, 도구 목록
