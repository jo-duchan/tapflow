---
"@tapflowio/flow-runner": minor
"@tapflowio/agent-core": minor
---

<!-- changelog: internal — a refactor that moves code without changing behaviour, plus entry points only the dashboard will use (Flow Capture, #1125) -->

flow-runner's session semantics are split from its WebSocket transport so a browser can run flows with the same code as `tapflow flow run`. `SessionChannel` holds the waiters and what each input is on the wire, `SocketFlowDriver` is the `FlowDriver` over any session device, and `RelayClient` and `RelayDriver` are now those two over `ws` and REST, with their API unchanged. The new `@tapflowio/flow-runner/browser` entry exports the engine with them and reaches no Node API. agent-core adds an `@tapflowio/agent-core/errors` entry so that entry can import the error classes without the package index.
