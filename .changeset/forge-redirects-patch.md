---
"@tapflowio/relay": patch
---

The relay's lockfile takes `node-forge` 1.4.2 and `follow-redirects` 1.16.2, both pulled in by `acme-client` for LAN HTTPS certificates. Fresh npm installs already resolved these; the Docker image picks them up with this release.
