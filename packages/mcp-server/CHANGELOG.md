# @tapflowio/mcp-server

## 0.16.0

### Minor Changes

- Flow-runner reliability and MCP session lifecycle.

  - **flow-runner: retry transient ui-tree query errors while polling.** Wait steps (`tapOn` / `assertVisible` / `assertNotVisible`) no longer fail the instant a query throws — e.g. the app not being in the foreground yet right after `launchApp`. The poll loop distinguishes transient failures (foreground race, idle timeout, network) from permanent ones (bad request, auth, missing session) and retries the transient ones until the step deadline, so waits are truly condition-based (no `sleep` workarounds). A stalled query is also bounded by an abort signal so it can't block past the deadline.
  - **flow-runner: `role` and `index` selector disambiguators.** The object-form selector takes two new optional fields — `role` (narrow by element kind, e.g. `{ label, role: button }` when a button and its inner text share a label) and `index` (0-based, pick the Nth remaining match, e.g. `{ role: cell, index: 2 }` for a label-less row). Additive: bare-string and `{ id }` / `{ label }` selectors are unchanged; the object form now needs at least one of `id` / `label` / `role`.
  - **mcp: `run_flow` installs the build before replaying** when `buildId` is set (parity with `tapflow flow run --build`), so `clearState` / `launchApp` find the app present; pass `install: false` to skip.
  - **mcp: `shutdown_device` tool** — powers a session's booted simulator/emulator down to free resources or force a cold boot, distinct from `disconnect_device` (which only leaves the session, keeping the device running).
  - Security: pinned `axios`, `protobufjs`, `body-parser`, and `js-yaml` past their advisories via `pnpm.overrides`.

### Patch Changes

- Updated dependencies
  - @tapflowio/flow-runner@0.16.0

## 0.15.0

### Patch Changes

- @tapflowio/flow-runner@0.15.0

## 0.14.0

### Minor Changes

- ba0a3d8: Automated QA axis: UI accessibility tree queries and the deterministic flow runner.

  - `query_ui_tree` (MCP) / `GET /api/v1/sessions/:sessionId/ui-tree` — unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`), frames normalized 0-1 so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window required) and still no WebDriverAgent; Android via `uiautomator dump` with a device-side timeout.
  - `@tapflowio/flow-runner` (new package) + `tapflow flow run` — replay YAML flows with zero LLM calls: 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, CI exit-code contract (0/1/2).
  - `run_flow` (MCP) — agents author a flow once, then replay it deterministically over the existing session.
  - New relay messages `app:clear-state` (reset app data — `pm clear` on Android, data-container wipe on iOS) and `input:type-done`/`input:type-error` (text-entry completion ack, so a following key press stays ordered). Text entry now waits for this ack: a self-hosted agent older than this release will not send it, so text steps time out — update the agent alongside the relay.
  - mcp-server and flow-runner graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

### Patch Changes

- Updated dependencies [ba0a3d8]
  - @tapflowio/flow-runner@0.14.0

## 0.7.0
