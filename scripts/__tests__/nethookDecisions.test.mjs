import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// **The header directory is overridable, and that is what makes mutation testing cost nothing.**
// `mutate-nethook.sh` copies the header somewhere else, breaks the copy, and points this at it — so
// the checkout is never written to and a build racing the run cannot pick up a broken source. Layer 1
// learned that the expensive way: three times in one day a signed extension was built from a source
// a mutation had deliberately broken.
const HEADER_DIR = process.env.NETHOOK_HEADER_DIR ?? path.join(REPO, 'packages/ios-agent/src')
const HARNESS = path.join(REPO, 'scripts/__tests__/fixtures/nethook-decisions.c')

/**
 * **The injected library's decisions, compiled and run — not read.**
 *
 * `packages/ios-agent/src/network-hook.m` is 1233 lines of Objective-C that patches libsystem
 * functions inside a simulator. Almost none of it stands up in a test: the patching needs 16K page
 * protection, the path monitor needs a booted device, the descriptor scan needs live sockets. What is
 * left once those are peeled away is `src/hook-decisions.h`, and this compiles that header for real
 * and asks it questions.
 *
 * **It runs here rather than on a macOS runner because it can.** Measured before choosing: the header
 * builds with a bare `clang -Wall -Wextra -Werror` and no simulator SDK — it uses only `ntohl`,
 * `IN6_IS_ADDR_LOOPBACK`, `IN6_IS_ADDR_V4MAPPED` and `snprintf`. An XCTest target would have cost the
 * `macos-15` job, which is already twelve minutes, for logic that needs none of it.
 *
 * Every expectation is here. The harness prints what the function returned and nothing else, so a
 * failure names a case rather than an exit code.
 */
let bin
let workDir

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nethook-decisions-'))
  bin = path.join(workDir, 'harness')
  // **A compiler that is missing is a failure, not a skip.** A skipped suite reads as a passing one
  // in a summary, and this is the only thing that judges these decisions at all.
  execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-I', HEADER_DIR, '-o', bin, HARNESS], {
    stdio: 'pipe',
  })
})

// **`mutate-nethook.sh` runs this suite twenty-three times per invocation**, so a directory left
// behind is not one directory. Measured before adding this: 133 of them under `os.tmpdir()`.
// `afterAll` runs even when `beforeAll` threw, which is the case that leaves the compiler's output.
afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
})

const ask = (...args) => execFileSync(bin, args.map(String), { encoding: 'utf8' }).trim()

describe('which peers survive a cut', () => {
  // `tf_cut_open_connections` shuts down the app's external sockets when a device goes offline.
  // Loopback is what it must leave alone: tapflow's own UI-tree runner listens inside the simulator
  // (#433) and Metro serves over the host's loopback, so cutting either turns "take this device
  // offline" into "break the session".
  it.each([
    ['127.0.0.1', 1, 'the canonical one'],
    ['127.0.0.2', 1, 'not just .0.1 — the whole /8'],
    ['127.255.255.254', 1, 'the top of the range'],
    ['126.255.255.255', 0, 'one below the range'],
    ['128.0.0.0', 0, 'one above it'],
    ['10.0.2.2', 0, "the simulator's route to the host — external, and cut on purpose"],
    ['0.0.0.0', 0, 'unspecified is not loopback'],
  ])('v4 %s is loopback=%i (%s)', (ip, want) => {
    expect(Number(ask('loopback4', ip))).toBe(want)
  })

  it.each([
    ['::1', 1, 'v6 loopback'],
    ['::ffff:127.0.0.1', 1, 'a v4 loopback through a v6 socket, which is what a dual-stack resolver hands back for localhost'],
    ['::ffff:127.255.255.254', 1, 'the mapped range, not just the mapped address'],
    ['::ffff:10.0.2.2', 0, 'mapped but external'],
    ['2001:db8::1', 0, 'an ordinary v6 peer'],
    ['::', 0, 'unspecified'],
    ['fe80::1', 0, 'link-local is not loopback'],
  ])('v6 %s is loopback=%i (%s)', (ip, want) => {
    expect(Number(ask('loopback6', ip))).toBe(want)
  })

  // `getpeername` can answer for a descriptor that is neither v4 nor v6 — a unix domain socket, for
  // one. Neither branch runs, and the answer has to be "not loopback" rather than whatever the
  // uninitialised read would say.
  it('an address family that is neither is not loopback', () => {
    expect(Number(ask('loopback-family', 1)), 'AF_UNIX').toBe(0)
    expect(Number(ask('loopback-family', 0)), 'AF_UNSPEC').toBe(0)
  })

  // **The family guard, and an all-zero body cannot see it.** With the body zeroed both branches
  // answer 0 whether or not the `AF_INET6` check runs, so the case above passes over a version that
  // has no guard at all — a review measured exactly that mutation surviving all 34 tests. These carry
  // a loopback-shaped body under a family that is not v6, which is the input that separates them.
  it.each([
    ['::1', 'a v6 loopback body'],
    ['::ffff:127.0.0.1', 'a mapped v4 loopback body'],
  ])('a non-v6 family carrying %s is still not loopback (%s)', (payload) => {
    expect(Number(ask('loopback-family', 1, payload)), 'AF_UNIX').toBe(0)
    expect(Number(ask('loopback-family', 17, payload)), 'AF_INET-adjacent family').toBe(0)
  })
})

describe('whether a call is refused', () => {
  // **The install gate outranks everything.** The patch cannot be removed, so a refusal on the second
  // target leaves the first one live; without this, `getaddrinfo` stayed hooked in a process whose
  // verdict said `installed:false` — the agent reporting layer 2 broken while a piece of it quietly
  // worked. Until every hook is in, every replacement tail-calls the original.
  it.each([
    [0, 1, 1, 0, 'a partial install never blocks, whatever else is set'],
    [0, 0, 0, 0, 'and it is not blocking for the other reason either'],
    [1, 0, 1, 1, 'the condition file the agent writes'],
    [1, 1, 0, 1, 'the in-process flag a self-check arms'],
    [1, 1, 1, 1, 'both'],
    [1, 0, 0, 0, 'installed and nothing asking'],
  ])('live=%i forced=%i file=%i blocks=%i (%s)', (live, forced, file, want) => {
    expect(Number(ask('blocking', live, forced, file))).toBe(want)
  })
})

describe('which process gets hooked', () => {
  // dyld injects into every process the simulator starts. The hooks belong in exactly one.
  it.each([
    ['A', 'com.x', 'com.x', 1, 'the app under test'],
    ['A', 'com.x', 'com.y', 0, 'every other app in the same simulator'],
    ['A', 'com.x', 'com.x.helper', 0, 'a prefix is not a match'],
    ['A', 'com.x.helper', 'com.x', 0, 'nor the other way'],
    ['--null', 'com.x', 'com.x', 0, 'no udid means no per-simulator namespace'],
    ['', 'com.x', 'com.x', 0, 'an exported-but-blank SIMULATOR_UDID is not a udid'],
    ['A', '--null', 'com.x', 0, 'no target named — the default is off'],
    ['A', '', 'com.x', 0, 'an exported-but-blank target is not a target'],
    ['A', 'com.x', '--null', 0, 'a bundle with no identifier'],
  ])('udid=%s target=%s me=%s activates=%i (%s)', (udid, target, me, want) => {
    expect(Number(ask('activate', udid, target, me))).toBe(want)
  })
})

// The gates run in every process of the simulator before `main`, and a daemon aborts on Objective-C there (measured:
// fileproviderd and GSSCred, which left every web view white). An app runs from directly inside its `.app`; no daemon
// does, so the executable's path is the question asked before any bundle is read.
describe('who is an app, before anything reads a bundle', () => {
  it.each([
    ['/Users/me/Library/Developer/CoreSimulator/Devices/U/data/Containers/Bundle/Application/X/wdiodemoapp.app/wdiodemoapp', 1, 'an installed app'],
    ['/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/Applications/MobileSafari.app/MobileSafari', 1, 'a system app'],
    ['/Volumes/V/System/Library/Frameworks/FileProvider.framework/Support/fileproviderd', 0, 'a daemon in a framework'],
    ['/Volumes/V/System/Library/PrivateFrameworks/Heimdal.framework/Helpers/GSSCred', 0, 'a helper'],
    ['/Volumes/V/usr/libexec/axassetsd', 0, 'a daemon in libexec'],
    ['/Applications/X.app/PlugIns/Share.appex/Share', 0, 'an app extension is not an app'],
    ['/Applications/X.app/Frameworks/Helper', 0, 'something deeper inside an app'],
    ['/Applications/X.app/', 0, 'a bundle with no executable named'],
    ['/Applications/.app/X', 0, 'a directory called only .app'],
    // Review: the lower bound on the slash, which keeps `slash[-5]` inside the string.
    ['.app/X', 0, 'a path that is only .app'],
    ['/Applications/X.application/X', 0, 'an extension that only begins with app'],
    ['X.app/X', 1, 'a relative path still ends in its bundle'],
    ['--null', 0, 'no path'],
    ['', 0, 'an empty path'],
  ])('%s is an app: %i (%s)', (exe, want) => {
    expect(Number(ask('inapp', exe))).toBe(want)
  })
})

describe('how far the descriptor scan goes', () => {
  const ask2 = (...a) => ask(...a).split('\t').map(Number)

  // `RLIMIT_NOFILE` can be `OPEN_MAX`, and walking millions of descriptors on a toggle is worse than
  // missing the tail of a process holding more than the cap.
  it.each([
    [1, 256, 256, 0, 'a limit below the cap is used as it stands'],
    [1, 8192, 8192, 0, 'exactly the cap is not a cap'],
    [1, 8193, 8192, 1, 'one over is'],
    [1, 1048576, 8192, 1, 'and so is a limit of the size that made this necessary'],
    [0, 999999, 1024, 0, 'an unreadable or infinite limit falls back to 1024, not to the huge value'],
    // **Above `INT_MAX`, which is where the cast used to turn the bound negative.** A negative bound
    // makes the caller's `for (int fd = 0; fd < max; …)` walk nothing while `capped` says it did not
    // trim — no connection cut and no line saying why. The table stopped one row short of it.
    [1, 2147483648, 8192, 1, 'a limit above INT_MAX still clamps, and still says it clamped'],
    // **A string, because the literal cannot survive JavaScript.** `9223372036854775806` is past
    // `Number.MAX_SAFE_INTEGER`, so `String()` of it renders `9223372036854776000` — rounded, and
    // *above* `RLIM_INFINITY` rather than below it. The case would still have passed, on an input the
    // caller's `!= RLIM_INFINITY` test rejects, while claiming to cover the largest value that test
    // lets through.
    [1, '9223372036854775806', 8192, 1, 'and so does the largest finite limit the caller lets through'],
  ])('haveLimit=%i soft=%i gives %i capped=%i (%s)', (have, soft, bound, capped) => {
    expect(ask2('fdscan', have, soft)).toEqual([bound, capped])
  })

  // **The flag exists so the truncation is audible.** A silent cap looks exactly like a process with
  // nothing left to cut, and that is the reading a person would take from the log.
  it('says it trimmed only when it trimmed', () => {
    expect(ask2('fdscan', 1, 8192)[1], 'at the boundary').toBe(0)
    expect(ask2('fdscan', 1, 8193)[1], 'just past it').toBe(1)
  })
})

describe('where the offline flag lives', () => {
  it('is /tmp/tapflow-offline-<udid>', () => {
    const [written] = ask('condpath', '752C0B5F-B060-4A5A-9D22-1DE9DAD483B3').split('\t')
    expect(written).toBe('/tmp/tapflow-offline-752C0B5F-B060-4A5A-9D22-1DE9DAD483B3')
  })

  // **The udid is not decoration.** The host's `/tmp` is the same `/tmp` inside every simulator on
  // the Mac, so a path without it takes every other session offline at once.
  it('changes with the udid', () => {
    const a = ask('condpath', 'AAA').split('\t')[0]
    const b = ask('condpath', 'BBB').split('\t')[0]
    expect(a).not.toBe(b)
  })

  // A truncated path is a device that can never be taken offline, and `snprintf` returning the
  // length it wanted is the only thing that can say so. Silence here would look like success.
  it('says how long the path wanted to be when it does not fit', () => {
    const [written, wanted] = ask('condpath', 'ABCDEFGHIJ', 12).split('\t')
    expect(written.length, 'the buffer was filled to its limit').toBe(11)
    expect(Number(wanted), 'and the full length is reported, not the truncated one').toBe(31)
  })

  /**
   * **The other half of the contract is in TypeScript, and nothing compiles both.**
   *
   * `SimulatorNetwork.ts` writes the file the header above reads. A drift makes the toggle do
   * nothing at all — silently, with the dashboard still reporting the device offline — because the
   * dylib stats a path nobody writes.
   */
  it('agrees with the path the agent writes', () => {
    const ts = fs.readFileSync(path.join(REPO, 'packages/ios-agent/src/SimulatorNetwork.ts'), 'utf8')

    const template = ts.match(/return `\$\{this\.conditionDir\}\/([a-z-]+)\$\{udid\}`/)
    expect(template, 'SimulatorNetwork.ts no longer builds the condition path the way this reads it').not.toBeNull()

    const dir = ts.match(/this\.conditionDir = opts\.conditionDir \?\? '([^']+)'/)
    expect(dir, 'the default condition directory moved or was renamed').not.toBeNull()

    const agentPath = `${dir[1]}/${template[1]}UDID`
    const hookPath = ask('condpath', 'UDID').split('\t')[0]
    expect(hookPath, 'the injected library and the agent disagree about where the offline flag lives')
      .toBe(agentPath)
  })
})
