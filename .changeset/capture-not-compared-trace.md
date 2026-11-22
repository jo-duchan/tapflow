---
"@tapflowio/flow-runner": patch
"@tapflowio/relay": patch
---

Flow Capture marks a step whose screen Match did not compare because you went on with Continue anyway when most of it was different: Edit shows it as **fragile** and says its screen was not compared. `CapturedStep` gains an optional `notCompared`.
