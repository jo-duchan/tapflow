---
"@tapflowio/mcp-server": patch
---

Include the network error and session recovery advice when a screenshot request cannot connect to the relay. Preserve the original error as its cause and keep caller cancellation unchanged.
