# CI/CD에서 MCP 활용하기

매 빌드마다 실제 시뮬레이터로 자동 스모크 테스트를 실행하세요. Selenium도, WebDriverAgent도, 좌표 하드코딩도 필요 없습니다. LLM 에이전트가 스크린샷으로 화면을 인식하고 스스로 탐색합니다.

## 동작 방식

CI 잡이 `@tapflowio/mcp-server`를 설치하고, 항상 켜져 있는 relay를 가리키도록 설정한 뒤, `claude`(Claude Code CLI)를 자연어 테스트 프롬프트와 함께 실행합니다. 에이전트는 MCP 도구로 시뮬레이터를 제어하고, 실패가 감지되면 non-zero 코드로 종료합니다.

```
CI 러너
  → @tapflowio/mcp-server 설치
  → 실행: claude --mcp-config .mcp.json -p "<테스트 프롬프트>"
      → 에이전트가 list_devices, connect_device, install_app, launch_app, screenshot, tap, ... 호출
      → 결과 보고 / 실패 시 non-zero 종료
```

## 사전 조건

| 항목 | 설명 |
|------|------|
| tapflow relay (상시 가동) | Mac 에이전트가 연결된 relay. LAN에 있는 Mac mini 한 대면 충분합니다. |
| `TAPFLOW_TOKEN` | Developer 이상 권한의 PAT. CI 시크릿으로 저장하세요. |
| `ANTHROPIC_API_KEY` | `claude`를 비대화형으로 실행하는 데 필요합니다. CI 시크릿으로 저장하세요. |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |

## GitHub Actions 예시

```yaml
name: 스모크 테스트

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: 도구 설치
        run: |
          npm install -g @tapflowio/mcp-server @anthropic-ai/claude-code

      - name: 스모크 테스트 실행
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

::: tip 저장소에 .mcp.json 커밋하기
저장소 루트에 `.mcp.json`을 커밋해두면 CI에서 그대로 사용할 수 있습니다.

```json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "INJECTED_AT_RUNTIME",
        "TAPFLOW_TOKEN": "INJECTED_AT_RUNTIME"
      }
    }
  }
}
```

`env` 값은 런타임에 셸 환경 변수로 덮어써지므로 시크릿이 저장소에 남지 않습니다.
:::

## 다중 디바이스 매트릭스

잡을 파라미터화해서 여러 시뮬레이터에 동일한 테스트를 병렬 실행하세요.

```yaml
jobs:
  smoke:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        device: ["iPhone SE (3rd generation)", "iPhone 16 Pro", "iPad Air 13-inch (M2)"]

    steps:
      # ... 설치 단계 ...

      - name: ${{ matrix.device }} 스모크 테스트
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          TARGET_DEVICE: ${{ matrix.device }}
        run: |
          claude --mcp-config .mcp.json -p "
            list_devices에서 '$TARGET_DEVICE' 시뮬레이터를 찾아 연결하세요.
            MyApp.app.zip을 설치하고 앱을 실행해 메인 화면이 오류 없이 로드됐는지 확인하세요.
          "
```

## 테스트 프롬프트 예시

결과를 기술하는 프롬프트를 작성하세요. 단계별 지시보다 목표를 명확히 쓰면 UI가 바뀌어도 깨지지 않습니다.

**로그인 플로우:**
```
사용 가능한 시뮬레이터에 연결하세요.
샌드박스 빌드를 설치하고 실행하세요.
로그인 화면으로 이동해 test@example.com과 비밀번호 test1234를 입력하고
로그인 버튼을 탭한 뒤 10초 이내에 홈 화면이 표시되는지 확인하세요.
결과를 스크린샷으로 캡처하세요. 로그인 실패나 오류가 있으면 오류 내용을 보고하고 실패로 종료하세요.
```

**온보딩:**
```
앱을 새로 설치하고 온보딩 플로우를 진행하세요.
각 단계를 스크린샷으로 기록하세요.
모든 버튼이 탭 가능하고 빈 화면이 없는지 확인하세요.
UI가 깨져 보이는 단계가 있으면 보고하세요.
```

**배포 후 상태 확인:**
```
최신 설치된 빌드를 실행하세요.
홈, 검색, 프로필 세 개의 탭을 순서대로 방문하세요.
각 탭을 스크린샷으로 캡처하고 오류나 빈 화면 없이 로드됐는지 확인하세요.
```

## 팁

- **프롬프트는 결과 중심으로** — "목록의 세 번째 항목을 탭하세요" 같은 단계 지시 대신 "홈 화면이 로드됐는지 확인하세요"처럼 결과를 기술하면 UI가 변경되어도 깨지지 않습니다.
- **세션 종료 명시** — 프롬프트 마지막에 "완료 후 디바이스 연결을 해제하세요"를 포함하세요. 그렇지 않으면 세션이 열린 채로 남습니다.
- **타임아웃 설정** — `claude`에 `--timeout`을 명시적으로 설정해 긴 플로우가 CI를 무한 대기 상태로 만들지 않도록 하세요.
- **동시 세션** — relay는 세션 단위로 라우팅하므로, 다른 디바이스에 연결하는 여러 잡을 같은 relay에서 동시에 실행해도 됩니다.
