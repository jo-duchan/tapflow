---
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
---

Flow Capture's Match compares the screen each step is about to act on with the picture of the screen it was recorded on (1b-3b), and stops at a step that looks different, showing both, until the person goes on (**Continue anyway**), goes back to Range (moving a start still at its default back over the steps taken in the app before it, never past the last clean start) or edits what matched. flow-runner adds the comparison as pure functions (`screenDiff`, `statusBarRect`, `sameShape`, `SCREEN_DIFF_THRESHOLD`), `stepsBeforeRange`, and `RawStep.keyboardRect`, where the on-screen keyboard was as a step began, in the picture's space. Edit what matched after Stop no longer carries the stop's message into Verify.
