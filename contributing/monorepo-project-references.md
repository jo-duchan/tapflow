---
type: rationale
topics: [monorepo, typescript, build]
status: stable
---

# Why the monorepo uses TypeScript project references

> Read this before changing a library package's `exports.types`, its `tsconfig`
> `composite`/`references`, or the `typecheck` pipeline. The setup looks like
> boilerplate but each piece fixes a specific failure. Origin: [#345](https://github.com/jo-duchan/tapflow/issues/345).

## The bug it fixes

Every library package shipped `exports.types` pointing at `./src/index.ts`, while
`files` only published `[dist, bin]`. So `src` never made it into the tarball, and an
npm consumer that installed the package could not reach its type entrypoint. All five
libraries (agent-core, android-agent, audiotap-helper, ios-agent, relay) carried the
same pattern — a side effect of the repo's source-first convention.

It stayed hidden because the workspace never hits the published path. pnpm symlinks the
packages and a `source`/`tsx` export condition resolves `src` as if it were an external
module, so cross-package typecheck worked with no build at all. Only a real published
consumer broke.

## The fix

Two coupled changes across the six library packages:

1. Point `exports.types` (and every sub-entry, see below) at `dist/*.d.ts`. The
   `source`/`tsx` conditions stay for the workspace runtime.
2. Replace the build-free source-export trick with TypeScript project references:
   `composite: true` + `references` per package, plus a root solution `tsconfig.json`
   (`files: []` + references to all six) so a single `tsc -b` builds the whole chain in
   dependency order. No turbo or tsup — the native TS mechanism is enough.

## Alternatives rejected

- **Add `src` to `files`.** Makes the source-export pattern work for publishing too, but
  it is not the standard (types belong in `dist`) and it leaks `src` and tests into the
  tarball.
- **Standard `paths` only, without references.** `paths` aimed at another package's `src`
  violates `rootDir` (TS6059). It does not work without `composite`.
- **`publishConfig.exports` override.** npm does not support it.

## Gotchas worth keeping

- **Map every export sub-entry, not just `.`.** agent-core exposes `./utils`; if its
  `types` stays on `src` while `.` moves to `dist`, a `@tapflowio/agent-core/utils` import
  fails to resolve (surfaces as TS6305 during the composite build). Changing only `.`
  silently misses these.
- **`tsc -b` emits declarations, so "typecheck" becomes "build + check."** Libraries run
  the solution `tsc -b`; the app packages (dashboard, mcp-server) are not composite and
  stay on `tsc --noEmit`. The root `typecheck` script must build the libs before the apps
  typecheck them, since app types now resolve through `dist`.
- **`.tsbuildinfo` must be gitignored.** The incremental cache is a build artifact.
