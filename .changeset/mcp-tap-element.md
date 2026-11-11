---
"@tapflowio/mcp-server": minor
---

MCP `tap` takes an `element` (`id`, `label`, `role`, `index`, as `query_ui_tree` reports them) instead of a pixel coordinate, and taps it the way `run_flow`'s `tapOn` does: it waits up to 5 s for the element, taps where the device says it reaches it, fails naming what covers it, and taps the centre marked `unchecked` where the device cannot judge (#1147). With `holdMs` it holds the element. `query_ui_tree`'s description and the server instructions no longer tell an agent to tap a frame's centre, which a tab bar or a sheet can cover; a coordinate tap stays for a place the tree names nothing at.
