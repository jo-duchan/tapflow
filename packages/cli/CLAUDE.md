# cli — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`tapflow` CLI: 로컬 개발 환경 점검과 시뮬레이터·릴레이·에이전트 기동을 한 번에 처리한다.
실제 명령어는 `src/index.ts`에 등록된 5개:

| 명령 | 동작 |
|------|------|
| `doctor` | 시스템 prerequisites 점검 (Xcode, simctl, etc.) |
| `devices` | 사용 가능한 시뮬레이터 목록 |
| `boot <name>` | 이름 또는 UDID로 시뮬레이터 부팅 |
| `start [--device, --relay]` | relay + ios-agent 동시 기동 |
| `reset` | 모든 시뮬레이터 종료 |

## HOW

- UX 기준: 한 줄 입력 → 진행 상황 → 결과 메시지. 스피너·배너로 시각 피드백 제공.
- 설정·캐시는 `~/.tapflow/`에 저장한다.
- 패키지 의존: `@tapflow/agent-core`, `@tapflow/ios-agent`, `@tapflow/relay`. 라이브러리로 import해 사용한다 (재구현 금지).

## HOW NOT

- 외부 시스템(클라우드, 원격 인프라)에 접근하는 명령을 추가하지 않는다 — 로컬 도구 범위 내.
- 자격증명·토큰을 코드에 하드코딩하지 않는다.
- `reset` 이외의 명령에서 시스템 상태를 파괴적으로 변경하지 않는다.
