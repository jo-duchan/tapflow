// Production reachability read from the lockfile, and the gate decision built on it.
//
// The fixtures are shaped like the real lockfile — inline empty maps, peer suffixes, workspace
// links — because every bug found while writing this was in one of those three shapes and none of
// them appear in a tidy invented example.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  importerProdDeps,
  snapshotDeps,
  prodReachableNames,
  prodResolvedVersions,
  prodVersionChanges,
  changedOverrideKeys,
  overrideKeyName,
} from '../prod-reach.mjs'
import { publishedImportersAt, rootDependencyChangeShips } from '../check-changeset.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^4.1.10
        version: 4.1.10

  packages/relay:
    dependencies:
      '@tapflowio/agent-core':
        specifier: workspace:*
        version: link:../agent-core
      better-sqlite3:
        specifier: ^12.11.1
        version: 12.11.1
    devDependencies:
      typescript:
        specifier: ^5.0.0
        version: 5.0.0

  packages/agent-core:
    dependencies:
      ws:
        specifier: ^8.21.1
        version: 8.21.1

snapshots:

  better-sqlite3@12.11.1:
    dependencies:
      bindings: 1.5.0

  bindings@1.5.0: {}

  ws@8.21.1: {}

  '@hono/node-server@2.0.12(hono@4.13.0)':
    dependencies:
      hono: 4.13.0

  hono@4.13.0: {}

  typescript@5.0.0: {}

  vitest@4.1.10: {}
`

describe('lockfile parsing', () => {
  it('reads production dependencies and skips devDependencies', () => {
    const imp = importerProdDeps(LOCK)
    expect(imp['packages/relay']).toEqual({
      '@tapflowio/agent-core': 'link:../agent-core',
      'better-sqlite3': '12.11.1',
    })
    expect(imp['packages/relay'].typescript).toBeUndefined()
  })

  it('keeps a package whose dependency map is written inline as {}', () => {
    // `hono@4.13.0: {}` does not end in `:`. Missing that branch dropped every leaf package,
    // and a leaf is exactly what an overridden transitive dependency usually is.
    expect(Object.keys(snapshotDeps(LOCK))).toContain('hono@4.13.0')
    expect(snapshotDeps(LOCK)['hono@4.13.0']).toEqual({})
  })

  it('reads a peer-suffixed snapshot key whole', () => {
    expect(snapshotDeps(LOCK)['@hono/node-server@2.0.12(hono@4.13.0)']).toEqual({ hono: '4.13.0' })
  })
})

describe('prodReachableNames', () => {
  it('follows workspace links into the linked importer', () => {
    // `ws` belongs to agent-core, which relay reaches only through `link:../agent-core`.
    const names = prodReachableNames(LOCK, ['packages/relay'])
    expect(names.has('ws')).toBe(true)
    expect(names.has('better-sqlite3')).toBe(true)
    expect(names.has('bindings')).toBe(true) // transitive
  })

  it('excludes devDependencies of the importer and of the root', () => {
    const names = prodReachableNames(LOCK, ['packages/relay'])
    expect(names.has('typescript')).toBe(false)
    expect(names.has('vitest')).toBe(false)
  })

  it('reports nothing when no importer publishes', () => {
    expect(prodReachableNames(LOCK, []).size).toBe(0)
  })
})

describe('prodResolvedVersions', () => {
  it('reads the package version, not the peer it is suffixed with', () => {
    const lock = LOCK.replace('  packages/agent-core:\n    dependencies:\n      ws:', '  packages/agent-core:\n    dependencies:\n      \'@hono/node-server\':\n        specifier: ^2.0.12\n        version: 2.0.12(hono@4.13.0)\n      ws:')
    const v = prodResolvedVersions(lock, ['packages/relay'])
    expect(v['@hono/node-server']).toEqual(['2.0.12'])
    expect(v['hono']).toEqual(['4.13.0'])
  })
})

describe('prodVersionChanges', () => {
  it('notices a production version that moved with no override involved', () => {
    // The `pnpm update` path. AGENTS.md now recommends it, so it has to be watched too.
    const after = LOCK.replace(/better-sqlite3@12\.11\.1/g, 'better-sqlite3@12.12.0')
      .replace('version: 12.11.1', 'version: 12.12.0')
    expect(prodVersionChanges(LOCK, after, ['packages/relay'])).toEqual(['better-sqlite3'])
  })

  it('ignores a devDependency that moved', () => {
    const after = LOCK.replace(/vitest@4\.1\.10/g, 'vitest@4.2.0').replace('version: 4.1.10', 'version: 4.2.0')
    expect(prodVersionChanges(LOCK, after, ['packages/relay'])).toEqual([])
  })

  it('sees no change when nothing moved', () => {
    expect(prodVersionChanges(LOCK, LOCK, ['packages/relay'])).toEqual([])
  })

  it('notices a re-patched production dependency, version unchanged', () => {
    // Editing a file under `pnpm.patchedDependencies` changes shipped code while the version
    // string stays put. pnpm records the patch in the lockfile as `(patch_hash=…)`, and `bareKey`
    // strips peer suffixes but keeps that — so the compare sees it.
    const patched = (hash) => `lockfileVersion: '9.0'

importers:

  packages/relay:
    dependencies:
      better-sqlite3:
        specifier: ^12.11.1
        version: 12.11.1(patch_hash=${hash})

snapshots:

  better-sqlite3@12.11.1(patch_hash=${hash}): {}
`
    expect(prodVersionChanges(patched('aaa111'), patched('bbb222'), ['packages/relay'])).toEqual([
      'better-sqlite3',
    ])
  })

  it('ignores a re-patched dependency that production cannot reach', () => {
    const patched = (hash) => `lockfileVersion: '9.0'

importers:

  packages/relay:
    devDependencies:
      typescript:
        specifier: ^5.0.0
        version: 5.0.0(patch_hash=${hash})

snapshots:

  typescript@5.0.0(patch_hash=${hash}): {}
`
    expect(prodVersionChanges(patched('aaa111'), patched('bbb222'), ['packages/relay'])).toEqual([])
  })
})

describe('changedOverrideKeys / overrideKeyName', () => {
  const before = JSON.stringify({ pnpm: { overrides: { 'hono@<4.12.27': '^4.12.27', 'undici@<7': '>=7' } } })

  it('reports added, removed and retargeted keys', () => {
    const after = JSON.stringify({ pnpm: { overrides: { 'hono@<4.12.34': '^4.12.34', 'undici@<7': '>=7' } } })
    expect(changedOverrideKeys(before, after).sort()).toEqual(['hono@<4.12.27', 'hono@<4.12.34'])
  })

  it('reports a replacement changed under the same key', () => {
    const after = JSON.stringify({ pnpm: { overrides: { 'hono@<4.12.27': '^4.12.34', 'undici@<7': '>=7' } } })
    expect(changedOverrideKeys(before, after)).toEqual(['hono@<4.12.27'])
  })

  it('treats an unreadable or absent manifest as no overrides', () => {
    expect(changedOverrideKeys('', '')).toEqual([])
    expect(changedOverrideKeys('not json', before).length).toBe(2)
  })

  it('names the package a key targets, including a rangeless key', () => {
    expect(overrideKeyName('fast-uri@>=3.0.0 <3.1.5')).toBe('fast-uri')
    expect(overrideKeyName('@hono/node-server@<2.0.5')).toBe('@hono/node-server')
    expect(overrideKeyName('esbuild')).toBe('esbuild')
  })

  it('names the CHILD of a parent selector, not the parent', () => {
    // pnpm accepts `parent>child`. Returning the parent would look up reachability for a package
    // the override does not touch, and miss a production one.
    expect(overrideKeyName('vite>picomatch')).toBe('picomatch')
    expect(overrideKeyName('vite@5.0.0>picomatch')).toBe('picomatch')
    expect(overrideKeyName('@vitejs/plugin-react>@babel/core')).toBe('@babel/core')
    expect(overrideKeyName('vite>picomatch@<4.0.4')).toBe('picomatch')
  })

  it('does not mistake a `>=` range for a parent selector', () => {
    expect(overrideKeyName('undici@>=7.0.0 <7.29.0')).toBe('undici')
    expect(overrideKeyName('protobufjs@>=7.5.0 <=7.6.4')).toBe('protobufjs')
  })
})

describe('against this repository', () => {
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  // The gate's OWN importer list, not a hand-written one. A parallel copy here judged a different
  // input from the thing it claimed to pin — it omitted `@tapflowio/dashboard`, which is private
  // but ships inside the relay and brings 119 more packages with it.
  const published = publishedImportersAt('HEAD')

  it('the image is a strict subset of what publishes', () => {
    // The override path judges against the image; the `packages/**` path judges against every
    // published package. Both are right for what they cover, and neither is the other.
    const image = prodReachableNames(lock, ['packages/relay', 'packages/dashboard'])
    const all = prodReachableNames(lock, published)
    expect(image.size).toBeLessThan(all.size)
    for (const n of image) expect(all.has(n), `${n} should also be published-reachable`).toBe(true)
  })

  it('agrees with `pnpm why -r --prod` on which of these packages reach production', () => {
    // Measured independently with pnpm; this parser has to reproduce it or it is not usable as
    // the gate's evidence.
    // `js-yaml`, `dompurify`, `shell-quote` and `esbuild` are no longer in `pnpm.overrides`, and
    // they stay in this list precisely because this assertion is what licensed retiring those
    // entries: the overrides went away, the packages did not, and the day one turns up in a
    // published tree is the day its retirement was wrong. `esbuild` is the sharpest of the four —
    // two of its resolved versions sit inside an advisory the retired key never covered, so this
    // assertion, that none of it reaches production, is the whole of why that is tolerable.
    // `@hono/node-server` is retired too but sits in the other list, where the same assertion
    // argues the opposite way: reaching production is what made that retirement worth checking
    // twice, not what cleared it. What cleared it is that `@modelcontextprotocol/sdk` declares
    // `^1.19.9 || ^2.0.5`, and the newest release of either branch is above that branch's
    // advisory floor — so restoring the declared range cannot reach a vulnerable version.
    const names = prodReachableNames(lock, published)
    for (const p of ['hono', 'fast-uri', 'axios', 'protobufjs', '@hono/node-server']) {
      expect(names.has(p), `${p} should be prod-reachable`).toBe(true)
    }
    for (const p of ['undici', 'dompurify', 'js-yaml', 'shell-quote', 'esbuild']) {
      expect(names.has(p), `${p} should NOT be prod-reachable`).toBe(false)
    }
  })
})

describe.skip('the gate decision, against real history', () => {
  it('the fixtures are actually in this clone', () => {
    // A shallow clone has none of them, and `git show` on a missing rev used to be swallowed as
    // "that file was not there" — so every case below quietly answered "nothing shipped" and the
    // suite failed on the one expecting `true`. Fail here, where the reason is legible.
    expect(() => rootDependencyChangeShips('package.json', 'f163227^1', 'f163227')).not.toThrow()
  })

  // Six merges that actually changed `pnpm.overrides`, run through the real
  // `rootDependencyChangeShips` rather than a copy of it. Every one merged with no changeset,
  // unquestioned; telling them apart is the whole point of the module (#472).
  //
  // Only `axios` qualifies, and that is the point rather than a weakness. These files decide the
  // contents of one artifact — the image — because `pnpm.overrides` and the lockfile do not travel
  // into a published tarball, where the consumer resolves each intermediary's own range. A bump
  // that only moves something inside `mcp-server` or `android-agent` changes nothing anyone
  // installs, and demanding a release note for it is how a gate becomes noise.
  it.each([
    ['d6a61b9', 'undici — dev-only via jsdom', false],
    ['afd7957', '#469 undici — dev-only', false],
    ['f163227', 'axios — reaches relay, so it is in the image', true],
    ['cd724a7', 'protobufjs / body-parser — android-agent and mcp-server only, not the image', false],
    ['6d5bad7', 'fast-uri / hono — mcp-server only, not the image', false],
    ['560bcf5', '#471 fast-uri / hono — mcp-server only, not the image', false],
  ])('%s (%s) → changeset required: %s', (sha, _label, expected) => {
    const ships =
      rootDependencyChangeShips('package.json', `${sha}^1`, sha) ||
      rootDependencyChangeShips('pnpm-lock.yaml', `${sha}^1`, sha)
    expect(ships).toBe(expected)
  })
})
