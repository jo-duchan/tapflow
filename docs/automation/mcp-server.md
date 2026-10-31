---
title: MCP Server
description: "Install @tapflowio/mcp-server and connect a coding agent to it. The coding agent hands you a link to watch, live, the device it is driving."
---

# MCP Server

::: warning Experimental
tapflow's **AI agents** (the MCP server) and **Automation** (the flow runner) are experimental. The manual QA dashboard is the most mature part of tapflow; these two are still maturing. Expect rough edges, especially in selector matching and in timing right after an app launches.
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
| `TAPFLOW_TOKEN` | An **API**-type PAT (`view, builds:write`), created in **Settings → Tokens**. Leave it out to read the [token file](#token-file) | (none) |
| `TAPFLOW_TOKEN_FILE` | Path of the token file | `~/.config/tapflow/credentials.json` |

## Keep the token in a file {#token-file}

Without `TAPFLOW_TOKEN`, the MCP server reads its token from a file. `tapflow token set` is the simplest way to store one, and it checks the token with the relay first; on a computer without the `tapflow` CLI, write the file by hand in the shape below. When the relay refuses the token, the server reads the file again and retries once, so replacing a token needs no re-registration and no restart.

- The file is `~/.config/tapflow/credentials.json`, or `tapflow/credentials.json` under `XDG_CONFIG_HOME` when that is set, or the path in `TAPFLOW_TOKEN_FILE`. It is in the home directory of the computer that runs the MCP server, not of the Mac the relay runs on.
- Each relay has its own token, keyed by the relay address's origin; write `ws://` as `http://` and `wss://` as `https://`.
- The file holds a token, so keep it at mode `600`, readable only by you. The MCP server warns when other users can read it (not checked on Windows).

```json
{
  "version": 1,
  "relays": {
    "http://localhost:4000": { "token": "tflw_pat_your_token_here" }
  }
}
```

`TAPFLOW_TOKEN`, when set, wins over the file and is never replaced by it. To move a registered `TAPFLOW_TOKEN` into the file, remove it from the MCP registration.

When a token is revoked, the relay closes the connection right away. Write the new token to the file and the next tool call reconnects with it. The relay releases the sessions the old connection held, so call `connect_device` again.

Connected straight to the relay's port on the Mac it runs on, the MCP server starts and drives devices without a token. `screenshot`, `query_ui_tree`, `list_builds`, `list_runs` and `get_run` still need one. When the relay refuses a token, the error says which relay refused it, where the token came from, and how to fix it.

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
| `launch_app` | Launch an installed app. `arguments` and `env` pass [launch arguments](/automation/flows#launch-arguments). The result's `applied` names the keys the app received, [launch defaults](/reference/configuration#launch-defaults) included |
| `run_flow` | Replay a YAML flow deterministically (no further LLM calls) |
| `list_runs` | List the run records `tapflow flow run` left on the relay (filter by status, build, flow name, CI or local) |
| `get_run` | Read one run record: each failed flow's steps (a passed flow's step count), failure message and file path, and screenshots of up to four failed flows |
| `get_testing_guide` | How to test a mobile feature with these tools: cases to cover, what cannot be tested here, how to avoid false bugs, how to save a verified flow, and the report format |

## Typical workflow

An LLM agent typically calls tools in this order:

```text
get_testing_guide  → read what to cover and how to report (once, before testing)
list_devices       → get available devices and sessionIds
connect_device     → join a session, hand the person the watch link
boot_device        → wait for the device to be ready (skip if already booted)
install_app        → install the build
launch_app         → launch the app
query_ui_tree      → read the screen (screenshot only for something visual)
tap / swipe / ...  → interact
query_ui_tree      → check the result → repeat
run_flow           → replay the verified scenario as a flow
disconnect_device  → end the session, freeing the device for others
```

::: info Device already booted
If `list_devices` returns `"status": "booted"` for a device, you can skip `boot_device`.
:::

A `list_devices` response can also carry values set in the dashboard: `displayName` (a name an Admin gave the device), `hidden` (an Admin hid it from the list) and `favourite` (the token owner starred it). They are for the dashboard's display and don't affect which devices you can use. A hidden device is still listed and can be connected to, and you refer to a device by its `name`, not its `displayName`. See [Organize the device list](/testing/qa-session#organize-devices).

For running this in a CI pipeline, see [MCP in CI/CD](/automation/mcp-ci).

## What the agent is told {#agent-guidance}

The server gives the coding agent two pieces of guidance, so a request as short as "test the login screen" gets a thorough run without you listing every case.

- **Server instructions**, sent once when the agent connects: the order of the tools, reading the screen with `query_ui_tree` rather than screenshots, releasing the device when done, and what a refused boot or an unconfirmed input means. Clients that support MCP server instructions add them to the agent's context: Claude Code and VS Code do, Gemini CLI does in trusted folders, and Codex shows them as the description of tapflow's tools. `connect_device`'s description repeats the two rules that matter most, for clients that do not.
- **`get_testing_guide`**, a tool the agent calls before it tests: which cases to cover, what these tools cannot test, how to check a finding before calling it a bug, how to save the verified path as a flow, and the report format.

The instructions are about 400 tokens in every session. The testing guide is about 1,200 tokens, spent only when the agent calls it.

## Watch the device a coding agent drives {#watch-the-device}

`connect_device` returns `watchUrl` in its result. Open that link in a browser to watch, live, the device the coding agent is driving. The tool description tells the coding agent to hand the link to the person who asked, so when you ask for something like "test the login screen", the coding agent gives you the link as it starts testing.

The page is reached only through the link. It is for the person who asked the coding agent to test, to watch their own work, so the dashboard has no list of these sessions. A teammate who opens the QA session's device list sees the device as in use, with **Coding agent is driving it** as the reason.

- Watching is read-only. Nothing you click reaches the device, and there is no sound.
- Any teammate signed in to the dashboard can watch. Whatever the coding agent types on the device shows on screen too, so do not test with values the team should not see.
- Up to 4 people can watch one session at a time.
- **Agent activity** beside the device shows what the coding agent does, in the order it happens, and a blue cursor stays on the device where it last tapped, gliding to the next spot with a brief trail. When a flow runs through `run_flow` or `tapflow flow run`, each step is a row with the actions taken in it underneath; steps start open and can be collapsed. Typing shows as a count of characters, and the URL opened or the character key pressed is not named. Nothing is stored, so the log starts when you open the page. When the session ends, the last picture and the log stay until you close the page.
- If the coding agent's connection drops briefly, the page keeps the last picture and waits for it to come back. The watch ends when the coding agent finishes with the session (`disconnect_device`) or another teammate starts using the device.

::: details How the link address is chosen
If the relay has an address teammates can open (a tunnel or `relay.url`), the link uses it, and you can share it with teammates as it is. Otherwise, including when `relay.url` is a `localhost` address, the MCP server builds the link from the `TAPFLOW_RELAY_URL` it connected with. For example, connected with `ws://localhost:4000`, the link starts with `http://localhost:4000/automation/sessions/` and opens on the computer running the MCP server. For an address to send to teammates, see [External access](/operate/external-access).
:::

## Fix a failed run {#fix-a-failed-run}

When `tapflow flow run` fails in CI, a coding agent can read the run and repair the flow. Ask it something like "fix last night's failed CI run", and it uses the tools in this order:

```text
list_runs   → find the failed run (status: failed)
get_run     → which step failed and why, the screen at that moment, and the flow file's path
(edit)      → change the YAML at the recorded path
run_flow    → replay the fixed flow on a device to check it
```

- A recorded flow file path is as the runner was given it, relative to the directory it ran in (the CI job's working directory, for a CI run). The coding agent finds that file in its own checkout.
- Run records are only read. The coding agent replays the flow itself with `run_flow`; nothing re-runs the CI job.
- `get_run` returns up to 4 screenshots of failed flows with the record. A passed flow's last screen and the videos are not included; open the run's page at the result's `url` to see them.
- A failure whose `failureKind` is `environment` was the device, the agent or the relay, not the app or the flow. There is nothing to fix in the flow.

The result's `url` is built from the `TAPFLOW_RELAY_URL` the MCP server connected with. Unlike the watch link, it does not use the relay's public address, so a server that connected by a name inside a container network (such as `ws://relay:4000`) gets a link a browser cannot open.

For when runs are recorded and what the dashboard shows, see [Flow Runs](/automation/runs).
