# 기여 가이드

기여를 환영합니다. 브랜치 전략, 커밋 컨벤션, PR 가이드라인은 저장소의 [`CONTRIBUTING.md`](https://github.com/jo-duchan/tapflow/blob/main/CONTRIBUTING.md)를 참고하세요.

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
internal/         ← 팀 내부 문서 (PRD, 디자인 시스템, 아키텍처)
playground/       ← 로컬 통합 테스트 환경
```

## 테스트 실행

전체 패키지:

```sh
pnpm test
```

특정 패키지만:

```sh
pnpm --filter @tapflow/ios-agent test
pnpm --filter @tapflow/android-agent test
pnpm --filter @tapflow/relay test
pnpm --filter @tapflow/cli test
```

PR을 올리기 전에 변경된 패키지의 테스트가 통과하는지 확인합니다. 새 동작을 추가할 때는 테스트를 먼저 작성합니다.

## 버그 신고

[버그 리포트](https://github.com/jo-duchan/tapflow/issues/new?template=bug_report.yml) 이슈 템플릿을 사용해 주세요. 재현 단계, 예상 동작과 실제 동작, 환경 정보(tapflow 버전, Node.js 버전, iOS 이슈라면 Xcode 버전)를 포함해 주시면 빠르게 대응할 수 있습니다.
