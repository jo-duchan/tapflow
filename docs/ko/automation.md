---
title: 자동화 QA
description: 저장한 YAML 플로우를 tapflow flow run이 AI 모델 호출 없이 재생하는 방식의 개요입니다. 플로우를 얻는 방법, 재생과 실행 기록, CI 실행, 누가 무엇을 하는지 다룹니다.
---

# 자동화 QA {#automation-qa}

자동화 QA는 저장한 [플로우](/ko/automation/flows)를 `tapflow flow run`이 재생해 앱을 테스트하는 방식입니다. 플로우는 탭, 입력, 화면에 보여야 할 요소를 순서대로 적은 YAML 파일입니다. 재생에는 AI 모델을 쓰지 않으므로 같은 플로우는 늘 같은 순서로 실행되고 API 비용이 들지 않습니다. 주로 CI에서 빌드마다 돌립니다. 페이지마다 상태가 다를 수 있으니 맨 위 배너를 확인하세요([페이지 상태](/ko/get-started/introduction#page-status)).

## 누가 무엇을 하나요 {#who-does-what}

| 누구 | 하는 일 |
|---|---|
| 운영자 | 릴레이와 에이전트 Mac을 실행합니다. 실행 기록에 남는 영상의 보관 기간과 저장 공간을 정합니다(Admin). |
| 개발자 | 플로우를 저장소에 두고 CI에서 `tapflow flow run`을 실행합니다. |
| 팀원 | QA 세션에서 한 동작을 플로우로 저장하고 실행 기록에서 어느 플로우가 왜 실패했는지 봅니다. |

## 플로우를 얻는 방법 {#where-flows-come-from}

- **QA 세션에서 저장**: 팀원이 직접 해 본 탭, 스와이프, 입력을 [Flow Capture](/ko/testing/flow-capture)로 내보냅니다.
- **코딩 에이전트가 저장**: 코딩 에이전트가 MCP로 확인한 경로를 [AI 에이전트 Flow Capture](/ko/ai-agents/agent-flow-capture)로 남깁니다.
- **직접 작성**: [플로우 레퍼런스](/ko/automation/flows)의 형식에 맞춰 YAML을 쓰거나 저장한 플로우를 고칩니다.

## 재생과 실행 기록 {#replay-and-results}

`tapflow flow run`으로 플로우를 재생합니다. 토큰을 주고 실행하면 결과가 대시보드의 [Flow Runs](/ko/automation/runs) 페이지에 남습니다. 팀원 누구나 브라우저에서 실패한 화면과 영상을 볼 수 있고 실패가 앱 문제인지 환경 문제인지도 나눠서 확인할 수 있습니다.

## CI에서 실행 {#ci}

[CI에서 플로우 실행](/ko/automation/ci)은 self-hosted Mac 러너에서 플로우를 재생하는 GitHub Actions 예시와 코딩 에이전트로 플로우를 작성하는 방법을 다룹니다.

## 관련 문서 {#related}

- [수동 QA](/ko/testing): 팀원이 브라우저에서 직접 빌드를 테스트하는 방법입니다.
- [AI 에이전트 QA](/ko/ai-agents): 코딩 에이전트가 MCP로 기기를 조작해 테스트하는 방법입니다.
- [페이지 상태](/ko/get-started/introduction#page-status): 실험적 배너와 지원 중단 예정 배너가 무엇을 뜻하는지 설명합니다.
