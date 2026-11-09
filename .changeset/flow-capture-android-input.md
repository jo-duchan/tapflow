---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/android-agent": minor
"@tapflowio/ios-agent": minor
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
"@tapflowio/mcp-server": minor
---

Flow Capture reads typing on Android and tells soft-keyboard taps from app taps (#1135). The Android agent reads the focused field through the uidump jar's new `Focused` class (`field-value`), sets typed text with `ACTION_SET_TEXT` at the caret (`input:type`, so `inputText` and MCP `type_text` take any text; ASCII still goes through `input text` with no field focused), holds Ctrl+A for select-all and Shift+Space for Caps Lock (Android 13+), and presses a field's IME action for the new `ImeAction` key code (Android 11+). Both agents answer `ui:keyboard:request` with where the soft keyboard is (`keyboard-state`; iOS through the tree runner's new `GET /keyboard`, carried into the touch space by the app's turn) and take `device:keyboard-set` with a done or error reply (`keyboard-set`): iOS writes the keyboard and restarts its daemon, Android switches Gboard with Shift+Space until its title matches, and only while it is up. `ui:field:response` carries the keyboard and its language. The relay reads the keyboard after each recorded input, one read at a time, and records it as `keyboard` entries, with a settled read once the person pauses; a tap that starts on the keyboard continues a run of typing. flow-runner judges each touch by those reads (`keyboardKey`, `imeAction`, `keyboard-unknown`), adds the `imeAction` step, and no longer refuses `replace` on Android before a run: a device that cannot select fails the step. The `paste-not-typeable` skip is gone. An iOS `flow run` boot resets the keyboard to its first language with its run reset.
