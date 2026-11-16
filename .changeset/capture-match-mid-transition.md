---
"@tapflowio/flow-runner": patch
"@tapflowio/relay": patch
---

Flow Capture's Match no longer stops on a tap made while the screen the tap before it brought was still coming (a doubled tap's second touch: within 400 ms start to start, that iOS counted as a repeat, or at the same spot where the app named nothing under it or did not report it). Its recorded picture is of the screen before the first tap acted, which the replay never sees. Match does what the touch did when recorded: not sent if the app ignored it (offered in the review of ignored taps), sent if the app acted on it, and sent and marked fragile (`mid-transition`) where nothing says or where it comes right before typing (which that review never offers). flow-runner adds `madeMidTransition` and `MID_TRANSITION_MS`.

<!-- changelog: internal — Flow Capture is unreleased; the Unreleased "Added" entry about ignored taps is edited -->
