---
"@tapflowio/flow-runner": minor
"@tapflowio/relay": minor
---

A `label` selector takes `exact: true`, which matches only an element whose whole label is the same, never a label that contains it: "Total $32.00" no longer passes on "Total $32.001". Flow Capture's Edit uses it (1b-3c): a tap step shows the screen right after the tap, where clicking an element adds it as what the tap should bring, written as an `assertVisible` with `exact: true` right after the tap. An input, the on-screen keyboard, and text holding a secret's value cannot be picked, and an element already there before the tap or a time is warned about. A step found by its place among elements alike carries a "by position" badge. flow-runner adds `expectedFor` and `mentionsSecret`. A `tapflow` from before this release refuses a flow using `exact`.
