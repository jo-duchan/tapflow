---
"@tapflowio/relay": patch
---

Backfills: #1159

The lockfile takes `node-forge` 1.4.3, `hono` 4.13.18 and `@hono/node-server` 2.1.8. The Docker image, built from the lockfile, ships the patched `node-forge` with this release; fresh npm installs already resolved all three.
