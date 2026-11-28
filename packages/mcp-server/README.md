# @tapflowio/mcp-server

[Model Context Protocol](https://modelcontextprotocol.io) server for [tapflow](https://github.com/jo-duchan/tapflow) — lets Claude Code, Codex, and any MCP-compatible LLM agent control iOS simulators and Android emulators as native tools.

## Setup

```sh
npm install -g @tapflowio/mcp-server
```

Point it at your tapflow relay:

```jsonc
// e.g. Claude Code: .mcp.json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "ws://localhost:4000",
        "TAPFLOW_TOKEN": "tflw_pat_..." // API-type PAT (view, builds:write). Optional: leave it out to read ~/.config/tapflow/credentials.json, which is re-read when the relay refuses a token, so replacing it needs no re-registration
      }
    }
  }
}
```

## Tools

`list_devices`, `connect_device`, `disconnect_device`, `boot_device`, `screenshot`, `query_ui_tree`, `run_flow`, `tap`, `swipe`, `type_text`, `press_key`, `press_button`, `install_app`, `launch_app`, `list_builds`, `list_runs`, `get_run`

- `query_ui_tree` returns the accessibility tree as `{ role, label, identifier, frame, enabled }` with frames normalized 0-1 — tap by element instead of guessing coordinates from screenshots.
- `list_runs` and `get_run` read the run records `tapflow flow run` leaves on the relay, with the screen each failed flow stopped on — so an agent can repair a failed CI flow and check it with `run_flow`.
- `run_flow` replays a [`@tapflowio/flow-runner`](https://www.npmjs.com/package/@tapflowio/flow-runner) YAML flow deterministically — author once with the agent, replay with zero LLM calls.

Full guide: [tapflow.dev/ai-agents/mcp-server](https://www.tapflow.dev/ai-agents/mcp-server)

## License

[MIT](LICENSE) — part of the [tapflow](https://github.com/jo-duchan/tapflow) project.
