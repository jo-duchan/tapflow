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

## 버저닝

tapflow는 [유의적 버전(Semantic Versioning)](https://semver.org/lang/ko/)을 따릅니다 (`MAJOR.MINOR.PATCH`).

| 범프 | 기준 |
|------|------|
| `patch` | 버그 수정, 성능 개선, 문서, 리팩터 — API 변경 없음 |
| `minor` | 새 기능 추가, 하위 호환 |
| `major` | 브레이킹 체인지 (공개 API, DB 스키마, WebSocket 프로토콜, CLI 플래그) |

하나의 릴리즈에 여러 타입의 커밋이 포함된 경우 가장 높은 범프를 적용합니다 (`major` > `minor` > `patch`).

**`v1.0.0` 이전**: 브레이킹 체인지가 `minor` 버전에 포함될 수 있습니다. `v1.0.0` 태깅 이후에는 위 표를 엄격하게 적용합니다.

### 프리릴리즈 버전

| 태그 | 의미 |
|------|------|
| `v0.3.0-alpha.1` | 불안정, 내부 테스트 |
| `v0.3.0-beta.1` | 기능 완성, 외부 테스트 |
| `v0.3.0-rc.1` | 릴리즈 후보, 새 기능 없음 |

특정 프리릴리즈 설치:

```sh
npm install tapflow@0.3.0-beta.1
```

## 버그 신고

[버그 리포트](https://github.com/jo-duchan/tapflow/issues/new?template=bug_report.yml) 이슈 템플릿을 사용해 주세요. 재현 단계, 예상 동작과 실제 동작, 환경 정보(tapflow 버전, Node.js 버전, iOS 이슈라면 Xcode 버전)를 포함해 주시면 빠르게 대응할 수 있습니다.
