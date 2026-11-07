---
"@tapflowio/protocol": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
"@tapflowio/mcp-server": minor
---

Flow Capture, first part (#1125). The relay remembers, in memory and for the length of the session, the steps a person takes on a device in the dashboard, so a later release can save them as a flow. Each person turns it on or off under **Capture my steps** in the account menu (`PATCH /api/v1/me/preferences`, on by default), and the device's info card says whether it is on. UI tree elements gain `secure` on every text field and `focused` on the one taking typing.
