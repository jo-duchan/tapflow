---
title: Exploratory runs in CI
description: "Let a coding agent judge the app's screen in CI on every run. It is not deterministic and costs API calls, so it suits scenarios not yet pinned into a flow."
---

# Exploratory runs in CI

::: warning Experimental
tapflow's **AI agents** (the MCP server) and **Automation** (the flow runner) are experimental. The manual QA dashboard is the most mature part of tapflow; these two are still maturing. Expect rough edges, especially in selector matching and in timing right after an app launches.
:::

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

The example uses the `.mcp.json` from [Authoring flows with a coding agent](/automation/ci#authoring-flows-with-an-agent).

## Related

- [Run flows in CI](/automation/ci): the deterministic CI path, replaying saved flows with no LLM calls
- [MCP server](/ai-agents/mcp-server): installing it, connecting a coding agent, and the tools
