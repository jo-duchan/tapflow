---
"@tapflowio/flow-runner": patch
"@tapflowio/relay": patch
---

Flow Capture turns a swipe into `scroll { until }` only when the swipe scrolled the tapped element into view: what was on screen before it moved with the finger, or the swipe was made inside a scrollable list. A drag-and-drop that finished a puzzle and brought up a Retry button on a new screen was turned into a scroll, so Verify searched the puzzle for Retry instead of dragging the last piece.
