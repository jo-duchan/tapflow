import fs from 'node:fs'
import path from 'node:path'
import { hashFiles, walk } from './artifact-hash.mjs'

/**
 * What ties the committed injected library to the sources it was built from.
 *
 * `bin/libtapflow-nethook.dylib` is a prebuilt committed to the repo, and until #653 it had no build
 * script either — the flags lived in whichever shell last produced it. So the failure this catches was
 * not merely possible, it was the normal case: **edit `network-hook.m`, forget the rebuild, and the
 * suite stays green while the shipped binary does the old thing.** Nothing else in the repo can see
 * that, because every test that exercises the network hook talks to a fake dylib path.
 *
 * **Unlike the network filter, a contributor can fix a failure here.** That extension is Developer-ID
 * signed and notarized on a maintainer's Mac — a red guard there is a handoff. This one needs only
 * Xcode's command-line tools, and `packages/ios-agent/build-nethook.sh` reproduces it: the flags were
 * recovered from the committed binary and confirmed by a rebuild whose every section matched byte for
 * byte. The failure messages below say so, because sending someone to a maintainer for a build they
 * can run themselves is its own kind of wrong answer.
 *
 * **Recording the source hash alone would not catch it**, for the reason the netfilter guard states
 * and which applies unchanged: whoever forgets the rebuild forgets the record too, both values stay
 * consistent with each other, and the check passes. The artifact's hash is recorded as well, and
 * `build-nethook.sh` writes both in the step that produces the binary.
 *
 * What it does **not** claim: that the committed binary was built from the committed sources. Nothing
 * here can say that. It says the two were recorded together and neither has moved since.
 */
export const AGENT_DIR = 'packages/ios-agent'
export const SHIPPED_DYLIB = `${AGENT_DIR}/bin/libtapflow-nethook.dylib`
export const RECORD = `${AGENT_DIR}/nethook-shipped.json`

/**
 * Everything whose change means the dylib should be rebuilt.
 *
 * `build-nethook.sh` is an input for the same reason `build.sh` is one next door: it changes what is
 * produced without touching a line of source. Dropping `-O2` or moving the deployment target yields a
 * different binary from identical `.m` and `.c`.
 *
 * `inline-hook.h` is here and not merely implied by the `.c`: a changed macro or struct layout is a
 * changed binary, and the header is where those live.
 */
const SOURCE_FILES = ['src/network-hook.m', 'src/hook-decisions.h', 'src/inline-hook.c', 'src/inline-hook.h', 'src/app-observer.m', 'build-nethook.sh']

/**
 * **A declared input that is not there is an error, not an empty set.**
 *
 * The same rule the netfilter guard learned: a skipped missing file drops it from the hash silently,
 * and the file-count floor cannot see it — the count is computed from the same list that lost the
 * entry, so it agrees with itself.
 */
export function collectSources(repo) {
  const base = path.join(repo, AGENT_DIR)
  const declared = SOURCE_FILES.map((f) => {
    const p = path.join(base, f)
    if (!fs.existsSync(p)) throw new Error(`nethook guard: declared source file is missing: ${AGENT_DIR}/${f}`)
    return p
  })

  // **And the mirror of that rule: a file that exists but was never declared.**
  //
  // This list is fixed where the netfilter guard globs a directory, so the next local header pulled
  // in by an `#import "..."` is compiled into the dylib while its changes move no hash at all — the
  // guard would go on certifying a binary built from something it does not read. Measured: adding
  // `src/tf-extra.h` and editing it left `computeRecord().sources` byte-identical.
  //
  // System headers are not this: `#import <...>` is the SDK's, and hashing it would report a change
  // for every Xcode update and nothing else.
  for (const file of declared) {
    const dir = path.dirname(file)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^\s*#\s*(?:import|include)\s+"([^"]+)"/gm)) {
      const target = path.resolve(dir, m[1])
      if (!fs.existsSync(target)) continue
      if (declared.includes(target)) continue
      throw new Error(
        `nethook guard: ${path.relative(base, file)} includes ${m[1]}, which is not in SOURCE_FILES.\n`
        + '  It is compiled into the dylib, so its changes must move the source hash. Add it.',
      )
    }
  }
  return declared
}

/** One file, walked rather than read directly so an artifact that becomes a directory is not silently
 *  hashed as nothing. */
export function collectArtifactFiles(repo) {
  const p = path.join(repo, SHIPPED_DYLIB)
  if (!fs.existsSync(p)) return []
  return fs.statSync(p).isDirectory() ? walk(p).sort() : [p]
}

export function computeRecord(repo) {
  const sources = collectSources(repo)
  const artifact = collectArtifactFiles(repo)
  return {
    sources: hashFiles(path.join(repo, AGENT_DIR), sources),
    sourceFileCount: sources.length,
    dylib: hashFiles(path.join(repo, AGENT_DIR), artifact),
    dylibBytes: artifact.reduce((n, f) => n + fs.statSync(f).size, 0),
  }
}

export function readRecord(repo) {
  const p = path.join(repo, RECORD)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}
