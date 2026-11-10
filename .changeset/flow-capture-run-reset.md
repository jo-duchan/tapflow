---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/android-agent": minor
"@tapflowio/ios-agent": minor
"@tapflowio/relay": minor
---

Flow Capture's Match and Verify start from the reset `tapflow flow run` gives a device (#1139). The new `device:run-reset` (agent capability `run-reset`) resets a device the session already holds and answers with what it did (`device:run-reset-done`, a `RunResetReport`) or why it could not (`device:run-reset-error`, `reason: 'unsupported'` from the relay for an agent without it). iOS reinstalls each named app in place, copying the installed bundle aside first, so it starts as a run's fresh install does, then resets the keychain, privacy permissions, pasteboard, location and keyboard language; Android `pm clear`s the apps and, over gRPC, empties the clipboard. Both put a device taken offline back online, and turn it upright (on Android, an emulator over gRPC), reported as the new `RunResetItem`s `app-reinstall`, `network` and `orientation`. A reset cut short by a shutdown or a newer boot answers an error, never a partial report. iOS runs a keyboard set behind a reset in flight on the same device. The relay answers a `device:keyboard-set` or `device:run-reset` an agent rebind stranded, as it answers a boot. The dialog shows what was reset, falls back to clearing the app's data on an agent without the request, and a flow whose range began turned sideways gets `setOrientation: landscape` after its launch.
