---
"@tapflowio/mcp-server": patch
"@tapflowio/ios-agent": patch
---

MCP Flow Capture follow-ups from a real agent session. The testing guide now has agents make new flows by capturing them and keep a captured flow on `capture_flow`'s own replay from a reset; YAML is edited only to repair a flow or add what a capture cannot record, and an edited flow is kept after two passing `run_flow` replays. `list_captured_steps` offers only the expectations a step brought and counts the ones already on screen (`alreadyShown`). While capturing, `type_text` also answers the field it typed into (`into`, `secure`), never the text. On iOS, a tree read while the app is still starting says to read again instead of asking whether the app is running.
