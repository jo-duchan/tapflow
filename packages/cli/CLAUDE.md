# cli — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`npx tapflow` CLI: 릴레이 서버 배포(`deploy`), Agent 시작(`agent start`), 팀 초대(`invite`), 상태 확인(`status`)을 인프라 지식 없이 제공한다. 내부에서 Pulumi를 사용하지만 유저에게 노출하지 않는다.

## HOW

- UX 기준: Vercel CLI. 각 명령은 한 줄 입력 → 진행 상황 → 결과 URL/확인 메시지.
- Pulumi 스택은 CLI 내부에서만 관리한다. 설정 파일은 `~/.tapflow/` 에 저장한다.
- 첫 배포 대상은 fly.io (가장 저렴, 설정 단순).

## HOW NOT

- Pulumi 오류 메시지를 그대로 유저에게 출력하지 않는다 — 친화적인 메시지로 변환한다.
- 클라우드 자격증명을 코드에 하드코딩하지 않는다.
- `deploy` 이외의 명령에서 인프라 상태를 변경하지 않는다.
