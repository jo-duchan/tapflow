import NetworkExtension
import Network
import Darwin
import os.log

// Layer 1: content filter (NEFilterDataProvider). Measured to capture simulator app flows where the
// transparent proxy (app-proxy flow layer) could not. See .work/2026-08-22-ios-transparent-proxy-plan.md.
//
// per-UDID: a flow carries a bundle id, never which simulator it belongs to. Every process inside a booted
// simulator is a child of that simulator's `launchd_sim`, and the UDID appears in exactly ONE observable
// place — launchd_sim's arguments:
//
//   launchd_sim /Users/<u>/Library/Developer/CoreSimulator/Devices/<UDID>/data/var/run/launchd_bootstrap.plist
//
// It is NOT in the executable path (simulator binaries, launchd_sim included, live in the shared
// simruntime) and NOT in the working directory (measured: "/"). So a flow is attributed by walking its
// process up to the ancestor whose parent is the host launchd, confirming that ancestor is launchd_sim,
// and reading the UDID out of its arguments. Host-Mac flows stop at their own top-level process, whose
// path is not launchd_sim, and resolve to nil.
private let log = OSLog(subsystem: "dev.tapflow.netfilter", category: "filter")

// The offline set arrives through NEFilterProviderConfiguration.vendorConfiguration, written by the
// container app (Open Q#3). Loopback needs no exception: measured, a content filter never sees loopback
// flows at all — a simulator in the offline set still reaches the host's 127.0.0.1 (which is where Metro
// runs) while every external flow of the same simulator is dropped.
//
// It is read per flow rather than cached at startFilter, because whether a change reaches a RUNNING
// provider is the open question this build measures: a toggle that only takes effect on restart is a
// different feature from one that takes effect now.
/// Not `private`: `IPCListener` reads it to answer `ping`, and reading the configuration through the
/// same function is what keeps the answer and the enforcement from drifting apart.
func offlineUDIDs(_ config: NEFilterProviderConfiguration) -> Set<String> {
    guard let raw = config.vendorConfiguration?["offlineUDIDs"] as? [String] else { return [] }
    return Set(raw)
}

// Logs the offline set the moment it changes, so the measurement can tell a live update from a restart
// (a restart shows up as a new provider pid plus a startFilter line).
private final class RuleWatch {
    private var last: Set<String>?
    private let lock = NSLock()

    /// Returns whether the rule moved, which is the one edge worth writing the heartbeat on
    /// immediately rather than at the next tick.
    @discardableResult
    func noteIfChanged(_ current: Set<String>) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard last != current else { return false }
        os_log("offline set now %{public}@ (was %{public}@)", log: log, type: .default,
               current.sorted().joined(separator: ","), last?.sorted().joined(separator: ",") ?? "<unset>")
        last = current
        return true
    }
}

private let ruleWatch = RuleWatch()

// MARK: - what the agent can see

/**
 * **The provider's only way to tell the agent anything** (#639).
 *
 * The agent runs on the host as the user and decides whether the network control is usable. Until
 * this file it decided entirely from the *dylib's* verdict, which is evidence about layer 2 — so a
 * filter that was killed, never approved, or running an older bundle left the control saying
 * "steerable" over a kernel dropping nothing.
 *
 * **This file is not the only channel there could be, and the note that used to say so was wrong.**
 * It read "the XPC mach service never registered", which was measured false: a build that starts a
 * listener on `NEMachServiceName` answers a call from the container app in **0.26–0.74 ms**. The same
 * probe measured `vendorConfiguration` reaching a running provider in **under 55 ms**, so "the
 * container app exits before the provider has been handed the rule" was wrong too. What is slow is
 * the pulse below — ours, not the framework's.
 *
 * **This build starts no listener**, and adopting that channel is a separate decision. Recorded here
 * because the old sentence was the reason nobody looked. If it is adopted, the two are not
 * alternatives and this file still has a job: a reply would say *the rule arrived*, while only this
 * says *the filter is running* — `stopFilter` removes it, and the probe measured a stopped provider
 * still answering XPC.
 *
 * **It pulses, and that is what makes absence mean something.** A first draft wrote only from
 * `handleNewFlow`, which is a heartbeat with no heart: a provider that died left its last file on
 * disk saying it was enforcing a rule, forever — the exact lie #639 exists to catch, written down.
 * Staleness could not rescue it either, because a quiet Mac and a dead provider look identical when
 * the only writer is traffic. So the timer below writes on its own, `startFilter` writes once, and
 * `stopFilter` removes the file. A reader can then treat *missing or older than a few pulses* as
 * "not enforcing" and be right about both cases.
 *
 * It carries three things, because three issues wanted them and one file is cheaper than three
 * mechanisms: the rule this provider is actually holding (#639), what the per-flow attribution costs
 * (#641), and how often attribution *failed* rather than finding a host process (#642).
 */
private final class Heartbeat {
    // `pulseSeconds(enforcing:)` is in `FlowIdentity.swift` with the measurements behind 1 and 5.

    private let lock = NSLock()
    /// The disk write happens here, never on the flow's thread. `handleNewFlow` decides whether a
    /// connection is allowed; a file system round trip has no business in that path, and the lock
    /// this used to hold across `Data.write` serialised every concurrent flow behind it.
    private let io = DispatchQueue(label: "dev.tapflow.netfilter.heartbeat", qos: .utility)

    private var path: String?
    private var warned = false
    /// Set once the filter has stopped. **Checked on the `io` queue, not at the call site**, because
    /// the call site is not where the ordering problem is: `pulse?.cancel()` does not stop a handler
    /// already running, and `handleNewFlow` can be mid-flight on another thread. Either could enqueue
    /// a write *after* `remove()` and recreate the file — leaving a fresh-looking state that claims
    /// the provider is enforcing a rule, which is the one thing this file must never say.
    private var stopped = false
    private var lastWrite: CFAbsoluteTime = 0
    /// The rule as of the last file this object rendered.
    ///
    /// `nil` until the first one **and again after every `resume()`**, so the first pulse of a filter's
    /// life is always due — which is what makes a fresh file appear promptly rather than at the idle
    /// rate. The reset matters because this object is process-wide and a filter can stop and start
    /// again inside it; see `resume()`.
    ///
    /// **Records what was rendered, which is one step short of what was published**: `publish` can
    /// still drop the write when a stop lands while it is queued. That direction is harmless — a
    /// dropped write means the filter is stopping, and `remove()` is what follows it.
    private var lastPublishedRule: Set<String>?

    private var flowsSimulator = 0
    private var flowsHost = 0
    private var flowsUnresolved = 0
    private var flowsDropped = 0
    private var flowsIdle = 0
    /// Flows an offline simulator was allowed anyway because they are name resolution.
    ///
    /// **A subset of `simulator`, like `dropped` is** — the first draft made it a sibling instead, so
    /// `simulator − dropped` silently stopped meaning "allowed simulator flows" for anyone reading the
    /// file. It stays out of `dropped` because that is the number the agent reads as evidence the
    /// filter is enforcing, and a DNS allow is not that.
    private var flowsDns = 0
    /**
     * Drops, per device (#654).
     *
     * **The file used to prove rule *delivery* and was read as enforcement.** A fresh file naming a
     * device says the provider received the rule; it does not say the device's traffic stopped. The
     * gap is deliberate — `handleNewFlow`'s `.unresolved` branch allows on purpose, because failing
     * closed on a transient `sysctl` failure would cut the user's own browser — so a simulator whose
     * flows consistently fail attribution keeps talking while the file stays fresh and correct.
     *
     * A drop is the one thing that can close it, because a dropped flow was attributed by
     * construction and therefore has a udid.
     *
     * **`unresolved` is not here and never can be.** Unresolved *means* the walk could not name an
     * owner; bucketing it per device would invent the attribution whose absence defines it. It stays
     * a host-wide total, and anyone reaching for a per-device version should read this instead.
     */
    private var droppedByUDID: [String: Int] = [:]
    private var walks = 0
    private var walkNanos: UInt64 = 0

    /// **`idle` is its own member and does not fold into `host`.**
    ///
    /// Those flows were never attributed — the walk was skipped because the rule was empty. Counting
    /// them as host flows would put a number in the file meaning "we decided this belonged to the
    /// Mac", when nothing decided anything. The file is read to diagnose, and a diagnosis built on an
    /// invented decision is worse than a missing one.
    enum Outcome { case simulator(dropped: Bool, udid: String), host, unresolved, idle, dns }

    /**
     * Candidates, in order — **and every one of them has to be readable by the agent**, which runs
     * as the user while this runs as root.
     *
     * That rules out the obvious-looking ones. `NSHomeDirectory()` for root is `/var/root`, which is
     * `drwxr-x---`, and root's `NSTemporaryDirectory()` is a `drwx------` folder under
     * `/var/folders`. A file written there succeeds, logs a cheerful path, and is invisible to the
     * only reader — worse than failing, because the loud "no writable path" line never fires.
     *
     * Measured: the first candidate works. `/tmp` has **not** been exercised — an earlier version of
     * this comment claimed the old "root cannot write /tmp" note was false, which the evidence did
     * not support, because the loop returns on the first success and never reached it.
     *
     * **Only success is remembered.** A `probed` flag used to be set before either candidate was
     * tried, so one transient refusal — a full disk, a permission that had not settled yet — silenced
     * the file for the rest of the provider's life, and the agent read that permanent silence as "not
     * enforcing" while the filter went on dropping traffic. Re-probing costs four syscalls on the
     * `io` queue at most once a pulse, and only while there is no path; the logs are what needed the
     * guard, not the work.
     */
    private static let candidates = [
        "/Library/Application Support/tapflow",
        "/tmp",
    ]

    private func resolvePath() -> String? {
        if let path { return path }
        for dir in Heartbeat.candidates {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o755])
            let candidate = (dir as NSString).appendingPathComponent("tapflow-netfilter-state.json")
            if FileManager.default.createFile(atPath: candidate, contents: Data("{}\n".utf8),
                                              attributes: [.posixPermissions: 0o644]) {
                os_log("heartbeat path: %{public}@", log: log, type: .default, candidate)
                path = candidate
                warned = false
                return path
            }
            if !warned {
                os_log("heartbeat path refused: %{public}@", log: log, type: .default, candidate)
            }
        }
        if !warned {
            warned = true
            os_log("no writable heartbeat path — the agent cannot see this provider", log: log, type: .error)
        }
        return nil
    }

    /// Count one flow and refresh the file if it is due. One lock acquisition for both, so the
    /// counters cannot be read half-updated and the rule cannot be published out of order.
    func note(_ outcome: Outcome, walkNanos: UInt64?, rule: Set<String>, ruleChanged: Bool) {
        lock.lock()
        switch outcome {
        case .simulator(let dropped, let udid):
            flowsSimulator += 1
            if dropped {
                flowsDropped += 1
                droppedByUDID[udid, default: 0] += 1
            }
        case .host: flowsHost += 1
        case .unresolved: flowsUnresolved += 1
        case .idle: flowsIdle += 1
        case .dns:
            flowsSimulator += 1
            flowsDns += 1
        }
        // Only a walk that ran is a walk. Counting the `pid <= 0` short circuit diluted the average
        // with samples that measured nothing.
        if let nanos = walkNanos {
            walks += 1
            self.walkNanos += nanos
        }
        // Enqueued while the lock is still held. See `publish`.
        if dueLocked(force: ruleChanged) { publish(renderLocked(rule: rule)) }
        lock.unlock()
    }

    /// The pulse. **One timer serves both rates** — it ticks at the fast one and this decides whether
    /// a write is due, so a rule change takes effect on the next tick with nothing to reschedule.
    ///
    /// The tolerance is the timer's leeway: without it a 1s tick against a 1s threshold misses by a
    /// few milliseconds and writes every *other* tick, which would halve the rate this exists to set.
    func pulse(rule: Set<String>) {
        lock.lock()
        let now = CFAbsoluteTimeGetCurrent()
        // **A rule this file has not published yet is due whatever the clock says.**
        //
        // `note` already forces one on the same edge, and that covers a Mac with traffic — which is
        // most of them, and is why this was easy to leave out. It is not all of them: `note` runs on
        // `handleNewFlow`, so a Mac with no connections at all has only this timer, and the threshold
        // it is about to check is the *idle* rate whenever the new rule is empty. Bringing the last
        // device back online there published nothing for 4.75 seconds, and the agent's confirmation
        // reads that silence as the rule not having landed.
        //
        // Compared against what was last written rather than taking `RuleWatch`'s edge: that watch is
        // consume-once and lives on the flow path, so reading it here would race `handleNewFlow` for
        // the same edge and one of the two would publish nothing.
        let unpublished = lastPublishedRule != rule
        if unpublished || now - lastWrite >= pulseSeconds(enforcing: !rule.isEmpty) - 0.25 {
            lastWrite = now
            publish(renderLocked(rule: rule))
        }
        lock.unlock()
    }

    /// Undo `remove()`, because a provider that is stopped can be started again in the same process.
    ///
    /// **`stopped` is process-wide and was one-way, which was a bug with the shape of the one it
    /// fixed.** `remove()` sets it so nothing can recreate the file after a stop; nothing cleared it,
    /// so the first `stopFilter` in a process killed the state file for good — and `startFilter` runs
    /// again on the same process when the filter is re-enabled. Measured: the provider went on
    /// answering `handleNewFlow` with no state file on disk, which is exactly the "enforcing while the
    /// agent reads absence" that this file exists to make impossible.
    func resume() {
        lock.lock()
        stopped = false
        // **The publication history goes with the file, and forgetting one without the other is the
        // same bug this method already exists to fix.** `remove()` deleted the file; `lastPublishedRule`
        // and `lastWrite` still describe it. A restart that lands on an unchanged rule — which is every
        // restart `nesessionmanager` performs for an installed-apps change, so every `ditto` into
        // `/Applications` — would then find nothing due: the rule matches what was last rendered, and
        // the elapsed check is measured from a write that no longer exists on disk. At the idle rate
        // that is 4.75 seconds of a provider enforcing while the agent reads absence, which is the one
        // thing this file must never say.
        //
        // `lastWrite` as well as the rule: keeping it would leave the *first* pulse after a resume
        // subject to a threshold measured against the previous life of the filter.
        lastPublishedRule = nil
        lastWrite = 0
        lock.unlock()
    }

    /// Absence is the signal a stopped filter should leave behind.
    func remove() {
        lock.lock(); stopped = true; let p = resolvePath(); lock.unlock()
        guard let p else { return }
        // Last on the queue, so anything already enqueued runs first and is then undone by this.
        io.async { try? FileManager.default.removeItem(atPath: p) }
    }

    private func dueLocked(force: Bool) -> Bool {
        let now = CFAbsoluteTimeGetCurrent()
        if !force && now - lastWrite < 1.0 { return false }
        lastWrite = now
        return true
    }

    private func renderLocked(rule: Set<String>) -> String {
        lastPublishedRule = rule
        let avg = walks > 0 ? Double(walkNanos) / Double(walks) / 1000.0 : 0
        // The rule arrives through `vendorConfiguration`, which this provider does not write and
        // cannot constrain. Hand-quoting it made the whole file invalid JSON for any value carrying a
        // quote or a backslash, and an unparseable file reads as "not enforcing" — the wrong answer,
        // stated confidently, with nothing in the log to say why.
        let rules = (try? JSONSerialization.data(withJSONObject: rule.sorted()))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        var json = "{\"at\":\(Int(Date().timeIntervalSince1970))"
        // **Which provider wrote this.** A replacement leaves two of them briefly alive, both
        // publishing to this one path, and only one is the session the kernel consults — so a reader
        // that finds the rule disagreeing cannot otherwise say whose rule it read. `--confirm` has
        // carried this since #639; the file did not, and the file is what a reader falls back to once
        // the replacement has taken the XPC listener away.
        json += ",\"pid\":\(ProcessInfo.processInfo.processIdentifier)"
        json += ",\"pulseSeconds\":\(Int(pulseSeconds(enforcing: !rule.isEmpty)))"
        json += ",\"rule\":\(rules)"
        json += ",\"flows\":{\"simulator\":\(flowsSimulator),\"host\":\(flowsHost)"
        json += ",\"unresolved\":\(flowsUnresolved),\"dropped\":\(flowsDropped)"
        json += ",\"idle\":\(flowsIdle),\"dnsAllowed\":\(flowsDns)}"
        // Assigned back on purpose — see `prunedDrops`, where the reason is written down.
        droppedByUDID = prunedDrops(droppedByUDID, rule: rule)
        let perDevice = droppedByUDID
        let dropped = (try? JSONSerialization.data(withJSONObject: perDevice))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        json += ",\"droppedByDevice\":\(dropped)"
        json += ",\"attribution\":{\"walks\":\(walks),\"avgMicros\":\(String(format: "%.1f", avg))}}\n"
        return json
    }

    /// **Called with `lock` held**, on purpose: rendering under the lock and enqueuing outside it let
    /// two threads render A then B and enqueue B then A, so the file could move backwards — an older
    /// `rule` landing last is a reader told the wrong thing about what is being enforced. `io.async`
    /// only copies a block, and nothing here ever waits on `io`, so holding the lock across it cannot
    /// deadlock.
    private func publish(_ json: String) {
        io.async { [self] in
            lock.lock(); let done = stopped; let p = resolvePath(); lock.unlock()
            // Re-checked here rather than before enqueuing: the stop can land while this is queued.
            guard !done, let p else { return }
            try? Data(json.utf8).write(to: URL(fileURLWithPath: p), options: .atomic)
        }
    }
}

private let heartbeat = Heartbeat()


// **An established connection cannot be cut, and this is where that was settled.**
//
// `.drop()` in `handleNewFlow` only ever reaches a NEW flow. A connection the app already holds — and
// `URLSession` holds one for a whole session — carries every later request without ever asking again,
// so a tester who goes offline mid-session leaves the app still talking. Apple is explicit that the
// decision is one-way: "Once you've allowed a connection to proceed, there's no way to go back on
// that decision. That's true for both content filter and transparent proxy."
// (https://developer.apple.com/forums/thread/710166)
//
// The one escape the framework offers is to never allow it: keep returning a data verdict so the flow
// stays under the filter. That was built and measured, and `peekBytes` — "the number of bytes after
// the end of the bytes passed that the filter wants to see in the next call" — makes it unusable:
//
//   peek 8192  →      0 data callbacks. An HTTP request is a few hundred bytes and never reaches the
//                     threshold, so the toggle never gets a chance to touch the flow.
//   peek 1     →  815,869 data callbacks in one 40-second run, one byte each. The drop does land, and
//                     it takes every simulator's throughput with it — the *control* simulator, which
//                     no rule named, timed out on every request.
//
// So the flow verdict is final here on purpose. What an app in a session sees is: new connections
// fail, and the connection it is holding keeps working until it is replaced. Closing that gap needs a
// mechanism inside the app process, not on the host — see the plan.

class Provider: NEFilterDataProvider {
    /// Holds the state-file pulse. See `startPulse`.
    private var pulse: DispatchSourceTimer?

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        os_log("startFilter entered, offline=%{public}@", log: log, type: .default,
               offlineUDIDs(filterConfiguration).sorted().joined(separator: ","))
        let settings = NEFilterSettings(rules: [], defaultAction: .filterData)
        apply(settings) { [weak self] error in
            if let error {
                os_log("startFilter failed: %{public}@", log: log, type: .error, error.localizedDescription)
            } else {
                // **After `apply` succeeds, not before it.** The filter can be stopped and started
                // again inside one process, so a stop's `remove()` has to be undone somewhere — but
                // undoing it before the filter is actually running opens a window for a writer left
                // over from the *previous* session: `pulse?.cancel()` does not stop a handler already
                // executing, and `handleNewFlow` can be mid-flight. Either reaching `publish` after
                // `stopped` was cleared recreates the file for a filter that never started, which a
                // reader takes as evidence of an active one.
                heartbeat.resume()
                // **After `apply`, for the same reason `resume()` is.** The box is what `ping`
                // answers `enforcing` from, and filling it before the filter is running would tell a
                // caller its rule is being enforced while the kernel is still passing that traffic —
                // the confirmation saying yes about the one moment it exists to catch.
                ProviderBox.shared.set(self)
                os_log("startFilter applied OK", log: log, type: .default)
                self?.startPulse()
            }
            completionHandler(error)
        }
    }

    /**
     * Refresh the state file on a timer, not only when traffic arrives.
     *
     * This is what lets a reader treat a missing or old file as "not enforcing". Driven by flows
     * alone, a provider that died left its last rule on disk indefinitely and a quiet Mac was
     * indistinguishable from a dead one.
     */
    private func startPulse() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        // Ticks at the fast rate whatever the rule says; `pulse` drops the ticks that are not due.
        // The leeway is what the tolerance in `pulse` is sized against — widen one and the other has
        // to follow, or the slow rate quietly becomes the only rate.
        timer.schedule(deadline: .now(), repeating: 1.0, leeway: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            heartbeat.pulse(rule: offlineUDIDs(self.filterConfiguration))
        }
        timer.resume()
        pulse = timer
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        os_log("stopFilter reason=%{public}d", log: log, type: .default, reason.rawValue)
        // Absence is the signal. A stopped filter that left its last rule behind would tell the agent
        // it is still enforcing something.
        pulse?.cancel()
        pulse = nil
        // Emptied here rather than left to the weak reference: the process outlives the filter, and a
        // stopped provider that has not been deallocated yet would still answer `enforcing: true`.
        // Measured on a `--off` provider: it stays alive and keeps answering XPC.
        ProviderBox.shared.set(nil)
        heartbeat.remove()
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        // **The rule is read before the audit token, so the idle path touches neither.**
        // `sourceAppAuditToken` materialises a `Data` on every flow and `pid`/`asid` are unused below
        // when there is nothing to enforce — leaving them above the early return would have kept a
        // per-flow allocation in the path this change exists to empty.
        //
        // `ruleWatch.noteIfChanged` stays above it on purpose: the forced publish on a rule change
        // depends on it running for every flow, idle ones included.
        let rule = offlineUDIDs(filterConfiguration)
        let ruleChanged = ruleWatch.noteIfChanged(rule)

        // **Nothing to enforce, so nothing to attribute** (#685).
        //
        // Every branch below returns `.allow()` when the rule is empty — `.host` and `.unresolved`
        // unconditionally, and `.simulator` because `rule.contains(udid)` is false. So the walk cannot
        // change this verdict, and it is not a cost paid for a benefit; it is a cost paid for nothing.
        //
        // That is most of the life of an installed filter. Measured on a Mac with no device offline:
        // 125,989 walks at an average of 425.9µs, `dropped` 0, and 96% of the flows belonging to the
        // Mac's own browser and mail. A user who took a device offline once, months ago, was paying
        // this on every connection since.
        //
        // **The heartbeat is not affected**, which is the thing to check before believing this is
        // free — and the mechanism is the other way round from how this comment first described it.
        // `note` is the *primary* writer: `dueLocked` uses a hardcoded 1.0s, so a Mac with traffic
        // publishes at 1Hz through this path. The `DispatchSourceTimer` ticks every second but
        // `pulse` writes only every `pulseSeconds(enforcing:) - 0.25` — 4.75s while the rule is
        // empty — so it is the fallback, not the source.
        //
        // What makes this safe is therefore not the timer but that `.idle` still goes through `note`:
        // the flow is counted and `dueLocked` runs exactly as before, so the publication rate is
        // unchanged. A provider seeing no flows at all still publishes on the timer alone.
        if rule.isEmpty {
            heartbeat.note(.idle, walkNanos: nil, rule: rule, ruleChanged: ruleChanged)
            return .allow()
        }

        let token = flow.sourceAppAuditToken
        let pid = token.flatMap(pidFromAuditToken) ?? -1
        let asid = token.map(asidFromToken) ?? 0

        // **How long the attribution actually takes** (#641). The walk was suspected of being an
        // unaffordable per-flow cost and nobody had measured it, so it is counted here rather than
        // argued about — and only when it runs, so the average is not diluted by flows that skipped
        // it. A cache added on a hunch is one more thing to keep correct across pid reuse.
        var walkNanos: UInt64?
        let attribution: Attribution
        if pid > 0 {
            let began = DispatchTime.now().uptimeNanoseconds
            attribution = attribute(pid)
            walkNanos = DispatchTime.now().uptimeNanoseconds - began
        } else {
            attribution = .unresolved("no audit token")
        }

        switch attribution {
        // A flow this Mac owns — the user's browser, mail, everything else. Allowed outright, which
        // also ENDS filtering for it, so nothing downstream is paid for by host traffic.
        case .host:
            os_log("handleNewFlow pid=%{public}d udid=- asid=%{public}u verdict=allow(host)",
                   log: log, type: .default, pid, asid)
            heartbeat.note(.host, walkNanos: walkNanos, rule: rule, ruleChanged: ruleChanged)
            return .allow()

        // **Not the same thing as a host flow, and it used to be logged as one** (#642). The walk
        // failed — no audit token, an unreadable `KERN_PROCARGS2`, a process that exited underneath
        // it — so this flow *might* belong to a simulator that is supposed to be offline.
        //
        // It is still allowed, and that is a decision rather than an oversight. Failing closed on a
        // failed `sysctl` would cut the user's own browser on a transient error, which is worse than
        // the hole: this filter is host-wide, and the whole promise of the feature is that only the
        // simulator you toggled is affected. What was actually wrong was that the hole was invisible
        // — indistinguishable in the log from an ordinary host flow, and absent from any counter.
        case .unresolved(let why):
            os_log("handleNewFlow pid=%{public}d udid=? asid=%{public}u verdict=allow(UNRESOLVED: %{public}@)",
                   log: log, type: .error, pid, asid, why)
            heartbeat.note(.unresolved, walkNanos: walkNanos, rule: rule, ruleChanged: ruleChanged)
            return .allow()

        case .simulator(let udid):
            let drop = rule.contains(udid)
            // **Asked only where it can change the answer.** A flow that was going to be allowed does
            // not need to know its port, and reading the endpoint costs an allocation per flow.
            if drop {
                let (port, how, isUDP, isOutbound) = flowShape(flow)
                if passesRegardlessOfRule(remotePort: port, isUDP: isUDP, isOutbound: isOutbound) {
                    os_log("handleNewFlow pid=%{public}d udid=%{public}@ asid=%{public}u verdict=allow(dns port=%{public}d via %{public}@)",
                           log: log, type: .default, pid, udid, asid, port ?? -1, how)
                    heartbeat.note(.dns, walkNanos: walkNanos, rule: rule, ruleChanged: ruleChanged)
                    return .allow()
                }
                // **The measurement this build exists to take** (#607 A2-0): whether the endpoint is
                // readable at all on this OS, and through which property. Logged for every dropped
                // flow rather than sampled, because a port that reads as `-1` here is the difference
                // between this feature working and not, and it must not depend on catching a sample.
                os_log("handleNewFlow pid=%{public}d udid=%{public}@ asid=%{public}u verdict=DROP port=%{public}d via %{public}@ udp=%{public}d out=%{public}d",
                       log: log, type: .default, pid, udid, asid, port ?? -1, how, isUDP ? 1 : 0, isOutbound ? 1 : 0)
                heartbeat.note(.simulator(dropped: true, udid: udid), walkNanos: walkNanos, rule: rule, ruleChanged: ruleChanged)
                return .drop()
            }
            os_log("handleNewFlow pid=%{public}d udid=%{public}@ asid=%{public}u verdict=allow",
                   log: log, type: .default, pid, udid, asid)
            heartbeat.note(.simulator(dropped: false, udid: udid), walkNanos: walkNanos, rule: rule, ruleChanged: ruleChanged)
            return .allow()
        }
    }
}

/**
 * The remote port of a flow, and which property gave it up.
 *
 * **Two properties, because which one answers is the open question.** `remoteEndpoint` is deprecated
 * since macOS 15 but is the one every shipping content filter reads; `remoteFlowEndpoint` is its
 * replacement. The second name is returned with the port so a log line says what worked rather than
 * only what the answer was — if a future OS empties one, that shows up as the channel changing rather
 * than as a port that mysteriously stops being readable.
 */
private func flowShape(_ flow: NEFilterFlow) -> (port: Int?, how: String, isUDP: Bool, isOutbound: Bool) {
    let outbound = flow.direction == .outbound
    guard let socketFlow = flow as? NEFilterSocketFlow else { return (nil, "not-a-socket-flow", false, outbound) }
    let udp = socketFlow.socketProtocol == IPPROTO_UDP
    // Read here, decided in `portFromChannels` — the two property reads are the only part a unit test
    // cannot reach, so they are the only part left in this file.
    var flowPort: UInt16?
    if let e = socketFlow.remoteFlowEndpoint, case let .hostPort(host: _, port: p) = e { flowPort = p.rawValue }
    let (port, how) = portFromChannels(hostEndpointPort: (socketFlow.remoteEndpoint as? NWHostEndpoint)?.port,
                                       flowEndpointPort: flowPort)
    return (port, how, udp, outbound)
}

// MARK: - pid → UDID

// **The decidable half of this section lives in `FlowIdentity.swift`** — the two audit-token
// readers, `ProcIdentity`, `UDIDCache` and `extractUDID`. The line the split follows is the kernel:
// a `Data` and a dictionary behind a lock are things a test can build, and `sysctl(KERN_PROC)` is
// not. What is left in this file is the reads themselves.

// Parent lookup goes through sysctl(KERN_PROC), which the sysext sandbox permits — measured against both
// a host process (a Chrome helper resolved to the Chrome browser process) and simulator flows (all 231
// resolved to launchd_sim).
private func procSysctl(_ pid: pid_t) -> (ppid: pid_t, identity: ProcIdentity)? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var kp = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    guard sysctl(&mib, u_int(mib.count), &kp, &size, nil, 0) == 0, size > 0 else { return nil }
    let start = kp.kp_proc.p_un.__p_starttime
    return (kp.kp_eproc.e_ppid,
            ProcIdentity(pid: pid, startSec: Int64(start.tv_sec), startUsec: start.tv_usec))
}

private func pidPath(_ pid: pid_t) -> String? {
    var buf = [CChar](repeating: 0, count: 4096) // PROC_PIDPATHINFO_MAXSIZE, not exported to Swift
    return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : nil
}

// The argument vector via sysctl(KERN_PROCARGS2). The buffer is a packed run of NUL-separated strings
// (argc, exec path, argv, envp); we only search it for a substring, so NULs become spaces instead of
// parsing that layout. KERN_ARGMAX sizes the buffer — a NULL-oldp size probe is not reliable here.
private func procArgs(_ pid: pid_t) -> String? {
    var argmaxMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
    var argmax: Int32 = 0
    var argmaxLen = MemoryLayout<Int32>.size
    guard sysctl(&argmaxMib, 2, &argmax, &argmaxLen, nil, 0) == 0, argmax > 0 else { return nil }

    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var buf = [UInt8](repeating: 0, count: Int(argmax))
    var len = Int(argmax)
    guard sysctl(&mib, u_int(mib.count), &buf, &len, nil, 0) == 0, len > 0 else { return nil }

    let text = buf.prefix(len).map { $0 == 0 ? UInt8(0x20) : $0 }
    return String(decoding: text, as: UTF8.self)
}

private let udidCache = UDIDCache()

/**
 * What a flow's process turned out to be — **three outcomes, where the code used to have two**.
 *
 * `udidForPID` returned `String?`, and `nil` meant both "this is the Mac's own traffic" and "the
 * walk failed". They were logged identically and counted not at all, so a simulator that should have
 * been offline could reach the network because a `sysctl` returned an error, with the log calling it
 * a host flow (#642).
 */
private enum Attribution {
    case simulator(String)
    case host
    case unresolved(String)
}

/// The parent walk, with its failures kept apart from its negative answer.
private func attribute(_ pid: pid_t) -> Attribution {
    var current = pid
    for _ in 0..<32 {
        guard let info = procSysctl(current) else {
            // The process is gone, or the kernel refused. Either way we do not know.
            return .unresolved("sysctl failed at pid \(current)")
        }
        if info.ppid <= 1 {
            if let path = pidPath(current), !path.hasSuffix("/launchd_sim") {
                return .host   // a known top-level process that is not a simulator's launchd
            }
            // An unreadable path falls through on purpose: the UDID pattern in the arguments is the
            // stronger check, and losing a flow to a path read would be the wrong trade.
            if let cached = udidCache.lookup(info.identity) { return .simulator(cached) }
            guard let udid = procArgs(current).flatMap(extractUDID) else {
                return .unresolved("no UDID in the arguments of pid \(current)")
            }
            udidCache.store(info.identity, udid)
            return .simulator(udid)
        }
        current = info.ppid
    }
    return .unresolved("parent chain did not terminate")
}
