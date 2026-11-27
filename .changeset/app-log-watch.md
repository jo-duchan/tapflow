---
'@tapflowio/relay': patch
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
'@tapflowio/protocol': patch
'@tapflowio/agent-core': patch
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
---

The QA session's app log follows the app, not the Launch button. The relay asks an agent naming `app-log-watch` to watch the installed app (`app:logs:watch` / `app:logs:unwatch`) for a person holding the device, never for an MCP client or a flow run. The agent keeps the watch across boots and installs and streams the app however it is opened: iOS by its executable's path (one `log stream` outlives each run and a reinstall), Android by its uid with each line's pid. It marks each run with `app:log:run` (`started`, `running` for an app already up, `exited`). The viewer keeps one log for the session with a separator line per run; only an install and a clear state empty it. Agents and relays without the feature keep the per-launch stream.
