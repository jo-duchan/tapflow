---
"@tapflowio/protocol": minor
"@tapflowio/ios-agent": minor
"@tapflowio/relay": minor
---

Flow Capture records what each iOS touch hit, seen from inside the app. While a person's steps are recorded, the iOS agent turns on the simulator's app accessibility (put back afterwards from a host marker, never touched where it was on already), the app observer reports each touch-down — whether the list under it was still moving, and the accessibility element and nearest button it hit — and the agent pairs the report with the gesture it delivered and sends it as `capture:touched`. The relay keeps it in the capture as a `touched` entry; it asks for these on the boot (`touchObservations`), so an agent sends none to an older relay. Nothing uses them yet: Match and Export read them next.
