---
"@tapflowio/relay": patch
---

relay: bind the server dual-stack (IPv4 + IPv6). A bare `listen(port)` bound IPv6-only on some macOS/node setups, so an agent on another Mac connecting over `ws://<ipv4>:4000` timed out (TCP/HTTP reached the host, but the WebSocket handshake never hit the server). The relay now binds with `{ host: '::', ipv6Only: false }`, so LAN agents connect over IPv4 without a workaround.
