---
"@tapflowio/flow-runner": minor
"@tapflowio/relay": minor
---

Flow Capture's Match ends with a review when the app did not respond to some of the recorded iOS taps (`acted: false`): one line says how many will be left out, Continue alone leaves them out, and the line opens onto a checklist, each row showing the screen it was tapped on, to keep any. A tap Match saw change the screen, or one right before typing, is never offered. Left-out taps show in Edit as not in the flow and are not replayed by Verify or exported. flow-runner adds `noResponseTaps`, `leaveOut` and the `no-response` skip reason. A tap that only stopped a moving list now says "Not replayed" inside its Range tile. The dashboard's disclosures (App Center releases, trace steps, Edit's step details, the upload's Override version) open and close with motion: they are shadcn's Accordion and Collapsible now, on Radix.
