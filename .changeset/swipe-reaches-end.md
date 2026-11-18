---
"@tapflowio/flow-runner": patch
"@tapflowio/mcp-server": patch
"@tapflowio/android-agent": patch
---

A swipe now ends where it was asked to. Its eight moves stopped at 7/8 of the way, and every agent lifts the finger where the last move was, so every flow `swipe`, `scroll` and MCP `swipe` stopped an eighth short of its end point. Flow Capture's Verify dropped drag-and-drop pieces short of their slots while Match, which replays the recorded moves, placed them (WebdriverIO demo app on Android). The last move is now the end point, and the lift comes one interval after it, all within the duration. A plain `scroll` or `swipe` moves the content about an eighth further than before. On Android, a field set or IME action the device could not carry out now logs the error the device reported, never the text.
