---
title: Exploratory runs in CI
description: "Let an AI agent judge the app's screen in CI on every run. It is not deterministic and costs API calls, so it suits scenarios not yet pinned into a flow."
status: experimental
---

# Exploratory runs in CI

When you are exploring a new screen or debugging a flow, you can let an LLM judge the screen directly in CI. This path reads the screen with an LLM on every run, so it is not deterministic and it costs API calls, but it is useful for quickly checking a scenario you have not yet pinned into a flow.

This path needs a few more prerequisites.

| Requirement | Notes |
|-------------|-------|
| tapflow relay (always-on) | A Mac with the agent connected. Can be a dedicated Mac mini on your LAN. |
| `TAPFLOW_TOKEN` | An **API**-type personal access token (PAT, `view, builds:write`), created in **Settings → Tokens** (shown to Admins, Developers and QA). Store as a CI secret. |
| `ANTHROPIC_API_KEY` | Required to run `claude` non-interactively. Store as a CI secret. |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |

```yaml
      - name: Exploratory check
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          set -o pipefail
          # The MCP server takes the relay's ws:// address; the upload API is the same relay over http.
          RELAY_HTTP="${TAPFLOW_RELAY_URL/#ws/http}"
          BUILD_ID=$(curl -sf -X POST "$RELAY_HTTP/api/v1/builds" \
            -H "Authorization: Bearer $TAPFLOW_TOKEN" \
            -F "file=@MyApp.app.zip" | jq -er '.id')
          [[ "$BUILD_ID" =~ ^[0-9]+$ ]]

          claude --mcp-config .mcp.json --allowedTools "mcp__tapflow" -p "
            List available devices and connect to a booted iOS simulator.
            Install build $BUILD_ID and launch the app.
            Read the screen and check that the main screen loaded correctly.
            Disconnect from the device when you are done.
            End your answer with one line: TAPFLOW_VERDICT: pass, or TAPFLOW_VERDICT: fail followed by the reason.
          " | tee claude-output.txt

          tail -n 1 claude-output.txt | grep -Eq '^TAPFLOW_VERDICT: pass[[:space:]]*$'
```

Three parts of the step matter:

- `install_app` installs a build the relay already has, by its ID, not a file on the runner. The step uploads the build it made (here `MyApp.app.zip`) with the [builds API](/operate/ci-distribution) first and gives the AI agent the ID it gets back. `TAPFLOW_TOKEN` is an API-type token, so it may upload. `pipefail` and the ID check stop the step when the upload fails, before `claude` runs.
- A `claude -p` run has no one to approve a tool call, so a call that needs approval is refused. `--allowedTools "mcp__tapflow"` approves the tapflow MCP server's tools in advance. It adds no other tool: one that needs approval is still refused.
- `claude` exits with `0` when it finishes answering, even when its answer says the app is broken. The last line decides the step instead: it passes only when the output's final line is `TAPFLOW_VERDICT: pass`, so a run that ended early, wrote no verdict or ended on a fail fails too.

Exploratory prompts work best when they describe outcomes. "Verify the home screen loaded" holds up better than "tap the third item in the list" when the UI changes. For a regression test you run repeatedly, though, pinning the confirmed scenario into a flow is deterministic and free.

The example uses the `.mcp.json` from [Authoring flows with an AI agent](/automation/ci#authoring-flows-with-an-agent), which hands the MCP server the step's `TAPFLOW_RELAY_URL` and `TAPFLOW_TOKEN`, so the AI agent reaches the relay the build was uploaded to.

## Related

- [Run flows in CI](/automation/ci): the deterministic CI path, replaying saved flows with no LLM calls
- [MCP server](/ai-agents/mcp-server): installing it, connecting an AI agent, and the tools
