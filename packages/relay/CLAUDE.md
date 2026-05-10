# relay — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

WebSocket 릴레이 서버 + 대시보드 서빙: NAT 통과, 세션 라우팅, JWT 인증을 처리하며, `public/`의 대시보드 static 파일을 HTTP로 함께 서빙한다.
단일 프로세스, 단일 포트(443)로 WebSocket과 HTTP static serving을 모두 처리한다.

## HOW

- Agent는 outbound WebSocket으로 릴레이에 먼저 연결한다 (NAT 통과의 핵심).
- JSON 메시지와 바이너리 프레임을 동일 WebSocket 연결로 처리한다. `isBinary` 플래그로 분기한다.
- 제어 메시지 프로토콜: `input:touch:*`, `input:pinch:*`, `input:button`, `device:boot`, `device:shutdown`, `session:start`, `session:end`.
- JWT는 팀 초대 링크 기반으로 발급한다.
- `public/` 디렉토리를 HTTP static 파일로 서빙한다 (dashboard build output).
- 릴레이는 스트림 데이터를 버퍼링하지 않는다 — 도착 즉시 포워딩한다.
- WebSocket 업그레이드 요청과 일반 HTTP 요청을 동일 포트에서 분기 처리한다.

## HOW NOT

- 릴레이에서 화면 데이터를 저장하거나 분석하지 않는다.
- 인증 없이 세션 라우팅을 허용하지 않는다.
- t3.small 이상의 인스턴스가 필요한 설계를 도입하지 않는다 (비용 원칙).
- `public/` 파일을 직접 수정하지 않는다 — dashboard 빌드 결과물이다.
- 바이너리 프레임을 JSON으로 파싱하거나 역직렬화하지 않는다 — `isBinary === true`이면 즉시 포워딩만 한다.

---

## Compound

### 바이너리 프레임 포워딩

**언제**: Agent에서 오는 WebSocket 바이너리 메시지를 Browser로 중계할 때

**방법**:
```typescript
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const session = this.sessions.getBySocket(ws)
    if (session?.browserSocket?.readyState === WebSocket.OPEN) {
      session.browserSocket.send(data, { binary: true })
    }
    return
  }
  try {
    const msg: RelayMessage = JSON.parse(data.toString())
    this.route(ws, msg)
  } catch { }
})
```

**이유**: `{ binary: true }` 옵션을 빠뜨리면 `ws` 라이브러리가 Buffer를 UTF-8 텍스트로 전송해 브라우저에서 `e.data`가 string이 된다. 릴레이는 스트림 내용에 무관해야 하며 파싱 비용이 없어야 한다.
