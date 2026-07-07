# Writing Flows

A flow is a UI test scenario written in YAML, replayed deterministically by `tapflow flow run` with no LLM calls. The same flow always runs in the same order from the same input, so it is idempotent — and it costs nothing in API calls in CI.

::: info Two QA axes
tapflow has two QA axes. The browser dashboard is the **manual QA axis**, where your team tests by hand; the flow runner covered here is the **automated QA axis**, whose main stage is CI/CD.

Flows are not a language you hand-write from scratch — they are an artifact an agent generates or a recording produces. To author them with an agent, see [MCP in CI/CD](/guide/mcp-ci).
:::

## Flow file structure

A flow has three top-level keys.

```yaml
name: login-smoke
appId: com.example.app
steps:
  - clearState
  - launchApp
  - assertVisible: "Sign in"
  - tapOn: { id: "com.example.app:id/email" }
  - inputText: "user@example.com"
  - pressKey: Enter
  - tapOn: "Sign in"
  - assertVisible: { label: "Orders", timeout: 15 }
```

| Key | Required | Description |
|-----|----------|-------------|
| `name` | No | Name shown in reports. Defaults to the file name. |
| `appId` | Conditional | Bundle id of the app under test. Required when `clearState` is used without an argument. |
| `steps` | Yes | The list of steps, run top to bottom. |

Coordinates are normalized 0–1 everywhere. Selectors point at screen elements directly, so you will rarely write pixel coordinates into a flow.

## Steps

The vocabulary is deliberately small. These ten cover most scenarios.

| Step | Form | Behavior |
|------|------|----------|
| `clearState` | keyword or `clearState: <bundleId>` | Resets the app data. The keyword form uses the top-level `appId`. |
| `launchApp` | keyword | Launches the build under test. |
| `tapOn` | selector | Taps the center of the matched element. |
| `inputText` | string | Types text into the focused input field. |
| `pressKey` | key name | Presses a keyboard key (`Enter`, `Backspace`, `Escape`, …). |
| `swipe` | `{ from, to, durationMs? }` | Swipes between two points. Coordinates are 0–1. |
| `scroll` | keyword or `scroll: <direction>` | Scrolls the screen. The bare keyword scrolls down. |
| `openUrl` | URL string | Opens a deep link or URL. |
| `assertVisible` | selector | Waits until the element appears; fails if it does not. |
| `assertNotVisible` | selector | Waits until the element disappears; fails if it does not. |

There is no fixed `sleep` step. Waiting is always condition-based. To wait for a transition, give `assertVisible` a `timeout`.

### Selectors

`tapOn`, `assertVisible`, and `assertNotVisible` target an element with a selector, which takes three forms.

```yaml
# a single string — resolved in the order below
- tapOn: "Sign in"

# explicit identifier
- tapOn: { id: "com.example.app:id/login" }

# explicit label + wait time (seconds)
- tapOn: { label: "Sign in", timeout: 20 }
```

A bare-string selector resolves in the order **exact identifier → exact label → partial label**. Once a stage matches, later stages are not tried.

If a `tapOn` selector matches more than one element, it fails immediately and lists the candidates. It never picks the first one implicitly, so an ambiguous selector fails visibly instead of quietly tapping the wrong place. `assertVisible` checks presence only, so it passes when at least one element matches.

`timeout` is in seconds and defaults to 10. You can set it per selector.

### Resetting state

`clearState` wipes the app data so every run starts from the same state. It uses `pm clear` on Android and empties the app data container on iOS. The installed binary survives either way, so you can follow `clearState` with `launchApp`.

```yaml
# uses the top-level appId
- clearState

# names a different bundle
- clearState: com.other.app
```

## Running flows

```sh
tapflow flow run .tapflow/flows/login-smoke.yaml
```

You can pass several files at once.

```sh
tapflow flow run .tapflow/flows/login.yaml .tapflow/flows/checkout.yaml
```

| Option | Description |
|--------|-------------|
| `--relay <url>` | Relay URL (default `ws://localhost:4000`) |
| `--token <token>` | PAT for a remote relay (or the `TAPFLOW_TOKEN` env var) |
| `--device <name>` | Target device by name. Boots it when shut down. |
| `--session <id>` | Target session id (from `tapflow status`) |
| `--build <id>` | Build under test. Installed before the run; the `launchApp` step launches it. |
| `--junit <path>` | Write a JUnit XML report to this path. |
| `--artifacts <dir>` | Failure-screenshot directory (default `.tapflow-data/artifacts`) |
| `--timeout <seconds>` | Default per-selector wait (default 10) |

The `launchApp` step takes no argument and launches the build passed via `--build`. That keeps the build id out of the flow file, so the same flow runs against a fresh build on every CI run.

### Exit codes

The exit codes are a contract so CI can tell what happened.

| Code | Meaning |
|------|---------|
| `0` | All flows passed |
| `1` | At least one flow failed |
| `2` | Environment/config error (flow parse failure, relay unreachable, no device) |

Distinguishing `1` from `2` matters: a test failure (`1`) and an infrastructure problem (`2`) should be handled differently on a CI dashboard.

A failed flow leaves a screenshot from the point of failure in the artifacts directory, and with `--junit` each flow is recorded as one `testcase`.

## File location convention

Keep flow files in your app repository under `.tapflow/flows/`. The runner accepts any path, so this is not enforced, but the CI examples and docs default to it.

```
your-app/
├── .tapflow/
│   └── flows/
│       ├── login-smoke.yaml
│       └── checkout.yaml
└── ...
```

A JSON Schema for editor autocomplete ships with the `@tapflowio/flow-runner` package at `schema/tapflow-flow.schema.json`.

## Running in CI

With a relay and agent always on a self-hosted Mac runner, a CI job only has to replay the flows. No LLM is involved on the replay path, so there is no API cost.

```yaml
name: Flow smoke test

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: [self-hosted, macos]

    steps:
      - uses: actions/checkout@v4

      - name: Run flows
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
        run: |
          tapflow flow run .tapflow/flows/*.yaml \
            --relay "$TAPFLOW_RELAY_URL" \
            --device "iPhone 16 Pro" \
            --build "$BUILD_ID" \
            --junit report.xml

      - name: Publish report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flow-results
          path: |
            report.xml
            .tapflow-data/artifacts/
```

The exit-code contract makes the job fail when a step fails (`1` or `2`). `if: always()` collects the failure screenshots and the JUnit report even on a failing run.

## Relationship to run_flow

The same flow engine runs through the MCP `run_flow` tool. An agent authors a scenario once while exploring the app, then replays that flow deterministically afterward. Exploratory work goes through the individual MCP tools; verified scenarios replay through `run_flow` — a hybrid of the two.

Authoring by an agent and replaying with a deterministic runner is covered in more depth in [MCP in CI/CD](/guide/mcp-ci).
