---
"tapflow": minor
"@tapflowio/flow-runner": minor
---

`tapflow flow run` records each run on the relay (`/api/v1/runs`) when it has a token: flows, steps, failure screenshots, device, build and CI context. Recording never changes the result or exit code; `--no-record` turns it off. A cancelled run leaves its session and exits 130 (SIGINT) or 143 (SIGTERM). `RelayClient.clientId` is now readable, so a run record can name its runner.
