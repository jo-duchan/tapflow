---
title: AI 에이전트 QA
description: Claude Code 같은 AI 에이전트가 MCP로 iOS 시뮬레이터와 Android 에뮬레이터를 조작해 앱을 테스트하는 방식의 개요입니다. 누가 무엇을 하는지, 어떤 순서로 시작하는지, 팀원이 그 기기를 지켜보는 방법을 다룹니다.
---

# AI 에이전트 QA {#ai-agent-qa}

AI 에이전트 QA는 Claude Code 같은 AI 에이전트가 tapflow의 기기를 조작해 앱을 테스트하는 방식입니다. AI 에이전트는 [MCP 서버](/ko/ai-agents/mcp-server)를 거쳐 화면을 읽고 탭과 입력을 보냅니다. 기기는 팀원이 QA 세션에서 쓰는 것과 같은 Mac의 시뮬레이터와 에뮬레이터입니다. 페이지마다 상태가 다를 수 있으니 맨 위 배너를 확인하세요([페이지 상태](/ko/get-started/introduction#page-status)).

## 누가 무엇을 하나요 {#who-does-what}

| 누구 | 하는 일 |
|---|---|
| 운영자 | 릴레이와 에이전트 Mac을 평소처럼 실행합니다. AI 에이전트 QA를 위해 Mac에 더 설치할 것은 없습니다. |
| AI 에이전트를 쓰는 사람 | 자기 컴퓨터에 MCP 서버를 설정하고 대시보드에서 발급한 토큰으로 릴레이에 연결합니다. 그다음 AI 에이전트에게 테스트를 부탁합니다. |
| 팀원 | AI 에이전트가 건네주는 링크를 열어 기기 화면을 브라우저에서 지켜봅니다. |

## 시작 순서 {#start}

1. [MCP 서버](/ko/ai-agents/mcp-server): `@tapflowio/mcp-server`를 설치하고 AI 에이전트에 연결합니다. 그 뒤 "로그인 화면을 테스트해 줘"처럼 부탁하면 AI 에이전트가 기기를 골라 앱을 설치하고 화면을 읽으며 테스트합니다.
2. [AI 에이전트 Flow Capture](/ko/ai-agents/agent-flow-capture): AI 에이전트가 확인한 경로를 플로우 YAML로 남깁니다. 기기를 초기화해 다시 재생한 뒤 통과한 플로우만 돌려줍니다.
3. [CI에서 플로우 실행](/ko/automation/ci): 남긴 플로우를 CI에서 AI 모델 없이 재생합니다. 여기서부터는 [자동화 QA](/ko/automation)입니다.

아직 플로우로 남기지 않은 시나리오는 [CI에서 탐색적 실행](/ko/ai-agents/exploratory-runs)으로 CI에서 AI 에이전트가 매번 판단하게 할 수 있습니다. 결과가 실행마다 달라질 수 있고 실행할 때마다 API 비용이 듭니다.

## 기기 지켜보기 {#watch}

AI 에이전트가 기기에 연결하면 그 기기 화면을 실시간으로 볼 수 있는 링크를 건네줍니다. 대시보드에 로그인한 팀원이면 누구나 열 수 있고 보기 전용이라 화면을 눌러도 기기에는 전달되지 않습니다. 자세한 내용은 [AI 에이전트가 조작하는 기기 보기](/ko/ai-agents/mcp-server#watch-the-device)를 참고하세요.

## 관련 문서 {#related}

- [자동화 QA](/ko/automation): 플로우를 얻는 방법, 재생, 실행 기록, CI를 안내합니다.
- [수동 QA](/ko/testing): 팀원이 브라우저에서 직접 빌드를 테스트하는 방법입니다.
- [페이지 상태](/ko/get-started/introduction#page-status): 실험적 배너와 지원 중단 예정 배너가 무엇을 뜻하는지 설명합니다.
