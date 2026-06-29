---
"@tapflowio/agent-core": patch
"@tapflowio/audiotap-helper": patch
"@tapflowio/relay": patch
"@tapflowio/ios-agent": patch
"@tapflowio/android-agent": patch
"tapflow": patch
---

Fix the package type entrypoint for npm consumers (#345). `exports.types` now points at the published `dist/*.d.ts` instead of `src/` — which isn't shipped in the tarball (`files` ships only `dist`/`bin`), so consumers couldn't resolve the package's types.

The monorepo moves to **TypeScript project references** (each lib package gets `composite: true` + `references`, plus a root solution `tsconfig.json`). `typecheck`/`build` run via `tsc -b`, so workspace typecheck stays build-light (incremental, no manual dist build) while the published packages expose correct types from `dist`. No runtime or public API changes.
