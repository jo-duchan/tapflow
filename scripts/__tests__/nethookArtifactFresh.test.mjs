import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { computeRecord, readRecord, collectSources, collectArtifactFiles } from '../lib/nethook-artifact.mjs'

/**
 * `bin/libtapflow-nethook.dylib` is committed as a prebuilt, and every test that exercises the
 * network hook injects a *fake* dylib path — so nothing in the suite has ever read the real one.
 * Editing `network-hook.m` and shipping the previous binary was therefore invisible, and #653 was
 * written in exactly that state: the source said `rename`, the shipped binary still truncated in
 * place, and 862 tests were green.
 *
 * **A failure here is yours to fix, unlike the netfilter one next door.** That extension is
 * Developer-ID signed and notarized on a maintainer's Mac, so its guard failing is a handoff. This
 * needs only Xcode's command-line tools:
 *
 *     pnpm --filter @tapflowio/ios-agent build:nethook
 */
const REPO = path.resolve(import.meta.dirname, '../..')

// Measured floor. A source list that lost an entry hashes to something stable, and every assertion
// below then passes while watching less than it says — the shape
// `contributing/test-and-guard-coverage.md` calls a guard that certifies its own absence.
const SOURCE_FILES = 6

describe('the shipped injected library matches what it was recorded against', () => {
  it('has a record at all', () => {
    expect(
      readRecord(REPO),
      'packages/ios-agent/nethook-shipped.json is missing — run packages/ios-agent/build-nethook.sh',
    ).not.toBeNull()
  })

  it('sees every declared source, and the artifact', () => {
    expect(collectSources(REPO).length, 'the source list shrank').toBe(SOURCE_FILES)
    expect(collectArtifactFiles(REPO).length, 'the dylib is missing').toBe(1)
  })

  it('still matches the sources it was built from', () => {
    const now = computeRecord(REPO)
    expect(
      now.sources,
      'The hook sources changed since the shipped dylib was built.\n'
      + '  Rebuild it: pnpm --filter @tapflowio/ios-agent build:nethook\n'
      + '  That rebuilds and rewrites this record in one step. It needs Xcode command-line tools;\n'
      + '  unlike the network filter, no signing key is involved.',
    ).toBe(readRecord(REPO).sources)
  })

  it('checks the fields it records, so none of them is decoration', () => {
    // A record carrying numbers nobody compares reads as more checked than it is, and a forged one is
    // easier to make look right. The netfilter guard compares its `bundleVersion`; these were the two
    // it has no counterpart for.
    const now = computeRecord(REPO)
    const recorded = readRecord(REPO)
    expect(now.dylibBytes).toBe(recorded.dylibBytes)
    expect(now.sourceFileCount).toBe(recorded.sourceFileCount)
  })

  it('is the same dylib that was recorded', () => {
    // The half that makes the check work at all. Recording only the sources fails in a way correlated
    // with the mistake: whoever forgets to rebuild forgets to re-record, both values stay consistent,
    // and the guard passes.
    const now = computeRecord(REPO)
    expect(now.dylib, 'the committed dylib is not the one in the record — rebuild it').toBe(readRecord(REPO).dylib)
  })
})
