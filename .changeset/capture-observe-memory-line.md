---
"@tapflowio/relay": patch
"@tapflowio/ios-agent": patch
---

On a Mac over its memory limit, a recorded person's iOS boot no longer turns off what each tap touched and app accessibility: the relay now sends `observed` on `device:boot`, which the iOS agent watches by, and `recorded` keeps its memory gate for older agents.

<!-- changelog: internal — record-time observation is unreleased (not in v0.32.0); its Unreleased "Added" entry already describes the fixed behaviour -->
