---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/ios-agent": minor
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
---

Flow Capture records what a person really typed (#1135). While a person is recorded, the relay asks the iOS agent for the keyboard-focused text field at the start of each run of typing and once typing pauses (`ui:field:request`/`ui:field:response`, capability `field-value`); the answer, the field's whole contents (an app's or AutoFill's text included), goes into the capture only and is never forwarded. The tree runner serves it from `GET /field`, whole and unquoted, without a secure field's value. Flow Capture exports the typing into one field as `inputText: { text, replace: true }`, which selects what the field holds and types over it; a run whose field could not be read is marked `field-unread`. `replace` is refused on Android before a run. A device's keyboard language is reset when another person takes it (`device:keyboard-reset`, capability `keyboard-reset`, #1134), and the boot's keyboard sync restarts `com.apple.TextInput.kbd` (the daemon's name on iOS 26.4) before the old name, which no longer exists there. A recorded person's boot warms the tree runner (`recorded` on `device:boot`), except on a Mac over its memory line, where fields are not read.
