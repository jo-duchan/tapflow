# dashboard — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

React SPA QA 대시보드: 시뮬레이터 뷰어, 버그 리포트, 팀 초대 화면을 제공한다.
**독립 배포 없음** — `vite build`로 `dist/`에 번들링하고, relay 패키지의 `public/`에 복사되어 릴레이 서버가 직접 서빙한다.

## HOW

- **스택**: Vite + React 19 + React Router v7 + Shadcn/Tailwind + next-themes
- **구조**: `src/` — 앱 엔트리·라우터·페이지, `components/` — 공유 컴포넌트, `hooks/` — 커스텀 훅, `lib/` — 유틸·타입·API 클라이언트
- **라우팅**: `BrowserRouter` 기반. `/login`, `/invite`는 public. 나머지는 `DashboardLayout`이 `useAuth`로 보호 (`/login` 리다이렉트).
- **Auth**: `GET /api/v1/auth/me`로 세션 확인. HttpOnly 쿠키 방식 (JS에서 직접 읽지 않음).
- **스트리밍**: `useRelay`에서 `binaryType = 'arraybuffer'` 설정, `e.data instanceof ArrayBuffer`로 바이너리 프레임 분기.
- **개발 서버 프록시**: `vite.config.ts`에서 `/api`, `/uploads` → `http://localhost:4000` 프록시.
- **빌드 순서**: dashboard 먼저 → relay 나중 (`agent-core → dashboard → relay`).

## HOW NOT

- `next` 패키지를 다시 도입하지 않는다.
- 별도 서버로 실행하지 않는다 — relay가 서빙한다.
- 대시보드에서 Agent를 직접 호출하지 않는다 — 릴레이를 반드시 경유한다.
- 플랫폼별 조건분기(`if platform === 'ios'`)를 UI 컴포넌트에 넣지 않는다.
- 세션 영상 데이터를 외부 스토리지로 전송하지 않는다.

---

## Compound

### WebSocket Binary 프레임 수신 패턴

**언제**: `useRelay`에서 바이너리 스트림 프레임을 처리할 때

**방법**:
```typescript
// useRelay.ts — connect() 내부
socket.binaryType = 'arraybuffer'
socket.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    onBinaryFrameRef.current?.(e.data)
    return
  }
  try { onMessageRef.current(JSON.parse(e.data)) } catch { }
}

// SimulatorViewer.tsx — 프레임 렌더링
createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
  .then((bitmap) => {
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()  // GPU 텍스처 메모리 해제 필수
  })
```

**이유**: `binaryType = 'arraybuffer'`를 설정하지 않으면 `e.data`가 `Blob`이 되어 추가 비동기 처리가 필요하다. `bitmap.close()`를 빠뜨리면 프레임마다 GPU 텍스처가 누적된다. `createImageBitmap`은 CPU 기반 디코딩이며 WebRTC Video Track과 달리 하드웨어 가속이 없다.
