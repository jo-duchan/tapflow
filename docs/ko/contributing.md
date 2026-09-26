# 기여 가이드

기여를 환영합니다. 개발 환경 설정, 브랜치 전략, 테스트 원칙, 버저닝, 커밋 컨벤션은 저장소의 [`CONTRIBUTING.md`](https://github.com/jo-duchan/tapflow/blob/main/CONTRIBUTING.md)를 참고하세요.

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
playground/       ← 로컬 통합 테스트 환경
```

## 버그 신고

[버그 리포트](https://github.com/jo-duchan/tapflow/issues/new?template=bug_report.yml) 이슈 템플릿을 사용해 주세요. 재현 단계, 예상 동작과 실제 동작, 환경 정보(tapflow 버전, Node.js 버전, iOS 이슈라면 Xcode 버전)를 포함해 주시면 빠르게 대응할 수 있습니다.
