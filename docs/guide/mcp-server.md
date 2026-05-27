# MCP Server

`@tapflowio/mcp-server` exposes tapflow as a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server. Claude Code, Codex, and any other MCP-compatible LLM agent can control iOS simulators and Android emulators as native tools — no scripting, no hardcoded selectors.

## When to use this

**Repeatable automated testing** is where this shines. One-off manual checks are still faster done by hand.

- **CI/CD regression tests** — After each build, an agent boots a simulator, installs the build, walks through key flows, captures screenshots, and reports regressions. No human intervention needed. → [MCP in CI/CD](/guide/mcp-ci)
- **Multi-device matrix** — Run the same flow on iPhone SE (iOS 16), iPhone 15 Pro (iOS 17), and an Android emulator in sequence without manually switching devices.
- **Natural language QA scripts** — Non-developers (QA, PM) describe test scenarios in plain text; the agent executes them. No coordinate mapping or brittle selectors.

## How it connects

```text
LLM Agent (Claude Code, etc.)
    ↓  MCP protocol (stdio)
@tapflowio/mcp-server
    ↓  WebSocket + REST
tapflow relay
    ↓  WebSocket
Mac Agent (iOS · Android)
```

The MCP server is a local process that bridges the LLM agent to your self-hosted relay. App data never leaves your network.

## Prerequisites

- A running tapflow relay.
- A **Personal Access Token (PAT)** created in the dashboard.
  Settings → Tokens → Create Token

## Installation

```sh
npm install -g @tapflowio/mcp-server
```

## Setup

### Claude Code

Register tapflow with the `claude mcp add` command:

```sh
claude mcp add --scope project \
  --env TAPFLOW_RELAY_URL=ws://localhost:4000 \
  --env TAPFLOW_TOKEN=tflw_pat_your_token_here \
  tapflow -- tapflow-mcp
```

`--scope project` saves the config to `.mcp.json` so the whole team shares it. Use `--scope local` (the default) if you only want it for yourself.

If the relay is on a remote server, change the URL:

```sh
claude mcp add --scope project \
  --env TAPFLOW_RELAY_URL=wss://your-relay.example.com \
  --env TAPFLOW_TOKEN=tflw_pat_your_token_here \
  tapflow -- tapflow-mcp
```

### Other MCP clients (Cursor, VS Code, Codex)

Any MCP-compatible client can use tapflow. Add the following to your MCP config JSON:

```json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "ws://localhost:4000",
        "TAPFLOW_TOKEN": "tflw_pat_your_token_here"
      }
    }
  }
}
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TAPFLOW_RELAY_URL` | Relay WebSocket URL | `ws://localhost:4000` |
| `TAPFLOW_TOKEN` | Personal Access Token | (required) |

## Available tools

| Tool | Description |
|------|-------------|
| `list_devices` | List connected simulators and emulators |
| `connect_device` | Join a session (required before controlling a device) |
| `disconnect_device` | End a session |
| `boot_device` | Boot a simulator or emulator |
| `screenshot` | Capture the current screen (PNG or JPEG) |
| `tap` | Tap at a coordinate |
| `swipe` | Swipe between two coordinates |
| `type_text` | Type text into the focused field |
| `press_key` | Press a keyboard key |
| `press_button` | Press a hardware button (home, lock, etc.) |
| `install_app` | Install an app |
| `launch_app` | Launch an installed app |

## Typical workflow

An LLM agent typically calls tools in this order:

```text
list_devices       → get available devices and sessionIds
connect_device     → join a session
boot_device        → wait for the device to be ready (skip if already booted)
install_app        → install the build
launch_app         → launch the app
screenshot         → capture screen → LLM analyzes
tap / swipe / ...  → interact
screenshot         → verify result → repeat
disconnect_device  → end the session
```

::: info Device already booted
If `list_devices` returns `"status": "booted"` for a device, you can skip `boot_device`.
:::

For running this in a CI pipeline, see [MCP in CI/CD](/guide/mcp-ci).
