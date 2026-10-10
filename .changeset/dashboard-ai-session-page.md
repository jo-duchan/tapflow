---
"@tapflowio/relay": minor
"@tapflowio/mcp-server": minor
"@tapflowio/flow-runner": minor
"tapflow": minor
---

Dashboard: a watch page (`/automation/sessions/<id>`) shows, read-only, the device an AI client is driving; it is reached through the link below, and the QA session's device list says which AI client holds a device. `connect_device` returns `watchUrl`, and `tapflow flow run` prints it outside CI. The relay sends `watchUrl` only when it knows an address teammates can open (a tunnel or `relay.url`); otherwise the client builds the link from the relay address it dialled.
