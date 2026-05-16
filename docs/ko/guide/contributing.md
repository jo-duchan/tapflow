# 기여 가이드

기여를 환영합니다. 브랜치 전략, 커밋 컨벤션, PR 가이드라인은 저장소의 [`contributing/CONTRIBUTING.md`](https://github.com/jo-duchan/tapflow/blob/main/contributing/CONTRIBUTING.md)를 참고하세요.

## 로컬 개발 환경

**요구사항**: Node.js ≥ 20, pnpm ≥ 9

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
pnpm install
pnpm dev
```

`pnpm dev`는 릴레이, 대시보드, iOS 에이전트, Android 에이전트를 동시에 시작합니다.

## 프로젝트 구조

```
packages/
  agent-core/     ← 공유 DeviceAgent 인터페이스
  ios-agent/      ← IOSAgent (macOS)
  android-agent/  ← AndroidAgent (macOS)
  relay/          ← 릴레이 서버 + REST API + SQLite
  dashboard/      ← React SPA (릴레이가 서빙)
  cli/            ← tapflow CLI
docs/             ← 이 문서 사이트 (VitePress)
contributing/     ← 내부 문서 (PRD, 디자인 시스템, 아키텍처)
playground/       ← 로컬 통합 테스트 환경
```

## 테스트 실행

```sh
pnpm test
```
