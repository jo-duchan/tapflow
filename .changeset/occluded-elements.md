---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
"@tapflowio/mcp-server": minor
"tapflow": minor
---

A touch lands where the device says it reaches its element, and a flow checks what the touch brings (#1125). protocol: `ui:reach:request`/`ui:reach:response`, `ReachTarget`, `ReachResult`, `UIElement.checked`/`selected`, `fromFramePoint`. agent-core: the `reach` capability. ios-agent: the UI-tree runner's `/reach` (`isHittable` and the hit point), and switch and selection state in the tree. android-agent: the uidump jar's `reach` mode (window layer and drawing order), and `checked`/`selected`. relay: `POST /api/v1/sessions/:sessionId/reach`, run records keep a step's `reach`, `reachNote` and `effect`, and the dashboard's Verify and Flow Runs show unchecked touches and touches that changed nothing. flow-runner: `tapOn`, `longPressOn` and `pinch` press the reached point, `scroll { until }` stops only at a reachable center, steps take `expect` and flows `viewport` (a flow carrying either cannot be read by an older flow-runner), `observeEffects`, and Flow Capture's swipe and point rules use reach. mcp-server: `run_flow` presses the reached point. cli: `flow run` says which touches were not checked.
