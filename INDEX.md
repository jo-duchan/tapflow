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
| dashboard | [packages/dashboard/CLAUDE.md](./packages/dashboard/CLAUDE.md) | Next.js 대시보드 UI 규칙 |
| cli | [packages/cli/CLAUDE.md](./packages/cli/CLAUDE.md) | CLI UX 및 Pulumi 추상화 규칙 |

## 로컬 전용

| 디렉토리 | CLAUDE.md | 용도 |
|---------|-----------|------|
| playground | [playground/CLAUDE.md](./playground/CLAUDE.md) | 전체 스택 로컬 실행 및 통합 테스트 |
| .work | [.work/CLAUDE.md](./.work/CLAUDE.md) | 로컬 작업 로그 컨벤션 (plan/review/compound) |

---

## 계층 구조

```
CLAUDE.md (공통 규칙 — WHAT/WHY/WHERE/HOW/HOW NOT + 워크플로우)
└── INDEX.md (이 파일 — 패키지별 CLAUDE.md 참조)
    ├── packages/agent-core/CLAUDE.md
    ├── packages/ios-agent/CLAUDE.md
    ├── packages/android-agent/CLAUDE.md
    ├── packages/relay/CLAUDE.md
    ├── packages/dashboard/CLAUDE.md
    ├── packages/cli/CLAUDE.md
    ├── playground/CLAUDE.md
    └── .work/CLAUDE.md
```
