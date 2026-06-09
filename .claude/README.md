# .claude/

Claude Code project configuration directory.

`settings.json` and `commands/` are shared across the team and tracked in git.  
`settings.local.json` holds personal permission overrides and is listed in `.gitignore`.

---

## Directory structure

```
.claude/
├── commands/               # Custom slash commands (team-shared)
│   ├── ai-tells.md         # /ai-tells
│   ├── compound.md         # /compound
│   ├── deep-research.md    # /deep-research
│   ├── doc-sync.md         # /doc-sync
│   ├── qa.md               # /qa
│   ├── work-plan.md        # /work-plan
│   └── write-docs.md       # /write-docs
├── ai-tells/               # /ai-tells rule data (ko/en taxonomy + MIT NOTICE)
├── settings.json           # Team settings (hooks, statusLine, etc.)
├── settings.local.json     # Personal settings — gitignored (permissions, etc.)
└── README.md               # This file
```

---

## Custom commands

Invoke with `/` in Claude Code.

| Command | Description |
|---------|-------------|
| `/ai-tells {ko\|en} {detect\|rewrite} [target]` | Detect/fix AI writing tells. `detect` is the default lint/gate (not a laundering tool). External posts (HN/Reddit) = `detect` only — see marketing OVERVIEW.md policy. |
| `/work-plan {topic}` | Create a `.work/` plan document with requirements and test cases. |
| `/deep-research {problem}` | Deep analysis of implementation, bug, or design problems using Opus. |
| `/qa {target}` | Plan and write tests for the target code. Potemkin and flaky tests prohibited. |
| `/doc-sync` | Audit and fix consistency between AGENTS.md / INDEX.md / `.work/` and the codebase. |
| `/compound` | Extract reusable patterns from the current session and update AGENTS.md. |
| `/write-docs {topic}` | Write a VitePress docs page — EN/KO simultaneously, sidebar registration, build verification. |

---

## settings.json vs settings.local.json

| | `settings.json` | `settings.local.json` |
|---|---|---|
| Git-tracked | Yes (team-shared) | No (gitignored) |
| Purpose | hooks, statusLine, plugins | Personal `permissions.allow` entries |
| Example | Completion notification hook | Allow `Bash(gh api *)` |

If `settings.local.json` doesn't exist, create it as an empty `{}` or omit it entirely.

---

## References

- Custom command authoring: [Claude Code slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Project context: [`AGENTS.md`](../AGENTS.md), [`INDEX.md`](../INDEX.md)
- Work logs: [`.work/`](../.work/)
