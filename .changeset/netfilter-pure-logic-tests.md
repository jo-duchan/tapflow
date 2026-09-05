---
"@tapflowio/ios-agent": patch
---

<!-- changelog: internal — no behaviour changes; the extension binary is rebuilt but does the same thing. -->

Tests for the network filter's Swift (#690). The pure decisions in `Provider.swift` and
`Host/main.swift` move into files a test bundle can compile — the audit-token readers, the process
identity and its cache, the drop-count prune, the pulse rate, and the host binary's argument handling
and rule arithmetic — and each is held by a mutation that must make a test fail.

Nothing about what the filter does changes. What changes is that four decisions which previously had
no test now cannot be broken silently: reading the pid from the wrong word of the audit token, keying
the attribution cache on a pid the kernel reuses, publishing a drop count from a previous episode, and
letting an argument the host binary does not understand empty the offline rule.
