---
type: rationale
topics: [relay, websocket, reliability]
status: stable
---

# Why the relay runs an application-level WebSocket heartbeat

> Read this before removing the ping/pong liveness check, or before assuming a closed
> socket cleans itself up promptly. An abnormally dropped socket can linger for minutes
> without it.

## The problem

A socket that dies abnormally (Wi-Fi drop, sleep, cable pull) is not reported closed until
the OS TCP timeout fires, which can be tens of seconds to minutes. Until then the relay
holds a dead agent/browser/stream socket, which shows up as a stale card or session. This
is the slow-decay other half of the already-merged register-time dedup.

## The design (standard ws heartbeat)

Every tick, terminate any socket that did not answer the previous ping, then ping the rest:

```
on connection: setAlive(ws, true); ws.on('pong', () => setAlive(ws, true))
heartbeat tick (every HEARTBEAT_MS):
  for ws of wss.clients:
    if (!isAlive(ws)) { ws.terminate(); continue }   // missed last pong → dead
    setAlive(ws, false)
    if (ws.readyState === OPEN) ws.ping()             // never ping a non-OPEN socket
```

Dead-socket detection therefore takes at most about `2 × HEARTBEAT_MS`.

## Why it needs no new cleanup code

- `terminate()` triggers the existing `ws.on('close')` handler, which already evicts agent,
  stream, and browser sockets. The heartbeat reuses that path rather than adding cleanup, so
  the regression surface stays minimal.
- All roles share `wss.clients`, so iterating it covers every socket with no role branching.
- Liveness is stored in a `WeakMap`, not a `Map`, so the GC reclaims entries and there is no
  manual delete to forget on close.
- The browser `WebSocket` API and the node `ws` client both auto-reply to ping, so this is
  relay-only: no client change.
- The heartbeat timer must be cleared in `stop()` alongside the existing interval, or it
  leaks as a zombie timer.
