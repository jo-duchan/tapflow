---
"@tapflowio/relay": patch
---

A relay without `plutil` (the Docker image, Linux) reads an iOS build's binary `Info.plist` itself, so the build keeps its bundle ID, version and name (#1257).
