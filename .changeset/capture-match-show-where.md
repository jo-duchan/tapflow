---
"@tapflowio/flow-runner": patch
"@tapflowio/relay": patch
---

Flow Capture's Match stop shows where the two pictures differ, as boxes on the replay's picture, instead of a paragraph of possible causes; a screen whose cells differ by more than half is said to be mostly different. Continue anyway now remembers: the boxed areas are left out of later stops of this capture's Matches on the same screen (a later step's recorded picture alike to the accepted one outside those areas, the areas under a quarter of the picture, and never over the point the step touches), and a mostly different step is not compared again; a Match from another start forgets both. Remembered areas apply after the mid-transition rule, only to whether Match stops; a step they let go on is neither looked at again nor has the tap before it pressed again, and a screen mostly different now is stopped on whatever was remembered there. Back to Range stays on a stop only while nothing past the launch matched or the start can still move. flow-runner adds `screenCells`, `withoutAreas` and `diffAreas`.

<!-- changelog: internal — Flow Capture is unreleased; the Unreleased "Added" entry about Flow Capture is edited -->
