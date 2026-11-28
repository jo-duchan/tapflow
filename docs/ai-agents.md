---
title: AI Agent QA
description: An overview of how an AI agent such as Claude Code tests your app by driving iOS simulators and Android emulators over MCP. Who does what, where to start, and how teammates watch the device.
---

# AI Agent QA {#ai-agent-qa}

In AI Agent QA, an AI agent such as Claude Code tests your app by driving tapflow's devices. The AI agent reads the screen and sends taps and typing through the [MCP server](/ai-agents/mcp-server). The devices are the same simulators and emulators that teammates use in a QA Session. Pages here can differ in status, so check the banner at the top of each ([Page status](/get-started/introduction#page-status)).

## Who does what {#who-does-what}

| Who | What they do |
|---|---|
| Operator | Runs the relay and the agents as usual. AI Agent QA needs nothing more installed where they run. |
| Whoever uses the AI agent | Sets up the MCP server on their own computer and connects it to the relay with a token from the dashboard. Then asks the AI agent to test. |
| Teammates | Open the link the AI agent hands over to watch the device screen in the browser. |

## Where to start {#start}

1. [MCP server](/ai-agents/mcp-server): install `@tapflowio/mcp-server` and connect it to your AI agent. Then ask something like "test the login screen", and the AI agent picks a device, installs the app and tests it by reading the screen.
2. [AI Agent Flow Capture](/ai-agents/agent-flow-capture): save the path the AI agent checked as a flow YAML. It resets the device, replays the flow and returns it only if it passes.
3. [Run flows in CI](/automation/ci): replay the saved flow in CI with no AI model. From here on it is [Automation QA](/automation).

For a scenario not yet saved as a flow, [Exploratory runs in CI](/ai-agents/exploratory-runs) has an AI agent judge the screen in CI on every run. The result can differ between runs, and every run costs API calls.

## Watching the device {#watch}

When an AI agent connects to a device, it hands over a link that shows the device screen live. Any teammate signed in to the dashboard can open it. It is view-only, so clicking the screen sends nothing to the device. See [Watching the device an AI agent drives](/ai-agents/mcp-server#watch-the-device).

## Related {#related}

- [Automation QA](/automation): where flows come from, replaying them, run records and CI.
- [Manual QA](/testing): how teammates test builds in the browser themselves.
- [Page status](/get-started/introduction#page-status): what the Experimental and Deprecated banners mean.
