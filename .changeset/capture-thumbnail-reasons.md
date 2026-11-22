---
"@tapflowio/protocol": patch
"@tapflowio/relay": patch
---

Flow Capture keeps a picture of more steps, and says why a step has none. On iOS, a step taken while the app under test is not in front (the home screen or another app) keeps its picture, as a screen recording would, and so does the app's first touch while it is still starting when the keyboard is down right after it. A Range tile with no picture shows an icon, and hovering over it says why; an install's tile shows a download icon. `CaptureSnapshot` gains an optional `thumbnailRefusals`.
