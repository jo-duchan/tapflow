---
"@tapflowio/protocol": minor
"@tapflowio/relay": minor
"@tapflowio/agent-core": minor
"@tapflowio/ios-agent": patch
"@tapflowio/android-agent": patch
"@tapflowio/flow-runner": patch
---

`input:touch:cancel` lifts an open touch without completing it (#1115). flow-runner sends it, followed by the end it sent before, when it leaves a session mid-gesture, so an agent that cancels shows the app a cancelled touch rather than a tap, and an older agent or relay completes the gesture as before. iOS cancels through the touch helper's digitizer event, Android through a palm on the gRPC slot (Android 11 and later), `ACTION_CANCEL` on scrcpy (not measured on a device), and a dropped gesture on the adb fallback; paths with no cancel lift with an up, as an end does. Agents announce `touch-cancel`, which the relay reads to keep the end that follows a cancel out of the watcher feed.
