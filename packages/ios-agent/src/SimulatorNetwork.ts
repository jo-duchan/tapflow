import { execFile } from 'child_process'
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { NetworkStatePayload } from '@tapflowio/agent-core'

const execFileAsync = promisify(execFile)
const NETHOOK_DYLIB = join(import.meta.dirname, '..', 'bin', 'libtapflow-nethook.dylib')

/**
 * A regular file, not merely a path that resolves.
 *
 * `existsSync` answers true for a directory, and dyld cannot inject one — so the check that exists to
 * say "the library is not here" would have passed and let `state()` fall through to the verdict,
 * reporting `awaiting-app` about an install that can never work. `statSync` follows symlinks, which is
 * right: a link to a real dylib is one.
 */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Take one simulator off the network, or put it back (#607).
 *
 * A simulator has no NIC to switch off — it is host processes sharing the Mac's network stack — so
 * "offline" is assembled from three mechanisms, and the whole point of this class is that they are
 * never applied separately:
 *
 *  1. **the host content filter** (`ios-netfilter`) drops the simulator's flows at the kernel
 *  2. **the injected dylib** tells the app its path is unsatisfied, and cuts the connections it is
 *     already holding
 *  3. **the status bar** stops showing service
 *
 * Each alone produces a false result a tester would sign off on. Layer 1 alone leaves the app
 * believing it is online — measured: traffic dead, `NWPathMonitor` reporting satisfied for the life
 * of the process — and leaves a pooled connection working. Layer 2 alone blocks nothing: faking
 * `nw_path_get_status` does not stop `URLSession`, which reads the kernel's real path. Layer 3 alone
 * is pixels.
 */
export interface SimulatorNetworkOptions {
  /** The container app that owns the system extension. Absent or not installed means layer 1 cannot
   *  be applied, which this class reports rather than works around. */
  filterHostBinary?: string
  /** Where the dylib looks for its per-simulator flag. The host's `/tmp` is visible at the same path
   *  inside every simulator on the Mac, which is why the file name carries the udid. */
  conditionDir?: string
  /** Where the dylib writes what its self-check found. */
  verdictDir?: string
  /** The injected library. Overridable so a test never arms a real simulator. */
  nethookDylib?: string
  /** Where the provider's state file may be, most likely first. Overridable so a test can point at a
   *  file it writes rather than at whatever the Mac's real filter is doing. */
  filterStateFiles?: string[]
  /** Called when a device that was offline stops being enforced. The agent turns this into an
   *  unsolicited `network:state`; nothing here knows about the wire. */
  onEnforcementLost?: (udid: string) => void
  /** How often liveness is checked. Overridable so a test does not have to spend seconds of wall
   *  clock proving that a stale file is noticed; the threshold itself comes from the file. */
  livenessIntervalMs?: number
  /** How long the state-file fallback waits for the provider to publish. Same reason as the interval
   *  above: proving that a file which never catches up is refused should not cost three seconds. */
  filterConfirmDeadlineMs?: number
}

const DEFAULT_HOST_BINARY = '/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter'

/** How long the filter host gets. It activates a system extension, which is a few hundred ms when
 *  nothing is wrong and unbounded when a user is being asked to approve something. */
const FILTER_HOST_TIMEOUT_MS = 15_000

/**
 * How long a confirmation gets. **This is the mechanism, not a backstop.**
 *
 * A confirmation made while the provider is dead does not fail — it *blocks*. Measured 3/3: the call
 * ran to the caller's own deadline with neither the invalidation nor the interruption handler firing,
 * because launchd holds the mach name while the process is away. So this number is what decides
 * `filter-unavailable` in the commonest failure there is, and the window it has to decide inside is
 * not rare: a provider killed and restarted by launchd is gone for about 5.8 seconds (measured; one
 * run in five took 21.3).
 *
 * One second: about thirty times the measured worst case of a healthy round trip (host binary launch
 * 34ms, XPC 0.26–0.74ms, propagation under 55ms), and an eighth of the dashboard's 8s request
 * deadline, so a refusal arrives as a refusal rather than as a request that timed out.
 *
 * It is also how long the operation queue is held when things go wrong, which is the cost side: a
 * second device's toggle waits behind it. That is accepted rather than overlooked, and the
 * alternative was tried and reviewed out — confirming outside the queue lets the write and its
 * confirmation belong to different rules, which produced two ways of applying layers 2 and 3 over a
 * kernel that was not enforcing. `serialize` has the sequences.
 */
const FILTER_CONFIRM_TIMEOUT_MS = 1_000

/**
 * How long the **file** fallback gets, once the ask above has already failed.
 *
 * Only reached when the XPC channel is gone, and after a system-extension replace it is: the retired
 * extension sits `[terminated waiting to uninstall on reboot]` holding the mach name, the new
 * provider's `NSXPCListener.resume()` fails with `Operation not permitted`, and `--confirm` answers
 * `no listener` in 9ms while the filter is genuinely enforcing. Measured 2026-09-03. The listener is
 * vended once per process and the provider survives `--off`/`--install`, so that failure lasts as
 * long as the provider does.
 *
 * Three seconds is three of the provider's enforcing pulses, the same tolerance `checkLivenessLocked`
 * gives a rule change that has not been published yet. It covers the forced publish a rule change
 * triggers (one 1s tick plus the timer's 250ms leeway).
 *
 * **What it does not cover, on purpose**: a provider old enough to lack that forced publish, going
 * back *online* on a Mac with no traffic at all — that direction waits out `pulseSeconds(false)`,
 * 4.75s. Sizing this past that would hold the operation queue for six seconds on every failed
 * toggle. The case is no worse than it is today, where the same Mac has no answer at all.
 */
const FILTER_FILE_CONFIRM_DEADLINE_MS = 3_000

/** Cheap enough to be indistinguishable from the file's own write, and coarse enough not to spin. */
const FILTER_FILE_POLL_MS = 100

/** Where the provider writes what it is enforcing. Both are tried: the first is where it lands on a
 *  healthy Mac, the second is the fallback it uses when that directory cannot be written. */
const FILTER_STATE_FILES = [
  '/Library/Application Support/tapflow/tapflow-netfilter-state.json',
  '/tmp/tapflow-netfilter-state.json',
]

/** How often liveness is checked while anything is offline. Matches the provider's fast pulse — it
 *  writes every second while its rule is non-empty — so a stopped heartbeat is noticed in about the
 *  time it takes for three of them to go missing. */
const LIVENESS_INTERVAL_MS = 1_000

/**
 * How long after a launch an absent verdict is still ordinary (#629).
 *
 * **Derived from the dylib rather than picked.** Its verdict is written from a
 * `__attribute__((constructor))`, which reads as "milliseconds" and is wrong: the constructor runs
 * `tf_self_check()` first, and that waits on a semaphore for up to **3 seconds** for a path update
 * (`network-hook.m`). So a perfectly healthy install produces no verdict for three seconds after the
 * process starts, plus whatever the launch itself took.
 *
 * 10s is that plus room for a loaded Mac starting a large app. Generous on purpose: past this the
 * answer changes from "waiting" to "this cannot work", and being early would put that verdict on an
 * install that was about to succeed. The cost of being late is that a tester sees `awaiting-app` for a
 * few seconds longer — which is the true answer for those seconds.
 */
export const LAUNCH_VERDICT_DEADLINE_MS = 10_000

/** What the provider pulses at **while it is enforcing something** (`Provider.swift`, `pulseSeconds`).
 *  Held here as well because a file written before the rule changed declares the *idle* rate, so the
 *  rate to expect next cannot always be read out of the file. Change one and change the other. */
const ENFORCING_PULSE_SECONDS = 1

/**
 * The non-negative counts in an untrusted object, entry by entry.
 *
 * Anything else is dropped rather than failing the whole read — see `droppedByDevice`. This file is
 * written by a root-owned process on the other side of a version boundary, so a value that is not a
 * count is a thing to discard, not a reason to disbelieve the rest.
 *
 * **`Number.isInteger`, because these are flows** and `dropped 0.5 flow(s)` is a sentence no reader
 * should be handed. **The array guard and the `>= 0` do not change today's output** — an array index
 * cannot be a udid, and a negative would fail the `> 0` test at the only place this is consumed. They
 * are here for the second consumer, and that is stated rather than left to look load-bearing.
 */
function numbersIn(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v
  }
  return out
}

/** What the provider's state file says. `pulseSeconds` is read rather than assumed: the provider
 *  changes its own rate (1s while enforcing, 5s idle) and publishes the one in force, so a threshold
 *  derived from this stays right when that changes. */
interface FilterStateFile {
  at: number
  pulseSeconds: number
  rule: string[]
  /**
   * Which provider wrote this, when the provider is new enough to say.
   *
   * **Absent is the ordinary answer during a rollout**, so nothing may treat its absence as a bad
   * file. It matters in one window: a replace leaves two providers briefly alive, both publishing to
   * the same path, and only one of them is the session the kernel consults. Without it a log saying
   * the rule disagreed cannot name which provider it read.
   */
  pid?: number
  /**
   * Flows the provider dropped, per device (#654) — **evidence, and only in one direction.**
   *
   * The rest of this file proves the provider *received* the rule. That is not the same as the
   * device's traffic having stopped: `handleNewFlow` allows a flow it could not attribute, on
   * purpose, so a simulator whose flows consistently fail attribution keeps talking while the file
   * stays fresh and its rule stays correct. A drop is the one observation that closes that gap,
   * because a dropped flow was attributed by construction.
   *
   * **A zero, or an absent entry, proves nothing.** An offline device that opens no connections drops
   * nothing, which is the ordinary state of a simulator sitting on a screen. Nothing here may be read
   * as failure — see `state()` and `checkLivenessLocked`, neither of which does.
   *
   * Absent entirely on a provider older than this change, which is the normal state while a Mac has
   * not reinstalled the extension yet.
   */
  droppedByDevice: Record<string, number>
}

/**
 * What layer 1 was last found to be doing for a device, when it was not simply working.
 *
 * Absent is the healthy case. The two members exist because `state()` is synchronous — every
 * re-join, every `device:ready`, every capability `networkState()` goes through it, and none can
 * make an XPC call. Without remembering, one re-join would repaint a device that cannot be steered
 * as a healthy one, and the toast a tester was shown would be the only trace left of it.
 */
type FilterVerdict = 'unavailable' | 'lost'

/** The simctl calls this needs. Narrower than `SimctlWrapper` so a test can stand in for it. */
interface SimctlForNetwork {
  setStatusBarOffline(udid: string, offline: boolean): Promise<void>
  setSimulatorEnv(udid: string, name: string, value: string): Promise<void>
}

export class SimulatorNetwork {
  private readonly hostBinary: string
  private readonly conditionDir: string
  private readonly verdictDir: string
  private readonly dylib: string
  /** Every simulator currently offline. The filter takes the whole set on each call — it has no
   *  add/remove — so this is the authority for what the rule should say, not a cache of it. */
  private readonly offline = new Set<string>()
  /** Devices whose injection is actually in place. Separates "nothing was delivered" from "delivered,
   *  no app has run under it yet" — two states with different remedies, and a reason each. */
  private readonly armed = new Set<string>()
  /** Serialises **whole operations**, not just the host run. See `serialize`. */
  private filterQueue: Promise<unknown> = Promise.resolve()
  /** Set while a liveness check is queued, so a slow toggle does not let ticks pile up behind it. */
  private livenessQueued = false
  /** What layer 1 was last found doing, per device. See `FilterVerdict` for why it is remembered. */
  private readonly filterVerdict = new Map<string, FilterVerdict>()
  /** When each device's offline rule was confirmed, in whole seconds. Read by `checkLiveness` to tell
   *  a file that disagrees from one that is simply older than the write. */
  private readonly offlineSince = new Map<string, number>()
  /**
   * The drop count last reported for each offline device (#654).
   *
   * **Two things need it.** The liveness check runs every second, so a device with any drops at all
   * would otherwise repeat the same line 600 times in a ten-minute session — into the stream where
   * the enforcement-lost report a person is actually looking for arrives. And the provider's count is
   * per episode but the *file* is a snapshot: only an increase since the last read is news.
   *
   * Cleared wherever `offlineSince` is, so a device that goes offline again starts from nothing —
   * an absent entry reads as zero, and the provider prunes its own counts per episode too, so both
   * ends forget together.
   */
  private readonly dropsReported = new Map<string, number>()
  /**
   * When a launch was last issued for each device (#629).
   *
   * A timestamp rather than a timer: `state()` is synchronous and called from several paths, and there
   * is nothing to cancel — a second launch overwrites this, and a verdict arriving makes it
   * irrelevant. A timer would have to be cancelled on both.
   */
  private readonly launchedAt = new Map<string, number>()
  /** The pid of the last launch that actually started a process, per device. See `markLaunched`. */
  private readonly launchedPid = new Map<string, number>()
  /** Runs only while something is offline. See `updateLiveness`. */
  private liveness: ReturnType<typeof setInterval> | undefined
  /** Set by `dispose`. Without it, work that was already in flight puts the interval back: both
   *  `setOffline` and `checkLiveness` call `updateLiveness()` *after* their awaits, so a dispose
   *  landing in between was undone by whichever of them resumed next.
   *
   *  **No test reaches this flag, and one that appeared to was deleted rather than kept.** The
   *  scenario it needs — a dispose landing mid-operation, then a state file that makes the watcher
   *  report on its next tick — did not report even with the flag removed *and* `clearInterval` taken
   *  out of `dispose`, so the assertion was green against every mutation of the thing it named.
   *  Observing the watcher stop needs a seam this class does not have (#664). The flag stays because
   *  it is correct and costs one comparison; what it does not have is coverage, and saying so here is
   *  cheaper than a test that says otherwise. */
  private disposed = false
  private readonly stateFiles: string[]
  private readonly confirmDeadlineMs: number
  private enforcementLost: (udid: string) => void
  private readonly livenessIntervalMs: number
  /** State files already reported as untrusted, so the warning is not repeated on every read. */
  private readonly refused = new Set<string>()

  constructor(
    private readonly simctl: SimctlForNetwork,
    opts: SimulatorNetworkOptions = {},
  ) {
    this.hostBinary = opts.filterHostBinary ?? DEFAULT_HOST_BINARY
    this.conditionDir = opts.conditionDir ?? '/tmp'
    this.verdictDir = opts.verdictDir ?? '/tmp'
    this.dylib = opts.nethookDylib ?? NETHOOK_DYLIB
    this.stateFiles = opts.filterStateFiles ?? FILTER_STATE_FILES
    this.confirmDeadlineMs = opts.filterConfirmDeadlineMs ?? FILTER_FILE_CONFIRM_DEADLINE_MS
    this.enforcementLost = opts.onEnforcementLost ?? (() => { /* nobody listening */ })
    this.livenessIntervalMs = opts.livenessIntervalMs ?? LIVENESS_INTERVAL_MS
  }

  /**
   * Put the injection in place for a device that has just booted.
   *
   * **Clearing comes first, and it is not tidiness.** The condition file and the verdict both outlive
   * the simulator that wrote them — they are on the host, keyed only by udid — so a device that boots
   * into a leftover condition file is offline before anyone asked, and a leftover verdict answers for
   * hooks that belong to a process which no longer exists.
   *
   * The library is armed here and the target app is not, because the target is not known yet. Until
   * `target()` names one the dylib loads into every process in the simulator and hooks none of them,
   * which is its designed default.
   */
  async arm(udid: string): Promise<void> {
    return this.serialize(() => this.armLocked(udid))
  }

  private async armLocked(udid: string): Promise<void> {
    this.offline.delete(udid)
    this.armed.delete(udid)
    // **Layer 1's remembered judgment goes too, and leaving it out was a defect two reviewers found
    // independently.** `state()` reads it before every other piece of evidence, and nothing else ever
    // clears it: a `'lost'` set by `checkLiveness` survives the provider coming back, because the
    // device has left `this.offline` and liveness never looks at it again. So a simulator whose
    // enforcement was lost, then rebooted, answered `enforcement-lost` from `device:ready` and from
    // every re-join afterwards — and the dashboard interrupts on that reason rather than re-colouring,
    // so a new tester was told to re-check work belonging to a session that had already ended.
    //
    // This block's own doc says a leftover verdict answers for a process that no longer exists. That
    // was true of the dylib's file and not of this, which is exactly how it was missed.
    this.filterVerdict.delete(udid)
    this.offlineSince.delete(udid)
    this.dropsReported.delete(udid)
    // **With the verdict it belongs to.** A boot is a new process for every app, so a launch recorded
    // before it describes one that no longer exists — and leaving it behind means a freshly booted
    // device reads as `hooks-not-installed` from its first `state()` call, on the strength of an app
    // that ran in the previous session.
    this.launchedAt.delete(udid)
    this.launchedPid.delete(udid)
    this.setCondition(udid, false)
    rmSync(this.verdictPath(udid), { force: true })

    // **The rule is rewritten, not merely forgotten.** Clearing the in-memory set and the condition
    // file used to be the whole of this, which left the one layer that actually stops traffic still
    // naming the device: a simulator toggled offline, shut down and booted again came up with its
    // traffic dead while this class reported it online and steerable, and nothing recovered it short
    // of toggling twice.
    //
    // **Names this udid and only this udid.** The rule is the host's and the set is this process's
    // memory, so a rule left behind by the process before it still has to be cleared — but clearing
    // it by writing this agent's whole set is what erased every other agent's devices. Naming the one
    // that just booted does the same job for the device that is actually being armed.
    await this.runFilterHost({ remove: [udid] })
    // Arm can empty the offline set, and the watcher has to stop with it or tick forever on nothing.
    this.updateLiveness()

    // Recorded only after the call returns. A device whose environment could not be set has had
    // nothing delivered, and saying otherwise would report it as merely waiting for an app — a state
    // whose remedy is to launch one, which would never help.
    await this.simctl.setSimulatorEnv(udid, 'DYLD_INSERT_LIBRARIES', this.dylib)
    this.armed.add(udid)
  }

  /**
   * Name the app the hooks may touch.
   *
   * **Must be called before the app is launched.** dyld reads the environment when a process starts,
   * so naming the target afterwards arms the *next* launch and leaves the running one unhooked —
   * reporting `available: true` for an app that would never see a path update.
   *
   * **The previous app's verdict goes with it.** A verdict is one process's report that its own hooks
   * took, and that process has exited by the time a second app is launched. Leaving the file behind
   * answered for the new app on the old one's evidence: `available: true` before the new process had
   * written anything, and — if its hooks fail — for as long as it runs. The gap where `state()`
   * answers `awaiting-app` for a launch already in flight is the correct reading of that moment;
   * inheriting a stale `ok` is not.
   */
  async target(udid: string, bundleId: string): Promise<void> {
    rmSync(this.verdictPath(udid), { force: true })
    await this.simctl.setSimulatorEnv(udid, 'TAPFLOW_TARGET_BUNDLE', bundleId)
  }

  /**
   * A process started, so a verdict is now owed — `markLaunched` opens the window `state()` measures.
   *
   * **Called after the launch, not before it, and that is a correction.** The mark was first set at
   * the top of `target()`, which put `simctl spawn … launchctl setenv`, `simctl launch` and the app's
   * whole dyld load *inside* the budget — none of it measured — and left the mark standing when the
   * launch failed outright, so a launch that never happened reported the hooks as broken ten seconds
   * later.
   *
   * **Only for a pid that is new.** `simctl launch` is issued without `--terminate-running-process`,
   * so launching a bundle that is already running returns the existing pid and starts nothing. The
   * verdict is written from a dyld constructor — once per process — so nothing will rewrite the file
   * `target()` just deleted, and starting a deadline there would report a permanently dead control
   * over an app whose hooks are live and watching. That case stays what it was before this change,
   * which is wrong but harmless; #692 has the decision it needs.
   */
  markLaunched(udid: string, pid: number | null): void {
    if (pid === null || this.launchedPid.get(udid) === pid) return
    this.launchedPid.set(udid, pid)
    this.launchedAt.set(udid, Date.now())
  }

  /**
   * **Layer 1 leads in both directions, and the order is measured rather than chosen.**
   *
   * Going offline, the dylib cuts the app's open sockets the moment the flag file appears. If the
   * filter were not already dropping new flows at that instant, the app would simply reconnect —
   * reproduced exactly that way while stepping the layers separately, and the reconnected socket then
   * survived the rest of the session.
   *
   * Coming back, the filter has to stop dropping before the app is told the path is satisfied, or the
   * first thing it does with the good news is fail.
   *
   * The status bar goes last either way: it reports, so it should not claim a state before the state
   * is true.
   */
  async setOffline(udid: string, offline: boolean): Promise<NetworkStatePayload> {
    return this.serialize(() => this.setOfflineLocked(udid, offline))
  }

  /** The body of `setOffline`, running with the queue held. Calls `runFilterHost` directly: going
   *  through `serialize` again from in here would wait on a slot this call already owns. */
  private async setOfflineLocked(udid: string, offline: boolean): Promise<NetworkStatePayload> {
    const was = this.offline.has(udid)
    if (offline) this.offline.add(udid)
    else this.offline.delete(udid)

    const enforced = await this.applyAndConfirm(udid, offline)
    if (!enforced) {
      // **Layer 1 is not enforcing, so layers 2 and 3 do not get applied.** Two of the three work
      // without it and neither blocks traffic: the app would be told its path is unsatisfied and its
      // sockets would be cut, while every request it makes afterwards succeeds. That is a tester
      // signing off offline behaviour they never saw — the exact failure this feature exists to
      // prevent, produced by the feature itself.
      //
      // **Both directions, including coming back online.** A draft carried the online request out
      // anyway, reasoning that a device nothing is enforcing is reachable already and refusing would
      // strand an app believing it is offline. That reasoning was wrong and a test caught it: not
      // being able to *change* the rule is not the same as nothing enforcing it. The provider is a
      // separate process holding the rule it was last given, so a container app that cannot run
      // leaves a device exactly as offline as it was — and taking layers 2 and 3 down there would tell
      // the app it is online while the kernel goes on dropping its traffic.
      //
      // Enforcement that has genuinely stopped is a different signal with a different remedy, and it
      // has one: `checkLiveness` takes the layers down and reports `enforcement-lost`.
      //
      // The device is wherever it already was — **which is not necessarily online.** This used to
      // delete unconditionally and answer `offline: false`, so a device that was already offline came
      // back as online here and from every later `state()` call, with the rule and the condition file
      // still saying otherwise. Reporting the request back as if it had taken is how a tester ends up
      // filing bugs against an app that was never offline; reporting it as online when it is offline
      // sends them to file against one that cannot reach anything.
      if (was) this.offline.add(udid)
      else this.offline.delete(udid)
      // **And the restored set is written back**, because the run that failed was not necessarily the
      // only writer. The host reads `this.offline` when it *runs*, not when it was queued — correct,
      // since the set is the authority — so with two toggles in flight an earlier run can already have
      // committed a later one's set. Restoring in memory alone then leaves this device named offline
      // here and absent from the kernel rule: traffic alive, and this class saying it is not, which is
      // the direction the paragraph above calls filing bugs against an app that was never offline.
      //
      // Best-effort by definition — the write that just failed may fail again — and that is still
      // strictly better than not trying, because the alternative is a divergence nothing revisits
      // until the device is rebooted.
      await this.runFilterHost(was ? { add: [udid] } : { remove: [udid] })
      this.filterVerdict.set(udid, 'unavailable')
      this.updateLiveness()
      return { offline: was, available: false, reason: 'filter-unavailable' }
    }

    this.filterVerdict.delete(udid)
    if (offline) {
      this.offlineSince.set(udid, Math.floor(Date.now() / 1000))
      // **Seeded from whatever the file already says, and this is the episode boundary.**
      //
      // The provider prunes its own counts when a device leaves the rule, but only while rendering —
      // and its `ruleWatch` only advances when a flow arrives. So a device toggled off, on, and off
      // again with no flow and no pulse in between leaves the provider having never seen the empty
      // rule, and it republishes the previous episode's count as if it belonged to this one.
      //
      // **The provider cannot fix that, because it cannot see an episode.** It knows a rule, not that
      // a tester toggled a control. This class does. Taking the current count as the baseline makes a
      // stale number harmless whatever the provider does: only drops *above* it are evidence for this
      // episode, and if there were none the answer is silence, which is what zero has always meant
      // here.
      this.dropsReported.set(udid, this.readFilterState()?.droppedByDevice[udid] ?? 0)
    } else {
      this.offlineSince.delete(udid)
      this.dropsReported.delete(udid)
    }
    this.setCondition(udid, offline)
    // **Layer 3 only reports, so its failure is not a reason and must not undo the two that do.**
    // Unswallowed, one `status_bar` failure threw out of here with layers 1 and 2 already applied: the
    // device really was offline and the caller was told the request failed, which is the direction
    // that sends a tester to file against an app that was never online.
    //
    // Swallowed in both directions, and they fail differently. Going offline it errs *quietly* — the
    // device is offline and the status bar has not caught up. Coming back it errs the other way: every
    // layer is restored and the bar still shows no service, on a device whose requests now succeed.
    // Neither is worth failing the call for. What puts the second one right is a later toggle writing
    // the bar again — **a full cycle, not one press**, since the first press writes the value the bar
    // is already stuck on. And it is not guaranteed: if layer 1 becomes unavailable in between, every
    // later call returns above this line and the bar stays wrong until the device is retired. That
    // gap, and the fact that swallowing also removes the `network:error` this used to raise, are
    // recorded rather than solved here.
    await this.simctl.setStatusBarOffline(udid, offline).catch((e: unknown) => {
      console.warn(`[network] status bar for ${udid} could not be set: ${(e as Error).message}`)
    })
    this.updateLiveness()

    return this.state(udid)
  }

  /**
   * Write the rule and **ask the provider whether it is holding it.**
   *
   * The write's exit code cannot answer that. The container app exits when the framework accepts the
   * save — 27ms for the whole run — and the running provider is handed the configuration afterwards
   * with nothing coming back. Measured propagation is under 55ms and a probe measured the ask itself
   * at 0.26–0.74ms, which is what makes asking cheaper than the six-second wait an earlier draft
   * proposed in place of it.
   *
   * **The predicate is per-device membership, not set equality.** The filter is host-wide and this
   * agent is not guaranteed to be its only writer; comparing whole sets would report every device as
   * unenforced the moment somebody else's device appeared in the rule.
   *
   * **`wanted` is the value the caller asked for, and it is a parameter for that reason.** Reading it
   * back off `this.offline` here compares the provider's answer against whatever the set says *now*,
   * which is not necessarily what this call wrote — so a second toggle landing in between made a
   * confirmation agree with a rule its own request had not asked for, and the success path then
   * applied layers 2 and 3 for the wrong direction.
   *
   * A mismatch is logged **with what was actually read**, and with the channel it was read from.
   * Two agents writing the same rule cannot be told apart afterwards from a log that only records
   * what each one expected — each is internally consistent and one of them is stale.
   */
  private async applyAndConfirm(udid: string, wanted: boolean): Promise<boolean> {
    // **Read before the write, and read the file's own clock.** The fallback below needs to tell a
    // publication that answers this write from one that predates it, and the file stamps whole
    // seconds — so a baseline taken from `Date.now()` here would land in the same second as the
    // provider's reply about nine times in ten and reject the very answer it was waiting for.
    const before = this.readFilterState()?.at ?? 0
    if (!await this.runFilterHost(wanted ? { add: [udid] } : { remove: [udid] })) return false
    const seen = await this.confirmEnforcement(udid, wanted, before)
    if (!seen) return false
    if (!seen.enforcing) return false
    if (seen.rule.includes(udid) !== wanted) {
      console.warn(
        `[network] filter rule disagrees for ${udid}: wanted ${wanted ? 'offline' : 'online'}, ` +
        `provider ${seen.pid} holds [${seen.rule.join(',')}] (read over ${seen.from})`,
      )
      return false
    }
    return true
  }

  /**
   * What the filter is enforcing — **asked first, and read from the file when the asking is gone.**
   *
   * `--confirm` is the fast and precise channel: 0.26–0.74ms, and it answers from the process the
   * kernel is actually consulting. It stays the primary for exactly that reason, so the healthy Mac
   * this class runs on most of the time is untouched by any of this.
   *
   * **But it disappears after every system-extension replace, and stays gone.** The retired extension
   * sits `[terminated waiting to uninstall on reboot]` still owning the mach name, so the new
   * provider's `NSXPCListener.resume()` fails with `Operation not permitted` — silently, because
   * `resume()` returns void. `--confirm` then answers `no listener` in 9ms while the filter is
   * genuinely enforcing and publishing a fresh state file. Measured 2026-09-03; the provider survives
   * `--off`/`--install` on the same pid, so the listener is never re-vended and the loss lasts as long
   * as the provider does.
   *
   * Taking that as "not confirmed" is what put `filter-unavailable` in front of a tester whose filter
   * was working, on every Mac that had upgraded. The CLI reached the same conclusion earlier and for a
   * different reason (`net-filter.ts`: a stale binary turns a flag it does not know into a rule
   * write); this is the agent following it.
   *
   * `undefined` for every way of not finding out — the remedy is the same whether the filter is
   * absent, disabled, or restarting.
   */
  private async confirmEnforcement(
    udid: string, wanted: boolean, since: number,
  ): Promise<{ enforcing: boolean; rule: string[]; pid: number; from: 'xpc' | 'file' } | undefined> {
    const asked = await this.askProvider()
    if (asked) return asked
    return await this.readConfirmation(udid, wanted, since)
  }

  /** The XPC channel. Its own failures are all the same answer, so none of them are distinguished. */
  private async askProvider(): Promise<{ enforcing: boolean; rule: string[]; pid: number; from: 'xpc' } | undefined> {
    if (!existsSync(this.hostBinary)) return undefined
    try {
      const { stdout } = await execFileAsync(this.hostBinary, ['--confirm'], {
        timeout: FILTER_CONFIRM_TIMEOUT_MS,
      })
      const parsed = JSON.parse(stdout) as { enforcing?: unknown; rule?: unknown; pid?: unknown }
      if (typeof parsed.enforcing !== 'boolean' || !Array.isArray(parsed.rule)) return undefined
      return {
        enforcing: parsed.enforcing,
        rule: parsed.rule.filter((r): r is string => typeof r === 'string'),
        pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
        from: 'xpc',
      }
    } catch {
      // A timeout lands here as well as a refusal, and they are the same answer: not confirmed.
      return undefined
    }
  }

  /**
   * The file channel, polled until it answers or the deadline passes.
   *
   * **Three outcomes, and the middle one is the reason this is a loop rather than a read.** This runs
   * immediately after a rule write, so the ordinary state for up to a pulse is a file that is fresh,
   * correct, and about the *previous* rule — `checkLivenessLocked` says the same thing about the same
   * window, and reading it as a disagreement would fire on every toggle.
   *
   * - The rule matches what was asked for: answered, whenever it was published.
   * - It does not match and was published *after* the baseline: the provider has spoken and it
   *   disagrees. That is a real mismatch and is returned so the caller can log it.
   * - It does not match and was published at or before the baseline: it has not published since the
   *   write. Wait.
   *
   * A stale file is never any of the three: a provider that died left it there, so it is skipped
   * rather than believed, and `Heartbeat.remove()` means absence is what a *stopped* filter leaves.
   */
  private async readConfirmation(
    udid: string, wanted: boolean, since: number,
  ): Promise<{ enforcing: boolean; rule: string[]; pid: number; from: 'file' } | undefined> {
    const until = Date.now() + this.confirmDeadlineMs
    for (;;) {
      const file = this.readFilterState()
      const now = Math.floor(Date.now() / 1000)
      // `file.at <= now` first, and it is not redundant: a timestamp from the future makes the
      // subtraction negative and passes any threshold, so a clock that moved backwards would let a
      // dead provider's frozen file read as perfect for as long as the skew lasted.
      // `checkLivenessLocked` refuses the same reading for the same reason; this is its twin and
      // had drifted from it.
      if (file && file.at <= now && now - file.at <= 3 * Math.max(file.pulseSeconds, 1)) {
        const answered = file.rule.includes(udid) === wanted || file.at > since
        if (answered) return { enforcing: true, rule: file.rule, pid: file.pid ?? -1, from: 'file' }
      }
      if (Date.now() >= until) return undefined
      await new Promise((resolve) => setTimeout(resolve, FILTER_FILE_POLL_MS))
    }
  }

  /** Layers 2 and 3, taken down together. Layer 3 is swallowed for the reason `forget` gives: it only
   *  reports, and failing it would abandon the cleanup that matters. */
  private async takeDownLayers(udid: string): Promise<void> {
    this.setCondition(udid, false)
    await this.simctl.setStatusBarOffline(udid, false).catch(() => { /* device may already be gone */ })
  }

  /**
   * What the device is doing and whether tapflow can still steer it.
   *
   * `offline` describes the **device**, not the last request: a simulator taken offline and then left
   * unsteerable is still offline, and saying otherwise would draw "online" over an app that can reach
   * nothing.
   */
  state(udid: string): NetworkStatePayload {
    const offline = this.offline.has(udid)

    // **Layer 1 is answered first, and from memory.** This method is synchronous — `device:ready`, a
    // viewer's re-join and the capability's `networkState()` all arrive here — so it cannot ask
    // anything. Deriving layer 1's health from the dylib's verdict instead would repaint a Mac that
    // cannot take devices offline as a healthy one on the next re-join, and the tester's toast would
    // be the only evidence it ever said otherwise.
    const filter = this.filterVerdict.get(udid)
    if (filter === 'lost') return { offline, available: false, reason: 'enforcement-lost' }
    if (filter === 'unavailable') return { offline, available: false, reason: 'filter-unavailable' }

    // **Layer 2 cannot work at all if the library is not on disk**, and that is the quietest failure
    // in the feature: `DYLD_INSERT_LIBRARIES` naming a path that does not exist is ignored by dyld
    // without a word, so the app launches unhooked and no verdict is ever written. `arm()` records
    // the device as armed whatever the file's state — it sets the environment and does not read the
    // path it sets — so the branch below fell to `awaiting-app`: "launch an app through tapflow", to
    // a tester who has already launched one, for the life of the session. (`not-armed` and its
    // reboot only appear when this process restarted, since `armed` is its memory.)
    //
    // Read rather than remembered, unlike layer 1 above. Layer 1 is a question this synchronous
    // method cannot put to the provider; this one is a `stat`, and a `node_modules` emptied under a
    // running agent is an ordinary thing to happen.
    if (!isFile(this.dylib)) return { offline, available: false, reason: 'hooks-not-installed' }

    const verdict = this.readVerdict(udid)

    // The three answers differ by what the tester has to do, which is what the reason set is for.
    // An absent verdict means two different things and they were reported as one: nothing was
    // delivered (reboot), or it was delivered and no app has exercised it yet (launch one). The
    // second is what every iOS session looks like before its app starts, so folding it into
    // `not-armed` put the wrong remedy on the common case.
    if (verdict === 'missing') {
      if (!this.armed.has(udid)) return { offline, available: false, reason: 'not-armed' }
      // **A launch that produced no verdict is not a device waiting for one** (#629), and this is the
      // second form of the failure the `isFile` guard above exists for. That one covers a path dyld
      // ignores because nothing is there; this covers a library that is there and still does not load
      // — a wrong architecture, a runtime change, a signature. dyld says nothing in either case.
      //
      // Without it, `awaiting-app` says "launch an app through tapflow" to a tester who has already
      // launched one, for the life of the session: word for word the sentence the comment above calls
      // the quietest failure in the feature.
      //
      // The window before the deadline is genuinely `awaiting-app` — the dylib may still be inside its
      // own three-second self-check — which is why this is a deadline and not a flag.
      const launched = this.launchedAt.get(udid)
      if (launched !== undefined && Date.now() - launched > LAUNCH_VERDICT_DEADLINE_MS) {
        return { offline, available: false, reason: 'hooks-not-installed' }
      }
      return { offline, available: false, reason: 'awaiting-app' }
    }
    if (verdict === 'failed') return { offline, available: false, reason: 'hooks-not-installed' }
    // **`state-unconfirmed`, because that is what happened: a read that could not be confirmed.**
    //
    // Two members it is deliberately not. Not `awaiting-app`: resolving this against `armed` would
    // land there almost every time — the library writes the file *because* an app is running, so
    // `armed` is true — and `awaiting-app` is the one member drawn with a healthy control and "launch
    // an app", which hands a normal-looking toggle to a device nobody can vouch for. And not
    // `not-armed`, whose sentence is "restart the device". Rebooting a simulator mid-session destroys
    // the app state under test, and none of the causes left here is fixed by it — a verdict from an
    // older dylib is replaced by the app's next launch, and a shape this reader cannot parse is not a
    // property of the boot. `state-unconfirmed` says "could not confirm — try again", and looking again is
    // exactly the remedy.
    if (verdict === 'unreadable') return { offline, available: false, reason: 'state-unconfirmed' }
    return { offline, available: true }
  }

  /** Called when a device goes away, so a shutdown simulator does not keep a rule alive that names
   *  it — the filter would carry the udid for the rest of the host's uptime. */
  async forget(udid: string): Promise<void> {
    return this.serialize(() => this.forgetLocked(udid))
  }

  private async forgetLocked(udid: string): Promise<void> {
    this.armed.delete(udid)
    // The judgment was about a device that is going away. Keeping it would answer for whatever is
    // booted into the same udid next.
    this.filterVerdict.delete(udid)
    this.offlineSince.delete(udid)
    this.dropsReported.delete(udid)
    this.launchedAt.delete(udid)
    this.launchedPid.delete(udid)
    // Unconditional, for the reason `arm()` gives at length: the set is this process's memory and the
    // rule is the host's. An agent that restarted knows of no offline device, so `delete` answers
    // false and the write was skipped — leaving the udid named in the rule for the rest of the Mac's
    // uptime, which is the exact outcome this method's doc block says it exists to prevent.
    this.offline.delete(udid)
    await this.runFilterHost({ remove: [udid] })
    this.setCondition(udid, false)
    // **The status bar is part of what has to come back.** It was set by `setOffline` and had no
    // other caller, so a device retired while offline kept showing no service for as long as it
    // stayed booted — a relay disconnect was enough. That is the pixels-only false result this class
    // exists to prevent, pointed the other way.
    //
    // Swallowed, and only here: a device being retired is often already gone, and `status_bar clear`
    // against a shut-down simulator fails. Failing this call would abandon the rest of the cleanup
    // for a layer that only reports.
    await this.simctl.setStatusBarOffline(udid, false).catch(() => { /* device may already be gone */ })
    this.updateLiveness()
  }

  /**
   * Point the report somewhere after construction.
   *
   * **The constructor option alone left this untestable, which a review found by mutating the wiring
   * away and watching the whole suite stay green.** `IOSAgent` builds its own `SimulatorNetwork` only
   * when one was not injected, and every test injects one — so the handler was attached on exactly the
   * path no test takes. The one channel that tells a tester their finished check was invalidated had
   * no coverage at all, while the refusal path beside it had five tests.
   */
  setEnforcementLostHandler(fn: (udid: string) => void): void {
    this.enforcementLost = fn
  }

  /**
   * Stop watching. **Nothing else clears the interval**, so an agent that shuts down while a device
   * is offline would otherwise keep a timer alive for the life of the process — which is what
   * happened, because for a while this had no caller outside the tests at all. `IOSAgent.disconnect`
   * owns it, beside the resources timer and the tree reader it already stops.
   */
  dispose(): void {
    this.disposed = true
    if (this.liveness) clearInterval(this.liveness)
    this.liveness = undefined
  }

  /**
   * Undo `dispose`, because an agent that disconnected can connect again on the same instance.
   *
   * **A one-way disposed flag is a bug with the shape of the one it fixes**, and this codebase has
   * already shipped it once: the provider's `Heartbeat.stopped` was set by a stop and cleared by
   * nothing, so the first `stopFilter` in a process killed the state file for good while the filter
   * went on filtering. Here it would be quieter and worse — `connect()` is public and reuses the
   * network, so a reconnect after a disconnect would leave the watcher off, and the one report that
   * tells a tester their check was invalidated would simply never come.
   */
  resume(): void {
    this.disposed = false
    this.updateLiveness()
  }

  // ── liveness: enforcement that stops after the fact ────────────────────────

  /**
   * Watch only while something is offline, because that is the only time there is anything to lose.
   *
   * The interval is `unref`'d: this must not be the reason a process stays alive.
   */
  private updateLiveness(): void {
    const wanted = !this.disposed && this.offline.size > 0
    if (wanted && !this.liveness) {
      this.liveness = setInterval(() => { void this.checkLiveness() }, this.livenessIntervalMs)
      this.liveness.unref?.()
    } else if (!wanted && this.liveness) {
      clearInterval(this.liveness)
      this.liveness = undefined
    }
  }

  /**
   * Notice that a device stopped being enforced, and say so.
   *
   * **Why this exists at all, given the confirmation on the write.** The confirmation answers the
   * moment of the request; enforcement can stop at any point afterwards, and when it does the tester
   * is looking at a control that still says offline. Measured on the reference Mac: killing the
   * provider leaves the kernel passing that simulator's traffic for about 5.8 seconds before launchd
   * has it back, and 23 to 27 requests got through each time. The tester's sign-off covers requests
   * that succeeded.
   *
   * **The threshold comes out of the file.** Three pulses, at whatever rate the provider says it is
   * pulsing — 1s while it is enforcing, so about three seconds. Hard-coding fifteen (three of the old
   * five-second pulses) is what made the outage above arithmetically invisible: the gap closes before
   * the threshold expires and nothing is ever reported.
   *
   * **A timestamp in the future is not freshness, it is a file that cannot be trusted.** Clocks move
   * backwards — NTP corrections, a sleeping Mac — and treating `at > now` as "very fresh" would make
   * a stale file look perfect for as long as the skew lasted.
   */
  private async checkLiveness(): Promise<void> {
    // Queued like every other mutation. It edits `this.offline`, rewrites the rule and takes layers
    // down, so running it beside a toggle is the race described on `serialize` — and the tick is the
    // half that used to run outside the boundary.
    if (this.livenessQueued) return
    this.livenessQueued = true
    try {
      await this.serialize(() => this.checkLivenessLocked())
    } finally {
      this.livenessQueued = false
    }
  }

  /**
   * **Three questions per device, and each one is a different piece of evidence.** A single "is the
   * file stale" test read against the whole set could not answer them, and the gap it left is
   * measured: the provider publishes its pulse rate *as of the rule it held when it wrote*, so the
   * last write before a device went offline says `pulseSeconds: 5`. A provider dying in the second
   * after a toggle therefore leaves a file that is not stale by its own declared rate for fifteen
   * seconds, and does not name the device either — both predicates false, nothing reported, and the
   * kernel passing that simulator's traffic for the whole of it.
   */
  private async checkLivenessLocked(): Promise<void> {
    if (this.offline.size === 0) return
    const file = this.readFilterState()
    const now = Math.floor(Date.now() / 1000)

    const lost = [...this.offline].filter((udid) => {
      // No file at all, or a timestamp from the future — a clock that moved backwards must not read
      // as very fresh, or a frozen file looks perfect for as long as the skew lasts.
      if (!file || file.at > now) return true
      const since = this.offlineSince.get(udid) ?? now
      // Named in the rule: only the file going stale can lose it, at whatever rate the file declares.
      // Per device rather than by set equality — the filter is host-wide, and somebody else's device
      // appearing in the rule must not make this one look unenforced.
      if (file.rule.includes(udid)) return now - file.at > 3 * Math.max(file.pulseSeconds, 1)
      // Not named, and the file was written before this device's rule was confirmed: the provider has
      // simply not published since. That is the ordinary state for about a second after every toggle,
      // and reading it as a disagreement fires on every one of them. It stops being ordinary once the
      // provider has had three of its enforcing pulses to say something.
      if (file.at <= since) return now - since > 3 * ENFORCING_PULSE_SECONDS
      // Not named, and published *after* the confirmation. The provider has spoken and this device is
      // not in what it said.
      return true
    })
    // **Q1, resolved: the evidence goes in the log and not on the wire.** Adding a drop count to
    // `NetworkStatePayload` would be a protocol change for a number a tester cannot act on, and the
    // one-directional reading below is not something a control can render honestly — "0 drops" looks
    // like a failure and is not. A person diagnosing reads this line; nothing else changes.
    //
    // Deliberately outside the `lost` branch: it is worth saying that a device is *proven* enforcing,
    // not only that one stopped being.
    if (file) {
      // **Over `this.offline`, never over the file's own keys.** The state file is host-wide: another
      // agent's devices and rule entries this instance never wrote can be in it, and claiming evidence
      // about those is the same mistake the loop above refuses to make — "somebody else's device
      // appearing in the rule must not make this one look unenforced", pointed the other way.
      for (const udid of this.offline) {
        // **Not for a device this tick just declared lost.** The file that froze is where both
        // readings come from, so without this the log says "enforcement observed" and then reports
        // that enforcement stopped, one line apart, about the same device — a flat contradiction
        // handed to the person the line exists for.
        if (lost.includes(udid)) continue
        const drops = file.droppedByDevice[udid] ?? 0
        // **Only an increase is news.** This runs once a second, so a device with any drops at all
        // would repeat the same line for as long as it stays offline — 600 of them in a ten-minute
        // session, in the stream where the enforcement-lost report actually matters. A count that
        // went *down* is a provider that restarted; it re-reports from there rather than staying
        // silent until it passes the old high-water mark.
        const reported = this.dropsReported.get(udid) ?? 0
        if (drops > reported) {
          console.log(`[network] filter has dropped ${drops} flow(s) for ${udid} — enforcement observed, not just delivered`)
        }
        if (drops !== reported) this.dropsReported.set(udid, drops)
      }
    }
    if (lost.length === 0) return

    for (const udid of lost) {
      this.offline.delete(udid)
      this.offlineSince.delete(udid)
      this.dropsReported.delete(udid)
      this.filterVerdict.set(udid, 'lost')
    }
    // **`remove: lost` is the whole point of this write, and naming only `add` was a regression.**
    //
    // The divergence being repaired is caused by the devices just deleted from `this.offline`. The
    // whole-set write this replaced removed them by writing a set they were no longer in; a delta has
    // to say so. Without it they stay in the host's rule, launchd brings the provider back in about
    // six seconds, it re-reads the persisted configuration, and the kernel drops that simulator's
    // traffic again — while layers 2 and 3 are down, `state()` answers `offline: false`, and the
    // watcher has stopped because the set is empty. Traffic dead and reported online, which is the
    // one direction this class exists to prevent.
    //
    // `add` stays, and not as symmetry: a device can be in this set with the rule not naming it, when
    // `setOffline`'s failure path restored it in memory and its best-effort rewrite failed too.
    await this.runFilterHost({ add: [...this.offline], remove: lost })
    for (const udid of lost) {
      // **Telling the tester is the remedy; taking the layers down is the tidying up.** The device is
      // already reachable — that is what was detected — so leaving the app believing otherwise would
      // add a second false state on top of the one being reported.
      await this.takeDownLayers(udid)
      this.enforcementLost(udid)
    }
    this.updateLiveness()
  }

  /** The first candidate that parses wins. A file that is present but unreadable is not evidence of
   *  anything, so it is treated as absent rather than as a reason to stop looking. */
  private readFilterState(): FilterStateFile | undefined {
    for (const path of this.stateFiles) {
      const text = this.readIfProviderWrote(path)
      if (text === undefined) continue
      try {
        const raw = JSON.parse(text) as Partial<FilterStateFile>
        if (typeof raw.at !== 'number' || !Array.isArray(raw.rule)) continue
        return {
          at: raw.at,
          pulseSeconds: typeof raw.pulseSeconds === 'number' ? raw.pulseSeconds : 5,
          rule: raw.rule.filter((r): r is string => typeof r === 'string'),
          // **Its absence is not a parse failure**, and that is the load-bearing part. The provider is
          // installed by hand and replaced only on reboot, so a Mac running a provider older than
          // #654 is the ordinary case during rollout — treating a missing field as a bad file would
          // report "not enforcing" for a filter doing its job, which is the exact failure the rest of
          // this file exists to prevent. A malformed one is discarded the same way, entry by entry.
          droppedByDevice: numbersIn(raw.droppedByDevice),
          // Same rule as the field above it: a provider that does not publish this is not a bad file.
          pid: typeof raw.pid === 'number' ? raw.pid : undefined,
        }
      } catch {
        continue
      }
    }
    return undefined
  }

  /**
   * The file's contents, or nothing when anyone on this Mac could have written it.
   *
   * The provider runs as root and writes with `.atomic`, so what it leaves is a root-owned regular
   * file. Its fallback is `/tmp`, and `/tmp` is world-writable: any local process can put a file
   * there with a current timestamp and a rule naming a device, and this class read it as the
   * provider's own publication. Since #733 that publication confirms a rule write — which is what
   * lets layers 2 and 3 go on — so a forged file could draw "offline" over a simulator whose traffic
   * is flowing, the sign-off failure the feature exists to prevent (#734). Reachable only while the
   * protected file is absent, which is the state of a Mac whose filter is stopped or never installed.
   *
   * **The rule is about the directory, not about which path this is.** A file in a directory that
   * anyone but its owner can write to is believed only when root owns it and nobody else can change
   * it. The protected path is untouched, and so is a test's temp directory: nobody but the owner can
   * write to either, which is what lets a test keep injecting a file it wrote itself. Judged through
   * the descriptor that is then read, so the file that was checked is the file that is believed, and
   * without following a symlink, which the provider never leaves. Liveness reads through here as
   * well, so a forged file cannot delay an `enforcement-lost` report either.
   *
   * `O_NONBLOCK` is load-bearing: opening a FIFO read-only blocks until a writer arrives, and the
   * `isFile()` check that would refuse it runs after the open — so a `mkfifo` at the fallback path
   * held the agent's whole thread, streaming and relay connection included. A regular file is
   * unaffected by the flag; the FIFO open returns at once and is refused where it was meant to be.
   */
  private readIfProviderWrote(path: string): string | undefined {
    let fd: number
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch {
      return undefined
    }
    try {
      const file = fstatSync(fd)
      if (!file.isFile()) return undefined
      if ((statSync(dirname(path)).mode & 0o022) !== 0 && (file.uid !== 0 || (file.mode & 0o022) !== 0)) {
        // Once per path: this is polled ten times a second while a confirmation waits.
        if (!this.refused.has(path)) {
          this.refused.add(path)
          console.warn(`[network] ignoring ${path}: in a world-writable directory and not written by root`)
        }
        return undefined
      }
      return readFileSync(fd, 'utf8')
    } catch {
      return undefined
    } finally {
      closeSync(fd)
    }
  }

  // ── layer 1 ────────────────────────────────────────────────────────────────

  /**
   * **Serialised, and bounded in time.**
   *
   * The host takes the whole offline set on each run and the last writer wins, so two of these in
   * flight at once decide the rule by which subprocess happens to finish last rather than by which
   * request came last. Two devices toggled in the same second is enough — and the set each one reads
   * is correct, which is what makes the wrong outcome hard to see afterwards: both runs are internally
   * consistent and one of them is stale.
   *
   * **What is serialised is the whole operation, and an earlier version serialised only the host
   * run.** That version released the queue the moment the rule was written, so the confirmation that
   * follows ran outside it — and a review found two ways that breaks. A liveness tick landing between
   * a device joining the offline set and its confirmation declared that device's enforcement lost,
   * rewrote the rule without it, took layers 2 and 3 down, and told every session; the confirmation
   * then came back, compared against a set the tick had already edited, agreed with itself, and put
   * layers 2 and 3 **back on** over a kernel rule that no longer named the device. Two toggles of the
   * same device overlapping produced the mirror image: a fully healthy-looking offline control with
   * layer 2 taken down under it. Both end in the state this class exists to prevent — the app told it
   * is offline while its requests succeed — so the boundary has to contain the confirmation, and
   * every reader and writer of `offline` has to be inside it.
   *
   * The timeout covers a host that never returns. It waits on `OSSystemExtensionRequest`, and one of
   * its outcomes is a System Settings dialog nobody is standing in front of; the binary now exits
   * itself on that path, but a timeout here is what keeps a wedge from taking the queue with it —
   * everything after it is waiting on this chain.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.filterQueue.then(work)
    // Keep the chain alive whatever this run did: a rejection left on it would fail every later call.
    this.filterQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * The container app writes the rule and exits.
   *
   * **Its exit is not the confirmation.** Zero means the container app launched and the framework
   * accepted the save — the whole run is 27ms, measured — and the running provider is handed the new
   * configuration afterwards, with nothing coming back to say it has it. So this answers "nothing
   * refused"; whether the device is actually offline is answered by `state()`, from evidence the
   * dylib wrote inside the simulator.
   */
  /**
   * **Names the devices it is changing, and nothing else.**
   *
   * This used to write `[...this.offline]` — the whole set — and the host replaced the rule with it.
   * The rule is host-wide, so that made every run an assertion about devices this agent had never
   * heard of: a second agent starting knows of no offline device, and `arm()` runs on every device
   * boot, so **starting one put every device the other had taken offline back online**, silently,
   * while its tester watched an offline control over working traffic.
   *
   * A delta cannot say anything about a device it does not name. The cleanup the whole-set write used
   * to provide is not lost, only made precise: `armLocked` names the udid that just booted in
   * `remove`, and a rule left behind by a dead process is cleared the next time that device comes up
   * rather than by wiping the host's.
   */
  private async runFilterHost(delta: { add?: string[]; remove?: string[] }): Promise<boolean> {
    if (!existsSync(this.hostBinary)) return false
    const args: string[] = []
    if (delta.add?.length) args.push('--add', delta.add.join(','))
    if (delta.remove?.length) args.push('--remove', delta.remove.join(','))
    // **Nothing to say means do not run it, and that is load-bearing rather than an optimisation.**
    // The host reads the absence of both flags as "clear the rule" — deliberately, because a person
    // whose agent died holding a rule has no other way to empty it. So an agent that ran it with an
    // empty delta would wipe the host's rule while believing it had done nothing.
    if (args.length === 0) return true
    try {
      await execFileAsync(this.hostBinary, args, { timeout: FILTER_HOST_TIMEOUT_MS })
      return true
    } catch {
      return false
    }
  }

  // ── layer 2 ────────────────────────────────────────────────────────────────

  private conditionPath(udid: string): string {
    return `${this.conditionDir}/tapflow-offline-${udid}`
  }

  private setCondition(udid: string, offline: boolean): void {
    const path = this.conditionPath(udid)
    if (!offline) {
      rmSync(path, { force: true })
      return
    }
    mkdirSync(this.conditionDir, { recursive: true })
    writeFileSync(path, '')
  }

  /**
   * `missing`, `failed` and `unreadable` are three different answers and a tester needs all of them.
   *
   * Missing is not by itself an answer — it is the same file being absent whether the injection was
   * never delivered or is simply waiting for its first app, which is why `state` reads it against
   * `armed` rather than reporting it directly. Failed means the dylib ran and proved by trying that
   * its hooks did not take, which no amount of relaunching will change.
   *
   * Unreadable is neither, and folding it into `failed` was this reader claiming evidence it does not
   * have: a file this reader cannot parse says nothing about whether the hooks took. **The library
   * now writes it with `rename` and no longer produces torn ones (#653)**, which removes the cause
   * that was reachable on a healthy session — not the member. A simulator still running an app that
   * was launched by an older dylib writes the old way, and a file whose shape this reader does not
   * recognise is unreadable however it got there. Unlike the other two it is **not** resolved against
   * `armed` — see `state` for why that would be worse than the problem.
   */
  private verdictPath(udid: string): string {
    return `${this.verdictDir}/tapflow-nethook-${udid}.json`
  }

  private readVerdict(udid: string): 'ok' | 'failed' | 'missing' | 'unreadable' {
    const path = this.verdictPath(udid)
    if (!existsSync(path)) return 'missing'
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { installed?: unknown }
      if (raw.installed === true) return 'ok'
      // **`failed` is the library's own signal and nothing else.** Testing for `!== true` swept up
      // every shape that is not it — `{}`, `[]`, a bare number, a bare string — and answered
      // "the library ran and proved its hooks did not take" about a file that shows no such thing.
      // That is the same overclaim this branch was split out to remove, one case over.
      return raw.installed === false ? 'failed' : 'unreadable'
    } catch {
      // A file whose shape says nothing, or one written by a dylib from before the write became
      // atomic (#653). Says nothing about the hooks either way, which is the whole reason it is not
      // `failed`.
      return 'unreadable'
    }
  }
}
