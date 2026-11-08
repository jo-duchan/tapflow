---
"@tapflowio/flow-runner": minor
---

`@tapflowio/flow-runner/browser` gains what a host other than `RelayClient` needs to replay and verify a flow (Flow Capture, #1125): `parseUITreeResponse`, `SessionChannel`'s `seed` and `treeQueryFailure`, `waitForStableScreen`, `isSecretName`, and `flowSteps` starting a captured flow with `clearState` when the app's bundle id is known. `FlowDriver.screenshot` and `FlowResult`'s screenshots are typed `Uint8Array` (a Node driver still returns a `Buffer`; `RelayClient.screenshot` is unchanged).
