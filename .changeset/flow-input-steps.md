---
"@tapflowio/flow-runner": minor
"@tapflowio/mcp-server": minor
"@tapflowio/protocol": minor
"@tapflowio/android-agent": patch
"@tapflowio/ios-agent": patch
"tapflow": minor
---

Flows can press hardware buttons (`pressButton`), hold an element (`longPressOn`) and pinch (`pinch`). A flow pressing a button the device lacks fails before its first step, as an environment failure. A button the platform never has (`back` on iOS) fails before a device is chosen when `--build` or `--parallel --platform` names the platform; one that depends on the device (`lock` on iOS) is checked against the device before the first step. `@tapflowio/protocol/buttons` holds which buttons each platform can press, read by both agents and by flow-runner. MCP `tap` takes `holdMs` for a long press. On Android's adb fallback a held touch is now a long press rather than a tap, and `flow run` ends a gesture in progress when it leaves a session.
