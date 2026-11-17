---
"@tapflowio/protocol": patch
"@tapflowio/relay": patch
---

Report malformed shutdown payloads to the caller when the envelope is valid, echoing a supplied request ID and omitting it when absent.
