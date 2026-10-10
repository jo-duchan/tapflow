---
"@tapflowio/relay": minor
"@tapflowio/mcp-server": minor
"@tapflowio/flow-runner": minor
"tapflow": minor
---

Dashboard: an **AI Sessions** page lists the devices an AI client is driving and watches one, read-only; the QA session's device list links an AI-held device to it. `connect_device` returns `watchUrl`, and `tapflow flow run` prints it outside CI. The relay sends `watchUrl` only when it knows an address teammates can open (a tunnel or `relay.url`); otherwise the client builds the link from the relay address it dialled.
