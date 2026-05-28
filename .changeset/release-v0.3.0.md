---
"tapflow": minor
"@tapflowio/agent-core": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
"@tapflowio/relay": minor
---

Release v0.3.0

- relay: add screenshot REST endpoint (`GET /api/v1/sessions/:id/screenshot`) for CI and AI agent use
- relay: enforce PAT scope checks on builds endpoints; new tokens include `view` scope by default
- relay: add `session:leave` message type — MCP clients can disconnect without ending the session
- relay: fix `.app` bundle names with spaces in zip upload validation
- dashboard: add deeplink URL execution from QA session toolbar
- dashboard: add keyboard shortcuts and Kbd UI to simulator toolbar
- dashboard: add streaming performance overlay
