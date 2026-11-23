---
"@tapflowio/relay": patch
"@tapflowio/mcp-server": patch
---

`pnpm build` on Windows can finish. The dashboard's copy into the relay's `public/` directory, the relay's copy of its SQL migrations, and the MCP server's executable bit on `tapflow-mcp` run through a small Node helper, because npm and pnpm execute package scripts with `cmd.exe`, which has no `rm`, `cp`, `mkdir` or `chmod`. Linux and macOS behaviour is unchanged.
