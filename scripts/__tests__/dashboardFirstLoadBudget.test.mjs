// Protect the metric #168 actually cares about: JavaScript fetched before first paint.
//
// Vite's large-chunk warning only watches individual raw chunks. The first vendor split looked
// good by that signal while adding eager modulepreloads. Build the real dashboard output, read
// index.html, and budget the precompressed Brotli bytes that the relay serves.
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DASHBOARD_DIST = resolve(ROOT, 'packages', 'dashboard', 'dist')
const INDEX_HTML = resolve(DASHBOARD_DIST, 'index.html')
// #520 set 155,000 against 147,099 B, about 8 kB of room. By #809, main had grown to 153,019 B, and
// that React 19.3 group adds 10.1 kB more (React 7.5, zod 1.6, lucide-react and react-hook-form 1.0)
// for 163,150 B. 171,000 restored the same 8 kB of room.
//
// 2026-09-22, turning the React Compiler on: 182,000 against 174,353 B, 7.6 kB of room.
//
// **The compiler is not what used the old budget up.** Measured the same day, main without the
// compiler was already at 170,543 B — 457 B under 171,000. Whatever landed between #809 and here
// spent the whole 8 kB, and the compiler's own share is +3,810 B (170,543 → 174,353), which is the
// memoisation it emits as code.
//
// The room must stay well below what the guard exists to catch: the eager vendor-ui / vendor-forms
// split from 252262ba's vite.config.ts. Rebuilt with that split on today's dependencies **and the
// compiler on**, as the previous note asked, it produces 187,809 B — so 182,000 fails it with
// 5.8 kB to spare, slightly more than the 5.1 kB the old pair had. Before raising this again,
// rebuild with that config and check it still fails.
//
// 2026-10-19, Dependabot's 32-update group (#1001): 191,000 against 183,011 B, 8 kB of room again.
// main was already at 181,432 B, 568 B under the old budget; the group adds 1,579 B, nearly all of it
// to the entry chunk (+1,510 B) rather than vendor-react (+64 B). The likely sources are the bumps that
// reach the entry chunk: the Radix minors (dialog 1.1 → 1.3, tooltip 1.2 → 1.4 and slot, through the
// sidebar) and lucide-react 1.52 → 1.58. That is not measured per package. The eager split — only its
// `manualChunks` restored into today's vite.config.ts, so with the compiler on — rebuilt on that group's
// dependencies is 200,957 B, so 191,000 still fails it with 10 kB to spare.
const FIRST_LOAD_BROTLI_BUDGET = 191_000
const MAX_RAW_JS_CHUNK_SIZE = 500_000

function buildDashboardDist() {
  const env = { ...process.env, NODE_ENV: 'production' }
  // agent-core and flow-runner too: the dashboard's Flow Capture dialog imports flow-runner from its dist, and a
  // checkout that never built them would fail the dashboard's own build here.
  for (const pkg of ['@tapflowio/protocol', '@tapflowio/agent-core', '@tapflowio/flow-runner', '@tapflowio/dashboard']) {
    execFileSync('pnpm', ['--filter', pkg, 'build'], { cwd: ROOT, env, stdio: 'inherit' })
  }
}

function attributes(tag) {
  const out = new Map()
  const pattern = /([:\w-]+)\s*=\s*(['"])(.*?)\2/g
  for (const match of tag.matchAll(pattern)) out.set(match[1].toLowerCase(), match[3])
  return out
}

function distAssetPath(assetPath) {
  const withoutOrigin = assetPath.replace(/^[a-z]+:\/\/[^/]+/i, '')
  const withoutQuery = withoutOrigin.split(/[?#]/, 1)[0]
  const relativeAsset = withoutQuery.replace(/^\/+/, '')
  const resolved = resolve(DASHBOARD_DIST, relativeAsset)
  if (relative(DASHBOARD_DIST, resolved).startsWith('..')) {
    throw new Error(`First-load asset escapes dashboard dist: ${assetPath}`)
  }
  return resolved
}

function firstLoadJavascriptAssets(html) {
  const assets = new Set()

  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const src = attrs.get('src')
    if (src?.endsWith('.js')) assets.add(distAssetPath(src))
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const rel = attrs.get('rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attrs.get('href')
    if (rel.includes('modulepreload') && href?.endsWith('.js')) assets.add(distAssetPath(href))
  }

  return [...assets].sort()
}

function firstLoadBrotliReport() {
  if (!existsSync(INDEX_HTML)) {
    throw new Error('packages/dashboard/dist/index.html is missing after dashboard build')
  }

  const assets = firstLoadJavascriptAssets(readFileSync(INDEX_HTML, 'utf8'))
  if (assets.length === 0) throw new Error('No first-load JavaScript assets found in packages/dashboard/dist/index.html')

  let total = 0
  const lines = []
  for (const asset of assets) {
    const brotliAsset = `${asset}.br`
    if (!existsSync(brotliAsset)) {
      throw new Error(`Missing Brotli asset for first-load JavaScript: ${relative(ROOT, brotliAsset)}`)
    }
    const size = statSync(brotliAsset).size
    total += size
    lines.push(`- ${relative(ROOT, brotliAsset)}: ${size} B`)
  }

  return { total, details: lines.join('\n') }
}

/** The one `<script src>` in index.html — the app's own entry, never a vendor chunk. */
function entryScriptPath(html) {
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attributes(match[0]).get('src')
    if (src?.endsWith('.js')) return distAssetPath(src)
  }
  throw new Error('No module entry script found in packages/dashboard/dist/index.html')
}

function oversizedJavascriptChunks() {
  const assetsDir = resolve(DASHBOARD_DIST, 'assets')
  if (!existsSync(assetsDir)) {
    throw new Error('packages/dashboard/dist/assets is missing after dashboard build')
  }

  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => {
      const asset = resolve(assetsDir, name)
      return { name, size: statSync(asset).size }
    })
    .filter(({ size }) => size > MAX_RAW_JS_CHUNK_SIZE)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// One build, three assertions about it. A second test file would mean a second `pnpm build` of the
// dashboard in CI for no new information — measured at roughly 30 s with the protocol build in front
// of it — which is why the compiler check below lives beside the size ones rather than on its own.
beforeAll(() => {
  buildDashboardDist()
}, 180_000)

describe('the shipped dashboard bundle is compiled by the React Compiler', () => {
  it('emits the compiler memo cache into the entry chunk', () => {
    // **`vitest.config.ts` and `vite.config.ts` need separate guards, and only one of them had a
    // test.** `packages/dashboard/src/__tests__/reactCompilerOn.test.tsx` asserts the compiler ran,
    // but it runs *under vitest* — so it proves the test config applies the compiler and says
    // nothing about the build. Deleting `reactWithCompiler()` from `vite.config.ts` alone left that
    // test green and shipped an uncompiled bundle.
    //
    // The marker is `Symbol.for("react.memo_cache_sentinel")`, which the compiler writes into every
    // function it caches values for. It is a string literal, so minification keeps it, and it lands
    // in app code only when app code was compiled — on an uncompiled build it appears in the React
    // vendor chunk alone, where React itself defines it. Reading the entry chunk rather than the
    // whole first-load set is what keeps the two apart.
    //
    // **What it cannot see: one component losing compilation.** A suppression added inside a single
    // component removes that component's share of 161 sentinels and leaves the rest, and most of
    // them are in lazy chunks this never opens — the streaming surface alone holds 73. That is held
    // at the source instead, by `packages/dashboard/src/__tests__/noSuppressedCompilation.test.ts`,
    // which asks the compiler for the skip *reason* rather than counting bytes.
    // **Counted, not merely present.** react-dom defines the sentinel itself and is the only
    // production dependency that ships it, so a build that stopped compiling *and* stopped splitting
    // `vendor-react` would inline react-dom into the entry and pass a `toContain`. React contributes
    // exactly one; compiled app code contributes dozens — 43 in the entry chunk on 2026-09-22, 161
    // across the bundle. Ten is the anti-vacuity floor between those two, not a budget.
    const entry = entryScriptPath(readFileSync(INDEX_HTML, 'utf8'))
    const sentinels = readFileSync(entry, 'utf8').split('react.memo_cache_sentinel').length - 1
    expect(
      sentinels,
      `${relative(ROOT, entry)} carries ${sentinels} memo-cache sentinels — the build did not run ` +
      `the React Compiler over app code. React itself accounts for one.`,
    ).toBeGreaterThanOrEqual(10)
  })
})

describe('dashboard first-load JavaScript budget', () => {
  it('keeps first-load Brotli JS below budget', () => {
    const { total, details } = firstLoadBrotliReport()
    expect(
      total,
      `First-load Brotli JS is ${total} B, budget is ${FIRST_LOAD_BROTLI_BUDGET} B.\n\nAssets:\n${details}`,
    ).toBeLessThanOrEqual(FIRST_LOAD_BROTLI_BUDGET)
  })

  it('keeps emitted JavaScript chunks below the Vite large-chunk threshold', () => {
    const oversized = oversizedJavascriptChunks()
    const details = oversized.map(({ name, size }) => `- ${name}: ${size} B`).join('\n')
    expect(
      oversized,
      `JavaScript chunks exceed ${MAX_RAW_JS_CHUNK_SIZE} B raw:\n${details}`,
    ).toHaveLength(0)
  })
})

// Flow Capture's dialog brings flow-runner's engine and `yaml` (#1125). Every QA session loads the session page; only
// one that captures should download those. The page is already a lazy route, so this is not about first load: it is
// about what the session page's own chunks pull in statically. Markers are string literals that survive minifying.
// One from the session channel, which any use of flow-runner reaches, and one each from the YAML writer and the schema;
// tree-shaking keeps only what is used, so a single marker would miss an import of just the channel (measured).
const FLOW_RUNNER_MARKERS = ['agent predates input correlation', 'does not read back as the same steps', 'requires a flow-level appId']

/** The chunks `start` imports statically, itself included — `import("…")` is a later download and is not followed. */
function staticClosure(start) {
  const assetsDir = resolve(DASHBOARD_DIST, 'assets')
  const seen = new Set()
  const queue = [start]
  while (queue.length) {
    const name = queue.pop()
    if (seen.has(name)) continue
    seen.add(name)
    const text = readFileSync(resolve(assetsDir, name), 'utf8')
    for (const m of text.matchAll(/(?:^|[;\s}])import\s*(?:[\w${}*,\s]+from\s*)?["']\.\/([^"']+\.js)["']/g)) queue.push(m[1])
  }
  return [...seen]
}

function chunkNamed(prefix) {
  const found = readdirSync(resolve(DASHBOARD_DIST, 'assets')).filter((n) => n.startsWith(prefix) && n.endsWith('.js'))
  if (found.length !== 1) throw new Error(`expected one ${prefix}*.js chunk, found ${found.join(', ') || 'none'}`)
  return found[0]
}

const carriesFlowRunner = (name) => {
  const text = readFileSync(resolve(DASHBOARD_DIST, 'assets', name), 'utf8')
  return FLOW_RUNNER_MARKERS.some((m) => text.includes(m))
}

// Shiki (CodeBlock's highlighting) is loaded on first use only, by `import()`: a static import anywhere on the session
// page would put its ~115 KB core in it. `ShikiError` is its error class's name, which survives minifying.
const carriesShiki = (name) => readFileSync(resolve(DASHBOARD_DIST, 'assets', name), 'utf8').includes('ShikiError')

describe('Flow Capture is downloaded only by a session that captures', () => {
  it('leaves Shiki out of everything the session page and the dialog import statically', () => {
    expect(staticClosure(chunkNamed('QASession-')).filter(carriesShiki)).toEqual([])
    expect(staticClosure(chunkNamed('FlowCaptureDialog-')).filter(carriesShiki)).toEqual([])
  })

  it('leaves flow-runner out of everything the session page imports statically', () => {
    const reached = staticClosure(chunkNamed('QASession-'))
    expect(reached.length).toBeGreaterThan(1)
    expect(reached.filter(carriesFlowRunner)).toEqual([])
  })

  it('puts it in the dialog\'s own chunks — so the check above is looking at something that exists', () => {
    expect(staticClosure(chunkNamed('FlowCaptureDialog-')).some(carriesFlowRunner)).toBe(true)
  })
})
