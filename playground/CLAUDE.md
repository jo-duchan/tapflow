# playground — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../CLAUDE.md) | 전체 인덱스: [INDEX.md](../INDEX.md)

---

## WHAT

로컬 전체 스택 테스트 환경. 실제 패키지를 npm workspaces symlink로 참조해 구현 전 API 설계 검증 및 구현 후 통합 테스트에 사용한다.

## HOW

터미널 두 개로 전체 스택을 실행한다.

```bash
# 터미널 1 — 릴레이 + 대시보드
npm run dev:relay

# 터미널 2 — Agent (플랫폼에 맞게 선택)
npm run dev:ios-agent
npm run dev:android-agent

# 브라우저 → http://localhost:3000
```

환경변수로 포트·릴레이 URL 오버라이드 가능.
```bash
PORT=4000 npm run dev:relay
RELAY_URL=ws://localhost:4000 npm run dev:ios-agent
```

## HOW NOT

- 이 디렉토리 코드를 패키지 소스로 import하지 않는다 — 단방향 참조.
- playground 코드를 `packages/`에 복사하지 않는다.
- 실제 디바이스 자격증명·토큰을 스크립트에 하드코딩하지 않는다.
