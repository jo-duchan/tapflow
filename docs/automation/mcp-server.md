---
title: MCP Server
description: "Install @tapflowio/mcp-server and connect a coding agent to it. Teammates can watch the device the coding agent is driving, live, in the dashboard."
---

# MCP Server

::: warning Experimental
tapflow's **AI Automation axis** — the MCP server and the flow runner — is experimental. The manual QA dashboard is the mature, production path; this axis is additive and still maturing. Expect rough edges, especially in selector matching and in timing right after an app launches.
:::

`@tapflowio/mcp-server` exposes tapflow as a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server. Claude Code, Codex, and any other MCP-compatible LLM agent can control iOS simulators and Android emulators as native tools — no scripting, no hardcoded selectors.

These three guides fit together: connect a coding agent here, learn the flow YAML format in the [Flow Reference](/automation/flows), then combine them in [MCP in CI/CD](/automation/mcp-ci), where an agent authors a flow once and CI replays it deterministically.

## When to use this

**Repeatable automated testing** is where this shines. One-off manual checks are still faster done by hand.

- **CI/CD regression tests** — After each build, an agent boots a simulator, installs the build, walks through key flows, captures screenshots, and reports regressions. No human intervention needed. → [MCP in CI/CD](/automation/mcp-ci)
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
- A **personal access token (PAT)** created in the dashboard.
  Go to **Settings → Tokens → New token** and choose the **API** Type. The Tokens page is shown to Admins, Developers and QA.

## Installation

```sh
npm install -g @tapflowio/mcp-server
```

## Setup

### Claude Code

Register tapflow with the `claude mcp add` command:

```sh
claude mcp add tapflow --scope project \
  --env TAPFLOW_RELAY_URL=ws://localhost:4000 \
  --env TAPFLOW_TOKEN=tflw_pat_your_token_here \
  -- tapflow-mcp
```

`--scope project` saves the config to `.mcp.json` so the whole team shares it. Use `--scope local` (the default) if you only want it for yourself.

If the relay is on a remote server, change the URL:

```sh
claude mcp add tapflow --scope project \
  --env TAPFLOW_RELAY_URL=wss://your-relay.example.com \
  --env TAPFLOW_TOKEN=tflw_pat_your_token_here \
  -- tapflow-mcp
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
| `TAPFLOW_TOKEN` | An **API**-type PAT (`view, builds:write`), created in **Settings → Tokens** | (required) |

## Available tools

| Tool | Description |
|------|-------------|
| `list_builds` | List the apps and builds on the relay (where the `buildId` for `install_app` and `launch_app` comes from) |
| `list_devices` | List connected simulators and emulators |
| `connect_device` | Join a session (required before controlling a device). Also returns `watchUrl`, a dashboard link for watching the device |
| `disconnect_device` | End a session |
| `boot_device` | Boot a simulator or emulator |
| `shutdown_device` | Power the device down (frees resources; forces a cold boot next time) |
| `screenshot` | Capture the current screen (PNG, or JPEG on iOS when requested) |
| `query_ui_tree` | Read the on-screen UI as a structured accessibility tree (role, label, identifier, frame) |
| `tap` | Tap at a coordinate |
| `swipe` | Swipe between two coordinates |
| `type_text` | Type text into the focused field |
| `press_key` | Press a keyboard key |
| `press_button` | Press a hardware button (home, lock, etc.) |
| `install_app` | Install an app |
| `launch_app` | Launch an installed app |
| `run_flow` | Replay a YAML flow deterministically (no further LLM calls) |

## Typical workflow

An LLM agent typically calls tools in this order:

```text
list_devices       → get available devices and sessionIds
connect_device     → join a session, hand the person the watch link
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

For running this in a CI pipeline, see [MCP in CI/CD](/automation/mcp-ci).

## Watch the device a coding agent drives {#watch-the-device}

`connect_device` returns `watchUrl` in its result. Open that link in a browser to watch, live, the device the coding agent is driving. The tool description tells the coding agent to hand the link to the person who asked, so when you ask for something like "test the login screen", the coding agent gives you the link as it starts testing.

Without the link, you can find the devices a coding agent is driving right now under **AI Sessions** in the dashboard sidebar. In the QA session's device list, such a device shows **Coding agent is driving it · Watch** (**Flow runner is driving it · Watch** for the flow runner) and opens the same page.

- Watching is read-only. Nothing you click reaches the device, and there is no sound.
- Any teammate signed in to the dashboard can watch. Whatever the coding agent types on the device shows on screen too, so do not test with values the team should not see.
- Up to 4 people can watch one session at a time.
- If the coding agent's connection drops briefly, the page keeps the last picture and waits for it to come back. The watch ends when the coding agent finishes with the session (`disconnect_device`) or another teammate starts using the device.

::: details How the link address is chosen
If the relay has an address teammates can open (a tunnel or `relay.url`), the link uses it, and you can share it with teammates as it is. Otherwise, including when `relay.url` is a `localhost` address, the MCP server builds the link from the `TAPFLOW_RELAY_URL` it connected with. For example, connected with `ws://localhost:4000`, the link starts with `http://localhost:4000/automation/sessions/` and opens on the computer running the MCP server. For an address to send to teammates, see [External access](/operate/external-access).
:::
