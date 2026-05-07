# dashboard — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

Next.js QA 대시보드: 시뮬레이터 뷰어, 세션 녹화/재생, 버그 리포트, 테스트 케이스 관리, 팀 초대 화면을 제공한다.
**독립 배포 없음** — `next build`로 `out/`에 static export하고, relay 패키지의 `public/`에 복사되어 릴레이 서버가 직접 서빙한다.

## HOW

- `next.config`에 `output: 'export'`를 설정해 완전한 static 파일로 빌드한다.
- 플랫폼 전환(iOS ↔ Android)은 `AgentRegistry.get(platform)` 한 줄로 처리한다.
- 스트림 뷰어는 WebSocket으로 릴레이에 연결하고, MJPEG/WebRTC 모두 지원하도록 추상화한다.
- 터치 이벤트는 canvas 좌표를 디바이스 해상도로 정규화해 전송한다.
- 빌드 순서: dashboard 먼저 → relay 나중 (`agent-core → dashboard → relay`).

## HOW NOT

- `next start`나 별도 서버로 실행하지 않는다 — relay가 서빙한다.
- 대시보드에서 Agent를 직접 호출하지 않는다 — 릴레이를 반드시 경유한다.
- 플랫폼별 조건분기(`if platform === 'ios'`)를 UI 컴포넌트에 넣지 않는다.
- 세션 영상 데이터를 외부 스토리지로 전송하지 않는다.
