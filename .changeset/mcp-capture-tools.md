---
"@tapflowio/mcp-server": minor
"@tapflowio/flow-runner": minor
---

MCP Flow Capture (L6a): `connect_device` takes `capture: true`, and two new tools turn what the agent did on the device into a flow. `list_captured_steps` numbers the captured steps, says how each is named (the agent's element, what the touch was seen to hit, the tree, or a fragile point) and what each may expect; `capture_flow` builds a flow from the agent's choices only, resets the device as a CI run does (`device:run-reset`), replays it, and returns the YAML only when the replay passes. Text typed while capturing is a secret unless the field was read as not secure, and is never echoed back. flow-runner's `agentFlow` reports each written step's origin and writes `viewport` for a flow that touches a point; `firstPointStep` and `viewportOf` are exported.
