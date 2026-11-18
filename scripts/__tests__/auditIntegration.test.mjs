// The parsers are unit-tested next door. This drives the actual CLI against a throwaway git
// repository, because the part that broke twice was the wiring, not the parsing: reading
// changesets at a merge that had already deleted them, and counting only ADDED ones so a PR that
// amended an existing entry was reported as a gap.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

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
  const subject = number === null ? `Merge branch '${branch}'` : `Merge pull request #${number} from me/${branch}`
  git('merge', '--no-ff', '-q', branch, '-m', subject)
}

/**
 * Runs the audit; returns {code, out, stdout, stderr} rather than throwing, since a gap exits 1.
 * `out` is both streams joined — most assertions only care that a number was mentioned.
 */
function audit(since = 'v0', cwd = repo) {
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  try {
    const args = since === null ? [SCRIPT, '--audit'] : [SCRIPT, '--audit', since]
    const stdout = execFileSync('node', args, opts)
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
  it('rejects a shallow first-parent walk even when the requested tag is present', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    const shallow = join(repo, 'shallow')
    git('clone', '-q', '--depth=1', '--branch', 'main', pathToFileURL(repo).href, shallow)
    git('-C', shallow, 'fetch', '-q', '--depth=1', 'origin', 'tag', 'v0')
    expect(git('-C', shallow, 'rev-parse', 'v0')).toBe(git('rev-parse', 'v0'))
    const result = audit('v0', shallow)
    expect(result).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('fetch-depth: 0') })
  })

  it('accepts a shallow checkout when the first-parent history reaches the tag', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    const shallow = join(repo, 'shallow')
    git('clone', '-q', '--depth=2', '--branch', 'main', pathToFileURL(repo).href, shallow)
    expect(git('-C', shallow, 'rev-parse', '--is-shallow-repository')).toBe('true')
    expect(audit('v0', shallow)).toMatchObject({ code: 1, stderr: expect.stringContaining('Merge pull request #101 ') })
  })

  it('rejects a base reached only through the second parent of a merge', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    const base = git('rev-parse', 'HEAD^2')
    expect(audit(base)).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('first-parent') })
  })

  it('accepts an empty range when the base is HEAD', () => {
    expect(audit('HEAD')).toMatchObject({ code: 0 })
  })

  it('selects the latest first-parent tag when no base is supplied', () => {
    git('commit', '--allow-empty', '-qm', 'Prepare next release')
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    git('tag', 'side-tag', 'HEAD^2')
    const result = audit(null)
    expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('Merges since v0: 1') })
    expect(result.stderr).toContain('Merge pull request #101 ')
  })

  it('accepts the full merge hash as a backfill for a merge without a PR number', () => {
    mergePr(null, 'local-fix', { [SHIPPED]: 'export const a = 1\n' })
    const sha = git('rev-parse', 'HEAD')
    const before = audit()
    expect(before.code).toBe(1)
    expect(before.stderr).toContain('no changeset:')
    expect(before.stderr).toContain('no entry in the root CHANGELOG.md')
    mergePr(102, 'backfill', { [ROOT_CHANGELOG]: rootNote('Fixes a.'), '.changeset/a.md': CHANGESET(`Fixes a.\n\nBackfills: ${sha}`) })
    expect(audit().code).toBe(0)
    expect(before.stderr).toContain(`Backfills: ${sha}`)
  })

  it('clears both gaps when a backfill uses the full hash of a numbered merge', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    const sha = git('rev-parse', 'HEAD')
    mergePr(102, 'backfill', {
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
      '.changeset/a.md': CHANGESET(`Fixes a.\n\nBackfills: ${sha}`),
    })
    expect(audit()).toMatchObject({ code: 0 })
  })

  it('credits only the referenced hash when two merge commits use the same PR number', () => {
    mergePr(101, 'first-fix', { [SHIPPED]: 'export const a = 1\n' })
    mergePr(101, 'second-fix', { [SHIPPED]: 'export const a = 2\n' })
    const sha = git('rev-parse', 'HEAD')
    mergePr(102, 'backfill', {
      [ROOT_CHANGELOG]: rootNote('Fixes the second merge.'),
      '.changeset/a.md': CHANGESET(`Fixes the second merge.\n\nBackfills: ${sha}`),
    })
    const result = audit()
    expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('no changeset:\n\n    Merge pull request #101 from me/first-fix') })
    expect(result.stderr).toContain('no entry in the root CHANGELOG.md:\n\n    Merge pull request #101 from me/first-fix')
    expect(result.stderr).not.toContain('from me/second-fix')
  })

  it('classifies a published path that Git would otherwise quote', () => {
    git('config', 'core.quotePath', 'true')
    const path = 'packages/relay/src/café.ts'
    mergePr(101, 'accented-path', { [path]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining(path) })
  })

  it.skipIf(process.platform === 'win32')('prints a shipped filename containing a newline on one diagnostic line', () => {
    const path = 'packages/relay/src/first\nsecond.ts'
    mergePr(101, 'newline-path', { [path]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    expect(audit()).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("      'packages/relay/src/first\\nsecond.ts'\n"),
    })
  })

  it('reports both gaps when a published file moves outside the published tree', () => {
    const source = 'export const a = 1\n'
    mergePr(101, 'add-a', { [SHIPPED]: source, [ROOT_CHANGELOG]: rootNote('Adds a.'), '.changeset/a.md': CHANGESET('Adds a.') })
    const destination = 'notes/thing.ts'
    mergePr(102, 'move-a', { [SHIPPED]: null, [destination]: source })
    expect(git('diff', '--name-status', '--find-renames', 'HEAD^1', 'HEAD')).toContain(`R100\t${SHIPPED}\t${destination}`)
    const { code, stderr } = audit()
    expect(code).toBe(1)
    expect(stderr).toContain(`no changeset:\n\n    Merge pull request #102 from me/move-a\n      ${SHIPPED}`)
    expect(stderr).toContain(`no entry in the root CHANGELOG.md:\n\n    Merge pull request #102 from me/move-a\n      ${SHIPPED}`)
  })

  it('reports a root gap when a source merge deletes a changelog and a changeset', () => {
    const changelog = 'packages/relay/CHANGELOG.md'
    mergePr(100, 'old-notes', { [changelog]: rootNote('Earlier fix.'), '.changeset/old.md': CHANGESET('Earlier fix.') })
    mergePr(101, 'remove-old-notes', { [SHIPPED]: 'export const a = 1\n', [changelog]: null, '.changeset/old.md': null })
    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('no entry in the root CHANGELOG.md') })
  })

  it('counts a new root changelog entry when Git records the file as renamed', () => {
    const draft = 'notes/release.md'
    const previous = rootNote('Earlier fix.\n' + '- Archived item.\n'.repeat(12))
    mergePr(100, 'draft-changelog', { [draft]: previous })
    mergePr(101, 'publish-changelog', {
      [draft]: null,
      [ROOT_CHANGELOG]: previous + '- Fixes a.\n',
      [SHIPPED]: 'export const a = 1\n',
      '.changeset/a.md': CHANGESET('Fixes a.'),
    })
    expect(git('diff', '--name-status', '--find-renames', 'HEAD^1', 'HEAD')).toMatch(/R\d+\tnotes\/release\.md\tCHANGELOG\.md/)
    expect(audit().code).toBe(0)
  })

  it('reports a source merge that updates a package changelog while dropping an obsolete changeset', () => {
    mergePr(100, 'old-notes', {
      'packages/relay/package.json': '{"version":"0.2.0"}\n',
      'packages/relay/CHANGELOG.md': '## 0.2.0\n\nEarlier fix.\n',
      [ROOT_CHANGELOG]: rootNote('Earlier fix.'),
      '.changeset/old.md': CHANGESET('Earlier fix.'),
    })
    mergePr(101, 'source-and-cleanup', {
      [SHIPPED]: 'export const a = 1\n',
      'packages/relay/CHANGELOG.md': '## 0.2.0\n\nCorrected release notes.\n',
      '.changeset/old.md': null,
    })
    const { code, stderr } = audit()
    expect(code).toBe(1)
    expect(stderr).toContain('no changeset:\n\n    Merge pull request #101 ')
    expect(stderr).toContain('no entry in the root CHANGELOG.md:\n\n    Merge pull request #101 ')
  })

  it('recognizes a backfill when a draft first enters the changeset directory', () => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    const claim = CHANGESET('Fixes a.\n\nBackfills: #101')
    mergePr(102, 'draft', { 'notes/late.md': claim })
    mergePr(103, 'publish-note', { 'notes/late.md': null, '.changeset/late.md': claim, [ROOT_CHANGELOG]: rootNote('Fixes a.') })
    expect(git('diff', '--name-status', '--find-renames', 'HEAD^1', 'HEAD')).toContain('R100\tnotes/late.md\t.changeset/late.md')
    expect(audit().code).toBe(0)
  })

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

  it.each(['PR number', 'full hash'])('keeps the root gap for an existing reference restated by %s', (format) => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    const ref = format === 'full hash' ? git('rev-parse', 'HEAD') : '#101'
    mergePr(102, 'claim-without-note', { '.changeset/late.md': CHANGESET('Fixes a.\n\nBackfills: #101') })

    mergePr(103, 'note-with-existing-claim', {
      [ROOT_CHANGELOG]: rootNote('An unrelated note.'),
      '.changeset/late.md': CHANGESET(`Clarifies the earlier fix.\n\nBackfills: ${ref}`),
    })
    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('Merge pull request #101 ') })

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

  it.each(['amended', 'renamed', 'rewritten and renamed'])('does not give a predated claim a new date when its changeset is %s', (operation) => {
    const claim = CHANGESET('Original package note.\n'.repeat(20) + '\nBackfills: #101')
    mergePr(102, 'early-root-note', {
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
      '.changeset/early.md': claim,
    })
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    const rewritten = CHANGESET('Replacement prose about the updated behavior.\n'.repeat(20) + '\nBackfills: #101')
    const change = operation === 'amended'
      ? { '.changeset/early.md': claim + '\nClarify the package note.\n' }
      : { '.changeset/early.md': null, '.changeset/renamed.md': operation === 'renamed' ? claim : rewritten }
    mergePr(103, 'unrelated-root-note', { ...change, [ROOT_CHANGELOG]: rootNote('Unrelated fix.') })

    if (operation === 'rewritten and renamed') {
      const diff = git('diff', '--name-status', '--find-renames', 'HEAD^1', 'HEAD', '--', '.changeset').split('\n')
      expect(diff).toEqual(expect.arrayContaining(['D\t.changeset/early.md', 'A\t.changeset/renamed.md']))
    }

    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('Merge pull request #101 ') })
  })

  it('accepts a new reference while another changeset is deleted', () => {
    mergePr(100, 'old-note', { '.changeset/old.md': CHANGESET('Backfills: #100') })
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fixes a.') })
    mergePr(102, 'backfill', {
      '.changeset/old.md': null,
      '.changeset/new.md': CHANGESET('Fixes a.\n\nBackfills: #101'),
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    expect(audit().code).toBe(0)
  })

  it('accepts a new internal exemption while deleting a public backfill for the same merge', () => {
    mergePr(101, 'typing', { [SHIPPED]: 'export const a = 1\n' })
    mergePr(102, 'public-backfill', {
      '.changeset/public.md': CHANGESET('Public note pending more details.\n'.repeat(12) + '\nBackfills: #101'),
    })
    expect(audit()).toMatchObject({ code: 1, stderr: expect.stringContaining('no entry in the root CHANGELOG.md') })
    mergePr(103, 'internal-backfill', {
      '.changeset/public.md': null,
      '.changeset/internal.md': CHANGESET('Only a type was affected.\n\n<!-- changelog: internal -->\n\nBackfills: #101'),
    })
    const diff = git('diff', '--name-status', '--find-renames', 'HEAD^1', 'HEAD', '--', '.changeset').split('\n')
    expect(diff).toEqual(expect.arrayContaining(['D\t.changeset/public.md', 'A\t.changeset/internal.md']))
    expect(audit().code).toBe(0)
  })

  it.each(['amended', 'renamed'])('accepts a new internal exemption when a public backfill is %s', (operation) => {
    mergePr(101, 'typing', { [SHIPPED]: 'export const a = 1\n' })
    const path = '.changeset/public.md'
    const claim = CHANGESET('Only a type was affected.\n'.repeat(12) + '\nBackfills: #101')
    mergePr(102, 'public-backfill', { [path]: claim })
    const internal = claim + '\n<!-- changelog: internal -->\n'
    const changes = operation === 'amended' ? { [path]: internal } : { [path]: null, '.changeset/internal.md': internal }
    mergePr(103, 'internal-backfill', changes)
    const diff = git('diff', '--name-status', '--find-renames', 'HEAD^1', 'HEAD')
    expect(diff).toMatch(operation === 'amended' ? /^M\t/ : /^R\d+\t/)
    expect(audit().code).toBe(0)
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

  it.each(['PR number', 'full hash'])('keeps a root gap when a public backfill uses the %s beside an internal backfill', (format) => {
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    const ref = format === 'full hash' ? git('rev-parse', 'HEAD') : '#101'
    mergePr(102, 'mixed-backfill', {
      '.changeset/internal.md': CHANGESET('Typing only.\n\n<!-- changelog: internal -->\n\nBackfills: #101'),
      '.changeset/public.md': CHANGESET(`Fixes a.\n\nBackfills: ${ref}`),
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
      'packages/relay/package.json': '{"version":"0.1.0"}\n',
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

  it('keeps a package gap when a predated claim receives a prose-only edit', () => {
    const path = '.changeset/early.md'
    const claim = CHANGESET('Fixes a.\n\nBackfills: #101')
    mergePr(100, 'early-claim', { [path]: claim })
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', [ROOT_CHANGELOG]: rootNote('Fixes a.') })
    mergePr(102, 'edit-claim', { [path]: claim + '\nMore context.\n' })
    expect(audit()).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no changeset:\n\n    Merge pull request #101 '),
    })
  })

  it.each(['unchanged', 'edited', 'separately authored'])('dates a %s backfill when the old path is reused', (kind) => {
    const path = '.changeset/early.md'
    const moved = '.changeset/renamed.md'
    const claim = CHANGESET('Early reference.\n'.repeat(12) + '\nBackfills: #101')
    mergePr(100, 'early-claim', { [path]: claim })
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    const fresh = kind === 'separately authored'
    const note = fresh
      ? CHANGESET('A new note about the shipped fix.\n'.repeat(12) + '\nBackfills: #101')
      : kind === 'edited' ? claim.replace('Early reference.', 'Clarified reference.') : claim
    mergePr(102, 'move-and-reuse', {
      [path]: CHANGESET('Unrelated package release note.\n'.repeat(12)),
      [moved]: note,
      [ROOT_CHANGELOG]: rootNote(fresh ? 'Fixes a.' : 'Unrelated note.'),
    })
    const entries = git('diff', '--name-status', '--find-renames', 'HEAD^1', 'HEAD', '--', '.changeset').split('\n')
    expect(entries).toEqual(expect.arrayContaining([`M\t${path}`, `A\t${moved}`]))
    if (fresh) {
      expect(audit()).toMatchObject({ code: 0 })
    } else {
      const result = audit()
      expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('no changeset:\n\n    Merge pull request #101 ') })
      expect(result.stderr).toContain('no entry in the root CHANGELOG.md:\n\n    Merge pull request #101 ')
    }
  })

  it('keeps an exact predecessor when Git points to a different source that kept the reference', () => {
    const kept = '.changeset/a.md'
    const replaced = '.changeset/z.md'
    const moved = '.changeset/new.md'
    const claim = CHANGESET('Early reference.\n'.repeat(12) + '\nBackfills: #101')
    mergePr(100, 'early-claims', { [kept]: claim, [replaced]: claim })
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    mergePr(102, 'move-and-reuse', {
      [kept]: claim + '\nClarify the old note.\n',
      [replaced]: CHANGESET('Unrelated release note.'),
      [moved]: claim,
      [ROOT_CHANGELOG]: rootNote('Unrelated note.'),
    })
    const copies = git('diff', '--name-status', '--find-copies', '--diff-filter=C', 'HEAD^1', 'HEAD', '--', '.changeset')
    expect(copies).toContain(`C100\t${kept}\t${moved}`)
    const result = audit()
    expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('no changeset:\n\n    Merge pull request #101 ') })
    expect(result.stderr).toContain('no entry in the root CHANGELOG.md:\n\n    Merge pull request #101 ')
  })

  it('keeps a root gap when a reused-path move switches its backfill reference to the full hash', () => {
    const path = '.changeset/early.md'
    const moved = '.changeset/moved.md'
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', '.changeset/a.md': CHANGESET('Fix a.') })
    const sha = git('rev-parse', 'HEAD')
    mergePr(102, 'package-backfill', { [path]: CHANGESET('Fix a.\n\nBackfills: #101') })
    mergePr(103, 'move-and-reuse', {
      [path]: CHANGESET('An unrelated note.'),
      [moved]: CHANGESET(`Fix a.\n\nBackfills: ${sha}`),
      [ROOT_CHANGELOG]: rootNote('Unrelated note.'),
    })
    const entries = git('diff', '--name-status', '--find-renames', 'HEAD^1', 'HEAD', '--', '.changeset').split('\n')
    expect(entries).toEqual(expect.arrayContaining([`M\t${path}`, `A\t${moved}`]))
    expect(audit()).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no entry in the root CHANGELOG.md:\n\n    Merge pull request #101 '),
    })
  })

  it('treats a short backfill sharing only boilerplate with the old note as new', () => {
    const path = '.changeset/early.md'
    const newPath = '.changeset/new.md'
    mergePr(100, 'early-claim', { [path]: CHANGESET('Improve streaming.\n\nBackfills: #101') })
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n' })
    mergePr(102, 'backfill', {
      [path]: CHANGESET('An unrelated change.'),
      [newPath]: CHANGESET('Fix a startup crash.\n\nBackfills: #101'),
      [ROOT_CHANGELOG]: rootNote('Fixes a startup crash.'),
    })
    const copies = git('diff', '--name-status', '--find-copies', '--diff-filter=C', 'HEAD^1', 'HEAD', '--', '.changeset')
    expect(copies).toMatch(/^C\d+\t\.changeset\/early\.md\t\.changeset\/new\.md$/m)
    expect(audit()).toMatchObject({ code: 0 })
  })

  it.each(['merge', 'direct commit'])('does not resurrect a package claim after a %s deletes it', (operation) => {
    const path = '.changeset/late.md'
    mergePr(101, 'fix-a', { [SHIPPED]: 'export const a = 1\n', [ROOT_CHANGELOG]: rootNote('Fixes a.') })
    mergePr(102, 'backfill', { [path]: CHANGESET('Fixes a.\n\nBackfills: #101') })
    if (operation === 'merge') {
      mergePr(103, 'drop-backfill', { [path]: null })
    } else {
      git('rm', path)
      git('commit', '-q', '-m', 'drop backfill')
    }
    mergePr(104, 'reuse-path', { [path]: CHANGESET('Unrelated release note.') })
    expect(audit()).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no changeset:\n\n    Merge pull request #101 '),
    })
  })

  it('keeps a late package claim through a rename and release consumption', () => {
    const manifest = 'packages/relay/package.json'
    mergePr(101, 'fix-a', {
      [manifest]: '{"version":"0.1.0"}\n',
      [SHIPPED]: 'export const a = 1\n',
      [ROOT_CHANGELOG]: rootNote('Fixes a.'),
    })
    const claim = CHANGESET('Fixes a.\n\nBackfills: #101')
    mergePr(102, 'backfill', { '.changeset/late.md': claim })
    mergePr(103, 'rename-backfill', { '.changeset/late.md': null, '.changeset/renamed.md': claim })
    mergePr(104, 'release', {
      '.changeset/renamed.md': null,
      [manifest]: '{"version":"0.2.0"}\n',
      'packages/relay/CHANGELOG.md': '## 0.2.0\n\nFixes a.\n',
    })
    expect(audit()).toMatchObject({ code: 0 })
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
