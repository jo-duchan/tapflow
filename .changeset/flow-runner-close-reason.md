---
'@tapflowio/flow-runner': minor
---

A relay that closes the connection is reported with its close code and reason. A token the relay refuses, such as one without the `view` scope, used to surface as "not connected to relay" or "relay connection closed" with nothing to act on; both errors now end with, for example, `(relay closed 1008: Forbidden: this token lacks the 'view' scope needed for device sessions; create an API-type token)`.
