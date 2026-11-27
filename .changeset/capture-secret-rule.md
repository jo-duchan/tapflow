---
"@tapflowio/relay": patch
---

<!-- changelog: internal — no user-reachable path: an expectation the dashboard's Flow Capture offers is always a label (and id) selector, which the old check already read; the bare text and role it reads now never reach it. -->

The dashboard's Flow Capture keeps a secret out of an expected element's selector by the same rule as MCP Flow Capture (flow-runner `selectorHoldsSecret`), reading every string of the selector.
