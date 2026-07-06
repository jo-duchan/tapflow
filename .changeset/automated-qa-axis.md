---
"tapflow": minor
"@tapflowio/agent-core": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
"@tapflowio/mcp-server": minor
---

Automated QA axis: UI accessibility tree queries and the deterministic flow runner.

- `query_ui_tree` (MCP) / `GET /api/v1/sessions/:sessionId/ui-tree` — unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`), frames normalized 0-1 so a frame center feeds straight into `tap`. iOS reads the tree via macOS AXUIElement on Simulator.app (no WebDriverAgent); Android via `uiautomator dump` with a device-side timeout.
- `@tapflowio/flow-runner` (new package) + `tapflow flow run` — replay YAML flows with zero LLM calls: 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, CI exit-code contract (0/1/2).
- `run_flow` (MCP) — agents author a flow once, then replay it deterministically over the existing session.
- New relay messages `app:clear-state` (reset app data — `pm clear` on Android, data-container wipe on iOS) and `input:type-done`/`input:type-error` (text-entry completion ack, so a following key press stays ordered). Text entry now waits for this ack: a self-hosted agent older than this release will not send it, so text steps time out — update the agent alongside the relay.
- mcp-server and flow-runner graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.
