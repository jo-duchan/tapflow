---
title: 자동화 QA
description: 주로 CI에서 tapflow flow run으로 저장된 YAML 플로우를 AI 모델 없이 재생해 앱을 테스트하고 대시보드의 Flow Runs 페이지에서 결과를 확인합니다.
---

# 자동화 QA {#automation-qa}

자동화 QA는 `tapflow flow run`으로 저장된 플로우를 재생해 앱을 테스트하는 방식입니다. 플로우는 탭, 텍스트 입력, 화면에 표시되어야 할 요소를 순서대로 나열한 YAML 파일입니다. 재생에는 AI 모델을 사용하지 않으므로 플로우는 매번 같은 단계를 실행하며 API 호출 비용이 들지 않습니다. 팀은 주로 CI에서 빌드할 때마다 플로우를 실행합니다.

## 플로우를 만드는 방법 {#where-flows-come-from}

- **수동 QA에서**: 팀원이 QA 세션에서 탭, 스와이프, 텍스트 입력으로 수행한 동작을 [Flow Capture](/ko/testing/flow-capture)로 저장합니다. 내보내기 전에 기기에서 플로우를 재생해 확인합니다.
- **AI 에이전트 QA에서**: AI 에이전트가 확인한 경로를 [AI 에이전트 Flow Capture](/ko/ai-agents/agent-flow-capture)로 저장합니다.
- **직접 작성**: [플로우 레퍼런스](/ko/automation/flows)의 형식에 맞춰 플로우를 작성하거나 저장된 플로우를 편집합니다.

## 결과 {#replay-and-results}

토큰과 함께 `tapflow flow run`을 실행하면 결과가 대시보드의 [Flow Runs](/ko/automation/runs) 페이지에 저장됩니다. 팀원은 누구나 브라우저에서 페이지를 열어 플로우가 실패한 화면과 플로우 영상을 볼 수 있습니다. 실패 원인이 앱에 있는지 환경(기기, 에이전트 또는 릴레이)에 있는지도 확인할 수 있습니다.

## CI에서 실행 {#ci}

[CI에서 플로우 실행](/ko/automation/ci)에는 자체 호스팅 Mac 러너용 GitHub Actions 예제가 있습니다. AI 에이전트로 플로우를 작성하는 방법도 확인할 수 있습니다.

## 관련 문서 {#related}

- [수동 QA](/ko/testing)는 팀원이 브라우저에서 직접 빌드를 테스트하는 방법을 설명합니다.
- [AI 에이전트 QA](/ko/ai-agents)는 AI 에이전트가 MCP로 기기를 조작해 앱을 테스트하는 방법을 설명합니다.
