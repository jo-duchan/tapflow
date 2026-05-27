# MCP in CI/CD

Run automated smoke tests against a real simulator on every build — no Selenium, no WebDriverAgent, no hardcoded selectors. The LLM agent reads the screen from screenshots and adapts.

## How this works

A CI job installs `@tapflowio/mcp-server`, configures it to point at your always-on relay, then invokes `claude` (Claude Code CLI) with a natural-language test prompt. The agent controls the simulator via MCP tools and exits with a non-zero code if it detects a failure.

```text
CI runner
  → installs @tapflowio/mcp-server
  → runs: claude --mcp-config .mcp.json -p "<test prompt>"
      → agent calls list_devices, connect_device, install_app, launch_app, screenshot, tap, ...
      → agent reports result / exits non-zero on failure
```

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| tapflow relay (always-on) | A Mac with the agent connected. Can be a dedicated Mac mini on your LAN. |
| `TAPFLOW_TOKEN` | PAT with at least Developer role. Store as a CI secret. |
| `ANTHROPIC_API_KEY` | Required to run `claude` non-interactively. Store as a CI secret. |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |

## GitHub Actions example

```yaml
name: Smoke test

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install tools
        run: |
          npm install -g @tapflowio/mcp-server @anthropic-ai/claude-code

      - name: Run smoke test
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude --mcp-config .mcp.json -p "
            List available devices and pick the first booted iOS simulator.
            Connect to it and install the build at ${{ github.workspace }}/MyApp.app.zip.
            Launch the app and take a screenshot.
            Verify the main screen loaded correctly — no error messages, no blank screens.
            If anything looks wrong, describe the issue and exit with a failure.
          "
```

::: tip .mcp.json in the repo
Commit a `.mcp.json` at the repo root that points to your relay. CI uses it directly.

```json
{
  "mcpServers": {
    "tapflow": {
      "command": "tapflow-mcp",
      "env": {
        "TAPFLOW_RELAY_URL": "INJECTED_AT_RUNTIME",
        "TAPFLOW_TOKEN": "INJECTED_AT_RUNTIME"
      }
    }
  }
}
```

The `env` values here are overridden at runtime by the shell environment, so secrets never land in the repo.
:::

## Multi-device matrix

Run the same test across multiple simulators by parameterizing the job:

```yaml
jobs:
  smoke:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        device: ["iPhone SE (3rd generation)", "iPhone 16 Pro", "iPad Air 13-inch (M2)"]

    steps:
      # ... install steps ...

      - name: Run smoke test on ${{ matrix.device }}
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          TARGET_DEVICE: ${{ matrix.device }}
        run: |
          claude --mcp-config .mcp.json -p "
            Find the simulator named '$TARGET_DEVICE' from list_devices.
            Connect to it, install MyApp.app.zip, launch the app,
            and verify the main screen loaded without errors.
          "
```

## Example test prompts

Write prompts that describe outcomes, not steps. The agent figures out the navigation.

**Login flow:**
```text
Connect to the first available simulator.
Install and launch the sandbox build.
Navigate to the login screen, enter email test@example.com and password test1234,
tap the login button, and confirm the home screen appears within 10 seconds.
Screenshot the result. If login fails or an error appears, report the error text and fail.
```

**Onboarding:**
```text
Fresh-install the app and walk through the onboarding flow.
Screenshot each step. Verify all buttons are tappable and no screens are blank.
Report any step where the UI appears broken.
```

**Post-deploy sanity check:**
```text
Launch the latest installed build.
Visit the three main tabs: Home, Search, and Profile.
Screenshot each tab and confirm they load without errors or empty states.
```

## Tips

- **Keep prompts outcome-focused.** "Verify the home screen loaded" is better than "tap the third item in the list" — the latter breaks when the UI changes.
- **Disconnect at the end.** Always include "disconnect the device when done" in your prompt, or the session stays open.
- **Set a timeout.** `claude` has a default timeout; set `--timeout` explicitly for long flows so CI doesn't hang indefinitely.
- **One session at a time.** The relay routes by session; running multiple jobs against the same relay concurrently is fine as long as they connect to different devices.
