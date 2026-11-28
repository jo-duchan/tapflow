---
title: AI Agent QA
description: Test your app by having an AI agent such as Claude Code drive iOS simulators and Android emulators over MCP, and save the paths it checks as flows.
---

# AI Agent QA {#ai-agent-qa}

AI Agent QA is a way to test your app by having an AI agent such as Claude Code drive tapflow's devices. The AI agent reads the screen through the [MCP server](/ai-agents/mcp-server) and sends taps and typing. The devices are the same simulators and emulators that teammates use in a QA Session.

## Connect an AI agent {#connect}

Whoever uses the AI agent installs the MCP server with npm and registers it in the AI agent's MCP settings, along with the relay address and an API-type personal access token (PAT) issued in the dashboard. The operator has nothing more to set up, since the relay and the agents keep running as usual. See [MCP server](/ai-agents/mcp-server) for the steps.

## Test and save a flow {#test-and-save}

Once it is connected, you can ask the AI agent something like "test the login screen". It can pick a device, install the app and test it by reading the screen. The AI agent also hands you a link to the device's screen. Anyone signed in to the dashboard can open the link to watch live, but cannot control the device from it.

With [AI Agent Flow Capture](/ai-agents/agent-flow-capture), the AI agent can save the path it checked as a flow YAML. tapflow resets the device and replays the flow, and returns it only if the replay passes. The replay uses no AI model.

## Run in CI {#ci}

A saved flow can be replayed in CI with no AI model. See [Run flows in CI](/automation/ci), part of [Automation QA](/automation).

A scenario not saved as a flow yet can still run in CI: an AI agent then judges the screen on every run. Results can differ between runs, and every run costs API calls. See [Exploratory runs in CI](/ai-agents/exploratory-runs).

## Related {#related}

- [MCP server](/ai-agents/mcp-server): installing it, registering it with an AI agent, the tools it offers, and watching the device.
- [Automation QA](/automation): where flows come from, replaying them, and their run records.
- [Manual QA](/testing): how teammates test builds in the browser themselves.
