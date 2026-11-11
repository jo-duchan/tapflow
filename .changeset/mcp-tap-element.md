---
"@tapflowio/mcp-server": minor
"@tapflowio/flow-runner": patch
---

MCP `tap` takes an `element` (`id`, `label`, `role`, `index`, as `query_ui_tree` reports them) instead of a pixel coordinate, and taps it the way `run_flow`'s `tapOn` does: it waits up to 5 s for the element, taps where the device says it reaches it, fails naming what covers it, and taps the centre marked `unchecked` where the device cannot judge (#1147). With `holdMs` it holds the element. `query_ui_tree`'s description and the server instructions no longer tell an agent to tap a frame's centre, which a tab bar or a sheet can cover; a coordinate tap stays for a place the tree names nothing at.

The engine bounds each reach it asks before a touch by the selector's deadline, never under 2 s: an agent that never answered held a `tapOn` for the relay's whole reach deadline (15 s and more) after the selector's had run out, in `flow run` and Verify as well as in MCP. It then taps the centre marked `unchecked`, as for any reach the device could not answer. A device that answered the element is covered, off the screen or not where it was read, and then could not answer, no longer has the centre it said was covered tapped: the step fails at its deadline on that answer. A reach body cut off by the deadline is a transient failure, not invalid JSON.
