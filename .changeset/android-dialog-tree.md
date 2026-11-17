---
"@tapflowio/android-agent": patch
---

On Android, a dialog's elements were placed by the dialog's own window: with an AlertDialog in front, uiautomator's dump has the dialog as its root, and the tree was normalised by it, so the dialog's OK read 0.36 of the screen below where it is drawn. A flow's `tapOn "OK"` pressed below the dialog, and Flow Capture exported the tap as a point. The tree and the reach check now measure a floating root against the screen.
