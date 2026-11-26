---
"@tapflowio/protocol": patch
"@tapflowio/relay": patch
"@tapflowio/ios-agent": patch
"@tapflowio/android-agent": patch
"@tapflowio/agent-core": patch
"@tapflowio/mcp-server": patch
"@tapflowio/flow-runner": patch
---

An MCP client can turn on record-time touch observation for the device it holds, without a boot, and get back what the agent observed for each touch it sent (`capture:observe`, `capture:observation`). The relay forwards the request to an agent naming `capture-observe`, keeps observation on across that client's own boots and the agent coming back, turns it off when the client goes, and keeps none of what was observed. Groundwork for MCP Flow Capture (L6a); no tool sends it yet.

<!-- changelog: internal — nothing in this release sends `capture:observe`; the MCP capture tools that use it come in a later PR of L6a, with their own changelog entry. -->
