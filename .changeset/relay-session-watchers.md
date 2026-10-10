---
"@tapflowio/protocol": minor
"@tapflowio/relay": minor
"@tapflowio/mcp-server": minor
"@tapflowio/flow-runner": minor
---

Watch a session an AI client is driving, read-only. `session:start` gains an optional `clientKind` (`dashboard`, `mcp`, `flow-runner`), which the MCP server and the flow runner now send. A session held by an AI client can be watched by a signed-in teammate through the new `watch:start` / `watch:stop`, answered by `watch:started` / `watch:refused` and followed by `watch:holder-left` / `watch:ended`. The device list names the AI client driving a device (`holder`), and an AI holder's `session:joined` carries `watchUrl`. All additive: an older client is simply not watchable, and an older relay ignores the new messages.
