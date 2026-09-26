---
'tapflow': minor
---

`tapflow logs` reads the relay on this machine, `http://localhost:<local.port>`, instead of `relay.url`, because the relay now serves its log buffer only to its own host. A `403` prints what to run on the relay machine instead of "Could not reach relay", and any other error status is named. `--relay` still picks another URL on the same machine.

`tapflow agent start` leaves out its "create a PAT with the agent scope" hint when the relay refuses the token because its owner is no longer an Admin; the relay's reason says what to do instead. Every other refusal keeps the hint.

When the local relay answers `403` (a Docker relay sees the host as remote), `tapflow logs` points at `docker compose logs`; when nothing answers and `relay.url` is set, it says that `relay.url` is not read and the command belongs on the relay host.
