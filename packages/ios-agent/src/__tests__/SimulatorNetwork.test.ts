import { execFileSync } from 'child_process'
import { appendFileSync, chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulatorNetwork, LAUNCH_VERDICT_DEADLINE_MS } from '../SimulatorNetwork.js'

const UDID = 'AAAAAAAA-1111-2222-3333-444444444444'
const OTHER = 'BBBBBBBB-5555-6666-7777-888888888888'
const THIRD = 'CCCCCCCC-9999-AAAA-BBBB-CCCCCCCCCCCC'

/**
 * A stand-in for the container app.
 *
 * It records **how many condition files existed at the moment it ran**, which is what makes the
 * layer ordering assertable at all: the files are written by this process, so their order relative to
 * the rule is invisible unless something observes it from the outside.
 */
function fakeHostBinary(dir: string, log: string, sleepMs = 0, failNth = 0): string {
  const path = join(dir, `fake-filter-host${sleepMs}-${failNth}`)
  // The rule arrives as a delta (`--add` / `--remove`); this script applies it to a rule it keeps.
  // Exits non-zero while a sentinel file exists, so a test can take the container app away between
  // one toggle and the next — which is the only way to reach the failure path from a device that is
  // already offline, and that starting state is where the bug was.
  //
  // `enter:` is logged on the way IN and the rule on the way out, so a test can see two runs
  // overlapping. Without both marks, concurrent runs and serialised ones leave the same log.
  // `failNth` fails one specific invocation and lets the rest through, which is what a *transient*
  // failure looks like. A permanently broken app (the `BREAK` sentinel) cannot show the divergence
  // this exists for, because the recovery write fails too.
  // It also stands in for the **provider**, because the class now asks one. `--confirm` answers from
  // the rule this script last wrote, and a state file is refreshed beside it — the two artefacts a
  // real provider produces. A fake that only recorded the write would let every confirmation fail and
  // turn each of these tests green for the wrong reason.
  //
  // `--confirm` is answered before the failure counters, so `failNth` still counts rule writes only.
  // `BREAK` comes first and takes the confirmation down with it: a container app that cannot run
  // cannot answer either.
  const ruleToJson = `awk -F, '{o="";for(i=1;i<=NF;i++){if($i!=""){o=o (o==""?"":",") "\\"" $i "\\""}} print "[" o "]"}'`
  writeFileSync(
    path,
    `#!/bin/sh\n`
    + `[ -e "${dir}/BREAK" ] && exit 1\n`
    + `if [ "$1" = "--confirm" ]; then\n`
    // Three sentinels, one per way a confirmation fails, because they are not the same code path in
    // the class: no answer at all, an answer saying nothing is being enforced, and a call that hangs
    // — which is what a dead provider actually does (measured 3/3, it blocks to the caller's
    // deadline rather than erroring).
    + `  [ -e "${dir}/NO_CONFIRM" ] && exit 7\n`
    + `  [ -e "${dir}/CONFIRM_HANG" ] && sleep 5\n`
    + `  if [ -e "${dir}/NOT_ENFORCING" ]; then printf '{"enforcing":false,"rule":[],"pid":1}\\n'; exit 0; fi\n`
    // Enforcing, and holding something other than what the caller just wrote — the one shape that
    // reaches the mismatch branch *through XPC*. Without it only the file channel ever disagrees,
    // so the channel name in that warning could be wrong for the path 99% of traffic takes.
    + `  [ -e "${dir}/CONFIRM_EMPTY" ] && { printf '{"enforcing":true,"rule":[],"pid":7}\\n'; exit 0; }\n`
    + `  R=$(cat "${dir}/rule" 2>/dev/null || echo "")\n`
    + `  printf '{"enforcing":true,"rule":%s,"pid":1}\\n' "$(echo "$R" | ${ruleToJson})"\n`
    + `  exit 0\n`
    + `fi\n`
    + (failNth > 0
      ? `N=$(cat "${dir}/runs" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "${dir}/runs"\n`
        + `[ "$N" = "${failNth}" ] && exit 1\n`
      : '')
    // **Applies the delta to a rule it keeps, rather than recording what it was told.** The host
    // merges now, so a fake that only echoed its arguments would let a test assert the right argv
    // over a rule that never changed — and the whole defect being fixed is about what the rule ends
    // up holding for devices this caller never named.
    + `ADD=""; REM=""; ARGV="$*"\n`
    + `while [ $# -gt 0 ]; do case "$1" in\n`
    + `  --add) ADD="\${2-}"; shift 2 ;;\n`
    + `  --remove) REM="\${2-}"; shift 2 ;;\n`
    + `  *) shift ;;\n`
    + `esac; done\n`
    + (sleepMs > 0 ? `printf 'enter:%s\\n' "$ADD" >> "${log}"\nsleep ${sleepMs / 1000}\n` : '')
    // **Publishes both files the way the real ones are published, and the scratch is per run.**
    //
    // The provider writes its state file with `options: .atomic` (`Extension/Provider.swift`), so a
    // reader never sees half of one — but `printf > file` truncates and then writes, and a reader
    // catching that window gets a parse failure. `readFilterState` cannot tell that from *no file*,
    // and no file means every offline device has lost its enforcement: the watcher then rewrites the
    // rule without them.
    //
    // That is not hypothetical. `test (22)` on #682 failed with the rule empty where one entry was
    // expected, because one instance's liveness tick read `state.json` while another instance's run
    // was rewriting it. Node 24 passed, and the two commits before it passed — the window is small,
    // which is what made it a flake rather than a failure.
    //
    // `.rem` and `.all` get the pid for the same reason: `dir` is shared by every instance a test
    // makes, so two overlapping runs were reading each other's half-written scratch.
    + `S="${dir}/.scratch.$$"\n`
    + `CUR=$(cat "${dir}/rule" 2>/dev/null || echo "")\n`
    + `printf '%s' "$REM" | tr ',' '\\n' | grep -v '^$' > "$S.rem"\n`
    + `printf '%s,%s' "$CUR" "$ADD" | tr ',' '\\n' | grep -v '^$' | sort -u > "$S.all"\n`
    + `if [ -s "$S.rem" ]; then OUT=$(grep -vxF -f "$S.rem" "$S.all" | paste -sd, -); else OUT=$(paste -sd, - < "$S.all"); fi\n`
    + `printf '%s' "$OUT" > "$S.rule" && mv "$S.rule" "${dir}/rule"\n`
    // **The counts are carried across a rewrite, because the provider carries them.** Its render
    // serialises a store that survives; it does not start each file from nothing. A double that
    // dropped `droppedByDevice` on every host run made the stale-count case unreachable — the very
    // case #654's episode boundary exists for — and a test written against it passed on a device that
    // had no drops at all.
    + `DROPS=$(cat "${dir}/drops.json" 2>/dev/null || echo '{}')\n`
    // `NO_STATE` suppresses the file the way `NO_CONFIRM` suppresses the answer, and the pair is what
    // a refusal now needs. The two channels are independent since the file became the fallback for a
    // provider whose XPC listener a replacement took away — so `NO_CONFIRM` alone no longer means
    // "could not find out", and a test that still assumes it does is asserting the old contract.
    // `pid` is published because the provider publishes it: two of them are briefly alive during a
    // replace, both writing this path, and a reader has no other way to say whose rule it read.
    + `if [ ! -e "${dir}/NO_STATE" ]; then\n`
    // `IGNORE_RULE` publishes the rule as it was *before* this delta — a provider holding
    // something other than what the caller just wrote, which is what a second writer looks like
    // from here. Without it the disagreement branch cannot fire: this fake always applies the
    // delta it was given, so its file always agrees with the request that produced it.
    + `  PUB="$OUT"; [ -e "${dir}/IGNORE_RULE" ] && PUB="$CUR"\n`
    // **`printf '%s\\n'`, and the newline is the whole of a harness defect that hid for months.**
    // `awk` runs its block per input *record*, and `printf '%s'` of an empty rule writes zero bytes —
    // no record, no output, so the substitution was empty and the line rendered `"rule":,` — invalid
    // JSON. `readFilterState` cannot tell a bad file from no file, so every test whose published rule
    // was empty was reading *absence* and agreeing with itself. The trailing newline gives awk one
    // empty record, which is what renders `[]`.
    + `  printf '{"at":%s,"pid":1,"pulseSeconds":1,"rule":%s,"droppedByDevice":%s}\\n' "$(date +%s)" "$(printf '%s\\n' "$PUB" | ${ruleToJson})" "$DROPS" > "$S.state" && mv "$S.state" "${dir}/state.json"\n`
    + `fi\n`
    + `rm -f "$S.rem" "$S.all"\n`
    // argv goes to its own file: the log line still carries the **resulting rule**, which is what the
    // assertions below are about, and argv is available separately for the tests that are about what
    // this run named rather than what it produced.
    + `printf '%s\\n' "$ARGV" >> "${dir}/argv.log"\n`
    + `printf 'rule:%s cond:%s\\n' "$OUT" "$(ls "${dir}" | grep -c '^tapflow-offline-')" >> "${log}"\n`,
    { mode: 0o755 },
  )
  return path
}

describe('SimulatorNetwork', () => {
  let dir: string
  let log: string
  let statusBar: string[]
  let env: string[]
  let simctl: {
    setStatusBarOffline: (udid: string, offline: boolean) => Promise<void>
    setSimulatorEnv: (udid: string, name: string, value: string) => Promise<void>
  }

  /**
   * A real file, because `state()` now refuses to vouch for layer 2 when the library is not on disk.
   *
   * These fixtures pointed at `/fake/libtapflow-nethook.dylib` — a path that has never existed — and
   * every assertion below passed, which is precisely the gap the check closes: nothing in this suite
   * had an opinion about whether the thing being injected was there. It is not the real dylib and
   * does not need to be; what is under test is the agent's reasoning, and `existsSync` is the whole
   * question it asks.
   */
  const hookPath = () => join(dir, 'libtapflow-nethook.dylib')

  const verdictPath = (udid: string) => join(dir, `tapflow-nethook-${udid}.json`)
  const conditionPath = (udid: string) => join(dir, `tapflow-offline-${udid}`)

  /** Every device this test reported as no longer enforced. */
  let lost: string[]

  const make = (hostBinary?: string, confirmDeadlineMs?: number, stateFiles?: string[]) => {
    const n = new SimulatorNetwork(simctl, {
      filterHostBinary: hostBinary ?? fakeHostBinary(dir, log),
      conditionDir: dir,
      verdictDir: dir,
      nethookDylib: hookPath(),
      // **Pointed at this test's own directory, and that is not only hygiene.** The default is the
      // path the real provider writes on this Mac, so a suite left on the default would read whatever
      // the developer's own filter happens to be enforcing — green or red depending on the machine.
      filterStateFiles: stateFiles ?? [join(dir, 'state.json')],
      onEnforcementLost: (udid) => { lost.push(udid) },
      livenessIntervalMs: 20,
      // Only set where a test is about the fallback running out of time; the default is 3s.
      ...(confirmDeadlineMs === undefined ? {} : { filterConfirmDeadlineMs: confirmDeadlineMs }),
    })
    made.push(n)
    return n
  }
  /** Disposed in `afterEach`: the liveness watcher is the first thing here that outlives a test. */
  let made: SimulatorNetwork[]

  /** The hooks reported themselves installed — the ordinary case for a device with an app running. */
  const armed = (udid = UDID) => writeFileSync(verdictPath(udid), JSON.stringify({ installed: true }))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tapflow-net-'))
    writeFileSync(join(dir, 'libtapflow-nethook.dylib'), '')
    log = join(dir, 'calls.log')
    statusBar = []
    env = []
    lost = []
    made = []
    simctl = {
      setSimulatorEnv: vi.fn(async (udid: string, name: string, value: string) => {
        env.push(`${udid}:${name}=${value}`)
      }),
      setStatusBarOffline: vi.fn(async (udid: string, offline: boolean) => {
        // Appended to the same log as the filter rule so the ORDER between layers is observable —
        // that ordering is this class's actual contract, not an implementation detail.
        statusBar.push(`${udid}:${offline}`)
        appendFileSync(log, `statusbar:${offline}\n`)
      }),
    }
  })

  afterEach(() => {
    // **Restored here, not per test.** The deadline cases below use fake timers, and a leak turns
    // every `vi.waitFor` in the liveness suite into a five-second timeout — measured: six of them.
    for (const n of made) n.dispose()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function readAll(): string {
    return existsSync(log) ? readFileSync(log, 'utf8') : ''
  }

  /** Just the rule lines, in the order the container app was invoked. */
  function rules(): string[] {
    return readAll().split('\n').filter(l => l.startsWith('rule:'))
  }

  /** What each host run was asked to change, as opposed to what the rule became. */
  function argv(): string[] {
    if (!existsSync(join(dir, 'argv.log'))) return []
    return readFileSync(join(dir, 'argv.log'), 'utf8').trim().split('\n').filter(Boolean)
  }

  it('reports the device offline and steerable once every layer is applied', async () => {
    armed()
    const net = make()

    await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })
    expect(existsSync(conditionPath(UDID))).toBe(true)
    expect(statusBar).toEqual([`${UDID}:true`])
  })

  it('applies the filter rule BEFORE the condition file', async () => {
    armed()
    const net = make()
    await net.setOffline(UDID, true)

    // The dylib cuts the app's open sockets the instant the condition file appears. If the filter is
    // not already dropping new flows by then, the app reconnects and the reconnected socket outlives
    // the toggle — reproduced exactly that way while stepping the layers separately.
    expect(rules()).toEqual([`rule:${UDID} cond:0`])
    expect(existsSync(conditionPath(UDID))).toBe(true)
  })

  it('applies the filter rule BEFORE the status bar', async () => {
    armed()
    const net = make()
    await net.setOffline(UDID, true)

    // The status bar reports; it must not claim a state before the state is true.
    const order = readAll()
    expect(order.indexOf('rule:')).toBeLessThan(order.indexOf('statusbar:'))
  })

  it('carries every offline simulator in the rule, because the filter takes the whole set', async () => {
    armed()
    armed(OTHER)
    const net = make()

    await net.setOffline(UDID, true)
    await net.setOffline(OTHER, true)

    expect(rules().at(-1)).toBe(`rule:${UDID},${OTHER} cond:1`)
  })

  it('leaves the other simulator alone when one goes back online', async () => {
    armed()
    armed(OTHER)
    const net = make()
    await net.setOffline(UDID, true)
    await net.setOffline(OTHER, true)

    await net.setOffline(UDID, false)

    expect(rules().at(-1)).toBe(`rule:${OTHER} cond:2`)
    expect(existsSync(conditionPath(UDID))).toBe(false)
    expect(existsSync(conditionPath(OTHER))).toBe(true)
  })

  it('does not report an offline device as online when the rule cannot be written', async () => {
    // The failure path used to delete from the set unconditionally and answer `offline: false`, so a
    // device that was already offline came back as online here **and from every later `state()`** —
    // with the rule and the condition file still saying otherwise. The one test that covered this
    // path started from a device that had never been offline, where deleting is accidentally right,
    // so inverting the line changed nothing.
    armed()
    const net = make()
    await net.setOffline(UDID, true)

    writeFileSync(join(dir, 'BREAK'), '')   // the container app stops working
    const after = await net.setOffline(UDID, false)

    expect(after).toEqual({ offline: true, available: false, reason: 'filter-unavailable' })

    // **The whole payload, and that is the gap #638 closed.** This used to compare `.offline` alone
    // with a comment explaining why it had to: `state()` looked only at the dylib's verdict, so for
    // this device — dylib fine, container app gone — it answered `available: true` in the same second
    // the call above answered `false`, and the reason it could have given (`not-armed`) prescribed a
    // reboot for something no reboot installs. `state()` now remembers what layer 1 was last found
    // doing, which is what makes one assertion cover both.
    expect(net.state(UDID)).toEqual({ offline: true, available: false, reason: 'filter-unavailable' })
  })

  it('does not report an online device as offline when the rule cannot be written', async () => {
    // The other direction of the same restore: a device that was online must not be left in the set
    // by a request that did not land.
    armed()
    const net = make()

    writeFileSync(join(dir, 'BREAK'), '')
    const after = await net.setOffline(UDID, true)

    expect(after).toEqual({ offline: false, available: false, reason: 'filter-unavailable' })
    expect(net.state(UDID).offline).toBe(false)
  })

  it('writes the rule back when a run fails after another has already committed', async () => {
    // **The failure serialising the runs introduced**, and it needs all three of concurrency, the
    // set being read at run time, and a transient failure — which is why the first attempt at this
    // test passed with the fix removed.
    //
    // Run 2 reads `this.offline` when it RUNS, by which point request 3 has already deleted UDID from
    // it — so it commits a set that request 3 asked for and request 2 did not. Request 3 then fails
    // and puts UDID back in memory. Without a further write the kernel rule says `OTHER` while this
    // class says UDID is offline: traffic alive, drawn as offline, which is the direction `setOffline`
    // calls filing bugs against an app that was never offline.
    //
    // **What this still verifies, and what it stopped verifying.** The memory assertion below is
    // live: delete the `if (was)` restore and the device comes back as online while the rule and the
    // condition file say otherwise. The rule assertion is not — a reviewer measured that removing the
    // restore branch's *write* leaves this green. Since the host merges deltas, run 2's own write
    // already carries UDID, so run 3's failed removal never took it out and there is nothing left for
    // the restore write to repair in this scenario. Reaching that write needs a run that removes
    // before the failure, which this burst does not produce. Said rather than left as a claim that
    // reads as enforced.
    armed()
    armed(OTHER)
    const net = make(fakeHostBinary(dir, log, 0, 3))
    await net.setOffline(UDID, true)                       // run 1
    await Promise.all([
      net.setOffline(OTHER, true),                         // run 2 — commits {OTHER}
      net.setOffline(UDID, false),                         // run 3 — fails, restores UDID
    ])

    expect(net.state(UDID).offline, 'the failed request must leave the device where it was').toBe(true)
    expect(rules().at(-1), 'the rule disagrees with the set').toContain(UDID)
  })

  it('drops a retired device from the rule even when this process never put it there', async () => {
    // An agent that restarted knows of no offline device, so `delete` answers false — and the write
    // used to be conditional on it. The rule is the host's, not this process's memory, so skipping it
    // left the udid named for the rest of the Mac's uptime, which is the outcome `forget` exists to
    // prevent.
    //
    // Mutation: restoring `if (this.offline.delete(udid))` fails here.
    const net = make()
    await net.forget(UDID)
    expect(rules(), 'forget wrote no rule at all').not.toEqual([])
  })

  it('does not claim offline when the container app is not installed', async () => {
    armed()
    const net = make(join(dir, 'does-not-exist'))

    await expect(net.setOffline(UDID, true)).resolves.toEqual({
      offline: false, available: false, reason: 'filter-unavailable',
    })
    // Nothing else may be applied on that path: a condition file with no filter behind it is the
    // half-state that tells an app it is offline while its traffic flows.
    expect(existsSync(conditionPath(UDID))).toBe(false)
    expect(statusBar).toEqual([])
  })

  it('says not-armed when nothing was delivered to the device', () => {
    // Never armed: the remedy is a reboot, which is what this reason prescribes.
    const net = make()
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'not-armed' })
  })

  it('says awaiting-app once the injection is in place but no app has run', async () => {
    // The common case, not an edge one — every iOS session looks like this between the device coming
    // up and its app starting. Reported as `not-armed` it prescribed a reboot, which fixes nothing,
    // and drew a control that does work as one that cannot.
    const net = make()
    await net.arm(UDID)
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'awaiting-app' })
  })

  it('still says awaiting-app while the launch is inside the dylib\'s own self-check', async () => {
    // **The control for the deadline, and the reason it is a deadline rather than a flag.** The
    // verdict is written from a constructor, which reads as instant and is not: the constructor runs
    // `tf_self_check()` first, and that waits up to three seconds on a semaphore. An absent verdict in
    // that window is a healthy install mid-check, and calling it broken there would report a working
    // one as dead.
    vi.useFakeTimers()
    const net = make()
    await net.arm(UDID)
    await net.target(UDID, 'com.example.app')
    net.markLaunched(UDID, 4242)
    vi.advanceTimersByTime(LAUNCH_VERDICT_DEADLINE_MS - 1)
    expect(net.state(UDID)).toMatchObject({ reason: 'awaiting-app' })
  })

  it('stops saying "launch an app" to a tester who already did', async () => {
    // **The behaviour this change exists for.** `state()` already guards the loud half — a
    // `DYLD_INSERT_LIBRARIES` path with nothing at it — because dyld ignores that without a word. A
    // library that *is* there and still does not load, from a wrong architecture or a runtime change,
    // is the same silence one step further along: no verdict is ever written, and `awaiting-app` then
    // tells someone who has launched an app to launch an app, for the life of the session.
    vi.useFakeTimers()
    const net = make()
    await net.arm(UDID)
    await net.target(UDID, 'com.example.app')
    net.markLaunched(UDID, 4242)
    vi.advanceTimersByTime(LAUNCH_VERDICT_DEADLINE_MS + 1)
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('gives a second launch its own window', async () => {
    // `target()` clears the verdict and re-marks, so the next app starts from waiting rather than
    // inheriting the previous one's failure — which would report an app that has not run yet on the
    // evidence of one that has exited.
    vi.useFakeTimers()
    const net = make()
    await net.arm(UDID)
    await net.target(UDID, 'com.example.app')
    net.markLaunched(UDID, 4242)
    vi.advanceTimersByTime(LAUNCH_VERDICT_DEADLINE_MS + 1)
    expect(net.state(UDID)).toMatchObject({ reason: 'hooks-not-installed' })

    await net.target(UDID, 'com.example.other')
    net.markLaunched(UDID, 4343)
    expect(net.state(UDID), 'the new app inherited the old one\'s verdict').toMatchObject({ reason: 'awaiting-app' })
  })

  it('does not carry a launch across a boot', async () => {
    // `arm()` runs on every boot. A launch recorded before it describes a process that no longer
    // exists, so leaving it behind would make a freshly booted device read as broken from its first
    // `state()` call — on the strength of an app that ran in the previous session.
    vi.useFakeTimers()
    const net = make()
    await net.arm(UDID)
    await net.target(UDID, 'com.example.app')
    net.markLaunched(UDID, 4242)
    vi.advanceTimersByTime(LAUNCH_VERDICT_DEADLINE_MS + 1)
    expect(net.state(UDID)).toMatchObject({ reason: 'hooks-not-installed' })

    await net.arm(UDID)
    expect(net.state(UDID), 'a boot inherited the previous session\'s launch').toMatchObject({ reason: 'awaiting-app' })

    // **And the pid is forgotten with it**, which is a second fact. Pids are reused, so a launch after
    // a boot can legitimately carry a number the previous session already saw — and if that number
    // were still remembered, the new process's window would never open and its failure would read as
    // "waiting for an app" forever.
    net.markLaunched(UDID, 4242)
    vi.advanceTimersByTime(LAUNCH_VERDICT_DEADLINE_MS + 1)
    expect(net.state(UDID), 'a reused pid was mistaken for the launch before the boot')
      .toMatchObject({ reason: 'hooks-not-installed' })
  })

  it('starts no clock for a launch that never happened', async () => {
    // **The window opens on a process, not on an intent.** The mark was first set at the top of
    // `target()`, above `simctl spawn … launchctl setenv` and above `simctl launch` — so a launch
    // that failed outright (a wrong bundle id, an app not installed) left it standing, and ten
    // seconds later the control reported the hooks as broken over a launch nobody ever completed.
    vi.useFakeTimers()
    const net = make()
    await net.arm(UDID)
    await net.target(UDID, 'com.example.app')
    vi.advanceTimersByTime(LAUNCH_VERDICT_DEADLINE_MS * 3)
    expect(net.state(UDID), 'a launch that never started was reported as a broken injection')
      .toMatchObject({ reason: 'awaiting-app' })

    // And a launch whose pid could not be read is the same thing: `simctl launch` prints
    // `bundle: <pid>` and `launchApp` returns null when it cannot parse one, which is not evidence
    // that a process exists. Measured — without this the null case opened a window.
    net.markLaunched(UDID, null)
    vi.advanceTimersByTime(LAUNCH_VERDICT_DEADLINE_MS + 1)
    expect(net.state(UDID), 'an unreadable pid was treated as a started process')
      .toMatchObject({ reason: 'awaiting-app' })
  })

  it('starts no clock when the launch produced no new process', async () => {
    // `simctl launch` is issued without `--terminate-running-process`, so launching a bundle that is
    // already running returns the existing pid and starts nothing — and the verdict is written from a
    // dyld constructor, once per process. Nothing will rewrite the file `target()` just deleted, so a
    // deadline here would report a permanently dead control over an app whose hooks are live. That
    // case stays as wrong as it was before this change and no worse; #692 carries the decision.
    vi.useFakeTimers()
    const net = make()
    await net.arm(UDID)
    await net.target(UDID, 'com.example.app')
    net.markLaunched(UDID, 4242)
    vi.advanceTimersByTime(LAUNCH_VERDICT_DEADLINE_MS + 1)
    expect(net.state(UDID)).toMatchObject({ reason: 'hooks-not-installed' })

    // The same app relaunched: same pid, so the clock must not restart either.
    await net.target(UDID, 'com.example.app')
    net.markLaunched(UDID, 4242)
    expect(net.state(UDID), 'a relaunch that started nothing opened a new window')
      .toMatchObject({ reason: 'hooks-not-installed' })
  })

  it('does not claim the injection is in place when the environment could not be set', async () => {
    simctl.setSimulatorEnv = vi.fn(async () => { throw new Error('simctl spawn failed') })
    const net = make()
    await expect(net.arm(UDID)).rejects.toThrow()
    // Nothing was delivered, so "waiting for an app" would send the tester to launch one forever.
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'not-armed' })
  })

  it('stops claiming the injection after the device is retired', async () => {
    const net = make()
    await net.arm(UDID)
    await net.forget(UDID)
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'not-armed' })
  })

  it('says hooks-not-installed when the dylib ran and proved it could not hook', () => {
    writeFileSync(verdictPath(UDID), JSON.stringify({ installed: false }))
    const net = make()
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('treats an unreadable verdict as unconfirmed, never as an install', () => {
    // **The half that does not change: a truncated file is not evidence the hooks took.** Reading it
    // as an install hands a healthy control to a device nobody can vouch for.
    //
    // What changed is which unavailable reason it is. `hooks-not-installed` means the library ran and
    // *proved* its hooks did not take, which a truncated file shows nothing of — it is the library
    // caught mid-write, which it does non-atomically (#653). `state-unconfirmed` says the read could
    // not be confirmed and to look again, which is what actually resolves it.
    writeFileSync(verdictPath(UDID), '{ truncated')
    const net = make()
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'state-unconfirmed' })
  })

  it('says the same for an unreadable verdict on a device that is armed', async () => {
    // **The case the reason was chosen for.** Resolving an unreadable verdict against `armed` puts it
    // in `awaiting-app` almost every time — the library writes that file *because* an app is running,
    // so `armed` is true — and `awaiting-app` is the one member the dashboard draws with a healthy
    // control and "launch an app". The answer must not depend on `armed` at all.
    const net = make()
    await net.arm(UDID)
    writeFileSync(verdictPath(UDID), '{ truncated')

    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'state-unconfirmed' })
  })

  it('says hooks-not-installed when the library it would inject is not on disk', () => {
    // **The failure nothing reported.** dyld ignores a `DYLD_INSERT_LIBRARIES` path that does not
    // exist without a word, so the app launches unhooked and no verdict is ever written. Read from
    // the verdict alone that is `missing`, which resolves against `armed` to "restart the device" —
    // a remedy that cannot work, offered forever.
    const net = make()
    rmSync(hookPath(), { force: true })
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('does not accept a directory standing where the library should be', async () => {
    // `existsSync` answers true for one, and dyld cannot inject a directory — so the check would have
    // passed and let the verdict decide, reporting `awaiting-app` about an install that can never
    // work. The shape a half-finished copy leaves behind.
    const net = make()
    await net.arm(UDID)
    rmSync(hookPath(), { force: true })
    mkdirSync(hookPath(), { recursive: true })
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('says it on a device that really was armed, which is the case that happens', async () => {
    // **The only shape the live path produces, and the two tests around it missed it.** `arm()` sets
    // the environment without reading the path it sets, so a real session has `armed` true with no
    // library on disk — and `if (!this.armed.has(udid) && !existsSync(this.dylib))` passes every
    // other test here while sending that device back to `awaiting-app`.
    const net = make()
    await net.arm(UDID)
    rmSync(hookPath(), { force: true })
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('does not answer for the library from an armed device or a written verdict', () => {
    // The two states that otherwise look healthiest are the ones this must still refuse: an armed
    // device whose app wrote `installed: true` is exactly what a stale verdict from before the file
    // went missing produces.
    const net = make()
    writeFileSync(verdictPath(UDID), JSON.stringify({ installed: true }))
    expect(net.state(UDID), 'a real dylib and a good verdict').toEqual({ offline: false, available: true })
    rmSync(hookPath(), { force: true })
    expect(net.state(UDID), 'same verdict, no library').toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('reserves hooks-not-installed for the library actually saying so', () => {
    // `installed !== true` swept up every shape that is not the library's own failure signal and
    // answered "it ran and proved its hooks did not take" about files that show nothing — the same
    // overclaim the branch above exists to remove, one case over.
    for (const body of ['{}', '[]', '123', 'true', '"x"', 'null']) {
      const net = make()
      writeFileSync(verdictPath(UDID), body)
      expect(net.state(UDID), `verdict body ${body}`)
        .toEqual({ offline: false, available: false, reason: 'state-unconfirmed' })
    }
    const net = make()
    writeFileSync(verdictPath(UDID), JSON.stringify({ installed: false }))
    expect(net.state(UDID), 'the one shape that does say so')
      .toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('swallows a status bar failure going offline, because layer 3 only reports', async () => {
    // Unswallowed, one `status_bar` failure threw out of `setOffline` with layers 1 and 2 already
    // applied: the device really was offline and the caller was told the request failed, which sends a
    // tester to file against an app that was never online.
    armed()
    const net = make()
    vi.mocked(simctl.setStatusBarOffline).mockRejectedValueOnce(new Error('device is gone'))

    await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })
    expect(existsSync(conditionPath(UDID)), 'the layer that does the work was rolled back').toBe(true)
  })

  it('swallows it on the way back too, and the next toggle writes the bar again', async () => {
    // The mirror, and it fails the other way. Going offline the bar errs quietly — the device is
    // offline and the bar has not caught up. Coming back, every layer is restored and the bar still
    // shows no service on a device whose requests now succeed. Neither is worth failing the call for;
    // what puts the second one right is the next successful toggle writing the bar again.
    armed()
    const net = make()
    await net.setOffline(UDID, true)
    expect(statusBar).toEqual([`${UDID}:true`])

    vi.mocked(simctl.setStatusBarOffline).mockRejectedValueOnce(new Error('device is gone'))
    await expect(net.setOffline(UDID, false)).resolves.toEqual({ offline: false, available: true })
    expect(statusBar, 'the bar is stale here, and that is the accepted cost').toEqual([`${UDID}:true`])

    await net.setOffline(UDID, true)
    await net.setOffline(UDID, false)
    expect(statusBar.at(-1), 'no later toggle caught the bar up').toBe(`${UDID}:false`)
  })

  it('still reports a device offline after it stops being steerable', async () => {
    armed()
    const net = make()
    await net.arm(UDID)
    armed()   // arm() clears what a previous boot left; this is the app running again
    await net.setOffline(UDID, true)

    // The app exits and takes its verdict with it. The injection is still in place, so the remedy is
    // to launch an app again — not to reboot.
    rmSync(verdictPath(UDID))

    // `offline` describes the device, not the request. Reporting false here would draw "online" over
    // an app that can reach nothing.
    expect(net.state(UDID)).toEqual({ offline: true, available: false, reason: 'awaiting-app' })
  })

  describe('arm', () => {
    it('inserts the library and clears what a previous boot left behind', async () => {
      // Both files live on the host and are keyed only by udid, so they outlive the simulator that
      // wrote them: a device booting into a leftover condition file is offline before anyone asked.
      writeFileSync(conditionPath(UDID), '')
      writeFileSync(verdictPath(UDID), JSON.stringify({ installed: true }))
      const net = make()

      await net.arm(UDID)

      expect(existsSync(conditionPath(UDID))).toBe(false)
      expect(existsSync(verdictPath(UDID))).toBe(false)
      expect(env).toEqual([`${UDID}:DYLD_INSERT_LIBRARIES=${hookPath()}`])
    })

    it('does not name a target app, because none is known yet at boot', async () => {
      const net = make()
      await net.arm(UDID)
      expect(env.some(e => e.includes('TAPFLOW_TARGET_BUNDLE'))).toBe(false)
    })

    it('forgets an offline device it is re-arming, in the rule and not only in memory', async () => {
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      await net.arm(UDID)

      // The device rebooted; whatever it was before, it is online now and **the rule has to agree**.
      // Asserting `state()` alone was what let this through: the in-memory set was cleared and the
      // host rule still named the device, so the simulator came up with its traffic dead while this
      // reported it online and steerable.
      expect(net.state(UDID).offline).toBe(false)
      expect(rules().at(-1)).toBe('rule: cond:0')
    })

    it('clears a rule left behind by a previous process', async () => {
      // An agent that crashed while a device was offline leaves the rule on the host and takes its
      // memory with it. The replacement knows of no offline device, and recovering the simulator is
      // what arming it does — now by naming that udid rather than by rewriting the whole rule, which
      // is the same recovery for the device being armed and none of the damage to the others.
      const net = make()
      await net.arm(UDID)
      expect(rules()).toEqual(['rule: cond:0'])
      expect(argv()).toEqual([`--remove ${UDID}`])
    })

    it('does not erase a device it was not asked about', async () => {
      // **The defect this whole change exists for.** The rule is the host's; a second agent starting
      // knows of no offline device, and `arm` runs on every device boot. Writing its own set — empty —
      // put every device the first agent had taken offline back online, silently, while that tester
      // watched an offline control over working traffic.
      const first = make()
      await first.setOffline(UDID, true)
      await first.setOffline(OTHER, true)
      expect(readFileSync(join(dir, 'rule'), 'utf8')).toBe([OTHER, UDID].sort().join(','))

      // A different agent, sharing this Mac's rule, arming a third device it has just booted.
      const second = make()
      await second.arm(THIRD)
      expect(
        readFileSync(join(dir, 'rule'), 'utf8'),
        'the second agent erased devices it had never heard of',
      ).toBe([OTHER, UDID].sort().join(','))
      // And the first agent still reports them offline, because they still are.
      expect(first.state(UDID)).toMatchObject({ offline: true })
      expect(first.state(OTHER)).toMatchObject({ offline: true })
    })

    it('still recovers a leftover when the device that owns it comes back', async () => {
      // The cleanup the whole-set write used to provide, in its precise form: the leftover goes when
      // that device is armed, which happens on its next boot. Asserted as the rule losing exactly one
      // entry — a test that only checked the rule was non-empty would pass on a write that did
      // nothing.
      const first = make()
      await first.setOffline(UDID, true)
      await first.setOffline(OTHER, true)
      const second = make()
      await second.arm(UDID)
      expect(readFileSync(join(dir, 'rule'), 'utf8')).toBe(OTHER)
    })

    it('takes the status bar down when a device is retired', async () => {
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      statusBar.length = 0

      await net.forget(UDID)

      // `setStatusBarOffline` had exactly one caller, so a device retired while offline kept showing
      // no service for as long as it stayed booted — a relay disconnect was enough.
      expect(statusBar).toEqual([`${UDID}:false`])
    })

    it('finishes retiring a device whose status bar can no longer be set', async () => {
      // The usual case: the simulator is already gone, so `status_bar clear` fails. The rule and the
      // condition file still have to come off.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      simctl.setStatusBarOffline = vi.fn(async () => { throw new Error('device shut down') })

      await expect(net.forget(UDID)).resolves.toBeUndefined()

      expect(rules().at(-1)).toBe('rule: cond:1')
      expect(existsSync(conditionPath(UDID))).toBe(false)
    })
  })

  describe('target', () => {
    it('names the app the hooks may touch', async () => {
      const net = make()
      await net.target(UDID, 'com.example.app')
      expect(env).toEqual([`${UDID}:TAPFLOW_TARGET_BUNDLE=com.example.app`])
    })

    it('does not answer for the next app on the previous one\'s evidence', async () => {
      // A verdict is one process's report about its own hooks, and that process is gone by the time a
      // second app is launched. Left behind it said `available: true` before the new app had written
      // anything — and kept saying it for the whole session if the new app's hooks failed.
      //
      // Mutation: dropping the `rmSync` from `target` fails here.
      const net = make()
      await net.arm(UDID)
      armed()
      expect(net.state(UDID)).toEqual({ offline: false, available: true })

      await net.target(UDID, 'com.example.second')
      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'awaiting-app' })
    })
  })

  it('runs the container app one at a time', async () => {
    // The host takes the whole offline set on each run and the last writer wins, so two in flight
    // decide the rule by which subprocess finishes last rather than by which request came last. Both
    // runs read a correct set, which is what makes the wrong outcome invisible afterwards.
    //
    // The fake host sleeps, so an unserialised implementation interleaves: the assertion is that the
    // LAST line is the last request's set, and that no run started before its predecessor finished.
    //
    // Mutation: awaiting `runFilterHost` directly instead of chaining fails here.
    armed()
    armed(OTHER)
    const net = make(fakeHostBinary(dir, log, 60))
    await Promise.all([net.setOffline(UDID, true), net.setOffline(OTHER, true)])

    const marks = readAll().split('\n').filter(l => l.startsWith('rule:') || l.startsWith('enter:'))
    for (let i = 0; i < marks.length; i += 2) {
      expect(marks[i], `overlapping host runs in ${JSON.stringify(marks)}`).toMatch(/^enter:/)
      expect(marks[i + 1], `overlapping host runs in ${JSON.stringify(marks)}`).toMatch(/^rule:/)
    }
    expect(rules().at(-1)).toContain(OTHER)
    expect(rules().at(-1)).toContain(UDID)
  })

  it('drops a forgotten device out of the rule', async () => {
    armed()
    const net = make()
    await net.setOffline(UDID, true)

    await net.forget(UDID)

    expect(rules().at(-1)).toBe('rule: cond:1')
    expect(existsSync(conditionPath(UDID))).toBe(false)
  })

  it('clears a stale condition file for a device that was never in the set', async () => {
    writeFileSync(conditionPath(UDID), '')
    const net = make()

    await net.forget(UDID)

    expect(existsSync(conditionPath(UDID))).toBe(false)
  })

  // ── the rule is confirmed, not assumed (#639) ───────────────────────────────────────────────
  //
  // The container app exits when the framework *accepts* the save — 27ms for the whole run — and the
  // provider is handed the configuration afterwards with nothing coming back. So every test here is
  // about a write that succeeded and a rule that is not being enforced, which is precisely the state
  // the old code reported as `available: true`.
  describe('confirmation', () => {
    /** Layers 2 and 3 must not have been applied. Asserted together because "refused" means both. */
    const nothingApplied = () => {
      expect(existsSync(conditionPath(UDID)), 'a condition file with no filter behind it').toBe(false)
      expect(statusBar, 'the status bar claimed a state nothing was enforcing').toEqual([])
    }

    it('refuses when the provider does not answer', async () => {
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      // Short, because this test is about the verdict rather than the wait; the wait itself is
      // covered above, against the real default.
      const net = make(undefined, 200)

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      nothingApplied()
    })

    it('confirms from the state file when the XPC listener is gone', async () => {
      // **The state every system-extension replace leaves behind.** The retired extension sits
      // `[terminated waiting to uninstall on reboot]` still owning the mach name, so the new
      // provider's `NSXPCListener.resume()` fails with `Operation not permitted` — silently, since
      // `resume()` returns void — and `--confirm` answers `no listener` in 9ms while the filter is
      // enforcing normally and publishing a fresh state file. Measured 2026-09-03, and the provider
      // survives `--off`/`--install` on the same pid, so nothing re-vends it: the loss lasts as long
      // as the provider does.
      //
      // Reading that as "not confirmed" is what put `filter-unavailable` in front of a tester whose
      // filter was working, on every Mac that had upgraded.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      const net = make()

      await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })
      expect(existsSync(conditionPath(UDID)), 'layer 2 was withheld over a layer 1 that did land').toBe(true)
    })

    /**
     * A state file in a directory anyone on the Mac can write to, which is what `/tmp` is.
     *
     * `chmod` after the `mkdir`, because the umask takes the world-writable bit off the mode passed
     * to `mkdir` — and the assertion on the directory is what keeps this from silently becoming a
     * test of a private directory, which the class trusts.
     */
    const forgedState = (rule: string[]) => {
      const open = join(dir, 'open')
      mkdirSync(open)
      chmodSync(open, 0o1777)
      expect(statSync(open).mode & 0o002, 'the directory is not world-writable').not.toBe(0)
      const path = join(open, 'state.json')
      writeFileSync(path, JSON.stringify({ at: Math.floor(Date.now() / 1000), pid: 1, pulseSeconds: 1, rule }))
      // Under root the file this test wrote would be root-owned, which is the one thing the class
      // trusts here — so it is handed to `nobody`, the way an attacker's file would be.
      if (process.getuid?.() === 0) chownSync(path, 65534, 65534)
      expect(statSync(path).uid, 'the forged file is root-owned, so it would be trusted').not.toBe(0)
      return path
    }

    it('refuses a state file that anyone could have written', async () => {
      // The protected file is absent and the XPC listener is gone: the exact state in which a forged
      // `/tmp` file used to confirm a rule write and let layers 2 and 3 go on (#734).
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      const forged = forgedState([UDID])
      const net = make(undefined, 300, [join(dir, 'state.json'), forged])

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      nothingApplied()
      // Said once, not on each of the polls the deadline is made of.
      const said = warn.mock.calls.filter((c) => String(c[0]).includes(forged))
      expect(said, 'the refused file was not named, or was named on every poll').toHaveLength(1)
      warn.mockRestore()
    })

    it('returns from a FIFO at the fallback path rather than blocking on it', async () => {
      // Opening a FIFO read-only waits for a writer, and the check that refuses a non-regular file
      // runs after the open. Without `O_NONBLOCK` this held the agent's whole thread — no timer can
      // fire, so the race below never resolved and the run had to be killed by hand.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      const open = join(dir, 'openfifo')
      mkdirSync(open)
      chmodSync(open, 0o1777)
      const fifo = join(open, 'state.json')
      execFileSync('mkfifo', [fifo])
      const net = make(undefined, 300, [join(dir, 'state.json'), fifo])

      const raced = await Promise.race([
        net.setOffline(UDID, true).then(() => 'returned'),
        new Promise((r) => setTimeout(() => r('hung'), 4000)),
      ])
      expect(raced, 'openSync on the FIFO blocked the event loop').toBe('returned')
      nothingApplied()
    })

    it('believes the same file from a directory only its owner can write', async () => {
      // The positive control for the refusal above: the one thing that differs is the directory.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000), pid: 1, pulseSeconds: 1, rule: [UDID],
      }))
      const net = make(undefined, 300)

      await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })
      expect(existsSync(conditionPath(UDID)), 'layer 2 was withheld over a file the provider wrote').toBe(true)
    })

    it('does not let a forged file stand in for a provider that stopped', async () => {
      // The liveness watcher reads the same files, so the same forgery would keep a device looking
      // enforced after the provider removed its file — the other half of #734's acceptance.
      armed()
      const forged = forgedState([UDID])
      const net = make(undefined, undefined, [join(dir, 'state.json'), forged])
      await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })

      rmSync(join(dir, 'state.json'))
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('waits out a file written before the request rather than calling it a disagreement', async () => {
      // The ordinary state for up to a pulse after every toggle: the file is fresh and correct and
      // about the *previous* rule, because the provider has not published since. `checkLivenessLocked`
      // says the same thing about the same window. Answering from it would refuse every toggle.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      const at = Math.floor(Date.now() / 1000)
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ at, pid: 1, pulseSeconds: 1, rule: [] }))
      // **The production deadline on purpose, and it is the only test that uses it.** Every other case
      // here injects its own, which left `FILTER_FILE_CONFIRM_DEADLINE_MS` observed by nothing —
      // measured: cutting it to 1ms, which turns the documented loop back into a single read, passed
      // all 83 tests. The good file lands at 600ms, so any default under about 700ms fails this.
      const net = make()

      const began = Date.now()
      const settling = net.setOffline(UDID, true)
      // **Comfortably past the first poll, and that margin is the test.** Two subprocess launches sit
      // between the call and the first read, so a delay tuned close to them lets the good file arrive
      // before the stale one is ever looked at — and then a fallback that answered from *any* fresh
      // file would pass this too. Measured: at 150ms it did.
      setTimeout(() => {
        writeFileSync(join(dir, 'state.json'),
          JSON.stringify({ at: at + 1, pid: 1, pulseSeconds: 1, rule: [UDID] }))
      }, 600)

      await expect(settling).resolves.toEqual({ offline: true, available: true })
      expect(Date.now() - began, 'it answered before the provider had published anything').toBeGreaterThan(500)
    })

    it('refuses a file the provider stopped updating, even when it names the device', async () => {
      // The one a freshness check exists for, and the only shape of stale file that is dangerous: it
      // *agrees*. A provider killed twenty seconds ago left a file saying this device is offline, and
      // the kernel has been passing its traffic the whole time — measured at about 5.8s per restart,
      // 23–27 requests through each occurrence.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      // **Four seconds, not sixty.** The bound under test is `3 * pulseSeconds`, so a file an order of
      // magnitude past it leaves every wider bound passing too — measured: `3 *` widened to `20 *` was
      // green. Four is one second past the real threshold and still refused, and the measured hazard it
      // stands for is a provider gone for about 5.8s while the kernel passes that device's traffic.
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) - 4, pid: 1, pulseSeconds: 1, rule: [UDID],
      }))
      const net = make(undefined, 200)

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      nothingApplied()
    })

    it('refuses a file dated in the future, however well it agrees', async () => {
      // **The dangerous direction of a clock that moved backwards**, and the reason the freshness test
      // is two comparisons rather than one: `now - at` goes negative and passes any threshold, so a
      // provider that died before an NTP correction or a VM restore leaves a frozen file that reads as
      // perfect for as long as the skew lasts. `checkLivenessLocked` refuses the same reading and says
      // so; this channel is its twin and has to agree.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) + 600, pid: 1, pulseSeconds: 1, rule: [UDID],
      }))
      const net = make(undefined, 200)

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      nothingApplied()
    })

    it('names the channel as xpc when the provider itself disagrees', async () => {
      // **The twin of the file case below, and the one the diagnostic field is mostly for.** XPC is the
      // channel almost every confirmation takes, so a `from` that is only ever asserted on the fallback
      // can be wrong exactly where it matters — measured: labelling the XPC answer `'file'` passed all
      // 83 tests. The state file here is fresh and correct; it is not consulted, because the ask
      // answered.
      armed()
      writeFileSync(join(dir, 'CONFIRM_EMPTY'), '')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const net = make()

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      const said = warn.mock.calls.flat().join(' ')
      warn.mockRestore()
      expect(said, 'the disagreement did not name the provider that answered').toContain('provider 7')
      expect(said, 'an answer from XPC was reported as coming from the file').toContain('read over xpc')
    })

    it('names the provider and the channel when the published rule disagrees', async () => {
      // A rule that landed as something else — a second writer, or a provider still holding the
      // previous one. The log is the only place this is visible, and it has to carry *what was read*
      // and *where from*: two agents writing the same rule are each internally consistent, and after
      // a replace two providers are briefly publishing to the same path.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'IGNORE_RULE'), '')
      // **The baseline has to sit in an earlier second than the publish, and that is a real limit of
      // this channel rather than a fixture convenience.** The file stamps whole seconds, so a
      // disagreeing publish landing in the same second as the previous one is indistinguishable from
      // one that has not happened yet — and the safe reading of that is "not yet", so it waits and
      // refuses on the deadline instead. Same verdict for the caller, less specific log. This models
      // a provider that published five seconds ago and again after the write, still holding the old
      // rule.
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) - 5, pid: 1, pulseSeconds: 1, rule: [],
      }))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const net = make()

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      const said = warn.mock.calls.flat().join(' ')
      warn.mockRestore()
      expect(said, 'the disagreement did not say which provider held the rule').toContain('provider 1')
      expect(said, 'the disagreement did not say which channel answered').toContain('read over file')
    })

    it('refuses when the provider answers that it is not enforcing', async () => {
      // `rule: []` alone cannot carry this: an idle provider with no offline device says the same
      // thing. Measured on a `--off` provider — alive, answering in 16ms, holding nothing — which is
      // why `enforcing` is a field of its own rather than something derived from the rule.
      armed()
      writeFileSync(join(dir, 'NOT_ENFORCING'), '')
      const net = make()

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      nothingApplied()
    })

    it('refuses even when the rule already matches, if nothing is enforcing it', async () => {
      // **The case `enforcing` exists for, and the one membership cannot cover.** Asking a device to
      // come back online while the filter is stopped: the rule is empty and the request wants it
      // empty, so a check comparing only membership calls that a success and reports a healthy control
      // over a Mac that cannot take anything offline.
      //
      // Found by mutation: deleting the `enforcing` branch left the whole suite green, because the
      // test above reaches the refusal through the membership mismatch instead.
      armed()
      writeFileSync(join(dir, 'NOT_ENFORCING'), '')
      const net = make()

      await expect(net.setOffline(UDID, false)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
    })

    it('refuses a confirmation that hangs rather than waiting it out', async () => {
      // **The case the timeout exists for, and it is the common one.** A call made while the provider
      // is dead does not fail — measured 3/3, it blocks to the caller's own deadline, because launchd
      // holds the mach name while the process is away. A provider killed and restarted by launchd is
      // gone for about 5.8s, so this is what a toggle during any restart runs into.
      armed()
      writeFileSync(join(dir, 'CONFIRM_HANG'), '')
      // **And no state file either, because the two go together.** A call that blocks is launchd
      // holding the mach name for a process that is *away*, and a process that is away publishes
      // nothing. A fake that hung the ask while still refreshing the heartbeat would be modelling a
      // Mac that cannot exist, and the file fallback would rightly answer from it.
      writeFileSync(join(dir, 'NO_STATE'), '')
      const net = make(undefined, 200)

      const began = Date.now()
      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      // The fake sleeps 5s. Anything near that means the timeout did not fire and the dashboard's own
      // 8s deadline would be deciding this instead.
      expect(Date.now() - began, 'the confirmation was waited out instead of cut short').toBeLessThan(3_000)
      nothingApplied()
    })

    it('keeps a device offline when a later request cannot be confirmed', async () => {
      // The direction that matters: reporting `offline: false` here would draw an online control over
      // a device whose app can reach nothing.
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      await expect(net.setOffline(UDID, false)).resolves.toEqual({
        offline: true, available: false, reason: 'filter-unavailable',
      })
    })

    it('remembers the refusal, so a re-join does not repaint the control as healthy', async () => {
      // `state()` is synchronous and cannot ask the provider anything, and every re-join, every
      // `device:ready` and MCP's `networkState()` come through it. Deriving layer 1's health from the
      // dylib's verdict — which is fine here — answers `available: true` in the same second the call
      // above answered `false`.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      // Short, because this test is about the verdict rather than the wait; the wait itself is
      // covered above, against the real default.
      const net = make(undefined, 200)
      await net.setOffline(UDID, true)

      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'filter-unavailable' })
    })
  })

  // ── enforcement that stops after the fact (#639) ────────────────────────────────────────────
  describe('liveness', () => {
    /** The drop evidence goes to the log and nowhere else (#654, Q1), so the log is what observes it. */
    let spy: ReturnType<typeof vi.spyOn>
    beforeEach(() => { spy = vi.spyOn(console, 'log').mockImplementation(() => {}) })
    afterEach(() => { spy.mockRestore() })

    const staleState = (rule: string[], atOffsetSeconds: number, pulseSeconds = 1) =>
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) + atOffsetSeconds, pulseSeconds, rule,
      }))

    /**
     * The state file a provider older than #654 writes: no `droppedByDevice` at all.
     *
     * **This is the ordinary case, not an edge one.** The extension is installed by hand and a
     * replacement only finishes on reboot, so a Mac runs the previous provider for as long as its
     * owner has not restarted. A missing field read as a bad file would report "not enforcing" for a
     * filter that is working — the exact failure the rest of this class exists to prevent.
     */
    const stateWithout = (rule: string[]) =>
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000), pulseSeconds: 1, rule,
      }))

    /** Writes the file *and* the sidecar the fake host reads, so a host run carries the counts on. */
    const stateWith = (rule: string[], droppedByDevice: unknown) => {
      writeFileSync(join(dir, 'drops.json'), JSON.stringify(droppedByDevice))
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000), pulseSeconds: 1, rule, droppedByDevice,
      }))
    }

    it('keeps a device offline when the provider is too old to report drops', async () => {
      // **`state()` is synchronous, so waiting on it proves nothing about the liveness loop** — it is
      // already true the moment the device goes offline, and the wait returns before a single 20ms
      // tick has read the file. The same vacuity was found twice on this branch; this is the third
      // instance, and it is closed the same way: a positive from the seam under test.
      //
      // Here that positive comes last. The file is deliberately one an older provider wrote, so it
      // produces nothing to wait for — but making the device stale at the end and watching `lost`
      // arrive proves the loop was reading this file all along.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      stateWithout([UDID])
      await new Promise((r) => setTimeout(r, 120))
      expect(net.state(UDID)).toMatchObject({ offline: true })
      expect(lost, 'an older provider was read as one that stopped enforcing').toEqual([])

      staleState([UDID], -60)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    /**
     * The drop count's only consumer is the log line, so that is where it can be observed.
     *
     * Asserting "the device is still offline" instead passes whatever the value is — the state does
     * not depend on it, deliberately (R7) — which is a test that agrees with any implementation.
     */
    const dropLines = (): string[] => spy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.includes('has dropped'))

    /**
     * Two devices offline, one of them with real drops — **so a tick provably ran** before anything is
     * asserted about the other.
     *
     * The first attempt at these waited on `state(UDID)` being offline, which is already true when the
     * device is put offline: `vi.waitFor` returned before the 20ms liveness interval had fired once,
     * and the "no line was printed" assertions passed because nothing had happened yet. Measured —
     * both survived a mutation that printed a line for every device. A negative about a periodic job
     * needs a positive from the same job to stand on.
     */
    const tickedWith = async (dropped: Record<string, unknown>) => {
      armed(UDID); armed(OTHER)
      const net = make()
      await net.setOffline(UDID, true)
      await net.setOffline(OTHER, true)
      stateWith([UDID, OTHER], { [OTHER]: 2, ...dropped })
      await vi.waitFor(() => expect(dropLines().some((l: string) => l.includes(OTHER))).toBe(true))
      return net
    }

    it('keeps a device offline when its drop count is malformed, and says nothing about it', async () => {
      // Entry by entry rather than all-or-nothing: one bad value must not discard a file whose `rule`
      // and `at` are the fields every other decision here is made from — and a value that is not a
      // count must not be reported as one.
      // **`'5'`, not `'lots'`.** The first attempt used a word, and it did not discriminate: `'lots' > 0`
      // is `false` in JavaScript, so the guard downstream filtered it whether or not the parse did.
      // A numeric string is what actually gets past that comparison — `'5' > 0` is true — and it is
      // the realistic corruption too, from a provider that formatted a count as text.
      const net = await tickedWith({ [UDID]: '5' })
      expect(net.state(UDID)).toMatchObject({ offline: true })
      expect(lost, 'a malformed drop count was read as enforcement stopping').toEqual([])
      expect(dropLines().filter((l: string) => l.includes(UDID)), 'a value that is not a count was reported as one')
        .toEqual([])
    })

    it('says a device is proven enforcing when the provider reports drops for it', async () => {
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      stateWith([UDID], { [UDID]: 3 })
      await vi.waitFor(() => expect(dropLines().length).toBeGreaterThan(0))
      expect(dropLines()[0]).toContain(UDID)
      expect(dropLines()[0], 'the count is not in the line that exists to carry it').toContain('3')
    })

    it('says nothing for a device with zero drops', async () => {
      // The control for the line above, and the shape of the whole feature: a zero proves nothing, so
      // it produces nothing. Without this the assertion above passes on a line printed unconditionally.
      await tickedWith({ [UDID]: 0 })
      expect(dropLines().filter((l: string) => l.includes(UDID)), 'zero drops was announced as evidence')
        .toEqual([])
    })

    it('reads zero drops exactly as it reads no drops at all', async () => {
      // **The one that fails if someone later makes zero mean something.** An offline device that
      // opens no connections drops nothing, which is what a simulator sitting on a screen does — so a
      // zero is the common case and proves nothing. Nothing may treat it as failure.
      armed()
      const a = make()
      await a.setOffline(UDID, true)
      stateWith([UDID], { [UDID]: 0 })
      const withZero = a.state(UDID)

      await a.setOffline(UDID, false)
      await a.setOffline(UDID, true)
      stateWithout([UDID])
      expect(a.state(UDID), 'a zero drop count changed the answer').toEqual(withZero)
      expect(lost).toEqual([])
    })

    it('changes no reason when the provider reports drops', async () => {
      // Evidence is one-directional and goes to the log; it must not become a state a control renders
      // (R7). Drops present, and the answer is byte-identical to drops absent.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      stateWithout([UDID])
      const before = net.state(UDID)
      stateWith([UDID], { [UDID]: 42 })
      await vi.waitFor(() => expect(net.state(UDID)).toEqual(before))
      expect(lost).toEqual([])
    })

    it('does not carry a previous offline episode\'s drops into the next one', async () => {
      // **The provider cannot close this and this class can.** Its prune runs at render time and its
      // `ruleWatch` only advances when a flow arrives, so a device toggled off, on and off again with
      // neither in between leaves it having never seen the empty rule — and it republishes the old
      // count against the new episode. The agent knows what the provider cannot: that a tester
      // toggled. Taking the file's current count as the baseline is what makes the stale number
      // harmless.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      stateWith([UDID], { [UDID]: 6 })
      await vi.waitFor(() => expect(dropLines().length).toBe(1))

      // Off and on again. The count stays in the file across both, which is what a provider that
      // never saw the empty rule publishes — and what the agent's seed has to render harmless.
      await net.setOffline(UDID, false)
      await net.setOffline(UDID, true)
      await new Promise((r) => setTimeout(r, 120))
      expect(dropLines().length, 'a previous episode\'s drops were announced as this one\'s evidence')
        .toBe(1)

      // And a drop that is genuinely new still counts.
      stateWith([UDID], { [UDID]: 9 })
      await vi.waitFor(() => expect(dropLines().length).toBe(2))
      expect(dropLines()[1]).toContain('9')
    })

    it('does not report a fraction of a flow', async () => {
      // A count is flows, and `dropped 0.5 flow(s)` is a sentence no reader should be handed. It is
      // also the one malformed shape the `> 0` guard downstream cannot catch on its own — unlike a
      // negative, and unlike a word, a fraction is a finite number greater than zero.
      await tickedWith({ [UDID]: 0.5 })
      expect(dropLines().filter((l: string) => l.includes(UDID)), 'a fraction of a flow was reported')
        .toEqual([])
    })

    it('claims nothing about a device this agent never took offline', async () => {
      // **The state file is host-wide.** Another agent's devices, and rule entries this instance never
      // wrote, appear in it — so the loop has to run over `this.offline` and not over the file's own
      // keys. `checkLivenessLocked` already refuses the mirror image of this ("somebody else's device
      // appearing in the rule must not make this one look unenforced"); the evidence line owes the
      // same refusal pointed the other way.
      //
      // Measured: sourcing the loop from `Object.entries(file.droppedByDevice)` passed all 67 tests
      // before this one existed, because every fixture's keys were a subset of what was offline.
      const net = await tickedWith({ [THIRD]: 9 })
      expect(dropLines().filter((l: string) => l.includes(THIRD)),
        'evidence was claimed for a device this agent never took offline').toEqual([])
      expect(net.state(OTHER)).toMatchObject({ offline: true })
    })

    it('reports every offline device that has drops, not just the first', async () => {
      // The other mutation that was green: a `break` after the first line. `tickedWith`'s first device
      // is deliberately the silent one, so a loop that stopped early still satisfied the wait.
      armed(UDID); armed(OTHER)
      const net = make()
      await net.setOffline(UDID, true)
      await net.setOffline(OTHER, true)
      stateWith([UDID, OTHER], { [UDID]: 4, [OTHER]: 7 })
      await vi.waitFor(() => expect(dropLines().length).toBeGreaterThanOrEqual(2))
      expect(dropLines().some((l: string) => l.includes(UDID))).toBe(true)
      expect(dropLines().some((l: string) => l.includes(OTHER))).toBe(true)
    })

    it('says it once, not once a second', async () => {
      // This runs on the liveness interval, so an unconditional line repeats for as long as the device
      // stays offline — 600 of them in a ten-minute session, in the stream where the enforcement-lost
      // report is what someone is looking for. Only an increase is news.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      stateWith([UDID], { [UDID]: 2 })
      await vi.waitFor(() => expect(dropLines().length).toBe(1))
      // Several more ticks at 20ms against a file that has not moved.
      await new Promise((r) => setTimeout(r, 120))
      expect(dropLines().length, 'the same evidence was announced again').toBe(1)

      // And a genuine increase is still news.
      stateWith([UDID], { [UDID]: 5 })
      await vi.waitFor(() => expect(dropLines().length).toBe(2))
      expect(dropLines()[1]).toContain('5')
    })

    it('does not call a device proven enforcing in the same breath as declaring it lost', async () => {
      // Both readings come from the file that froze, so an unguarded loop says "enforcement observed"
      // and then reports that enforcement stopped — about the same device, one line apart.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      // Stale by more than three pulses, and carrying drops from before it froze.
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) - 60, pulseSeconds: 1, rule: [UDID],
        droppedByDevice: { [UDID]: 7 },
      }))
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
      expect(dropLines(), 'a device declared lost was announced as proven enforcing').toEqual([])
      void net
    })

    it('reports a device whose enforcement stopped and takes the other layers down', async () => {
      // **The measurement this exists for**: killing the provider leaves the kernel passing that
      // simulator's traffic for about 5.8 seconds, and 23–27 requests got through each time. The
      // tester is looking at an offline control for all of it, and the sign-off they give covers
      // requests that succeeded.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      expect(statusBar).toEqual([`${UDID}:true`])

      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))

      // Telling the tester is the remedy; the layers coming down is the tidying up. Leaving them
      // would add a second false state on top of the one being reported.
      expect(existsSync(conditionPath(UDID))).toBe(false)
      expect(statusBar.at(-1)).toBe(`${UDID}:false`)
      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'enforcement-lost' })
    })

    it('answers before the missing-library branch, which sits below it', async () => {
      // Order, not merely presence. A Mac whose filter stopped enforcing invalidates work a tester
      // has already signed off; "reinstall tapflow" does not say that, so the reason that does has
      // to win — and moving the dylib check above this one leaves every other test green.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
      rmSync(hookPath(), { force: true })
      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'enforcement-lost' })
    })

    it('takes the lost device out of the host rule, not only out of its own memory', async () => {
      // **The rule is the host's and it outlives this process.** Reporting the loss and leaving the
      // udid named there means launchd's restarted provider re-reads it and drops that simulator's
      // traffic again — with layers 2 and 3 already down, `state()` saying `offline: false`, and the
      // watcher stopped because the set is empty. Nothing looks at it again.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      expect(readFileSync(join(dir, 'rule'), 'utf8')).toBe(UDID)
      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
      await vi.waitFor(() => expect(readFileSync(join(dir, 'rule'), 'utf8')).toBe(''))
    })

    it('leaves another device in the rule while removing the lost one', async () => {
      // The delta must name the loss, not replace the rule — the correction that reintroduces the
      // defect this whole change is about would pass a test that only checked the lost one is gone.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      writeFileSync(join(dir, 'rule'), `${UDID},${OTHER}`)
      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
      await vi.waitFor(() => expect(readFileSync(join(dir, 'rule'), 'utf8')).toBe(OTHER))
    })

    it('still says so on a re-join', async () => {
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))

      // A second read is what a re-join is. If this repainted healthy, the toast would be the only
      // trace that anything had gone wrong.
      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'enforcement-lost' })
    })

    it('treats a timestamp in the future as untrustworthy, not as fresh', async () => {
      // Clocks move backwards — an NTP correction, a Mac waking up. Reading `at > now` as very fresh
      // would make a frozen file look perfect for as long as the skew lasted.
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      staleState([UDID], 3_600)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('judges membership per device, not by comparing whole sets', async () => {
      // Per-device membership, never set equality. The filter is host-wide and this agent is not
      // guaranteed to be its only writer; comparing whole sets would report every device as
      // unenforced the moment somebody else's appeared in the rule.
      //
      // **The wait is what puts this on the branch it is about.** `at` has one-second granularity and
      // a file from the same second as the write is not judged at all, so without it both halves below
      // would pass on a build with no membership test in it.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      await new Promise((r) => setTimeout(r, 1_100))

      staleState([UDID, OTHER], 0)
      await new Promise((r) => setTimeout(r, 100))
      expect(lost, 'another simulator in the rule is not this one\'s problem').toEqual([])
      expect(net.state(UDID)).toEqual({ offline: true, available: true })

      // And the same file with this device dropped out of it is the failure being watched for.
      staleState([OTHER], 0)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('does not call a device lost on a file published before the write', async () => {
      // What an idle provider's last publish looks like at the moment a device is toggled offline: a
      // fresh, valid file that does not name it yet, because the provider has not pulsed since. Read
      // as a disagreement it fires on **every** toggle — which is how it was found, by a test about
      // something else whose rule this kept rewriting.
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      staleState([], -1)
      await new Promise((r) => setTimeout(r, 100))

      expect(lost).toEqual([])
      expect(net.state(UDID)).toEqual({ offline: true, available: true })
    })

    it('reads the second candidate path when the first is absent', async () => {
      armed()
      const net = new SimulatorNetwork(simctl, {
        filterHostBinary: fakeHostBinary(dir, log),
        conditionDir: dir,
        verdictDir: dir,
        nethookDylib: hookPath(),
        filterStateFiles: [join(dir, 'nowhere.json'), join(dir, 'state.json')],
        onEnforcementLost: (udid) => { lost.push(udid) },
        livenessIntervalMs: 20,
      })
      made.push(net)
      await net.setOffline(UDID, true)

      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('takes the staleness threshold from the rate the file declares', async () => {
      // The provider changes its own rate — one second while it is enforcing, five when idle — and
      // publishes the one in force. A reader holding a constant instead is either too eager or blind:
      // every test here used `pulseSeconds: 1`, so a hard-coded `3` was indistinguishable from reading
      // the file, and the doc block's claim that the threshold comes out of the file was never run.
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      // Named, eight seconds old, declaring the five-second rate. Three of those is fifteen, so this
      // is a provider that is alive and quiet — not a lost one. A constant three loses it here.
      staleState([UDID], -8, 5)
      await new Promise((r) => setTimeout(r, 200))
      expect(lost, 'lost a device that was still inside its own declared threshold').toEqual([])

      staleState([UDID], -20, 5)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('reports a loss even when the last file was written at the idle rate', async () => {
      // **The hole a review found, and it is the one this whole watcher exists for.** The rate in the
      // file describes the rule the provider held *when it wrote*, so the last publish before a device
      // goes offline declares the idle five seconds. A provider dying in the second after a toggle
      // leaves that file as the newest one there is: not stale by its own rate for fifteen seconds,
      // and not naming the device either. Both predicates false, nothing reported — while the kernel
      // passes that simulator's traffic.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) - 1, pulseSeconds: 5, rule: [],
      }))

      // Not immediately: for about a second after any toggle this is exactly what a healthy provider
      // that has not pulsed yet looks like, and firing there fires on every toggle.
      await new Promise((r) => setTimeout(r, 1_500))
      expect(lost, 'reported before the provider had its pulses to speak').toEqual([])

      // But it does not wait fifteen seconds for a rate that no longer applies.
      await vi.waitFor(() => expect(lost).toEqual([UDID]), { timeout: 6_000 })
    })

    it('does not report a device lost while its own toggle is still in flight', async () => {
      // **Blocker found by review.** A device joins `this.offline` before its rule is written, so a
      // liveness tick landing in between saw a device the file did not name and declared its
      // enforcement lost — rewriting the rule without it, taking layers 2 and 3 down and telling every
      // session. The confirmation then returned, agreed with the set the tick had just edited, and put
      // layers 2 and 3 back **on** over a kernel rule that no longer named the device: the app told it
      // is offline while every request succeeds, produced by the feature that exists to prevent it.
      //
      // The second device is what makes it reachable — the watcher only runs once something is
      // offline — and the slow host is what makes the window wide enough to hit deterministically.
      armed()
      armed(OTHER)
      const net = make(fakeHostBinary(dir, log, 600))
      await net.setOffline(OTHER, true)
      staleState([OTHER], 0)

      const inFlight = net.setOffline(UDID, true)
      await new Promise((r) => setTimeout(r, 300))
      const result = await inFlight

      // **Two guards close this and either one alone is enough**, which is worth knowing before
      // mutating: reverting only the queueing of the liveness tick, or only the `?? now` fallback for a
      // device with no confirmation yet, leaves this green. Reverting both fails it. That is the shape
      // of the defect — it needed a tick to run mid-toggle *and* a predicate that read an absent
      // confirmation as "long ago" — so a mutation of either line surviving is the design, not a hole.
      expect(lost, 'a device was declared lost while its own toggle was still running').toEqual([])
      expect(result).toEqual({ offline: true, available: true })
      expect(existsSync(conditionPath(UDID)), 'layer 2 was applied over a rule that lost the device').toBe(true)
      expect(rules().at(-1)).toContain(UDID)
    })

    it('keeps the layers agreeing when two toggles of one device overlap', async () => {
      // The mirror of the case above, and the second blocker: the confirmation used to read what it
      // wanted off the shared set at reply time rather than from its own request, so an overlapping
      // toggle made one call's confirmation agree with the other call's rule. The loser then ran its
      // success path for the wrong direction — a fully healthy-looking offline control with layer 2
      // taken down under it.
      //
      // Asserted as an invariant rather than a sequence: whatever order they land in, what `state()`
      // reports and what the three layers hold have to be the same thing.
      armed()
      const net = make(fakeHostBinary(dir, log, 200))
      await net.setOffline(UDID, true)

      await Promise.all([net.setOffline(UDID, false), net.setOffline(UDID, true)])

      // Same redundancy as the test above, and the same warning. Serialising the whole operation and
      // taking `wanted` from the request each close this alone; removing both reproduces the original
      // failure and this fails on layer 1.
      const settled = net.state(UDID)
      expect(existsSync(conditionPath(UDID)), 'layer 2 disagrees with the reported state').toBe(settled.offline)
      expect(statusBar.at(-1), 'layer 3 disagrees with the reported state').toBe(`${UDID}:${settled.offline}`)
      expect(rules().at(-1)?.includes(UDID), 'layer 1 disagrees with the reported state').toBe(settled.offline)
    })

    it('is steerable again once the filter answers again', async () => {
      // The recovery half, which nothing covered: every failure test wrote a sentinel and none removed
      // one, so the line that clears the remembered verdict ran unobserved. Deleting it leaves a device
      // permanently `filter-unavailable` after one refusal, with the whole suite green.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      writeFileSync(join(dir, 'NO_STATE'), '')
      // Short, because this test is about the verdict rather than the wait; the wait itself is
      // covered above, against the real default.
      const net = make(undefined, 200)
      await net.setOffline(UDID, true)
      expect(net.state(UDID).available).toBe(false)

      rmSync(join(dir, 'NO_CONFIRM'), { force: true })
      rmSync(join(dir, 'NO_STATE'), { force: true })

      await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })
      expect(net.state(UDID)).toEqual({ offline: true, available: true })
    })

    it('does not carry a lost verdict into the next boot', async () => {
      // `state()` reads the remembered layer-1 judgment before every other piece of evidence, and
      // nothing else clears it — a device that left `this.offline` is never looked at by the watcher
      // again. So a rebooted simulator answered `enforcement-lost` from `device:ready` and from every
      // re-join after it, and the dashboard interrupts on that reason rather than re-colouring: a new
      // tester told to re-check work that belonged to a session which had already ended.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
      expect(net.state(UDID)).toMatchObject({ reason: 'enforcement-lost' })

      await net.arm(UDID)

      expect(net.state(UDID)).not.toMatchObject({ reason: 'enforcement-lost' })
    })

    it('watches again after a disconnect and a reconnect', async () => {
      // `dispose()` is called when the agent loses the relay, and `connect()` is public and reuses the
      // same instance — so a one-way flag would leave the watcher off for the rest of the process and
      // the one report that invalidates a finished check would never come. Asserted as a positive:
      // without `resume` clearing the flag nothing fires and this times out.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      net.dispose()
      net.resume()

      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('stops watching once nothing is offline', async () => {
      // The watcher is the first thing here that outlives a call, so it has to end on its own — and
      // a stale file after everything is back online is not an enforcement failure, it is a filter
      // with nothing to do.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      await net.setOffline(UDID, false)

      staleState([], -10)
      await new Promise((r) => setTimeout(r, 100))

      expect(lost).toEqual([])
    })
  })
})
