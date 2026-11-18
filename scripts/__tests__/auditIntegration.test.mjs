// The parsers are unit-tested next door. This drives the actual CLI against a throwaway git
// repository, because the part that broke twice was the wiring, not the parsing: reading
// changesets at a merge that had already deleted them, and counting only ADDED ones so a PR that
// amended an existing entry was reported as a gap.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-changeset.mjs')

let repo
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

/** Commit `files` on a branch and merge it with a GitHub-shaped merge subject. */
function mergePr(number, branch, files) {
  git('checkout', '-q', '-b', branch)
  for (const [path, body] of Object.entries(files)) {
    if (body === null) {
      rmSync(join(repo, path))
      continue
    }
    mkdirSync(join(repo, dirname(path)), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  git('add', '-A')
  git('commit', '-q', '-m', `work for #${number}`)
  git('checkout', '-q', 'main')
  git('merge', '--no-ff', '-q', branch, '-m', `Merge pull request #${number} from me/${branch}`)
}

/**
 * Runs the audit; returns {code, out, stdout, stderr} rather than throwing, since a gap exits 1.
 * `out` is both streams joined — most assertions only care that a number was mentioned.
 */
function audit(since = 'v0') {
  const opts = { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  try {
    const stdout = execFileSync('node', [SCRIPT, '--audit', since], opts)
    return { code: 0, stdout, stderr: '', out: stdout }
  } catch (e) {
    const stdout = e.stdout ?? '', stderr = e.stderr ?? ''
    return { code: e.status, stdout, stderr, out: stdout + stderr }
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tapflow-audit-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 'T')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(repo, '.changeset'), { recursive: true })
  writeFileSync(join(repo, '.changeset', 'README.md'), 'changesets')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('tag', 'v0')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

const CHANGESET = (body) => `---\n"@tapflowio/relay": patch\n---\n\n${body}\n`

/**
 * Runs the **PR gate** — the same script with no `--audit` — against a base ref in the throwaway repo.
 *
 * The audit is what this file was built for, and the gate had no integration coverage at all: its
 * branches are unit-tested as pure functions and nothing drove the wiring. That is the half this file's
 * own header says broke twice.
 */
function gate(base = 'main') {
  const opts = { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PR_BODY: '' } }
  try {
    const stdout = execFileSync('node', [SCRIPT, base], opts)
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

/** Commit `files` on a branch off main and leave HEAD there — the shape the gate sees on a PR. */
function branchWith(files) {
  git('checkout', '-q', '-b', 'feature')
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'work')
}

const SHIPPED = 'packages/relay/src/thing.ts'
const ROOT_CHANGELOG = 'CHANGELOG.md'
const rootNote = (note) => `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- ${note}\n`

describe('the PR gate asks for a root CHANGELOG entry', () => {
  // The root CHANGELOG is hand-written and had nothing enforcing it, so it went four days and 22
  // merged PRs stale while every one of those PRs carried a changeset. The rule was in CONTRIBUTING
  // and the enforcement was in neither place.
  it('fails a changeset that leaves the root CHANGELOG untouched', () => {
    branchWith({ [SHIPPED]: 'export const a = 1\n', '.changeset/x.md': CHANGESET('a fix') })
    const r = gate()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no entry in the root CHANGELOG/i)
    expect(r.out).toContain('.changeset/x.md')
  })

  it('passes when the branch also writes the entry', () => {
    branchWith({
      [SHIPPED]: 'export const a = 1\n',
      '.changeset/x.md': CHANGESET('a fix'),
      'CHANGELOG.md': '## [Unreleased]\n\n### Fixed\n\n- a fix\n',
    })
    expect(gate().code).toBe(0)
  })

  // Not every changeset earns an entry — half a typing cycle is invisible to a user, and forcing a line
  // for each would fill the file with noise nobody can act on. Opting out is a written decision.
  it('passes when the changeset says it is internal', () => {
    branchWith({
      [SHIPPED]: 'export const a = 1\n',
      '.changeset/x.md': `${CHANGESET('typing only')}\n<!-- changelog: internal — no observable behaviour -->\n`,
    })
    expect(gate().code).toBe(0)
  })

  // **Not an ordering claim, and a first draft said it was.** There is no gate "ahead of" this one — the
  // changelog block runs *before* the missing-changeset error, and this passes because a branch with no
  // changeset has nothing to owe an entry for. Stating the wrong mechanism is worse than stating none: it
  // reads as covering an ordering that a later edit could break silently. The assertion that matters is
  // that this branch prints the *changeset* instruction and not the changelog one, since a contributor
  // told to write a CHANGELOG entry when what they are missing is a changeset goes to the wrong file.
  it('tells a branch with no changeset to add one, not to write a changelog entry', () => {
    branchWith({ [SHIPPED]: 'export const a = 1\n' })
    const r = gate()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/adds no changeset/i)
    expect(r.out).not.toMatch(/no entry in the root CHANGELOG/i)
  })

  // Deleting the file is not writing in it. `changed` comes from a bare `--name-only`, which lists a
  // deletion like any other path, so the first draft of the demand was satisfied by removing the file.
  it('does not accept deleting the CHANGELOG as writing an entry', () => {
    writeFileSync(join(repo, 'CHANGELOG.md'), '## [Unreleased]\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'a changelog to delete')
    git('checkout', '-q', '-b', 'feature')
    mkdirSync(join(repo, dirname(SHIPPED)), { recursive: true })
    writeFileSync(join(repo, SHIPPED), 'export const a = 1\n')
    writeFileSync(join(repo, '.changeset', 'x.md'), CHANGESET('a fix'))
    rmSync(join(repo, 'CHANGELOG.md'))
    git('add', '-A')
    git('commit', '-q', '-m', 'work')
    const r = gate()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no entry in the root CHANGELOG/i)
  })

  // The mirror of the amended case: satisfying the demand must actually pass. Widening the demand to
  // `AMR` while the success path still counted only `added` made this a false failure.
  it('passes an amended changeset that does write its entry', () => {
    writeFileSync(join(repo, '.changeset', 'existing.md'), CHANGESET('first pass'))
    git('add', '-A')
    git('commit', '-q', '-m', 'earlier changeset')
    branchWith({
      [SHIPPED]: 'export const a = 1\n',
      '.changeset/existing.md': CHANGESET('first pass, now also this'),
      'CHANGELOG.md': '## [Unreleased]\n\n### Fixed\n\n- also this\n',
    })
    expect(gate().code).toBe(0)
  })

  // The amended and renamed cases, which keying on `--diff-filter=A` let through. A follow-up that
  // extends an existing unconsumed changeset with new behaviour is the ordinary shape of a second PR on
  // one subject, and it was invisible.
  it('demands an entry for an amended changeset, not only a new one', () => {
    writeFileSync(join(repo, '.changeset', 'existing.md'), CHANGESET('first pass'))
    git('add', '-A')
    git('commit', '-q', '-m', 'earlier changeset')
    branchWith({ [SHIPPED]: 'export const a = 1\n', '.changeset/existing.md': CHANGESET('first pass, now also this') })
    const r = gate()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no entry in the root CHANGELOG/i)
  })
})

describe('audit --audit against real git history', () => {
  it('reports the merge missing the root changelog even when it has a changeset and a package changelog', () => {
    mergePr(101, 'fix-a', {
      [SHIPPED]: 'export const a = 1\n',
      '.changeset/fix-a.md': CHANGESET('Fixes a.'),
      'packages/relay/CHANGELOG.md': rootNote('Fixes a.'),
    })
    const { code, stdout, stderr } = audit()
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/1 merge\(s\).*no entry in the root CHANGELOG.md/)
    expect(stderr).toContain('Merge pull request #101 ')
    expect(stderr).not.toContain('no changeset:')
  })

  it('exempts internal changesets without hiding a public changeset in a mixed merge', () => {
    const internal = CHANGESET('Protocol typing.\n\n<!-- changelog: internal — no observable behaviour -->')
    mergePr(101, 'internal', { [SHIPPED]: 'export const a = 1\n', '.changeset/internal.md': internal })
    expect(audit().code).toBe(0)

    mergePr(102, 'mixed', {
      [SHIPPED]: 'export const a = 2\n',
      '.changeset/internal-two.md': internal,
      '.changeset/public.md': CHANGESET('Fixes a.'),
    })
    const { code, stderr } = audit()
    expect(code).toBe(1)
    expect(stderr).toContain('no entry in the root CHANGELOG.md')
    expect(stderr).toContain('Merge pull request #102 ')
    expect(stderr).not.toContain('Merge pull request #101 ')
  })

  it('does not clear a root gap until a later backfill names the PR and writes the root changelog', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    mergePr(102, 'claim-without-note', { '.changeset/late.md': CHANGESET('Fixes a.\n\nBackfills: #101') })
    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('Merge pull request #101 ') })

    mergePr(103, 'note-without-claim', { [ROOT_CHANGELOG]: rootNote('An unrelated note.') })
    expect(audit().code).toBe(1)

    mergePr(104, 'root-backfill', {
      [ROOT_CHANGELOG]: rootNote('Fixes a.\n- An unrelated note.'),
      '.changeset/root-backfill.md': CHANGESET('Fixes a.\n\nBackfills: #101'),
    })
    expect(audit().code).toBe(0)
  })

  it('does not let a root backfill pre-clear a later merge', () => {
    mergePr(102, 'early-root-note', {
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
      '.changeset/early.md': CHANGESET('Fixes a.\n\nBackfills: #101'),
    })
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('Merge pull request #101 ') })
  })

  it.each(['amended', 'renamed'])('does not give a predated claim a new date when its changeset is %s', (operation) => {
    const claim = CHANGESET('Fixes a.\n\nBackfills: #101')
    mergePr(102, 'early-root-note', {
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
      '.changeset/early.md': claim,
    })
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    const change = operation === 'renamed'
      ? { '.changeset/early.md': null, '.changeset/renamed.md': claim }
      : { '.changeset/early.md': claim + '\nClarify the package note.\n' }
    mergePr(103, 'unrelated-root-note', { ...change, [ROOT_CHANGELOG]: rootNote('Unrelated fix.') })

    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('Merge pull request #101 ') })
  })

  it('accepts an explicit internal backfill without a root note', () => {
    mergePr(101, 'typing', { [SHIPPED]: 'export const a = 1\n' })
    const internal = CHANGESET('Typing only.\n\n<!-- changelog: internal -->\n\nBackfills: #101')
    mergePr(102, 'internal-backfill', { '.changeset/internal.md': internal })
    expect(audit().code).toBe(0)
  })

  it('keeps the internal exemption when a backfill changeset is renamed', () => {
    mergePr(101, 'typing', { [SHIPPED]: 'export const a = 1\n' })
    const internal = CHANGESET('Typing only.\n\n<!-- changelog: internal -->\n\nBackfills: #101')
    mergePr(102, 'internal-backfill', { '.changeset/old.md': internal })
    expect(audit().code).toBe(0)
    mergePr(103, 'rename-backfill', { '.changeset/old.md': null, '.changeset/new.md': internal })
    expect(audit().code).toBe(0)
  })

  it('keeps a root gap when backfills for the same PR include a public changeset', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    mergePr(102, 'mixed-backfill', {
      '.changeset/internal.md': CHANGESET('Typing only.\n\n<!-- changelog: internal -->\n\nBackfills: #101'),
      '.changeset/public.md': CHANGESET('Fixes a.\n\nBackfills: #101'),
    })
    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('no entry in the root CHANGELOG.md') })
  })

  it('reports a missing root entry on a bot merge without requiring a changeset', () => {
    mergePr(104, 'dependabot/npm/foo', { 'packages/relay/package.json': '{"version":"1.0.0","dependencies":{"foo":"2.0.0"}}\n' })
    const { code, stderr } = audit()
    expect(code).toBe(1)
    expect(stderr).toContain('no entry in the root CHANGELOG.md')
    expect(stderr).toContain('Merge pull request #104 ')
    expect(stderr).not.toContain('no changeset:')
  })

  it('reports a merge that shipped code without a changeset', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', [ROOT_CHANGELOG]: rootNote('Fixes a.') })
    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('#101')
    expect(out).toContain('no changeset:')
    expect(out).not.toContain('no entry in the root CHANGELOG.md')
  })

  it('stays quiet when the same merge carries its changeset and root note', () => {
    mergePr(101, 'fix-a', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/fix-a.md': CHANGESET('Fixes a.'),
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    expect(audit().code).toBe(0)
  })

  it('does not treat deletion of the root changelog as a note', () => {
    mergePr(100, 'initial-changelog', { [ROOT_CHANGELOG]: rootNote('Previous note.') })
    mergePr(101, 'fix-and-delete', {
      [SHIPPED]: 'export const a = 1\n',
      '.changeset/a.md': CHANGESET('Fixes a.'),
      [ROOT_CHANGELOG]: null,
    })
    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('Merge pull request #101 ') })
  })

  // The reason this feature exists. Without it the gap is reported for the whole release cycle,
  // and confirming it is a false alarm means matching changesets to merges by hand every run.
  it('clears an earlier merge when a later changeset declares it backfills it', () => {
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    mergePr(102, 'backfill', {
      '.changeset/late.md': CHANGESET('Fixes a.\n\nBackfills: #101'),
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    const { code, out } = audit()
    expect(code).toBe(0)
    expect(out).toContain('No changeset or root CHANGELOG.md gaps found.')
  })

  it('honours a changeset-only backfill for the original changeset gap', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    mergePr(102, 'package-backfill', { '.changeset/late.md': CHANGESET('Fixes a.\n\nBackfills: #101') })
    const { code, stderr } = audit()
    expect(code).toBe(1)
    expect(stderr).toContain('no entry in the root CHANGELOG.md')
    expect(stderr).not.toContain('no changeset:')
  })

  it('does not clear a merge the backfill did not name', () => {
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    mergePr(103, 'fix-b', { 'packages/relay/src/b.ts': 'export const b = 1\n' })
    mergePr(102, 'backfill', {
      '.changeset/late.md': CHANGESET('Fixes a.\n\nBackfills: #101'),
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('#103')
    expect(out).not.toContain('#101')
  })

  // A PR that extends an existing entry is still writing release notes. Counting only ADDED
  // changesets reported #420 as a gap when it had amended the clipboard entry.
  it('accepts an amended changeset, not just a new one', () => {
    mergePr(101, 'first', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/entry.md': CHANGESET('Fixes a.'),
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    mergePr(102, 'follow-up', {
      'packages/relay/src/a.ts': 'export const a = 2\n',
      '.changeset/entry.md': CHANGESET('Fixes a, and b as well.'),
      [ROOT_CHANGELOG]: rootNote('Fixes a and b.'),
    })
    expect(audit().code).toBe(0)
  })

  // `changeset version` consumes changesets and bumps every package.json. Reading them at that
  // merge fails outright — they no longer exist there.
  it('does not choke on the release merge, which deletes changesets', () => {
    mergePr(101, 'fix-a', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/entry.md': CHANGESET('Fixes a.'),
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    git('checkout', '-q', '-b', 'release')
    rmSync(join(repo, '.changeset', 'entry.md'))
    writeFileSync(join(repo, 'packages/relay/package.json'), '{"version":"0.2.0"}\n')
    writeFileSync(join(repo, 'packages/relay/CHANGELOG.md'), '## 0.2.0\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'release')
    git('checkout', '-q', 'main')
    git('merge', '--no-ff', '-q', 'release', '-m', 'Merge pull request #199 from me/release')

    const { code, out } = audit()
    expect(code).toBe(0)
    expect(out).not.toMatch(/fatal|does not exist/)
  })

  // Removing a shipped file is the highest-consequence change there is. Narrowing the file list
  // to added/changed dropped deletions from the check, and every test still passed.
  it('reports a merge that DELETES published source without a changeset', () => {
    mergePr(101, 'add-b', {
      'packages/relay/src/b.ts': 'export const b = 1\n',
      '.changeset/add-b.md': CHANGESET('Adds b.'),
    })
    git('checkout', '-q', '-b', 'rip')
    rmSync(join(repo, 'packages/relay/src/b.ts'))
    git('add', '-A')
    git('commit', '-q', '-m', 'remove b')
    git('checkout', '-q', 'main')
    git('merge', '--no-ff', '-q', 'rip', '-m', 'Merge pull request #201 from me/rip')

    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('no changeset:')
    expect(out).toContain('#201')
  })

  // The marker switches a gate off, and every doc in this repo prints it verbatim. A changeset
  // that documents the convention must not clear whatever number the example names.
  it('ignores a backfill claim quoted inside a code fence', () => {
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    mergePr(102, 'docs', {
      '.changeset/late.md': CHANGESET('Explains the rule:\n\n```\nBackfills: #101\n```\n'),
    })
    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('no changeset:')
    expect(out).toContain('#101')
  })

  // A claim can only speak for what already happened.
  it('does not let a claim pre-clear a merge that lands after it', () => {
    mergePr(102, 'early-claim', { '.changeset/early.md': CHANGESET('Later.\n\nBackfills: #101') })
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('no changeset:')
    expect(out).toContain('#101')
  })

  // Claim it, then think better of it: nothing reaches the changelog, so the gap is real again.
  it('stops honouring a claim whose changeset was dropped afterwards', () => {
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    mergePr(102, 'backfill', { '.changeset/late.md': CHANGESET('Fixes a.\n\nBackfills: #101') })
    git('checkout', '-q', '-b', 'undo')
    rmSync(join(repo, '.changeset', 'late.md'))
    git('add', '-A')
    git('commit', '-q', '-m', 'drop it')
    git('checkout', '-q', 'main')
    git('merge', '--no-ff', '-q', 'undo', '-m', 'Merge pull request #103 from me/undo')

    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('no changeset:')
    expect(out).toContain('#101')
  })

  it('counts a renamed changeset, which is still a changeset', () => {
    mergePr(101, 'first', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/old-name.md': CHANGESET('Fixes a.'),
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    git('checkout', '-q', '-b', 'rename')
    git('mv', '.changeset/old-name.md', '.changeset/new-name.md')
    writeFileSync(join(repo, 'packages/relay/src/a.ts'), 'export const a = 2\n')
    writeFileSync(join(repo, ROOT_CHANGELOG), rootNote('Fixes a again.'))
    git('add', '-A')
    git('commit', '-q', '-m', 'rename and edit')
    git('checkout', '-q', 'main')
    git('merge', '--no-ff', '-q', 'rename', '-m', 'Merge pull request #102 from me/rename')

    expect(audit().code).toBe(0)
  })

  // stdout carries the verdict, stderr the diagnosis, so `2>/dev/null` leaves a caller with the
  // answer and nothing else. One line of the guidance block stayed on stdout and broke that.
  it('keeps stdout empty when there are gaps, and puts the whole report on stderr', () => {
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    const { code, stdout, stderr } = audit()
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('#101')
    expect(stderr).toContain('Backfills:')          // the guidance block travels with it
  })

  it('puts only the verdict on stdout when there is nothing to report', () => {
    mergePr(101, 'fix-a', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/fix-a.md': CHANGESET('Fixes a.'),
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    const { code, stdout } = audit()
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('No changeset or root CHANGELOG.md gaps found.')
  })

  it('accepts a bot merge that writes a root note without a changeset', () => {
    mergePr(104, 'dependabot/npm/foo', {
      'packages/relay/package.json': '{"dependencies":{"foo":"2.0.0"}}\n',
      [ROOT_CHANGELOG]: rootNote('Updates foo.'),
    })
    expect(audit().code).toBe(0)
  })

  // Three shapes the audit reported as gaps during the v0.18.0 release, none of them real. Each
  // was diagnosed by hand there; these are what stop the next release paying for it again.

  it('ignores main being merged back into a feature branch', () => {
    // Not a PR landing — someone refreshing their branch. It rides onto main inside their PR, and
    // diffed against its first parent it shows everything main did since the fork, all of which
    // already had changesets. One such commit reported 32 files.
    // The branch has to fork BEFORE main moves, or the back-merge carries nothing and the test
    // passes with or without the fix — measured, that is exactly what a first attempt did.
    git('checkout', '-q', '-b', 'long-running')
    writeFileSync(join(repo, 'README.md'), 'notes\n')
    git('add', '-A'); git('commit', '-q', '-m', 'docs while main moved on')
    git('checkout', '-q', 'main')

    mergePr(201, 'shipped', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/a.md': CHANGESET('Ships a.'),
      [ROOT_CHANGELOG]: rootNote('Ships a.'),
    })
    // …and released, so the changeset that covered it is gone by the time the back-merge happens.
    // That is the real shape: the back-merge carries the source without the note.
    git('rm', '-q', '.changeset/a.md')
    writeFileSync(join(repo, 'packages/relay/CHANGELOG.md'), '# relay\n\n## 0.2.0\n')
    git('add', '-A'); git('commit', '-q', '-m', 'chore: release v0.2.0')

    git('checkout', '-q', 'long-running')
    git('merge', '--no-ff', '-q', 'main', '-m', "Merge remote-tracking branch 'origin/main' into long-running")
    git('checkout', '-q', 'main')
    git('merge', '--no-ff', '-q', 'long-running', '-m', 'Merge pull request #202 from me/long-running')

    expect(audit().code).toBe(0)
  })

  it('ignores a merge that only touched a private package', () => {
    // A test-only helper nobody installs. The PR gate got this right and the audit did not, which
    // is how one repository came to hold two answers about the same commit.
    mergePr(203, 'helpers', {
      'packages/test-utils/package.json': '{"name":"@tapflowio/test-utils","private":true}\n',
      'packages/test-utils/src/socket.ts': 'export const wait = () => {}\n',
    })
    expect(audit().code).toBe(0)
  })

  it('still reports a new published package, which has no manifest to judge it by yet', () => {
    // The direction that must not be traded away for the two above: a package appearing for the
    // first time is the case that most needs a release note.
    mergePr(204, 'new-pkg', {
      'packages/flow-capture/package.json': '{"name":"@tapflowio/flow-capture"}\n',
      'packages/flow-capture/src/index.ts': 'export const capture = () => {}\n',
    })
    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('no changeset:')
    expect(out).toContain('#204')
  })
})
