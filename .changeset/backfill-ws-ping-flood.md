---
"@tapflowio/agent-core": patch
"@tapflowio/android-agent": patch
"tapflow": patch
"@tapflowio/flow-runner": patch
"@tapflowio/ios-agent": patch
"@tapflowio/mcp-server": patch
"@tapflowio/relay": patch
---

Backfills: #1197

Depend on `ws` 8.23.0, which fixes a memory exhaustion by a peer that floods Ping frames and stops reading.
