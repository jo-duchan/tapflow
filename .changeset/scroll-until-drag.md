---
"@tapflowio/flow-runner": patch
"@tapflowio/mcp-server": patch
"@tapflowio/relay": patch
---

`scroll { until }` searches with drags held still before the lift instead of flings, so the list stops where the finger left it instead of gliding on past the element. On iOS a fling's glide (10 rows on a SwiftUI List and a UIKit table, measured) skipped the element between two reads, and the search ended at the list's end without it; Flow Capture's Match stopped on the tap that followed. A held finger sends its point every frame with a tiny wobble, since iOS takes neither silence nor the same point repeated as a new sample (`holdStill`, exported). The step after two that moved nothing flings, for a pager that snaps a held drag back (after one, it drags again: a drag the device dropped also moves nothing), and the end of the list is three. Whether a step moved the list is read from rows that travelled with the finger; when the screen changed and nothing travelled, the step reads once more without a gesture to learn what changes by itself (a clock, a countdown). A match at the end is taken only where the device reaches its centre. Each step moves the content as far as the finger, so a long list takes more steps (45 rows on iOS: 9.6 → 13.3 s), and the search's default wait is 60 s. `FlowDriver.swipe` takes an optional `holdMs`; MCP `run_flow` and the dashboard's Match and Verify pass it on.

The MCP client lifts a swipe's finger before it leaves the session, reports a connection lost mid-swipe as unconfirmed input, and no longer lets an old socket's late close drop the connection that replaced it.
