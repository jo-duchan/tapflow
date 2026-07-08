# MCP in CI/CD

The automated QA axis splits into two stages: an LLM agent explores the app and **authors** a scenario, and a deterministic runner **replays** it. The guiding principle is simple — an LLM is involved only at authoring time, and replay is deterministic.

That distinction changes CI. If an LLM judges the screen on every run, the result varies run to run and you pay for API calls each time. Save a verified scenario as a [flow](/guide/writing-flows) instead, and CI replays that flow with no LLM calls — idempotent, and free.

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

The flow YAML syntax, selector rules, and exit-code contract are covered in [Writing Flows](/guide/writing-flows).

## Authoring flows with an agent

Flows are an artifact an agent produces while exploring the app, not something you hand-write from scratch. Ask an MCP-capable agent like Claude Code for a scenario in plain language, and it drives the app through tapflow's MCP tools to confirm the behavior, then extracts the verified sequence as flow YAML and commits it to the repository.

To connect the agent to the relay, keep a `.mcp.json` at the repo root pointing at the relay.

```json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "ws://localhost:4000",
        "TAPFLOW_TOKEN": "INJECTED_AT_RUNTIME"
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

## Exploratory runs — optional

When you are exploring a new screen or debugging a flow, you can let an LLM judge the screen directly in CI. This path reads the screen with an LLM on every run, so it is not deterministic and it costs API calls, but it is useful for quickly checking a scenario you have not yet pinned into a flow.

This path needs a few more prerequisites.

| Requirement | Notes |
|-------------|-------|
| tapflow relay (always-on) | A Mac with the agent connected. Can be a dedicated Mac mini on your LAN. |
| `TAPFLOW_TOKEN` | PAT with at least Developer role. Store as a CI secret. |
| `ANTHROPIC_API_KEY` | Required to run `claude` non-interactively. Store as a CI secret. |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |

```yaml
      - name: Exploratory check
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          WORKSPACE: ${{ github.workspace }}
        run: |
          claude --mcp-config .mcp.json -p "
            List available devices and connect to a booted iOS simulator.
            Install the build at $WORKSPACE/MyApp.app.zip and launch the app.
            Take a screenshot and verify the main screen loaded correctly.
            If there are error messages or blank screens, describe the issue and exit with a failure.
          "
```

Exploratory prompts work best when they describe outcomes. "Verify the home screen loaded" holds up better than "tap the third item in the list" when the UI changes. For a regression test you run repeatedly, though, pinning the confirmed scenario into a flow is deterministic and free.

## Tips

- **Flows for regression, agents for exploration.** A test that runs every time in CI fits deterministic replay; checking a new scenario is faster with an agent.
- **The `env` values in `.mcp.json` are overridden at runtime by the shell environment**, so secrets never land in the repo.
- **One session per device.** The relay routes by session, so running multiple jobs against the same relay concurrently is fine as long as they connect to different devices.
