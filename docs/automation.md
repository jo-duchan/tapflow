---
title: Automation QA
description: An overview of replaying saved YAML flows with tapflow flow run and no AI model calls. Where flows come from, replaying them and their run records, running them in CI, and who does what.
---

# Automation QA {#automation-qa}

In Automation QA, `tapflow flow run` tests your app by replaying saved [flows](/automation/flows). A flow is a YAML file listing taps, typing and the elements that should be on screen, in order. Replay uses no AI model, so a flow always runs in the same order and costs no API calls. It mostly runs in CI, on every build. Pages here can differ in status, so check the banner at the top of each ([Page status](/get-started/introduction#page-status)).

## Who does what {#who-does-what}

| Who | What they do |
|---|---|
| Operator | Runs the relay and agent Macs. Sets how long run videos are kept and how much storage they may use (Admin). |
| Developers | Keep flows in the repository and run `tapflow flow run` in CI. |
| Teammates | Save what they did in a QA Session as a flow, and read in the run records which flow failed and why. |

## Where flows come from {#where-flows-come-from}

- **Saved from a QA Session**: a teammate exports the taps, swipes and typing they did with [Flow Capture](/testing/flow-capture).
- **Saved by a coding agent**: a coding agent saves a path it checked over MCP with [AI Agent Flow Capture](/ai-agents/agent-flow-capture).
- **Written by hand**: write the YAML in the format of the [Flow reference](/automation/flows), or edit a saved flow.

## Replay and run records {#replay-and-results}

`tapflow flow run` replays flows. Run it with a token and the results land on the dashboard's [Flow Runs](/automation/runs) page, where any teammate can see the failed screen and a video in the browser, and whether a failure came from the app or from the environment.

## Running in CI {#ci}

[Run flows in CI](/automation/ci) has a GitHub Actions example that replays flows on a self-hosted Mac runner, and covers authoring flows with a coding agent.

## Related {#related}

- [Manual QA](/testing): how teammates test builds in the browser themselves.
- [AI Agent QA](/ai-agents): how a coding agent tests by driving a device over MCP.
- [Page status](/get-started/introduction#page-status): what the Experimental and Deprecated banners mean.
