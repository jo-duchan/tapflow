import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'

// `@tapflowio/flow-runner/browser` is what the dashboard imports to run a flow through the same engine and session
// semantics as `tapflow flow run` (Flow Capture, #1125). Nothing a browser loads from it may reach Node, and nothing
// else would say so: vitest runs in node, where every builtin exists, and the dashboard's own build would fail only
// once something it bundles reaches one — after the import had already shipped on the Node side.
//
// So this walks the **import graph** from the entry rather than reading a list of files: a module joins the browser
// bundle by being imported, wherever it lives, including across into a workspace package (`@tapflowio/agent-core`'s
// index reaches `downloadBuild` and Node's `fs`; its `./errors` subpath does not). Third-party packages are not
// descended into — `yaml` is the one there is, and it is browser-safe — but `ws` is refused by name.
//
// Also refused in the walked code: Node globals used as values (`Buffer.from`, `process.`) and the secure-context-only
// Web Crypto calls `dashboardSecureContextApis.test.mjs` refuses in the dashboard — a LAN dashboard is plain HTTP, and
// those calls are absent there. Erased imports (`import type`, `export type`) are not followed: they never load.

const root = join(import.meta.dirname, '../..')
const ENTRY = 'packages/flow-runner/src/browser.ts'

const NODE_ONLY = new Set([...builtinModules, 'ws'])
const FORBIDDEN_CODE = [
  { pattern: /\bBuffer\s*\.\s*(from|alloc|allocUnsafe|concat|isBuffer)\b/, what: 'Buffer (a Node global)' },
  { pattern: /\bprocess\s*\./, what: 'process (a Node global)' },
  { pattern: /\b(setImmediate|require)\s*\(/, what: 'setImmediate or require (Node only)' },
  { pattern: /\bcrypto\.randomUUID\s*\(/, what: 'crypto.randomUUID (secure-context only)' },
  { pattern: /\bcrypto\.subtle\b/, what: 'crypto.subtle (secure-context only)' },
]

/** Comments blanked so prose naming `process.` or `Buffer.from` does not count — several doc blocks do. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

/** The specifiers a module loads at runtime: imports and re-exports that are not type-only, and dynamic imports. */
function runtimeSpecifiers(path, src) {
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out = []
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
      const named = n.importClause?.namedBindings
      const onlyTypes = !n.importClause?.name && named && ts.isNamedImports(named) && named.elements.length > 0
        && named.elements.every((e) => e.isTypeOnly)
      if (!onlyTypes) out.push(n.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && !n.isTypeOnly) {
      out.push(n.moduleSpecifier.text)
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      out.push(n.arguments[0].text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** A workspace package's subpath, by its `source` condition — what vitest and this repo's tests resolve to. */
function workspaceSource(base, spec) {
  const m = /^(@tapflowio\/[^/]+)(\/.*)?$/.exec(spec)
  if (!m) return null
  const pkgDir = join(base, 'packages', m[1].slice('@tapflowio/'.length))
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const entry = manifest.exports?.[m[2] ? `.${m[2]}` : '.']
  const source = typeof entry === 'object' ? entry?.source : undefined
  if (!source) throw new Error(`${spec}: no "source" export — the walk cannot follow it`)
  return join(pkgDir, source)
}

/** Walks the graph from `entry` under `base`, returning every module visited and every violation found. */
export function walkBrowserGraph(base, entry) {
  const seen = new Set()
  const violations = []
  const thirdParty = new Set()
  const queue = [join(base, entry)]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const rel = relative(base, file)
    const src = readFileSync(file, 'utf8')
    for (const spec of runtimeSpecifiers(file, src)) {
      if (spec.startsWith('.')) {
        const resolved = join(dirname(file), spec.replace(/\.js$/, '.ts'))
        const target = existsSync(resolved) ? resolved : join(dirname(file), spec, 'index.ts')
        if (!existsSync(target)) throw new Error(`${rel}: cannot resolve ${spec}`)
        queue.push(target)
        continue
      }
      const bare = spec.replace(/^node:/, '')
      if (spec.startsWith('node:') || NODE_ONLY.has(bare) || NODE_ONLY.has(bare.split('/')[0])) {
        violations.push(`${rel} imports ${spec}`)
        continue
      }
      const ws = workspaceSource(base, spec)
      if (ws) queue.push(ws)
      else thirdParty.add(spec)
    }
    const body = code(src)
    for (const { pattern, what } of FORBIDDEN_CODE) {
      if (pattern.test(body)) violations.push(`${rel} uses ${what}`)
    }
  }
  return { seen: [...seen].map((f) => relative(base, f)).sort(), violations, thirdParty: [...thirdParty].sort() }
}

describe('@tapflowio/flow-runner/browser reaches no Node', () => {
  const { seen, violations, thirdParty } = walkBrowserGraph(root, ENTRY)

  it('the walk reached the engine, the session channel and across into workspace packages', () => {
    // Anti-vacuity: a walk that stopped at the entry would find nothing and pass.
    for (const f of [
      'packages/flow-runner/src/engine.ts',
      'packages/flow-runner/src/sessionChannel.ts',
      'packages/flow-runner/src/SocketFlowDriver.ts',
      'packages/flow-runner/src/schema.ts',
      'packages/agent-core/src/errors.ts',
      'packages/protocol/src/screen/index.ts',
    ]) expect(seen).toContain(f)
    expect(seen).not.toContain('packages/flow-runner/src/RelayClient.ts')
  })

  it('no module in the graph imports a Node builtin or ws, or uses a Node global or a secure-context API', () => {
    expect(violations).toEqual([])
  })

  it('the only third-party package in reach is yaml, which the walk does not descend into', () => {
    // `yaml` maps `default` to its browser build. A new dependency here is not walked, so it has to be looked at
    // and added by hand — the list is the record that someone did.
    expect(thirdParty).toEqual(['yaml'])
  })

  it('the entry is the one package.json exports as ./browser', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'packages/flow-runner/package.json'), 'utf8'))
    expect(manifest.exports['./browser'].source).toBe('./src/browser.ts')
  })
})

describe('the walk catches what it exists to catch', () => {
  // Each planted module sits one or more hops from the entry, through each kind of edge the walk follows.
  const plant = (files) => {
    const base = mkdtempSync(join(tmpdir(), 'browser-graph-'))
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true })
      writeFileSync(join(base, path), body)
    }
    return base
  }
  const cases = {
    'a node: builtin two hops away': { 'e.ts': "import { a } from './a.js'\n", 'a.ts': "export { b as a } from './b.js'\n", 'b.ts': "import { join } from 'node:path'\nexport const b = join\n" },
    'a bare builtin': { 'e.ts': "import { readFileSync } from 'fs'\n" },
    'ws': { 'e.ts': "import { WebSocket } from 'ws'\n" },
    'a dynamic import': { 'e.ts': "export const f = () => import('node:crypto')\n" },
    'a dynamic import of a template literal': { 'e.ts': "export const f = () => import(`node:fs`)\n" },
    'setImmediate': { 'e.ts': 'setImmediate(() => {})\n' },
    'a workspace package index that reaches Node': {
      'e.ts': "import { x } from '@tapflowio/pkg'\n",
      'packages/pkg/package.json': JSON.stringify({ exports: { '.': { source: './src/index.ts' } } }),
      'packages/pkg/src/index.ts': "import { createHash } from 'node:crypto'\nexport const x = createHash\n",
    },
    'Buffer.from': { 'e.ts': 'export const b = Buffer.from([])\n' },
    'crypto.randomUUID': { 'e.ts': 'export const id = crypto.randomUUID()\n' },
  }
  for (const [name, files] of Object.entries(cases)) {
    it(`reports ${name}`, () => {
      const base = plant(files)
      try {
        expect(walkBrowserGraph(base, 'e.ts').violations.length).toBeGreaterThan(0)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    })
  }

  it('does not follow an erased import', () => {
    const base = plant({ 'e.ts': "import type { X } from './n.js'\nimport { type Y } from './n.js'\nexport type { Z } from './n.js'\n", 'n.ts': "import 'node:fs'\n" })
    try {
      expect(walkBrowserGraph(base, 'e.ts').violations).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
