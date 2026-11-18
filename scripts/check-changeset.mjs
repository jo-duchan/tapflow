#!/usr/bin/env node
// Fails a PR that changes published source without adding a changeset.
//
// Why: between v0.16.0 and v0.17.0 four PRs (#410–#413) changed shipped code with no changeset
// between them, and the omission only surfaced while preparing the release. The rule was written
// down in CONTRIBUTING.md and nothing enforced it, so the release notes would have announced the
// clipboard bridge and stayed silent on the four fixes underneath it.
//
// Usage: node scripts/check-changeset.mjs <base-ref>   (default: origin/main)
//
// Opting out: put `<!-- no-changeset: reason -->` in the PR body, or pass --reason "…" locally.
// A comment-only or test-only change is a legitimate skip; the point is that skipping is a
// decision someone writes down, not something that happens by forgetting.
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { readFileSync, realpathSync } from 'fs'
import { inspect } from 'node:util'
import {
  changedOverrideKeys,
  overrideKeyName,
  prodReachableNames,
  prodVersionChanges,
} from './prod-reach.mjs'
import { proseLines } from './lib/prose-lines.mjs'

// Inverted on purpose: everything under `packages/` ships unless named here. Listing what
// ships instead left a NEW published package invisible to the gate — the case that most needs
// a release note. These two are directories that are not packages at all.
const NOT_SHIPPED_PACKAGES = ['docs', 'playground']

// `dashboard` is `private` yet reaches users: it is built into the relay's `public/` and ships
// inside that package. Every other private package ships nothing, which `packagePublishesAt`
// reads from the manifest rather than from a list — the list this replaced still named `docs`
// and `playground`, which have not been under `packages/` for some time, while
// `@tapflowio/test-utils`, added later, was absent and so counted as shipped.
// Exported so `changesetIgnoresPrivate.test.mjs` can check this list against the manifests rather
// than keeping a second copy of the answer. That test is the one that would notice this going stale.
export const SHIPS_DESPITE_PRIVATE = ['@tapflowio/dashboard']

/**
 * Whether `packages/<dir>` published anything, judged by its manifest **at `rev`**.
 *
 * At `rev`, not on disk: the audit walks history, and a package deleted since — or added by the
 * very merge under examination — must be judged as it was then. Absent or unreadable counts as
 * publishing, so the gate asks rather than waves through; that is also what keeps a brand-new
 * package visible, which is the case that most needs a release note.
 */
export function packagePublishesAt(readManifest, dir) {
  const raw = readManifest(dir)
  if (raw === null) return true
  try {
    const m = JSON.parse(raw)
    return !m.private || SHIPS_DESPITE_PRIVATE.includes(m.name)
  } catch { return true }
}

// Deny by default. An earlier version listed what ships — `src/**` with a TypeScript extension —
// and so ignored `.sql` migrations, `bin/`, `proto/`, `schema/`, `xctest-runner/`, the dashboard
// entirely, and every `package.json`. Listing the EXCEPTIONS instead means a new shipped
// directory errs toward asking for a changeset, which is the harmless direction to be wrong in.
const EXEMPT = [
  /(^|\/)__tests__\//,
  /(^|\/)__fixtures__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /Test\.swift$/,                                  // the XCUITest runner's own test target
  /(^|\/)dist\//,
  /(^|\/)\.(gitignore|env[^/]*)$/,
  /(^|\/)(README|LICENSE|CHANGELOG|AGENTS|CLAUDE|DESIGN)(\.md)?$/i,
  /^packages\/dashboard\/design\/.+\.md$/,           // component specs beside DESIGN.md — prose, never bundled
  /(^|\/)(tsconfig[^/]*\.json|vitest\.config\.[^/]+|eslint\.config\.[^/]+|\.npmignore)$/,
]

const PACKAGE_FILE = /^packages\/([^/]+)\//

/**
 * Whether a `package.json` edit can reach a user. `package.json` is deliberately not in EXEMPT —
 * `dependencies`, `exports`, `bin` and `files` all ship — but `devDependencies` never does, and
 * wiring up a private test helper touches every consumer's manifest. At v0.18.0 the audit called
 * #453 a missing changeset on the strength of four such lines, while the PR-time gate had already
 * (correctly) said no changeset was required. Two gates, two answers, same repository.
 *
 * Anything unreadable counts as shipping: a manifest we cannot parse is not one to wave through.
 */
export function manifestChangeShips(before, after) {
  // Key order is not content. `JSON.stringify` preserves insertion order, so a formatter or a
  // `npm pkg set` that rewrites the manifest without changing a value would compare as different
  // and ask for a changeset that nothing earned — the same spurious signal this file exists to
  // remove, arriving from the other side.
  const stable = (v) =>
    v === null || typeof v !== 'object' ? v
      : Array.isArray(v) ? v.map(stable)
        : Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))

  const strip = (raw) => {
    if (raw === null) return null                    // added or deleted outright — that ships
    try {
      const { devDependencies: _drop, ...rest } = JSON.parse(raw)
      return JSON.stringify(stable(rest))
    } catch { return null }
  }
  const a = strip(before)
  const b = strip(after)
  if (a === null || b === null) return true
  return a !== b
}
/**
 * PR number of a merge commit, from its subject. `null` for anything else (a hand-made merge,
 * a squash). Exported for the tests.
 */
export function prNumberOf(subject) {
  const m = /^Merge pull request #(\d+) /.exec(subject)
  return m ? Number(m[1]) : null
}

/**
 * PR numbers or full merge commit IDs a changeset names on a `Backfills:` line.
 *
 * Why this exists: the audit judges each merge on its own, so a changeset added by a LATER PR to
 * cover an earlier one never clears it. During the v0.17.0 cycle four merges were reported as
 * gaps for a week after they had in fact been covered, and the only way to know was to match
 * them up by hand on every run. A backfill now says which merges it answers for.
 */
export function parseBackfills(body) {
  const out = []
  const reference = /(?:#(\d+)|([0-9a-f]{40}))\b/iy
  const separator = /(?:\s*,\s*(?:and\s+)?|\s+(?:and\s+)?)/iy
  // Frontmatter skipped: `Backfills:` there is a YAML key, not a claim. Fences and indented
  // blocks skipped for the same reason `extractReason` skips them — the audit's own failure
  // message prints `Backfills: #413` indented, and CONTRIBUTING, AGENTS and /release all carry
  // it verbatim, so a changeset that documents the convention must not clear whatever it names.
  for (const { line } of proseLines(body, { skipFrontmatter: true })) {
    const m = /^Backfills:\s*(.+?)\s*$/i.exec(line)
    if (!m) continue
    reference.lastIndex = 0
    for (let ref = reference.exec(m[1]); ref; ref = reference.exec(m[1])) {
      out.push(ref[1] === undefined ? ref[2].toLowerCase() : Number(ref[1]))
      separator.lastIndex = reference.lastIndex
      if (!separator.test(m[1])) break
      reference.lastIndex = separator.lastIndex
    }
  }
  return out
}

/**
 * Is this the branch `pnpm changeset version` produces? It consumes (deletes) the changesets it
 * folds into the changelogs, so a gate looking for ADDED ones fails the release PR — which, with
 * the check required, blocks the release itself. Both halves are needed: deleting a changeset
 * you decided against is not a release. Exported for the tests.
 */
export function isReleaseBranch(consumedChangesets, changedFiles) {
  if (consumedChangesets.length === 0) return false
  return changedFiles.some((f) => /(^|\/)CHANGELOG\.md$/.test(f))
}

function isAuditRelease(consumed, written, before, after) {
  if (!isReleaseBranch(consumed, written)) return false
  // A changelog edit can accompany ordinary cleanup. Changesets also writes a new version
  // heading in the changelog of a package it bumps.
  return written.some((file) => {
    if (!/^packages\/[^/]+\/package\.json$/.test(file)) return false
    const changelog = file.replace(/package\.json$/, 'CHANGELOG.md')
    if (!written.includes(changelog)) return false
    const previous = packageVersionAt(before, file)
    const next = packageVersionAt(after, file)
    return previous !== null && next !== null && previous !== next
      && blobAt(after, changelog)?.split('\n').some((line) => line.trim() === `## ${next}`)
  })
}

function packageVersionAt(rev, file) {
  const body = blobAt(rev, file)
  try {
    const manifest = JSON.parse(body)
    return typeof manifest?.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** Would a user of a released tapflow notice this file changing? Exported for the tests. */
export function shipsToUsers(f) {
  const pkg = f.match(PACKAGE_FILE)?.[1]
  if (!pkg || NOT_SHIPPED_PACKAGES.includes(pkg)) return false
  return !EXEMPT.some((re) => re.test(f))
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** File content at a revision, or null when it does not exist there. */
const blobAt = (rev, file) => {
  // stderr silenced: "exists on disk, but not in <rev>" is the answer to a question, not a
  // failure, and git says it straight to the console on the way to throwing.
  try { return execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch {
    // A rev that is not in the clone is a different thing from a file that was not in that rev,
    // and only the second one means "nothing shipped". Conflating them made a shallow clone read
    // as an empty manifest and an empty lockfile, so every change waved through — silently, which
    // is how it reached CI as a wrong verdict rather than an error.
    assertRevPresent(rev)
    return null
  }
}

const revChecked = new Set()

function assertRevPresent(rev) {
  if (revChecked.has(rev)) return
  try {
    execFileSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], { stdio: 'ignore' })
    revChecked.add(rev)
  } catch {
    throw new Error(
      `${rev} is not in this clone — history is too shallow to judge what changed.\n` +
        'Check out with `fetch-depth: 0`.',
    )
  }
}

/**
 * `shipsToUsers`, plus the one question a path cannot answer: a `package.json` whose only change
 * is under `devDependencies` ships nothing. Both call sites go through this so the audit and the
 * PR gate cannot give different answers about the same commit again.
 */
/**
 * Workspace importers that publish, at `rev`. `.` is the private root; `docs`/`playground` are not
 * packages. Judged from each manifest rather than a list, for the reason `packagePublishesAt` gives.
 */
export function publishedImportersAt(rev) {
  return blobAt(rev, 'pnpm-lock.yaml')
    .split('\n')
    .filter((l) => /^  packages\/[^/]+:$/.test(l))
    .map((l) => l.trim().slice(0, -1))
    .filter((path) => packagePublishesAt((d) => blobAt(rev, `packages/${d}/package.json`), path.slice('packages/'.length)))
}

/**
 * The importers whose PRODUCTION tree ends up inside the Docker image.
 *
 * Narrower than "everything published", and deliberately so. `pnpm.overrides` and the lockfile
 * decide resolved versions for THIS workspace; they do not propagate into a published tarball,
 * where a consumer resolves each intermediary's own declared range instead. So an override that
 * moves a package inside `@tapflowio/mcp-server` changes nothing anyone installs — asking for a
 * release note there teaches people the gate is noise.
 *
 * The image is `Dockerfile:34`, `pnpm deploy --filter @tapflowio/relay --prod`, plus the dashboard,
 * which vite bundles into the relay's `public/` and which therefore ships inside it. That is the
 * same pair `SHIPS_DESPITE_PRIVATE` already names, for the same reason.
 */
const IMAGE_PACKAGES = ['relay', 'dashboard']

function imageImportersAt(rev) {
  return IMAGE_PACKAGES.map((d) => `packages/${d}`).filter(
    (path) => blobAt(rev, `${path}/package.json`) !== null,
  )
}

/**
 * Does a change to the root manifest or the lockfile move something a user runs?
 *
 * Root `package.json` is `private` with zero `dependencies`, so classifying it by path — as
 * `shipsToUsers` does — meant it never qualified whatever it contained. Its one route to a shipped
 * artifact is `pnpm.overrides`, and four override commits merged with no changelog line before
 * anything asked (#472). Judged against the image (see `imageImportersAt`), not against every
 * published package, because that is the only artifact these files decide the contents of.
 *
 * The lockfile is checked for the same reason and by the same measure. `AGENTS.md` now says to try
 * `pnpm update` before adding an override; without this, taking that advice would move the blind
 * spot rather than close it.
 */
export function rootDependencyChangeShips(file, before, after) {
  const importers = imageImportersAt(after)
  if (!importers.length) return false

  if (file === 'package.json') {
    const changed = changedOverrideKeys(blobAt(before, file), blobAt(after, file))
    if (!changed.length) return false
    // Reachability is read at `after`: an override that ADDS a package to the production tree is
    // invisible in the older graph, and that is the direction most worth catching.
    const reachable = prodReachableNames(blobAt(after, 'pnpm-lock.yaml'), importers)
    return changed.some((k) => reachable.has(overrideKeyName(k)))
  }

  return (
    prodVersionChanges(blobAt(before, file), blobAt(after, file), importers).length > 0
  )
}

function shipsBetween(file, before, after) {
  if (file === 'package.json' || file === 'pnpm-lock.yaml') {
    return rootDependencyChangeShips(file, before, after)
  }
  if (!shipsToUsers(file)) return false
  const pkg = file.match(PACKAGE_FILE)?.[1]
  if (pkg && !packagePublishesAt((d) => blobAt(after, `packages/${d}/package.json`), pkg)) return false
  if (!/(^|\/)package\.json$/.test(file)) return true
  return manifestChangeShips(blobAt(before, file), blobAt(after, file))
}

/**
 * Pull `<!-- no-changeset: reason -->` out of a PR body.
 *
 * Two rules, both learned the hard way: the marker must be the WHOLE line, and it must not be
 * inside a fenced code block. Otherwise any PR that merely quotes the syntax — a PR explaining
 * the rule, or the PR that introduced it, both of which paste the snippet from CONTRIBUTING.md —
 * silently switches the gate off.
 *
 * Exported for the tests.
 */
export function extractReason(body) {
  for (const { line } of proseLines(body)) {
    const m = line.match(/^<!--\s*no-changeset:\s*(.*?)\s*-->$/)
    if (m && m[1]) return m[1]
  }
  return ''
}

/**
 * Packages `changeset version` refuses to see. A changeset that names one of these ALONGSIDE a
 * published package is rejected outright — "Mixed changesets that contain both ignored and not
 * ignored packages are not allowed" — and nothing catches it until release day, because the gate
 * below only asks whether a changeset exists and never opens one. Four such changesets stopped
 * the v0.18.0 release, written across four different PRs that all went green.
 */
export function ignoredPackages() {
  // **Rooted at this file, and no longer failing open.** A bare `catch` returning an empty set meant
  // "nothing is ignored", which switches `mixedChangesets` off entirely — the check that exists
  // because four mixed changesets stopped the v0.18.0 release. Combined with the relative path, any
  // invocation whose cwd was not the repo root disabled it silently. A gate that cannot read its own
  // configuration has to say so rather than wave everything through.
  const config = new URL('../.changeset/config.json', import.meta.url)
  return new Set(JSON.parse(readFileSync(config, 'utf8')).ignore ?? [])
}

/** The package names a changeset's frontmatter bumps. */
export function packagesNamedIn(source) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (!front) return []
  return [...front[1].matchAll(/^\s*["']([^"']+)["']\s*:\s*(major|minor|patch)\s*$/gm)].map((m) => m[1])
}

/** Changesets that mix an ignored package with a published one, as `{file, ignored, published}`. */
export function mixedChangesets(files, ignored, read) {
  return files.flatMap((f) => {
    const named = packagesNamedIn(read(f))
    const inIgnore = named.filter((n) => ignored.has(n))
    const rest = named.filter((n) => !ignored.has(n))
    return inIgnore.length && rest.length ? [{ file: f, ignored: inIgnore, published: rest }] : []
  })
}

/**
 * Whether the added changesets name a package that will actually get a release note.
 *
 * The mixed case above throws at `changeset version` and is loud on release day. This one is
 * **silent**: `assemble-release-plan` produces no release for an ignored-only changeset and
 * `changeset version` deletes the file, so published source ships with nothing written about it and
 * every gate stayed green. It is the exact mistake the root AGENTS.md warns about — a dashboard
 * change must name `@tapflowio/relay`, because the dashboard is built into that package's `public/`
 * and cannot be versioned itself.
 *
 * Adding the private packages to `ignore` made this quieter rather than louder: before, an
 * ignored-only changeset at least bumped an unpublished package and wrote it a CHANGELOG, which is
 * visible in the release PR's diff. Now it emits nothing at all.
 *
 * Returns the offending files, so the caller can name them.
 */
export function ignoredOnlyChangesets(files, ignored, read) {
  return files.filter((f) => {
    const named = packagesNamedIn(read(f))
    return named.length > 0 && named.every((n) => ignored.has(n))
  })
}

/**
 * Which added changesets still owe the root `CHANGELOG.md` an entry.
 *
 * Two changelogs exist and only one has a gate. The per-package `CHANGELOG.md` files are generated by
 * `changeset version` and cannot be forgotten. The **root** `CHANGELOG.md` is hand-written, is what a
 * self-hoster reads to decide whether to upgrade, and nothing checked it — so on 2026-08-15 it had been
 * untouched for four days across 22 merged PRs, while all 22 carried a changeset. The rule was in
 * CONTRIBUTING and the enforcement was in neither place.
 *
 * **Not every changeset earns an entry**, and forcing one would fill the file with noise a user cannot
 * act on — half of this cycle's changesets are protocol typing with no observable behaviour. So a
 * changeset opts out by saying so in its own body, on a line of its own:
 *
 *     <!-- changelog: internal — protocol typing, nothing a user can observe -->
 *
 * The marker itself records the decision; prose after `internal` is optional.
 *
 * **What this covers, stated rather than implied:** a branch that touches a changeset — added, amended or
 * renamed — and ships published source. It does **not** cover a branch with no changeset (its
 * `no-changeset` reason answers the same question one layer up), a bot PR (the CI job is skipped for
 * those, and a skipped required check passes), or a release branch (exempt by design). Nor does it read
 * the entry: touching the file is what it checks, because no check can tell whether prose corresponds to
 * a diff. The measured incident it ends — 22 merged PRs against a four-day-stale file — was 22 PRs that
 * all carried changesets. The marker lives in the changeset
 * rather than the PR body because it classifies *that change*, and because a PR carrying two changesets
 * can need it for one of them.
 */
export function changelogEntryOwed(files, read) {
  return files.filter((f) => !isInternalChangeset(read(f)))
}

function isInternalChangeset(note) {
  for (const { line } of proseLines(note, { skipFrontmatter: true })) {
    if (/^<!--\s*changelog:\s*internal\b.*-->$/.test(line)) return true
  }
  return false
}

function main() {
  // `--audit [since]` walks merges instead of the current branch: the PR gate cannot help with
  // anything already on main, and that is exactly how #410–#413 slipped through. Run at release
  // time, from /release step 1.
  if (process.argv.includes('--audit')) {
    const i = process.argv.indexOf('--audit')
    const after = process.argv[i + 1]
    let since = after && !after.startsWith('-') ? after : null
    if (!since) {
      try {
        since = git('describe', '--tags', '--abbrev=0')
      } catch {
        console.error('No tags here — pass an explicit revision: pnpm changeset:audit <ref>')
        process.exit(2)
      }
    }

    let commitLog
    try {
      // Follow the branch that received the merges. Direct commits can drop or move a note
      // between merges, so read them for continuity even though only merges can claim coverage.
      commitLog = execFileSync('git', ['log', `${since}..HEAD`, '--first-parent', '--reverse', '--format=%H%x09%P%x09%s'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      // Exit 2, not 1: a typo'd revision must not look like a finding.
      console.error(`Not a revision in this repository: ${since}`)
      process.exit(2)
    }
    const isChangeset = (f) => /^\.changeset\/.+\.md$/.test(f) && !/^\.changeset\/README\.md$/i.test(f)

    // Collect claims before judging merges. Only surviving or released package notes count.
    const liveClaims = new Map()
    const claims = new Map()
    const changelogClaims = new Map()
    const creditPackageClaims = (references) => {
      for (const [ref, index] of references) {
        claims.set(ref, Math.max(claims.get(ref) ?? -1, index))
      }
    }
    const perMerge = []
    for (const [index, line] of commitLog.split('\n').entries()) {
      const [sha, parents, ...rest] = line.split('\t')
      if (!parents) continue
      const merge = parents.includes(' ')
      const before = `${sha}^1`
      const files = []
      const touched = new Map()
      const consumed = []
      const renamedFrom = []
      const written = []
      const entries = git('diff', '--name-status', '--find-renames', '-z', before, sha).split('\0')
      for (let i = 0; i < entries.length - 1;) {
        const status = entries[i++][0]
        const previous = entries[i++]
        const file = status === 'R' || status === 'C' ? entries[i++] : previous
        files.push(file)
        if (status === 'R') {
          files.push(previous)
          if (isChangeset(previous)) renamedFrom.push(previous)
        }
        if (status === 'A' || status === 'M' || (status === 'R' && file === 'CHANGELOG.md')) written.push(file)
        if (!isChangeset(file)) continue
        if (status === 'D') consumed.push(file)
        if (status === 'A' || status === 'M' || status === 'R') touched.set(file, status === 'A' ? null : previous)
      }
      const release = merge && isAuditRelease(consumed, written, before, sha)
      const changelogWritten = written.includes('CHANGELOG.md')
      if (merge) perMerge.push({ sha, index, files, subject: rest.join('\t'), touched, release, changelogWritten })

      const rootBackfills = new Map()
      const updatedClaims = new Map()
      const priorNote = (file) => {
        const note = git('show', `${before}:${file}`)
        return { note, refs: new Set(parseBackfills(note)), internal: isInternalChangeset(note), dates: liveClaims.get(file) }
      }
      let deletedNotes
      let rewrittenNotes
      for (const [f, previous] of touched) {
        const note = git('show', `${sha}:${f}`)
        const backfills = parseBackfills(note)
        const dates = new Map()
        updatedClaims.set(f, dates)
        if (backfills.length === 0) continue
        const internal = isInternalChangeset(note)
        const coversRoot = changelogWritten || internal
        // Git can report a substantial rewrite as delete/add. Keep carried references dated
        // to their original introduction. A new internal marker can cover the root separately.
        let predecessors
        if (previous === null) {
          deletedNotes ??= consumed.map(priorNote)
          // Git can report a move as an edit and an addition when the old path gets new content.
          rewrittenNotes ??= [...touched]
            .filter(([file, from]) => file === from)
            .map(([file]) => {
              const earlier = priorNote(file)
              const remaining = new Set(parseBackfills(git('show', `${sha}:${file}`)))
              return { ...earlier, refs: earlier.refs.difference(remaining) }
            })
          predecessors = deletedNotes.concat(rewrittenNotes.filter((entry) => entry.note === note))
        } else {
          predecessors = isChangeset(previous) ? [priorNote(previous)] : []
        }
        for (const ref of backfills) {
          const carried = predecessors.filter((entry) => entry.refs.has(ref))
          const introduced = carried.length === 0 && merge
            ? index
            : Math.max(-1, ...carried.map((entry) => entry.dates?.get(ref) ?? -1))
          dates.set(ref, introduced)
          if (merge && !carried.some((entry) => !internal || entry.internal)) {
            rootBackfills.set(ref, (rootBackfills.get(ref) ?? true) && coversRoot)
          }
        }
      }
      for (const [ref, coversRoot] of rootBackfills) {
        if (coversRoot) changelogClaims.set(ref, index)
      }
      if (release) {
        for (const file of consumed) creditPackageClaims(liveClaims.get(file) ?? [])
      }
      for (const file of [...consumed, ...renamedFrom]) liveClaims.delete(file)
      for (const [file, dates] of updatedClaims) liveClaims.set(file, dates)
    }
    for (const dates of liveClaims.values()) creditPackageClaims(dates)

    const changesetGaps = []
    const changelogGaps = []
    // Keep the report newest first. A later declaration may cover an earlier merge.
    for (const { sha, subject, files, touched, release, index, changelogWritten } of perMerge.toReversed()) {
      if (release) continue
      const shipped = files.filter((f) => shipsBetween(f, `${sha}^1`, sha))
      if (shipped.length === 0) continue

      const pr = prNumberOf(subject)
      const backfilled = (byRef) => (byRef.get(pr ?? sha) ?? -1) > index
      // Bots are exempt from changesets, but production dependency bumps can still owe a root note.
      if (touched.size === 0 && !/dependabot|renovate/i.test(subject) && !backfilled(claims)) {
        changesetGaps.push({ sha, pr, subject, shipped })
      }
      if (changelogWritten || backfilled(changelogClaims)) continue
      if (touched.size === 0 || changelogEntryOwed([...touched.keys()], (f) => git('show', `${sha}:${f}`)).length > 0) {
        changelogGaps.push({ sha, pr, subject, shipped })
      }
    }

    // stdout carries the verdict, stderr the diagnosis — so `2>/dev/null` leaves a caller with
    // the answer and nothing else. The guidance block below broke that by staying on stdout.
    console.error(`Merges since ${since}: ${perMerge.length}`)
    if (changesetGaps.length === 0 && changelogGaps.length === 0) {
      console.log('No changeset or root CHANGELOG.md gaps found.')
      process.exit(0)
    }
    for (const [gaps, missing] of [[changesetGaps, 'changeset'], [changelogGaps, 'entry in the root CHANGELOG.md']]) {
      if (gaps.length === 0) continue
      console.error(`\n  ${gaps.length} merge(s) changed published source with no ${missing}:\n`)
      for (const { sha, pr, subject, shipped } of gaps) {
        console.error(`    ${subject}`)
        if (pr === null) console.error(`      Backfills: ${sha}`)
        for (const f of shipped.slice(0, 5)) {
          console.error(`      ${/\p{Cc}/u.test(f) ? inspect(f, { breakLength: Infinity }) : f}`)
        }
        if (shipped.length > 5) console.error(`      …and ${shipped.length - 5} more`)
      }
    }
    console.error(`
    Backfill each reported gap. For a root changelog gap, add the note under ## [Unreleased]
    and add a new Backfills declaration to a changeset in the same PR. If the reference already
    appears in a changeset, leave that file in place and add the declaration to a separate changeset.
    A change with no observable effect can use an internal changeset instead of a root note.
    Merge the backfill PR into main and rerun the audit before running pnpm changeset version.
    Name the PR number, or use the full merge hash printed for merges without a PR:

        Backfills: #413
  `)
    process.exit(1)
  }

  // Parse rather than index. Reading `argv[2]` blindly handed `--reason` itself to
  // `git merge-base`; skipping only dash-prefixed words then handed it the reason TEXT.
  const argv = process.argv.slice(2)
  const positional = []
  let reasonArg = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reason') { reasonArg = argv[++i] ?? ''; continue }
    if (argv[i] === '--audit') { i++; continue }        // its value is read in the audit branch
    if (!argv[i].startsWith('-')) positional.push(argv[i])
  }
  const base = positional[0] ?? 'origin/main'
  const reason = reasonArg !== null ? reasonArg.trim() : extractReason(process.env.PR_BODY ?? '')

  let mergeBase
  try {
    mergeBase = git('merge-base', base, 'HEAD')
  } catch {
    console.error(`Could not find a merge base with ${base}. Fetch it first:  git fetch origin main`)
    process.exit(2)
  }

  const changed = git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').filter(Boolean)
  const shipped = changed.filter((f) => shipsBetween(f, mergeBase, 'HEAD'))

  if (shipped.length === 0) {
    console.log('No published source changed — no changeset required.')
    process.exit(0)
  }

  // Added, not merely present: `.changeset/` always has entries waiting for the next release, so
  // "a changeset exists" is true on every branch and would never fail.
  const added = git('diff', '--name-only', '--diff-filter=A', `${mergeBase}...HEAD`)
    .split('\n')
    .filter((f) => /^\.changeset\/.+\.md$/.test(f) && !/^\.changeset\/README\.md$/i.test(f))

  // A `changeset version` branch bumps every `packages/*/package.json` and DELETES the
  // changesets it consumed, so it trips a gate that only looks for added ones — with the check
  // required, that blocks the release PR permanently. Recognise it by its signature: changesets
  // removed plus changelogs written. Verified against a real `pnpm changeset version` run.
  const consumed = git('diff', '--name-only', '--diff-filter=D', `${mergeBase}...HEAD`)
    .split('\n')
    .filter((f) => /^\.changeset\/.+\.md$/.test(f))
  if (isReleaseBranch(consumed, changed)) {
    console.log(`Release branch: ${consumed.length} changeset(s) consumed into a changelog.`)
    process.exit(0)
  }

  const mixed = mixedChangesets(added, ignoredPackages(), (f) => readFileSync(f, 'utf8'))
  if (mixed.length > 0) {
    console.error('Changeset names an ignored package alongside a published one:\n')
    for (const { file, ignored, published } of mixed) {
      console.error(`  ${file}`)
      console.error(`    ignored:   ${ignored.join(', ')}`)
      console.error(`    published: ${published.join(', ')}`)
    }
    console.error('\n`changeset version` rejects this outright, and it is not discovered until')
    console.error('release day. Name the package that actually ships the change — for a dashboard')
    console.error('change that is `@tapflowio/relay`, which builds it into its `public/`.')
    process.exit(1)
  }

  const ignoredOnly = ignoredOnlyChangesets(added, ignoredPackages(), (f) => readFileSync(f, 'utf8'))
  if (ignoredOnly.length === added.length && added.length > 0) {
    console.error('Every added changeset names only ignored packages:\n')
    for (const f of ignoredOnly) console.error(`  ${f}`)
    console.error('\n`changeset version` produces no release for these and deletes the file, so this')
    console.error('branch would ship with no release note at all. Name the package that actually ships')
    console.error('the change — for a dashboard change that is `@tapflowio/relay`.')
    process.exit(1)
  }

  // **`AMR`, not the `added` list above.** A PR that extends an existing unconsumed changeset with new
  // behaviour shows up as `M` and never as `A`, and a rename is `R` — so keying this on `added` let the
  // two most ordinary shapes of follow-up work escape. The audit half already counts `AMR` for exactly
  // that reason. What this still cannot see is a branch with no changeset at all: a `no-changeset`
  // reason answers the same question one layer up, and a bot PR skips the CI job entirely.
  const touchedChangesets = git('diff', '--name-only', '--diff-filter=AMR', `${mergeBase}...HEAD`)
    .split('\n')
    .filter((f) => /^\.changeset\/.+\.md$/.test(f) && !/^\.changeset\/README\.md$/i.test(f))
  const owed = changelogEntryOwed(touchedChangesets, (f) => readFileSync(f, 'utf8'))
  // Added or modified, not merely *named in the diff*. `changed` comes from a bare `--name-only`, which
  // lists deletions too — so deleting the file satisfied the demand to write in it.
  const changelogWritten = git('diff', '--name-only', '--diff-filter=AM', `${mergeBase}...HEAD`)
    .split('\n')
    .includes('CHANGELOG.md')
  if (owed.length > 0 && !changelogWritten) {
    console.error('Changeset added with no entry in the root CHANGELOG.md:\n')
    for (const f of owed) console.error(`  ${f}`)
    console.error('\nThat file is what a self-hoster reads to decide whether to upgrade, and unlike the')
    console.error('per-package changelogs nothing generates it. Add an entry under `## [Unreleased]`, in')
    console.error('the section CONTRIBUTING lists — a breaking change needs `### Breaking Changes` and a')
    console.error('`Migrate:` hint. If this change is not something a user can observe, say so in the')
    console.error('changeset on a line of its own:\n')
    console.error('  <!-- changelog: internal — reason -->')
    process.exit(1)
  }

  // **`touchedChangesets`, matching the obligation above.** Widening the demand to `AMR` and leaving the
  // success path on `added` was half a change: a branch that amended an existing changeset *and* wrote its
  // CHANGELOG entry satisfied the demand and then fell through to "adds no changeset" — a false failure,
  // and the direction that teaches people the gate is noise.
  if (touchedChangesets.length > 0) {
    console.log(`Published source changed and ${touchedChangesets.length} changeset(s) touched:`)
    for (const f of touchedChangesets) console.log(`  + ${f}`)
    process.exit(0)
  }

  if (reason) {
    console.log(`Published source changed with no changeset, skipped on purpose:\n  ${reason}`)
    process.exit(0)
  }

  console.error('\n  This branch changes published source but adds no changeset.\n')
  for (const f of shipped.slice(0, 20)) console.error(`    ${f}`)
  if (shipped.length > 20) console.error(`    …and ${shipped.length - 20} more`)
  console.error(`
    Add one:

        pnpm changeset

    Write it for someone reading the release notes: what was wrong, what they get now.

    If this genuinely needs no release note — a comment, a rename with no behaviour change —
    say so in the PR body:

        <!-- no-changeset: comment-only follow-up to #123 -->
  `)
  process.exit(1)
}

// Only when run directly: the tests import `extractReason` from here.
// `realpathSync`: `import.meta.url` is already resolved, `argv[1]` is not, so invoking
// through a symlink skipped `main()` entirely and the gate reported success having done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
