// The audit judges each merge on its own, so a changeset added by a LATER PR to cover an earlier
// one never cleared it. During the v0.17.0 cycle that meant four merges were reported as gaps for
// a week after they had been covered by #424, and confirming that took a manual comparison on
// every run. A backfill now names the merges it answers for.
import { describe, it, expect } from 'vitest'
import { parseBackfills, prNumberOf } from '../check-changeset.mjs'

describe('prNumberOf', () => {
  it('reads the number out of a GitHub merge subject', () => {
    expect(prNumberOf('Merge pull request #413 from jo-duchan/fix/android-clipboard-shortcuts'))
      .toBe(413)
  })

  it('returns null for anything that is not one', () => {
    // A squash merge, a hand-made merge, a plain commit — none carry a PR number, and guessing
    // one would mean clearing a merge that no changeset actually covers.
    expect(prNumberOf('Merge branch main into feature')).toBeNull()
    expect(prNumberOf('fix(android): map Cmd/Ctrl clipboard shortcuts (#413)')).toBeNull()
    expect(prNumberOf('Merge pull request from jo-duchan/x')).toBeNull()
    expect(prNumberOf('')).toBeNull()
  })
})

describe('parseBackfills', () => {
  const body = (...lines) => ['---', '"@tapflowio/relay": patch', '---', '', ...lines].join('\n')

  it('reads a single reference', () => {
    expect(parseBackfills(body('Fixes the thing.', '', 'Backfills: #413'))).toEqual([413])
  })

  it('reads several from one line', () => {
    expect(parseBackfills(body('Backfills: #410, #411 and #412'))).toEqual([410, 411, 412])
  })

  it('reads several lines', () => {
    expect(parseBackfills(body('Backfills: #410', 'Backfills: #411'))).toEqual([410, 411])
  })

  it('is case-insensitive and tolerates indentation', () => {
    expect(parseBackfills(body('  backfills:   #413  '))).toEqual([413])
  })

  it('finds nothing in an ordinary changeset', () => {
    expect(parseBackfills(body('Fix the copy shortcut on Android.', '', 'It typed the letter.')))
      .toEqual([])
  })

  it('ignores a PR number that is not on a Backfills line', () => {
    // Changeset bodies reference issues and PRs in prose all the time. Treating those as
    // coverage claims would silently clear merges nobody wrote a release note for.
    expect(parseBackfills(body('Follows up on #413 and closes #99.'))).toEqual([])
    expect(parseBackfills(body('See the discussion in #413 for why.'))).toEqual([])
  })

  it('requires the keyword to open the line, not appear inside a sentence', () => {
    // Strict on purpose: "this also backfills: #413" is prose, and reading it as a coverage
    // claim would clear a merge on the strength of a passing mention.
    expect(parseBackfills(body('This one also backfills: #413 as a side effect'))).toEqual([])
    expect(parseBackfills(body('Nothing to do with backfills here (#413)'))).toEqual([])
  })

  it('allows prose after the references on the same line', () => {
    expect(parseBackfills(body('Backfills: #413 — the shortcuts never worked before it'))).toEqual([413])
  })

  it('reads full hashes in the list but ignores references in the explanation', () => {
    const sha = '1234567890abcdef'.repeat(2) + '12345678'
    expect(parseBackfills(body(`Backfills: #202 — compare with ${sha} and #413`))).toEqual([202])
    expect(parseBackfills(body(`Backfills: ${sha.toUpperCase()}, and #202`))).toEqual([sha, 202])
  })

  it.each([
    ['a shorter fence nested inside a longer one', '````md', '```md', 'Backfills: #413', '```', '````', 'Backfills: #414'],
    ['a closing fence with an info string', '```md', '``` not-a-close', 'Backfills: #413', '```', 'Backfills: #414'],
  ])('ignores a reference inside %s and resumes after it', (_name, ...lines) => {
    expect(parseBackfills(body(...lines))).toEqual([414])
  })

  it('reads an unindented reference between four-space-indented fence-like lines', () => {
    expect(parseBackfills(body('    ```md', 'Backfills: #413', '    ```'))).toEqual([413])
  })
})
