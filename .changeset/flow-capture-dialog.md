---
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
---

Flow Capture's dialog (#1125). **Capture flow** in a QA Session's toolbar turns the steps a person took into a flow YAML in five steps: pick the range, replay it on the device from a clean start to name what each step touched, edit the steps (remove one, rename a secret, see which are fragile, turned into a scroll or left out), verify the flow with selectors only on the engine `tapflow flow run` uses, and export the file. The dashboard ships inside the relay, so it is released under `@tapflowio/relay`. flow-runner: a recorded run of typing is replayed as typed text, and Caps Lock is no longer read as upper case; a run typed with it in force is marked fragile.
