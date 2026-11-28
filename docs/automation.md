---
title: Automation QA
description: Test your app by replaying saved YAML flows with tapflow flow run and no AI model, mostly in CI, and read the results on the dashboard's Flow Runs page.
---

# Automation QA {#automation-qa}

Automation QA is a way to test your app by replaying saved flows with `tapflow flow run`. A flow is a YAML file that lists taps, typing and the elements that should be on screen, in order. Replay uses no AI model, so a flow runs the same steps every time and costs no API calls. Teams mostly run their flows in CI, on every build.

## Where flows come from {#where-flows-come-from}

- **From Manual QA**: a teammate saves the taps, swipes and typing they did in a QA Session with [Flow Capture](/testing/flow-capture). Before export, the flow is replayed on the device to check it.
- **From AI Agent QA**: an AI agent saves the path it checked with [AI Agent Flow Capture](/ai-agents/agent-flow-capture).
- **By hand**: write a flow in the format of the [Flow reference](/automation/flows), or edit a saved one.

## Results {#replay-and-results}

Run `tapflow flow run` with a token, and the results are kept on the dashboard's [Flow Runs](/automation/runs) page. Any teammate can open it in the browser to see the screen a flow failed on, a video of the flow, and whether the failure came from the app or from the environment (the device, the agent or the relay).

## Run in CI {#ci}

[Run flows in CI](/automation/ci) has a GitHub Actions example for a self-hosted Mac runner, and shows how to author flows with an AI agent.

## Related {#related}

- [Manual QA](/testing): how teammates test builds in the browser themselves.
- [AI Agent QA](/ai-agents): how an AI agent tests the app by driving a device over MCP.
