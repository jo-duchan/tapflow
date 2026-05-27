# MCP Server

`@tapflowio/mcp-server` exposes tapflow as a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server. Any LLM agent that supports MCP — Claude Code, Codex, and others — can call tapflow directly as a native tool.

```
LLM Agent (Claude Code, etc.)
    ↓  MCP protocol (stdio)
@tapflowio/mcp-server
    ↓  WebSocket + REST
tapflow relay
    ↓  WebSocket
Mac Agent (iOS · Android)
```

## Prerequisites

- A running tapflow relay.
- A **Personal Access Token (PAT)** created in the dashboard.
  Settings → Tokens → Create Token

## Installation

```sh
npm install -g @tapflowio/mcp-server
```

## Claude Code configuration

Add the following to your project's `.claude/mcp.json`:

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

If the relay is on a remote server, update `TAPFLOW_RELAY_URL` accordingly:

```json
{
  "TAPFLOW_RELAY_URL": "wss://your-relay.example.com"
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

```
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

## Example prompt

In Claude Code, you can instruct the agent in natural language:

```
Open the simulator and capture the login screen of the sandbox app.
Type test@example.com into the email field, tap the login button,
then capture the result screen and check for any errors.
```
