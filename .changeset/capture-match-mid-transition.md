---
"@tapflowio/flow-runner": patch
"@tapflowio/relay": patch
---

Flow Capture's Match no longer stops on a tap made while the screen the tap before it brought was still coming (a doubled tap's second touch, within 500 ms, that iOS counted as a repeat or the app named nothing under). Its recorded picture is of the screen before the first tap acted, which the replay never sees. Match does what the touch did when recorded: not sent if the app ignored it (offered in the review of ignored taps), sent if the app acted on it, and sent and marked fragile (`mid-transition`) where nothing says. flow-runner adds `madeMidTransition` and `MID_TRANSITION_MS`.

<!-- changelog: internal — Flow Capture is unreleased; the Unreleased "Added" entry about ignored taps is edited -->
