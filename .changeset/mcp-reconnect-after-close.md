---
"@tapflowio/mcp-server": patch
---

The MCP server reconnects to the relay on the next tool call after the connection closes, instead of answering every tool with "Not connected to relay" until the MCP client restarts it. A tool aimed at a device session held before the close says to call `connect_device` again, since the relay ends those sessions when the connection closes.
