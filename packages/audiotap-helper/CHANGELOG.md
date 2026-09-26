# @tapflowio/audiotap-helper

## 0.3.7

### Patch Changes

- @tapflowio/agent-core@0.25.0

## 0.3.6

### Patch Changes

- Updated dependencies [2700746]
  - @tapflowio/agent-core@0.24.0

## 0.3.5

### Patch Changes

- Updated dependencies [e63e410]
  - @tapflowio/agent-core@0.23.0

## 0.3.4

### Patch Changes

- @tapflowio/agent-core@0.22.0

## 0.3.3

### Patch Changes

- Updated dependencies [7d8eb4e]
  - @tapflowio/agent-core@0.21.0

## 0.3.2

### Patch Changes

- @tapflowio/agent-core@0.20.1

## 0.3.1

### Patch Changes

- Updated dependencies [becbe77]
- Updated dependencies [3f18f70]
- Updated dependencies [7152b21]
- Updated dependencies [4901c8c]
- Updated dependencies [d238c34]
  - @tapflowio/agent-core@0.20.0

## 0.3.0

### Minor Changes

- e55371c: **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security patches.

  Three declarations disagreed about what was supported, and none of them matched what was actually run. The manifests said `>=20.12.0`, the documentation said "≥ 20" — meaning 20.0.0 — and CI ran 20 while Docker ran 22 and the release job ran 24. There was also a band that was declared but unusable: every `undici` 7.x requires Node `>=20.18.1`, so 20.12 through 20.17 could not complete a development install regardless of what the manifests promised.

  The floor is now 22 everywhere, and 22 is a version that will be tested rather than merely claimed — CI runs the suite on both 22 and 24. That is the part that had been missing: `>=20.12.0` was declared for a year and never once exercised on 20.12, which is how it drifted below what the dependency tree already required.

  `tapflow`, `@tapflowio/flow-runner` and `@tapflowio/mcp-server` declared no `engines` at all and now do. `tapflow` is the package installed with `npm i -g`, so until now the CLI announced no Node requirement to the people most likely to need it.

  `tapflow doctor` moves with it and reports `Node ≥ 22 required` below the floor. Without that change it would have printed a green check on Node 20 while the package manifest called the same version unsupported.

  Node 22 is supported until 2027-04-30; Node 24 is the active LTS. Containers and the published image now run 24.

### Patch Changes

- 5ab537d: Type-check and lint the test trees

  Backfills: #537

  <!-- changelog: internal — a per-package `typecheck` script and a test-tree tsconfig; no runtime or interface change a self-hoster can observe -->

  Every package's build tsconfig excluded `src/__tests__` and eslint ignored it, so a test double could
  drift from the interface it doubled with both gates green. The manifests gained a `typecheck` script and
  the test trees a tsconfig of their own, which is the only reason this touches published files at all.
  What the gates then found was inside the tests: a double declaring `implements DeviceAgent` while missing
  two members, five duplicate object keys, a call passing one argument to a two-argument method, and a
  `test-utils` constraint no named message could satisfy.

  The CLI is `tapflow`, not `@tapflowio/cli` — the manifest name, which is what `changeset version` resolves.

- Updated dependencies [a5466b9]
- Updated dependencies [15593db]
- Updated dependencies [e55371c]
- Updated dependencies [5ab537d]
- Updated dependencies [b459157]
  - @tapflowio/agent-core@0.19.0

## 0.2.8

### Patch Changes

- @tapflowio/agent-core@0.18.0

## 0.2.7

### Patch Changes

- @tapflowio/agent-core@0.17.0

## 0.2.6

### Patch Changes

- @tapflowio/agent-core@0.16.0

## 0.2.5

### Patch Changes

- @tapflowio/agent-core@0.15.0

## 0.2.4

### Patch Changes

- Updated dependencies [ba0a3d8]
  - @tapflowio/agent-core@0.14.0

## 0.2.3

### Patch Changes

- @tapflowio/agent-core@0.13.0

## 0.2.2

### Patch Changes

- @tapflowio/agent-core@0.12.0

## 0.2.1

### Patch Changes

- @tapflowio/agent-core@0.11.1

## 0.2.0

### Minor Changes

- 6bd8ebe: Symmetric host-mute for Android (#341): the emulator's audio no longer leaks to the agent Mac's speakers.

  The macOS Core Audio process-tap helper is now a shared package, `@tapflowio/audiotap-helper` (moved out of `ios-agent`), used by both platforms — so android-agent depending on it is a clean direction (no cross-platform-agent dependency). On macOS 14.2+, android-agent holds a **mute-only** `.muted` tap on the emulator's qemu process, silencing its host output while gRPC keeps capturing for the browser — matching iOS's `muteBehavior=.muted`. The helper self-exits when qemu dies; below 14.2 / non-macOS it's a no-op (fall back to the Mac's volume). `tapflow agent start` / `start` now also prime the audio-capture permission when Android is selected.

  `ios-agent` keeps the same public API (`requestAudioPermission`/`isAudioSupported` are re-exported from the shared package); only the helper's internal location changed.

### Patch Changes

- 3377bfe: Fix the package type entrypoint for npm consumers (#345). `exports.types` now points at the published `dist/*.d.ts` instead of `src/` — which isn't shipped in the tarball (`files` ships only `dist`/`bin`), so consumers couldn't resolve the package's types.

  The monorepo moves to **TypeScript project references** (each lib package gets `composite: true` + `references`, plus a root solution `tsconfig.json`). `typecheck`/`build` run via `tsc -b`, so workspace typecheck stays build-light (incremental, no manual dist build) while the published packages expose correct types from `dist`. No runtime or public API changes.

- Updated dependencies [3377bfe]
  - @tapflowio/agent-core@0.11.0
