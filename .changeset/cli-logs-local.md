---
'tapflow': minor
---

`tapflow logs` reads the relay on this machine, `http://localhost:<local.port>`, instead of `relay.url`, because the relay now serves its log buffer only to its own host. A `403` prints what to run on the relay machine instead of "Could not reach relay", and any other error status is named. `--relay` still picks another URL on the same machine.

`tapflow agent start` shows the relay's own reason when it refuses an agent token (for example, when the token's owner is no longer an Admin), and keeps the "create a PAT with the agent scope" hint for the refusal that actually means a missing agent token.
