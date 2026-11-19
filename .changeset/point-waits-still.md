---
"@tapflowio/flow-runner": patch
---

A point step waits for the screen to stop moving before it touches: a `swipe`, a plain `scroll`, and a tap, long press or pinch on a point read the UI tree until two reads at least a quarter of a second apart find every element where it was (positions only; motion drawn inside one element is not seen), for at most 3 seconds, and go on as before if the screen cannot be read. In Flow Capture's Verify a swipe on a drag-and-drop piece that was still springing back from a missed drop grabbed empty space, while Match, which waits for the recorded screen, did not. Each point step costs two or more tree reads more: about 0.3 s on iOS and on Android with the faster tree read.
