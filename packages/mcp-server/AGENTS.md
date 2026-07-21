---
type: rules
topics: [mcp, ai-agent]
status: living
---

# mcp-server — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`@tapflowio/mcp-server`: bridges tapflow to LLM agents via the [Model Context Protocol](https://modelcontextprotocol.io).

Published on the standard npm channel and versioned by changesets in the repo-wide fixed group (graduated from the `experimental` dist-tag in 2026-07). Never publish with raw `npm publish` — it does not rewrite `workspace:*` dependencies (the package depends on `@tapflowio/flow-runner`); the changesets → pnpm publish path does.

Connects to the relay over WebSocket + REST (`TapflowClient`), registers MCP tools, and exposes them to any MCP-compatible client (Claude Code, Codex, Cursor, etc.) via stdio transport.

## HOW

- Entry: `src/index.ts` — reads `TAPFLOW_RELAY_URL` and `TAPFLOW_TOKEN` env vars, connects `TapflowClient`, calls `registerTools`, starts `StdioServerTransport`.
- Client: `src/client.ts` — WebSocket connection to relay + REST calls for build/app data.
- Tools: `src/tools.ts` — all MCP tool definitions. One `registerTools(server, client)` call registers everything.
- Screenshots are saved to a temp file and returned as MCP `image` content with base64 encoding.

### Available tools

`list_devices`, `connect_device`, `disconnect_device`, `boot_device`, `shutdown_device`, `screenshot`, `query_ui_tree`, `run_flow`, `tap`, `swipe`, `type_text`, `press_key`, `press_button`, `install_app`, `launch_app`, `list_builds`

`disconnect_device` only leaves the session (`session:leave`) — the device stays booted. `shutdown_device` powers the device down (`device:shutdown` → agent runs simctl/adb shutdown → `device:shutdown-done`); use it to free resources or force a cold boot.

`run_flow` replays a `@tapflowio/flow-runner` YAML flow deterministically (no LLM at replay time) over this process's existing relay connection — it shares the session joined via `connect_device`, so it never opens a second WebSocket or hits "Session busy".

`query_ui_tree` returns the unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`/`rawRole`) via `GET /api/v1/sessions/:sessionId/ui-tree`. Frames are normalized 0-1, so a frame center multiplied by the screenshot pixel size feeds straight into `tap`.

## HOW NOT

- Do not add relay-side logic to this package — it is a client only.
- Do not introduce stateful session management beyond what `TapflowClient` already tracks.
