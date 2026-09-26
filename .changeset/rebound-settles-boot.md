---
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
---

A `session:rebound` now settles an in-flight `device:boot` immediately instead of letting it run to its full deadline. The rebinding agent never saw the parked boot, so it can never be answered; the failure carries the rebound cause and reads as environmental. Every other request type keeps waiting for its reply on the new socket, `session:agent-away` still settles nothing, and a boot issued after the rebound is the recovery boot that restores the binding.
