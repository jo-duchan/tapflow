import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sources, SKIP_DIRS, SKIP_PATHS, SKIP_PATHS_SOURCE, listDir, readListed, statListed } from './sourceFiles.mjs'
import { tmpdir } from 'node:os'

// #522. Three static checks asked git which files exist. `git ls-files` reports **tracked** files only, and a
// file that was just created is exactly the state a new violation is in — so each of those checks was blind to
// the one file it existed to look at. Measured on `agentSendTyped`: an offender planted in
// `packages/ios-agent/src` left all 6 of its tests passing while untracked, and failed the moment `git add -N`
// made it visible.
//
// Fixing the three instances is worth less than this file, because the pattern is what recurs: asking git is
// the obvious way to enumerate a package, it reads as more authoritative than a directory walk, and the hole
// it opens is invisible — the check goes green.
//
// The cost was never a bypass, and saying so plainly matters for judging this: pre-commit runs lint and
// typecheck rather than vitest, and by push time the file is tracked, so CI catches it. What was lost is the
// local signal — green on the machine that introduced the offender, red in CI, and nothing in the failure to
// say the two runs disagreed about which files existed.
//
// **The first version of this guard was defeated four ways in review**, and each defeat shaped an assertion
// below rather than being patched where it landed:
//
//  1. It scanned only `*.test.mjs` at the top of `scripts/__tests__`. Moving the git call into a sibling
//     helper module put it out of reach — and this change *created* that idiom by adding `sourceFiles.mjs`,
//     so the next person writes `trackedFiles.mjs`. One new file plus one changed import reopened the hole
//     with all three tests green.
//  2. Its regex required a quote on each side of the literal, so `` execSync(`git ls-files ${pkg}`) `` and
//     `'git ls-files ' + pkg` walked past it, as did `git ls-tree -r HEAD --name-only`, which lists tracked
//     files without containing the string at all.
//  3. `readdirSync` does not recurse, while vitest's include is `scripts/__tests__/**/*.test.mjs`. A check in
//     a subdirectory was run by vitest and unknown to the guard.
//  4. (Not a defeat of this file, but found with it.) The extraction had quietly dropped `.d.ts` from the
//     walk — see `sourceFiles.mjs`.

const root = join(import.meta.dirname, '../..')
const scriptsDir = join(root, 'scripts')
const SELF = relative(root, import.meta.filename)

/** Comments stripped, so prose *about* this rule — which every file involved contains — cannot trip it. */
const code = (path) =>
  readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every `.mjs` under `scripts/`, recursively: checks, helpers a check imports, and checks in subdirectories.
 *  Walked rather than listed by git, for the reason this whole file is about — a guard against a listing that
 *  cannot see new files, built on that listing, is blind to the new file, which is the case it exists for.
 *
 *  **Not `SKIP_DIRS`**, which is for walks over *sources* and therefore skips `__tests__` — where every check
 *  lives. Reusing it here reduced this walk to the 7 top-level scripts and was caught only by the floor
 *  assertion below, which is the case that assertion exists for. */
const NOT_MODULES = new Set(['node_modules', 'dist', 'coverage'])
function scriptModules(dir = scriptsDir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!NOT_MODULES.has(e.name) && !e.name.startsWith('.')) scriptModules(join(dir, e.name), out)
    } else if (e.name.endsWith('.mjs')) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

describe('static checks enumerate the tree from disk, not from git', () => {
  const modules = scriptModules().filter((p) => relative(root, p) !== SELF)

  it('no script module asks git which files exist', () => {
    // `ls-tree` as well as `ls-files`: both report tracked paths only, and the second is the natural
    // substitute once the first is forbidden. Unanchored, so a template literal or a concatenated command
    // matches — the spelling that defeated the first version of this assertion.
    //
    // What this does not catch is deliberate obfuscation (`'ls' + '-files'`), and it is not trying to. The
    // failure mode being guarded is someone reaching for the obvious tool, not someone hiding it. The import
    // assertion below is the structural half that does not depend on spelling at all.
    expect(modules.length).toBeGreaterThan(15) // derivation broke ⇒ everything below passes vacuously

    const offenders = modules.filter((p) => /\bls-(files|tree)\b/.test(code(p))).map((p) => relative(root, p))
    expect(
      offenders,
      `these modules ask git which files exist, which cannot see an untracked offender — ` +
      `import { sources } from './sourceFiles.mjs' instead (#522)`,
    ).toEqual([])
  })

  it('every module that enumerates files gets the walk from sourceFiles.mjs', () => {
    // The structural half, and the one that catches the defeat the spelling check was designed around: the
    // review reopened the hole by adding `trackedFiles.mjs` exporting its own `sources()` and changing one
    // import line. The call site read identically, so nothing about the call could tell the difference.
    const wrong = []
    for (const p of modules) {
      const src = code(p)
      if (!/\bsources\s*\(/.test(src)) continue
      if (relative(root, p).replaceAll('\\', '/') === 'scripts/__tests__/sourceFiles.mjs') continue // it *is* the walk
      if (!/from\s+'\.\/sourceFiles\.mjs'/.test(src)) wrong.push(relative(root, p))
    }
    expect(
      wrong,
      `these modules call sources() but do not import it from './sourceFiles.mjs' — a second walk is how ` +
      `the git listing comes back under a name this check does not know (#522)`,
    ).toEqual([])
  })

  it('a walker skips what was removed after it was listed, and nothing else', () => {
    // Other tests plant files in the tree for a moment, in parallel workers (`testsReadSource`'s probe in
    // `packages/*/src/__tests__`, the probes in this file under `scripts/`). A walker that listed one and then
    // read it failed on ENOENT, which is a failure about nothing: 2 of 12 full runs under load.
    const dir = mkdtempSync(join(tmpdir(), 'walk-vanish-'))
    try {
      const gone = join(dir, 'gone')
      expect(listDir(gone)).toEqual([])
      expect(statListed(join(gone, 'x.ts'))).toBeNull()
      expect(readListed(join(gone, 'x.ts'))).toBeNull()
      writeFileSync(join(dir, 'here.ts'), 'export {}\n')
      expect(readListed(join(dir, 'here.ts'))).toBe('export {}\n')
      // Only a removal is skipped: reading a directory as a file is still an error a check must hear about.
      expect(() => readListed(dir)).toThrow(/EISDIR/)
      expect(() => listDir(join(dir, 'here.ts'))).toThrow(/ENOTDIR/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the walk sees a file git has never heard of', () => {
    // The assertions above are about how the checks are written. This one is about what the walk does, and the
    // pair is what makes the rule real: alone, the others would still pass if `sources` itself were rewritten
    // to shell out.
    //
    // The probe lives under `scripts/`, deliberately not under `packages/`, where three checks walk for
    // sources — a leaked directory there would be reported as a real path by `clientOutboundTyped`.
    // `scripts/` is not out of every walk, though: `agentReadableDocs` walks the whole repo for text files. So
    // a removal mid-walk is handled where it can happen anywhere, in the walkers (`listDir`, `readListed`,
    // below), and not by where the probe is put.
    const dir = mkdtempSync(join(scriptsDir, '__tests__', '.walkprobe-'))
    try {
      writeFileSync(join(dir, 'brandNew.ts'), 'export const x = 1\n')
      const rel = relative(root, dir)

      expect(sources(rel)).toContain(join(rel, 'brandNew.ts').replaceAll('\\', '/'))
      // And git genuinely cannot see it, so the two disagree — which is the whole finding.
      expect(execFileSync('git', ['ls-files', rel], { cwd: root, encoding: 'utf8' }).trim()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips the directories a source check never wants, and keeps .d.ts', () => {
    // `__tests__` is in the skip set because all three callers filtered it by hand. Dropping it widens every
    // one of them — measured: three tests fail, two of them the consumer checks reporting their own fixtures
    // as offenders. So the set is load-bearing and the failure is loud, which is why membership is asserted
    // here as well as behaviour. `dist` likewise: a built copy of an offender would be reported at a path
    // nobody can fix.
    //
    // `.d.ts` is asserted **present**, which is the inverse of what this case first claimed. Excluding them
    // narrowed `browserInboundRouting`, whose subject is exactly what a declaration file holds — see
    // `sourceFiles.mjs`.
    const dir = mkdtempSync(join(scriptsDir, '__tests__', '.walkprobe-'))
    try {
      for (const d of ['__tests__', 'dist', 'node_modules']) {
        mkdirSync(join(dir, d))
        writeFileSync(join(dir, d, 'hidden.ts'), 'export const y = 1\n')
      }
      writeFileSync(join(dir, 'visible.ts'), 'export const z = 1\n')
      writeFileSync(join(dir, 'types.d.ts'), 'export declare const w: number\n')

      const rel = relative(root, dir)
      expect(sources(rel).sort()).toEqual([
        join(rel, 'types.d.ts').replaceAll('\\', '/'),
        join(rel, 'visible.ts').replaceAll('\\', '/'),
      ])
      expect(SKIP_DIRS.has('__tests__')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not walk into the dashboard build\'s copy, which another test in this suite deletes', () => {
    // `clientOutboundTyped.test.mjs` walks all of `packages/`, and `dashboardFirstLoadBudget.test.mjs`
    // runs `pnpm --filter @tapflowio/dashboard build` in the same `pnpm test:scripts` invocation — whose
    // last step replaces `../relay/public` with the contents of `dist`. A walk inside that
    // directory while the copy is replaced dies on ENOENT, which is a failure about nothing.
    //
    // **Two halves, and neither touches the real directory.** Planting a probe inside
    // `packages/relay/public` is what the first version of this did, and it reproduced the very race
    // it exists to prevent: the build can delete the tree between `mkdirSync` and `writeFileSync`,
    // and a recursive cleanup can remove what the build just wrote. So the mechanism is proved in a
    // temp tree — under `scripts/`, for the reason the probe above gives — and the *content* of the
    // real set is proved against the script that writes it. What joins the two is `sources()`'s
    // default argument, which is one line in `sourceFiles.mjs`.
    const dir = mkdtempSync(join(scriptsDir, '__tests__', '.skipprobe-'))
    try {
      // **Nested one level below the walk's root on purpose.** With the skipped directory as a direct
      // child, the check runs in the top-level call and a `sources()` that forgot to forward
      // `skipPaths` to its recursion still passes — measured. The real path is nested too
      // (`packages/` → `relay` → `public`), and there it is invisible because the recursion falls
      // back to the same default set.
      const pkg = join(dir, 'pkg')
      const generated = join(pkg, 'generated')
      mkdirSync(generated, { recursive: true })
      writeFileSync(join(pkg, 'kept.ts'), 'export const a = 1\n')
      writeFileSync(join(generated, 'skipped.ts'), 'export const b = 2\n')
      const rel = relative(root, dir)

      const walked = sources(rel, [], new Set([generated]))
      expect(walked).toContain(join(rel, 'pkg', 'kept.ts').replaceAll('\\', '/'))
      expect(
        walked.filter((f) => f.endsWith('skipped.ts')),
        'sources() descended into a directory its skip set names',
      ).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    // The set names a path the dashboard build writes, so if the build stops writing it the skip is
    // pointing at nothing and the race is back with every check still green.
    const buildScript = JSON.parse(readFileSync(SKIP_PATHS_SOURCE.manifest, 'utf8'))
      .scripts[SKIP_PATHS_SOURCE.script]
    expect(
      buildScript,
      `the dashboard build no longer writes ${SKIP_PATHS_SOURCE.mentions} — SKIP_PATHS is stale`,
    ).toContain(SKIP_PATHS_SOURCE.mentions)
    expect([...SKIP_PATHS].map((p) => relative(root, p).replaceAll('\\', '/')))
      .toContain('packages/relay/public')
  })
})
