# mcp-server — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`@tapflowio/mcp-server`: bridges tapflow to LLM agents via the [Model Context Protocol](https://modelcontextprotocol.io).

**Experimental** — published under the `experimental` dist-tag. APIs and tool schemas may change between releases. Excluded from changeset automatic version management until promoted to stable.

Connects to the relay over WebSocket + REST (`TapflowClient`), registers MCP tools, and exposes them to any MCP-compatible client (Claude Code, Codex, Cursor, etc.) via stdio transport.

## HOW

- Entry: `src/index.ts` — reads `TAPFLOW_RELAY_URL` and `TAPFLOW_TOKEN` env vars, connects `TapflowClient`, calls `registerTools`, starts `StdioServerTransport`.
- Client: `src/client.ts` — WebSocket connection to relay + REST calls for build/app data.
- Tools: `src/tools.ts` — all MCP tool definitions. One `registerTools(server, client)` call registers everything.
- Screenshots are saved to a temp file and returned as MCP `image` content with base64 encoding.

### Available tools

`list_devices`, `connect_device`, `disconnect_device`, `boot_device`, `screenshot`, `tap`, `swipe`, `type_text`, `press_key`, `press_button`, `install_app`, `launch_app`, `list_builds`

## HOW NOT

- Do not add relay-side logic to this package — it is a client only.
- Do not introduce stateful session management beyond what `TapflowClient` already tracks.
- Do not promote to `latest` dist-tag until the experimental graduation checklist in `.work/2026-05-28-mcp-usability-todo.md` is complete.
- Do not add this package to changeset automatic versioning until the `ignore` entry in `.changeset/config.json` is removed as part of graduation.
