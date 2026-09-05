---
"@tapflowio/ios-agent": patch
---

<!-- changelog: internal — no behaviour change; one log line regained a field it briefly lost. -->

The rest of #690. `Heartbeat`'s counters, the state file it renders, its two rate limits and the
candidate directory list move into `Extension/FlowIdentity.swift` where a test bundle can compile
them, and `handleNewFlow`'s decision moves with them as `decideFlow` — rule, attribution and endpoint
in, verdict and counter bucket out.

The file the agent parses now has its five field names pinned by a test, and a node check compares
the three copies of the state path list that live in Swift and in two TypeScript packages. 68 tests,
70 mutations.
