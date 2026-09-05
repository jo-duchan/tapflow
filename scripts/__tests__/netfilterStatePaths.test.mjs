import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8')

/**
 * **The provider writes the state file; two TypeScript packages read it. The list of where lives in
 * all three, and nothing compiles more than one of them.**
 *
 * A Swift test can pin the Swift copy — `HeartbeatStateTests.testTheCandidatesAreTheTwoTheAgentAlsoLooksIn`
 * does — and that is all it can do, because it cannot read TypeScript. Its comment used to claim
 * otherwise. Reordering or replacing a path on either side leaves every suite green and sends the
 * agent looking in a directory the provider never writes: the control then reports the filter as
 * absent while the kernel is dropping traffic, which is the failure #639 exists to prevent, reached
 * through a directory name.
 *
 * The two halves are shaped differently on purpose. The provider iterates DIRECTORIES and appends the
 * file name (`resolvePath`), because it has to create the directory before it can create the file;
 * the readers only ever open a full path. So this joins rather than compares literals.
 */
const SWIFT = 'packages/ios-agent/ios-netfilter/Extension/FlowIdentity.swift'
const PROVIDER = 'packages/ios-agent/ios-netfilter/Extension/Provider.swift'
const READERS = [
  'packages/ios-agent/src/SimulatorNetwork.ts',
  'packages/cli/src/lib/net-filter.ts',
]

/** The directories the provider tries, in order. */
function swiftCandidates() {
  const block = read(SWIFT).match(/let stateFileCandidates = \[([^\]]*)\]/)
  if (!block) throw new Error(`${SWIFT}: no \`let stateFileCandidates = [...]\` — it was renamed or reshaped`)
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

/** The file name the provider appends to each of them. */
function swiftFileName() {
  const m = read(PROVIDER).match(/appendingPathComponent\("([^"]+)"\)/)
  if (!m) throw new Error(`${PROVIDER}: no \`appendingPathComponent("...")\` — resolvePath was reshaped`)
  return m[1]
}

/** A reader's full paths, in order. */
function readerPaths(file) {
  const block = read(file).match(/const FILTER_STATE_FILES = \[([^\]]*)\]/)
  if (!block) throw new Error(`${file}: no \`const FILTER_STATE_FILES = [...]\``)
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('every copy of the netfilter state path agrees', () => {
  // Each list is read rather than assumed: a rename that empties one would otherwise make this pass
  // by comparing two empty arrays, which is the shape `contributing/test-and-guard-coverage.md`
  // rule 3 is about. The parsers above throw instead, and these floors say so out loud.
  it('finds a non-empty list in every file', () => {
    expect(swiftCandidates().length, 'the provider tries at least two directories').toBeGreaterThan(1)
    expect(swiftFileName()).toMatch(/\.json$/)
    for (const f of READERS) {
      expect(readerPaths(f).length, `${f} reads at least two paths`).toBeGreaterThan(1)
    }
  })

  it('has the readers looking exactly where the provider writes, in the same order', () => {
    const expected = swiftCandidates().map((dir) => `${dir}/${swiftFileName()}`)
    for (const f of READERS) {
      expect(readerPaths(f), `${f} disagrees with the provider about where the state file goes`)
        .toEqual(expected)
    }
  })

  // Order is not cosmetic: the provider returns on its FIRST writable directory, so a reader that
  // tries them in the other order reads a stale file from the fallback while the live one sits in
  // the protected directory.
  it('agrees that the protected directory is tried before the world-writable fallback', () => {
    const [first, second] = swiftCandidates()
    expect(first).toBe('/Library/Application Support/tapflow')
    expect(second).toBe('/tmp')
  })
})
