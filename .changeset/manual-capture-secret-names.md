---
"@tapflowio/flow-runner": patch
"@tapflowio/relay": patch
---

Flow Capture (the dashboard's) no longer writes a value typed as a secret into a step's name. A tap, long press or pinch named by an element whose text holds a password or a value made a secret in Edit is written by its point and marked fragile (`secret-name`), a `scroll { until }` to such an element as the swipe it was, and a step with no such form is left out (`holds-secret`). flow-runner keeps each named touch's unnamed form on `CapturedStep.unnamed` and exports `withoutSecretNames`; the dashboard applies it to what Edit shows, verifies and exports, builds its secret list with `secretPieces`, and leaves out of Export any `expect` anchor Verify saw holding one (Verify's engine hides only the secrets the flow types, not a removed step's). A step said by its point keeps Match's look of its effect, and typed text a secret's value left out can still be made a secret. Both captures (this and MCP's) now read only strings that can hold typed text: a key code, a button, an orientation, a bundle id, a role or a scroll's direction is never matched, so a one-character secret no longer takes those steps with it.
