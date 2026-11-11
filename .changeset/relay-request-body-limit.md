---
"@tapflowio/relay": patch
---

A JSON request body is limited to 1 MiB and an invitation form to its own fields, and a WebSocket refused for its credential is not read after the refusal. An invitation avatar over 2 MB is refused instead of being kept cut off.
