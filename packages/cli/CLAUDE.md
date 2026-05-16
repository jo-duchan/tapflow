# cli — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`tapflow` CLI: 로컬 개발 환경 점검과 시뮬레이터·릴레이·에이전트 기동을 처리한다.
실제 명령어는 `src/index.ts`에 등록:

| 명령 | 동작 |
|------|------|
| `start [--device, --platform]` | 로컬 전용 shortcut — relay + agent 동시 기동 (같은 Mac) |
| `relay start [--port]` | relay만 기동 (Docker/Linux 서버용) |
| `agent start [--relay, --device, --platform]` | agent만 기동 — 기존 relay에 연결 |
| `doctor` | 시스템 prerequisites 점검 (Xcode, simctl, adb, etc.) |
| `devices` | 사용 가능한 시뮬레이터·AVD 목록 |
| `boot <name>` | 이름 또는 UDID로 시뮬레이터 부팅 |
| `reset` | 모든 시뮬레이터·에뮬레이터 종료 |
| `status [--relay]` | 연결된 agent·디바이스·세션 수 표시 (WebSocket `agents:listed`) |
| `logs [--relay] [--lines]` | relay 인메모리 로그 버퍼 조회 (`GET /api/v1/logs`) |
| `init [--relay]` | relay에 최초 관리자 계정 생성 |

### 커맨드 설계 원칙

커맨드마다 역할이 하나다. `tapflow start`는 로컬 개발 전용이며 `--relay` 옵션을 받지 않는다.
"relay에 연결"과 "relay를 기동"은 별도 커맨드(`agent start` / `relay start`)로 분리한다.

## HOW

- UX 기준: 한 줄 입력 → 진행 상황 → 결과 메시지. 스피너·배너로 시각 피드백 제공.
- 설정·캐시는 `~/.tapflow/`에 저장한다.
- 패키지 의존: `@tapflow/agent-core`, `@tapflow/ios-agent`, `@tapflow/relay`. 라이브러리로 import해 사용한다 (재구현 금지).

## HOW NOT

- 외부 시스템(클라우드, 원격 인프라)에 접근하는 명령을 추가하지 않는다 — 로컬 도구 범위 내.
- 자격증명·토큰을 코드에 하드코딩하지 않는다.
- `reset` 이외의 명령에서 시스템 상태를 파괴적으로 변경하지 않는다.
