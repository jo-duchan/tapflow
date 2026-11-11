---
"@tapflowio/relay": minor
"@tapflowio/protocol": minor
"@tapflowio/flow-runner": minor
---

Flow Capture keeps a picture of the screen each recorded step began on (1b-3b). The dashboard grabs the frame it draws as an input starts and sends a 160 px JPEG to `PUT /api/v1/sessions/:sessionId/capture/thumbnails/:requestId`, keyed by the step's first `requestId`; the relay holds it in memory beside the capture under a 1.5 MB cap of its own, only for an input the capture holds, once, cookie-only and owner-only, and drops it with the capture's seal and trim. A touch that began on the soft keyboard is never kept: that screen shows what was just typed. `CaptureSnapshot.thumbnails` lists the steps with a picture, read from `GET …/capture/snapshot/thumbnails/:requestId`. flow-runner's `RawStep.thumbnailKey` names each step's picture, and the dialog's Range strip shows it, marking a key on the soft keyboard as kept without one. The Range help now says the part starts at your first step in the app.
