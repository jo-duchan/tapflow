---
"@tapflowio/protocol": minor
"@tapflowio/flow-runner": minor
"tapflow": minor
"@tapflowio/relay": patch
"@tapflowio/android-agent": patch
"@tapflowio/mcp-server": patch
---

Flow Capture, second part (#1125). Flows gain `tapOn: [x, y]`, `longPressOn` with a point, and `inputText: { secret: NAME }`, typed from a value `tapflow flow run --secret NAME` reads from the environment and never logged. `@tapflowio/flow-runner/browser` adds the capture module the dashboard will use to turn a person's recorded steps into a flow, and `SessionChannel` gains `replayInputs` and `pasteText` for replaying them. `@tapflowio/protocol/capture` holds the record's types, and the relay keeps each gesture's last move when it thins a long record. A run missing a secret stops before a device is chosen (`run_flow` before its install), and Android's `inputText` no longer puts the typed text in an error.
