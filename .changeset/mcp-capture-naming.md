---
"@tapflowio/flow-runner": patch
---

`capture/agent.ts`: an AI agent's capture (the MCP server's record of its taps, swipes, typing and `run_flow`s, with the trees it read) turned into a flow without a Match replay, and the agent's judgement of it — a range, steps left out, expectations from those offered, secrets' names — applied with a comment in the YAML saying what was left out. `flowToYaml` takes that comment. Groundwork for MCP Flow Capture (L6a); no tool calls it yet.

<!-- changelog: internal — nothing in this release calls agentSteps or agentFlow; the MCP capture tools that do come in a later PR of L6a, with their own changelog entry. -->
