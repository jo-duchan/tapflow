---
'@tapflowio/ios-agent': patch
---

The iOS agent no longer believes a network-filter state file that anyone on the Mac could have written. The filter publishes what it is enforcing to a file, falling back to `/tmp` when its protected directory refuses it, and the agent read whichever was there. `/tmp` is world-writable, so any local process could put a file there naming a device and the agent would take a simulator offline on that word alone. A state file in a world-writable directory is now believed only when root owns it and nobody else can change it; the protected path and the liveness check are covered by the same rule.
