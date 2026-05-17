# INDEX.md — CLAUDE.md 참조 인덱스

각 패키지의 CLAUDE.md는 이 파일을 통해 계층적으로 참조된다.
공통 규칙은 루트 [CLAUDE.md](./CLAUDE.md)에서 확인한다.

---

## 패키지별 규칙

| 패키지 | CLAUDE.md | 핵심 역할 |
|-------|-----------|---------|
| agent-core | [packages/agent-core/CLAUDE.md](./packages/agent-core/CLAUDE.md) | DeviceAgent 인터페이스 설계 원칙 |
| ios-agent | [packages/ios-agent/CLAUDE.md](./packages/ios-agent/CLAUDE.md) | macOS 전용 시뮬레이터 제어 규칙 |
| android-agent | [packages/android-agent/CLAUDE.md](./packages/android-agent/CLAUDE.md) | ADB 기반 에뮬레이터 제어 규칙 |
| relay | [packages/relay/CLAUDE.md](./packages/relay/CLAUDE.md) | WebSocket 릴레이 서버 규칙 |
| dashboard | [packages/dashboard/CLAUDE.md](./packages/dashboard/CLAUDE.md) | Vite + React SPA UI 규칙 |
| cli | [packages/cli/CLAUDE.md](./packages/cli/CLAUDE.md) | CLI UX 규칙 |

## 로컬 전용

| 디렉토리 | CLAUDE.md | 용도 |
|---------|-----------|------|
| playground | [playground/CLAUDE.md](./playground/CLAUDE.md) | 전체 스택 로컬 실행 및 통합 테스트 |
| .work | [.work/CLAUDE.md](./.work/CLAUDE.md) | 로컬 작업 로그 컨벤션 (plan/review/compound) |

## 문서

| 파일 | 내용 |
|------|------|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 브랜치·릴리즈·커밋 컨벤션 |
| [packages/dashboard/DESIGN.md](./packages/dashboard/DESIGN.md) | dashboard 디자인 시스템 — 색상 토큰, 타이포그래피, elevation, 컴포넌트 스펙 |
| [internal/PRD.md](./internal/PRD.md) | 제품 요구사항 (내부 문서) |
| [docs/CLAUDE.md](./docs/CLAUDE.md) | VitePress 작업 규칙 — shiki 코드블럭, CSS 커스터마이징 주의사항 |

---

## 계층 구조

```
CLAUDE.md (공통 규칙 — WHAT/WHY/HOW/HOW NOT)
└── INDEX.md (이 파일 — 패키지·문서 참조 인덱스)
    ├── packages/agent-core/CLAUDE.md
    ├── packages/ios-agent/CLAUDE.md
    ├── packages/android-agent/CLAUDE.md
    ├── packages/relay/CLAUDE.md
    ├── packages/dashboard/CLAUDE.md
    ├── packages/cli/CLAUDE.md
    ├── playground/CLAUDE.md
    ├── .work/CLAUDE.md
    ├── docs/CLAUDE.md
    └── CONTRIBUTING.md
```
