import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Deliberately NOT at the repo root. A config file there is inherited by every package that has
// none of its own — all of them do — and they then run with this `include` and find no tests.
// Invoked explicitly: `pnpm test:scripts`.
//
// `root` is resolved from this file, not from the cwd: vitest resolves a relative `root` against
// the working directory, so '..' pointed one level above the repo.
// Two files touch another package's `dist` and must not overlap: dashboardFirstLoadBudget builds flow-runner, and
// testsReadSource plants a marker in flow-runner's `dist` to prove a probe does not load it. A build between the two
// can wipe the marker and let a `dist`-resolved import pass, or be put back over by a stale copy (CodeRabbit on #1175).
// Each runs in a group of its own, one after the other; the rest stay parallel (serialising the whole suite measured
// 88 s against 48 s).
const DIST_WRITERS = ['scripts/__tests__/dashboardFirstLoadBudget.test.mjs', 'scripts/__tests__/testsReadSource.test.mjs']

export default defineConfig({
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  test: {
    projects: [
      ...DIST_WRITERS.map((file, i) => ({ extends: true, test: { name: `dist-${i}`, include: [file], sequence: { groupOrder: i } } })),
      { extends: true, test: { name: 'scripts', include: ['scripts/__tests__/**/*.test.mjs'], exclude: DIST_WRITERS, sequence: { groupOrder: DIST_WRITERS.length } } },
    ],
  },
})
