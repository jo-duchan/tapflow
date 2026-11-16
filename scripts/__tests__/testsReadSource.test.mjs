// A test in one package must exercise its sibling's SOURCE, not whatever was last built of it.
//
// #459 shipped a regression behind a green 1889-test run because that was not true: `ios-agent`
// stands up a real `RelayServer`, the import resolved through `exports` to `dist/`, and `dist` was
// stale. It surfaced only when the pre-commit `tsc -b` refreshed the build.
//
// The guard is `ssr.resolve.conditions` in `vitest.shared.ts`, which each affected package extends.
// Two ways that silently stops working — a package drops the config, or a NEW package starts
// importing a sibling and never adds it — so this checks both, and checks the resolution itself
// rather than trusting the config to mean what it says.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKGS = join(ROOT, 'packages')

const packageDirs = () =>
  readdirSync(PKGS).filter((d) => existsSync(join(PKGS, d, 'package.json')))

// Every suffix in Vitest's default include (`**/*.{test,spec}.?(c|m)[jt]s?(x)`):
// a test in any of them can import a sibling, so the guard must walk all of
// them or a sibling import hides behind an unscanned file.
const TEST_FILE_SUFFIX = /\.(?:[cm]?[jt]s(?:x)?)$/
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mtsx', '.mjs', '.mjsx', '.js', '.jsx', '.cts', '.ctsx', '.cjs', '.cjsx']

function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    // A helper behind a dynamic import() or a plain re-export in any suffix
    // would otherwise hide a sibling import from the guard.
    return entry.isDirectory() ? sourceFiles(path) : TEST_FILE_SUFFIX.test(entry.name) ? [path] : []
  })
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function resolveLocalImport(from, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier.replace(/\.(js|mjs)$/, ''))
  // isFile, not existsSync: a bare directory path exists too, and queuing it
  // makes readFileSync die with EISDIR instead of simply missing.
  for (const candidate of [
    base,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ]) {
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/** Does a test import a sibling directly or through one of its local source modules? */
function testsImportASibling(dir) {
  const tests = join(PKGS, dir, 'src', '__tests__')
  if (!existsSync(tests)) return false
  const queue = sourceFiles(tests)
  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    if (/['"]@tapflowio\/[^'"]+['"]/.test(source)) return true
    const specifiers = [
      ...source.matchAll(/from\s*['"]([^'"]+)['"]/g),
      // Dynamic import() too: a lazy `await import('./helper.mjs')` hides a
      // sibling behind a call the static-import regex never sees.
      ...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g),
    ]
    for (const match of specifiers) {
      const local = resolveLocalImport(file, match[1])
      if (local && !seen.has(local)) queue.push(local)
    }
  }
  return false
}

const extendsShared = (dir) => {
  const cfg = join(PKGS, dir, 'vitest.config.ts')
  return existsSync(cfg) && readFileSync(cfg, 'utf8').includes('sourceFirst')
}

function runProbe(packageDir, probe) {
  const relativeProbe = probe.slice(packageDir.length + 1)
  if (process.platform === 'win32') {
    const vitest = join(packageDir, 'node_modules', '.bin', 'vitest.cmd')
    // Run as one shell string so paths containing spaces (e.g.
    // `C:\Users\Jane Doe\...`) survive: each path is quoted once, and the
    // shell runs the .cmd shim. The previous `cmd /s /c` array form passed
    // its quoting through one layer too many and failed to launch.
    execFileSync(`"${vitest}" run "${relativeProbe}"`, {
      cwd: packageDir,
      stdio: 'pipe',
      encoding: 'utf8',
      shell: true,
    })
  } else {
    execFileSync('pnpm', ['exec', 'vitest', 'run', relativeProbe], { cwd: packageDir, stdio: 'pipe', encoding: 'utf8' })
  }
}

describe('the guard sees every Vitest test suffix', () => {
  // The 12 suffixes `?(c|m)[jt]s?(x)` expands to. A narrower list lets a test
  // file in an unscanned suffix import a sibling with no sourceFirst required.
  const all = ['js', 'jsx', 'ts', 'tsx', 'cjs', 'cjsx', 'mjs', 'mjsx', 'cts', 'ctsx', 'mts', 'mtsx']

  it('walks test files in every suffix', () => {
    for (const suffix of all) {
      expect(TEST_FILE_SUFFIX.test(`probe.test.${suffix}`), suffix).toBe(true)
    }
    expect(TEST_FILE_SUFFIX.test('probe.test.css')).toBe(false)
  })

  it('resolves extensionless and index imports in every suffix', () => {
    const withoutDot = RESOLVABLE_EXTENSIONS.map((e) => e.slice(1)).sort()
    expect(withoutDot).toEqual([...all].sort())
  })
})

describe('every package whose tests import a sibling reads its source', () => {
  // Derived, not listed. A hardcoded list is exactly how vitest came to be the tool nobody had
  // switched on: it described the day it was written.
  const affected = packageDirs().filter(testsImportASibling)

  it('finds the packages by inspection, not from a list', () => {
    // Measured: 9 packages import a sibling in their tests (agent-core,
    // android-agent, audiotap-helper, cli, dashboard, flow-runner, ios-agent,
    // mcp-server, relay). A lower floor lets a package silently drop out of
    // the guard.
    expect(affected.length).toBeGreaterThanOrEqual(9)
  })

  it.each(affected)('%s extends the shared config', (dir) => {
    expect(extendsShared(dir), `packages/${dir} imports a sibling in its tests but does not extend sourceFirst`).toBe(true)
  })
})

describe("the copied condition list still matches vite's", () => {
  // `vitest.shared.ts` cannot import `vite` — most packages that load it do not depend on it — so
  // it copies `defaultServerConditions`. Copies go stale silently, and the way this one goes stale
  // is ugly: dropping `node` from the list sent jsdom to the wrong entry of `decimal.js` and killed
  // ten dashboard tests with `Decimal is not a constructor`.
  it('has not drifted', () => {
    const actual = JSON.parse(execFileSync('node', ['--input-type=module', '-e',
      `import('vite').then(v => console.log(JSON.stringify(v.defaultServerConditions)))`],
      { cwd: join(PKGS, 'dashboard'), encoding: 'utf8' }))
    const copied = readFileSync(join(ROOT, 'vitest.shared.ts'), 'utf8')
      .match(/conditions:\s*\[([^\]]*)\]/)[1]
      .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)

    expect(copied[0], 'source must come first, or the build wins').toBe('source')
    expect(copied.slice(1)).toEqual(actual)
  }, 30_000)
})

describe('and the resolution really lands on source', () => {
  // The config could be present and not work — a vitest upgrade moving the setting, a merge that
  // drops it. So this plants a marker in a built artifact and asserts a cross-package import
  // cannot see it. It is the only assertion here that would survive the config being a no-op.
  const RELAY_DIST = join(PKGS, 'relay', 'dist', 'index.js')
  const MARKER = '__LOADED_FROM_DIST__'

  it('a cross-package import does not see a symbol that exists only in dist', () => {
    if (!existsSync(RELAY_DIST)) {
      throw new Error('packages/relay/dist/index.js is missing — run `pnpm build` first; this test needs a build to plant a marker in')
    }
    const before = readFileSync(RELAY_DIST, 'utf8')
    appendFileSync(RELAY_DIST, `\nexport const ${MARKER} = true;\n`)
    try {
      const probe = join(PKGS, 'ios-agent', 'src', '__tests__', 'zz-source-resolution.probe.test.ts')
      writeFileSync(probe, [
        `import { it, expect } from 'vitest'`,
        `import * as relay from '@tapflowio/relay'`,
        `it('resolves to source', () => { expect('${MARKER}' in relay).toBe(false) })`,
        '',
      ].join('\n'))
      try {
        runProbe(join(PKGS, 'ios-agent'), probe)
      } finally {
        rmSync(probe, { force: true })
      }
    } finally {
      writeFileSync(RELAY_DIST, before)
    }
  }, 120_000)

  // The dashboard's tests run in jsdom, on vite's client resolution: `sourceFirst`'s `ssr.resolve` does not reach them,
  // and every flow-runner import there loaded `dist` until its config prepended `source` to `resolve.conditions`
  // (measured with DEBUG=vite:resolve). The marker is a string statement inside a function's body, read back through
  // its source text: an `export const` appended to `dist/browser.js` read as absent from the namespace even while
  // `dist` was what loaded, and a comment would go if a transform ever stripped comments, passing on `dist` again.
  // Put back only if the file is still as planted: a flow-runner build in another test file (dashboardFirstLoadBudget)
  // may have written it since, and restoring `before` over that would leave `dist` silently stale.
  it('the dashboard flow-runner import runs source, not dist', () => {
    const SCHEMA_DIST = join(PKGS, 'flow-runner', 'dist', 'schema.js')
    const packageDir = join(PKGS, 'dashboard')
    const probe = join(packageDir, 'src', '__tests__', 'zz-source-resolution.probe.test.ts')
    const marker = '__RAN_FLOW_RUNNER_FROM_DIST__'
    if (!existsSync(SCHEMA_DIST)) throw new Error('packages/flow-runner/dist/schema.js is missing — run `pnpm build` first')
    const before = readFileSync(SCHEMA_DIST, 'utf8')
    if (!before.includes('function parseFlow(')) throw new Error('flow-runner/dist/schema.js no longer defines parseFlow — move the marker')
    const planted = before.replace(/function parseFlow\(([^)]*)\) \{/, `function parseFlow($1) { '${marker}';`)
    if (planted === before) throw new Error('could not plant the marker in parseFlow — move it')
    writeFileSync(SCHEMA_DIST, planted)
    try {
      writeFileSync(probe, [
        `import { it, expect } from 'vitest'`,
        `import { parseFlow } from '@tapflowio/flow-runner/browser'`,
        `it('resolves to source', () => { expect(parseFlow.toString()).not.toContain('${marker}') })`,
        '',
      ].join('\n'))
      runProbe(packageDir, probe)
    } finally {
      rmSync(probe, { force: true })
      if (readFileSync(SCHEMA_DIST, 'utf8') === planted) writeFileSync(SCHEMA_DIST, before)
    }
  }, 120_000)

  it('the MCP flow-runner import does not see a symbol that exists only in dist', () => {
    const FLOW_RUNNER_DIST = join(PKGS, 'flow-runner', 'dist', 'index.js')
    const packageDir = join(PKGS, 'mcp-server')
    const probe = join(packageDir, 'src', '__tests__', 'zz-source-resolution.probe.test.ts')
    const marker = '__LOADED_FLOW_RUNNER_FROM_DIST__'
    if (!existsSync(FLOW_RUNNER_DIST)) throw new Error('packages/flow-runner/dist/index.js is missing — run `pnpm build` first')
    const before = readFileSync(FLOW_RUNNER_DIST, 'utf8')
    const planted = `${before}\nexport const ${marker} = true;\n`
    writeFileSync(FLOW_RUNNER_DIST, planted)
    try {
      writeFileSync(probe, [
        `import { it, expect } from 'vitest'`,
        `import * as runner from '@tapflowio/flow-runner'`,
        `it('resolves to source', () => { expect('${marker}' in runner).toBe(false) })`,
        '',
      ].join('\n'))
      runProbe(packageDir, probe)
    } finally {
      rmSync(probe, { force: true })
      // As above: a build in another file may have written it since.
      if (readFileSync(FLOW_RUNNER_DIST, 'utf8') === planted) writeFileSync(FLOW_RUNNER_DIST, before)
    }
  }, 120_000)
})
