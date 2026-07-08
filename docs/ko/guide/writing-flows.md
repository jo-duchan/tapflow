# 플로우 작성

플로우는 YAML로 작성한 UI 테스트 시나리오이며, `tapflow flow run`이 LLM 호출 없이 결정적으로 재생합니다. 같은 플로우는 같은 입력에서 항상 같은 순서로 실행되므로 멱등하고 CI에서 API 비용이 들지 않습니다.

::: info 두 가지 QA 축
tapflow에는 두 가지 QA 축이 있습니다. 브라우저 대시보드는 팀원이 직접 손으로 테스트하는 **수동 QA 축**이고 여기서 다루는 플로우 러너는 CI/CD가 주 무대인 **자동 QA 축**입니다.

플로우는 사람이 처음부터 손으로 작성하는 언어가 아니라, 에이전트가 생성하거나 시연에서 뽑아내는 산출물입니다. 에이전트로 작성하는 방법은 [CI/CD에서 MCP 활용](/ko/guide/mcp-ci)을 참고하세요.
:::

## 플로우 파일 구조

플로우 하나는 최상위 키 세 개로 이루어집니다.

```yaml
name: login-smoke
appId: com.example.app
steps:
  - clearState
  - launchApp
  - assertVisible: "로그인"
  - tapOn: { id: "com.example.app:id/email" }
  - inputText: "user@example.com"
  - pressKey: Enter
  - tapOn: "로그인"
  - assertVisible: { label: "주문 목록", timeout: 15 }
```

| 키 | 필수 | 설명 |
|-----|------|------|
| `name` | 아니오 | 리포트에 표시되는 이름. 생략하면 파일명을 씁니다. |
| `appId` | 조건부 | 테스트 대상 앱의 번들 ID. `clearState`를 인자 없이 쓸 때 필요합니다. |
| `steps` | 예 | 위에서 아래로 순서대로 실행되는 스텝 목록. |

좌표는 어디서나 0~1로 정규화합니다. 셀렉터가 화면 요소를 직접 가리키므로 플로우에 픽셀 좌표를 직접 적을 일은 거의 없습니다.

## 스텝

어휘는 의도적으로 작게 유지했습니다. 아래 열 가지로 대부분의 시나리오를 표현할 수 있습니다.

| 스텝 | 형태 | 동작 |
|------|------|------|
| `clearState` | 키워드 또는 `clearState: <bundleId>` | 앱 데이터를 초기화합니다. 키워드 형태는 최상위 `appId`를 씁니다. |
| `launchApp` | 키워드 | 테스트 대상 빌드를 실행합니다. |
| `tapOn` | 셀렉터 | 매칭된 요소의 중심을 탭합니다. |
| `inputText` | 문자열 | 포커스된 입력 필드에 텍스트를 입력합니다. |
| `pressKey` | 키 이름 | 키보드 키를 누릅니다(`Enter`, `Backspace`, `Escape` 등). |
| `swipe` | `{ from, to, durationMs? }` | 두 지점 사이를 스와이프합니다. 좌표는 0~1. |
| `scroll` | 키워드 또는 `scroll: <방향>` | 화면을 스크롤합니다. 인자 없는 형태는 아래로 스크롤합니다. |
| `openUrl` | URL 문자열 | 딥링크나 URL을 엽니다. |
| `assertVisible` | 셀렉터 | 요소가 나타날 때까지 기다립니다. 나타나지 않으면 실패합니다. |
| `assertNotVisible` | 셀렉터 | 요소가 사라질 때까지 기다립니다. 사라지지 않으면 실패합니다. |

고정된 `sleep` 스텝은 없습니다. 대기는 언제나 조건 기반입니다. 화면 전환을 기다리려면 `assertVisible`에 `timeout`을 주면 됩니다.

### 셀렉터

`tapOn`, `assertVisible`, `assertNotVisible`은 셀렉터로 요소를 지정합니다. 셀렉터는 세 가지 형태로 쓸 수 있습니다.

```yaml
# 문자열 하나 — 아래 순서로 해석합니다
- tapOn: "로그인"

# 식별자로 명시
- tapOn: { id: "com.example.app:id/login" }

# 라벨로 명시 + 대기 시간(초)
- tapOn: { label: "로그인", timeout: 20 }
```

문자열 하나만 쓴 셀렉터는 **정확한 식별자 → 정확한 라벨 → 부분 라벨** 순서로 해석합니다. 앞 단계에서 매칭되면 뒤 단계로 넘어가지 않습니다.

`tapOn`에서 셀렉터가 여러 요소에 매칭되면 후보를 나열하며 즉시 실패합니다. 첫 번째를 임의로 고르지 않으므로 애매한 셀렉터는 조용히 잘못된 곳을 탭하는 대신 눈에 보이게 실패합니다. `assertVisible`은 존재 여부만 보므로 하나 이상 매칭되면 통과합니다.

`timeout`은 초 단위이며 기본값은 10초입니다. 셀렉터마다 개별로 지정할 수 있습니다.

### 상태 초기화

`clearState`는 앱 데이터를 초기화해 매 실행이 같은 시작 상태에서 출발하도록 합니다. Android에서는 `pm clear`, iOS에서는 앱 데이터 컨테이너를 비우는 방식으로 동작하며 설치된 앱 바이너리는 그대로 유지되므로 `clearState` 다음에 `launchApp`을 이어 쓸 수 있습니다.

```yaml
# 최상위 appId를 사용
- clearState

# 다른 번들을 명시
- clearState: com.other.app
```

## 실행

```sh
tapflow flow run .tapflow/flows/login-smoke.yaml
```

여러 파일을 한 번에 넘길 수 있습니다.

```sh
tapflow flow run .tapflow/flows/login.yaml .tapflow/flows/checkout.yaml
```

| 옵션 | 설명 |
|------|------|
| `--relay <url>` | Relay URL (기본값 `ws://localhost:4000`) |
| `--token <token>` | 원격 relay용 PAT (또는 `TAPFLOW_TOKEN` 환경변수) |
| `--device <name>` | 대상 디바이스를 이름으로 지정. 꺼져 있으면 부팅합니다. |
| `--session <id>` | 대상 세션 ID (`tapflow status`로 확인) |
| `--build <id>` | 테스트 대상 빌드. 실행 전 설치되고 `launchApp` 스텝이 이 빌드를 실행합니다. |
| `--junit <path>` | JUnit XML 리포트를 지정한 경로에 씁니다. |
| `--artifacts <dir>` | 실패 스크린샷 저장 디렉터리 (기본값 `.tapflow-data/artifacts`) |
| `--timeout <seconds>` | 셀렉터 기본 대기 시간 (기본값 10) |

`launchApp` 스텝은 인자를 받지 않고 `--build`로 지정한 빌드를 실행합니다. 덕분에 플로우 파일에 빌드 ID를 하드코딩하지 않아도 되고 CI 실행마다 새 빌드에 그대로 재사용할 수 있습니다.

### 종료 코드

CI가 결과를 판별할 수 있도록 종료 코드를 계약으로 고정했습니다.

| 코드 | 의미 |
|------|------|
| `0` | 모든 플로우 통과 |
| `1` | 하나 이상의 플로우 실패 |
| `2` | 환경·설정 오류 (플로우 파싱 실패, relay 접속 불가, 디바이스 없음) |

`1`과 `2`를 구분하는 것이 중요합니다. 테스트 실패(`1`)와 인프라 문제(`2`)는 CI 대시보드에서 다르게 다뤄야 하기 때문입니다.

실패한 플로우는 실패 시점의 스크린샷을 아티팩트 디렉터리에 남기고, `--junit`을 주면 각 플로우가 하나의 `testcase`로 기록됩니다.

## 파일 위치 규약

플로우 파일은 앱 리포지토리의 `.tapflow/flows/`에 두기를 권장합니다. 러너는 임의 경로를 받으므로 강제는 아니지만, CI 예시와 문서는 이 경로를 기본으로 삼습니다.

```text
your-app/
├── .tapflow/
│   └── flows/
│       ├── login-smoke.yaml
│       └── checkout.yaml
└── ...
```

에디터 자동완성을 위한 JSON Schema는 `@tapflowio/flow-runner` 패키지의 `schema/tapflow-flow.schema.json`에 함께 배포됩니다.

## CI에서 실행

self-hosted Mac 러너에서 relay와 에이전트가 항상 켜져 있다면, CI 잡은 플로우를 재생하기만 하면 됩니다. 재생 경로에는 LLM이 개입하지 않으므로 API 비용이 들지 않습니다.

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

      - name: Publish report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flow-results
          path: |
            report.xml
            .tapflow-data/artifacts/
```

종료 코드 계약 덕분에 스텝이 실패하면(`1` 또는 `2`) 잡도 실패합니다. `if: always()`로 실패 스크린샷과 JUnit 리포트를 실패한 실행에서도 수집합니다.

## run_flow와의 관계

같은 플로우 엔진을 MCP `run_flow` 도구로도 실행할 수 있습니다. 에이전트가 앱을 탐색하며 시나리오를 한 번 작성해두면, 이후에는 그 플로우를 결정적으로 재생하는 방식입니다. 탐색적으로 헤매는 작업은 개별 MCP 도구로, 검증된 시나리오는 `run_flow`로 재생하는 하이브리드가 됩니다.

작성은 에이전트가, 재생은 결정적 러너가 맡는 구조는 [CI/CD에서 MCP 활용](/ko/guide/mcp-ci)에서 더 자세히 다룹니다.
