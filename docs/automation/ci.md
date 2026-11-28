---
title: Run flows in CI
description: "Replay saved flows in CI with tapflow flow run, with no LLM calls, and author those flows with a coding agent over MCP."
---

# Run flows in CI

<a id="mcp-in-ci-cd"></a>

::: warning Experimental
tapflow's **AI agents** (the MCP server) and **Automation** (the flow runner) are experimental. The manual QA dashboard is the most mature part of tapflow; these two are still maturing. Expect rough edges, especially in selector matching and in timing right after an app launches.
:::

Using an agent with the flow runner splits the work into two stages: an LLM agent explores the app and **authors** a scenario, and a deterministic runner **replays** it. The guiding principle is simple — an LLM is involved only at authoring time, and replay is deterministic. Exploratory runs, covered on [their own page](/ai-agents/exploratory-runs), are the one exception: they read the screen with an LLM on every run.

That distinction changes CI. If an LLM judges the screen on every run, the result varies run to run and you pay for API calls each time. Save a verified scenario as a [flow](/automation/flows) instead, and CI replays that flow with no LLM calls — idempotent, and free.

## Deterministic replay — the main CI path

A CI job replays saved flows with `tapflow flow run`. There is no LLM on the replay path, so the same input always produces the same result, and there is no API cost.

With a relay and agent always on a self-hosted Mac runner, the job runs the flows and uses the exit code to tell whether they passed.

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
```

The flow YAML syntax, selector rules, and exit-code contract are covered in the [Flow Reference](/automation/flows).

## Authoring flows with a coding agent {#authoring-flows-with-an-agent}

Flows are an artifact an agent produces while exploring the app, not something you hand-write from scratch. Ask an MCP-capable agent like Claude Code for a scenario in plain language, and it drives the app through tapflow's MCP tools to confirm the behavior, then extracts the verified sequence as flow YAML and commits it to the repository.

To connect the coding agent to the relay, keep a `.mcp.json` at the repo root pointing at the relay.

```json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "${TAPFLOW_RELAY_URL:-ws://localhost:4000}",
        "TAPFLOW_TOKEN": "${TAPFLOW_TOKEN:-}"
      }
    }
  }
}
```

Give the agent a request that describes the outcome rather than the steps.

```text
Build a flow that signs in with an email and password and confirms the orders list.
Drive the app to verify it works, then save the verified sequence to .tapflow/flows/login-smoke.yaml.
```

The agent reads screen elements with `query_ui_tree`, drives them with `tap` and `type_text` to confirm the scenario, then saves it as a selector-based flow. That flow then replays deterministically in CI.

## Replaying verified scenarios with run_flow

You can use deterministic replay from within an agent session too. The `run_flow` tool replays a saved flow through the same deterministic engine, so an agent goes through the individual MCP tools while exploring and replays a verified scenario through `run_flow` — a hybrid of the two.

## Tips

- **Flows for regression, coding agents for exploration.** A test that runs every time in CI fits deterministic replay; checking a new scenario is faster with an agent.
- **`.mcp.json` takes the relay address and token from the environment** (`${TAPFLOW_TOKEN:-}`), so secrets never land in the repo. A value written into `env` as it is wins over the environment, so do not put a placeholder there. With `TAPFLOW_TOKEN` unset, the MCP server reads the [token file](/ai-agents/mcp-server#token-file).
- **One session per device.** The relay routes by session, so running multiple jobs against the same relay concurrently is fine as long as they connect to different devices.

## Moved sections {#moved-sections}

Sections that used to be on this page now live on these pages.

- [Exploratory runs in CI](/ai-agents/exploratory-runs)
  - <a id="exploratory-runs-—-optional" data-moved-to="/ai-agents/exploratory-runs"></a>[Exploratory runs in CI](/ai-agents/exploratory-runs)
