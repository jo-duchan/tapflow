import Foundation
import NetworkExtension
import SystemExtensions
import os.log

// Container app: installs the content-filter system extension and enables the filter via NEFilterManager.
// (Content filter, not transparent proxy — the proxy couldn't see simulator flows. See Provider.swift.)
// Capture is observed via the NE framework log.

private let log = OSLog(subsystem: "dev.tapflow.netfilter", category: "host")
private let extensionBundleID = "dev.tapflow.netfilter.ext"

/**
 * **Every failure exits with its own code, and none of them exits 0.**
 *
 * This used to `exit(0)` from the configuration completion whether the preferences loaded, saved, or
 * failed. A user who declines the filter in System Settings makes the save fail, and the process
 * still reported success — so the agent wrote a rule nothing was enforcing and the control said
 * `available: true` over a kernel dropping nothing.
 *
 * **Zero still is not a confirmation that the rule is being enforced.** It now means the save was
 * accepted — every exit runs from inside a completion handler — and no further. The framework hands
 * `vendorConfiguration` to the running provider afterwards, on its own schedule and with no
 * acknowledgement coming back, and the whole run returns in 27ms (measured). So the claim an exit
 * status can carry here is "nothing refused", which is smaller than "it works" and is the reason the
 * agent decides `available` from the dylib's verdict instead of from this. Reporting layer 1's own
 * health needs an artefact the agent can read, which is a separate issue and not this.
 */
private enum ExitCode: Int32 {
    case ok = 0
    case activationFailed = 1
    case loadPreferencesFailed = 2
    case savePreferencesFailed = 3
    case needsUserApproval = 4
    case completesAfterReboot = 5
    case activationStalled = 6
    /// `--confirm` could not get an answer out of the provider. Says nothing about *why*, on purpose:
    /// the caller's remedy is the same whether the filter was never installed, is disabled, or died a
    /// second ago, and the states are not distinguishable from here anyway.
    case notConfirmed = 7
    /// An argument this build does not understand.
    ///
    /// **It exits rather than proceeding, and that is the whole point.** Every unrecognised flag used
    /// to fall through to `.configure`, where `parseOfflineUDIDs` found nothing and the run wrote an
    /// *empty* rule. So a caller asking a question this binary could not answer — `--confirm` against
    /// a build predating it — did not get a refusal, it silently **erased the rule**. Measured on this
    /// Mac while a newer agent talked to an older installed app.
    case badArguments = 8
}

private func die(_ code: ExitCode, _ why: String) -> Never {
    hlog("exiting \(code.rawValue): \(why)")
    exit(code.rawValue)
}

/**
 * **An overall deadline on the activation, because the approval one is not enough.**
 *
 * The approval timeout arms inside `requestNeedsUserApproval`, so it exists only once macOS has
 * asked for approval. An `OSSystemExtensionRequest` that never calls *any* delegate method had no
 * bound at all — and that is a real, reproducible state: `submitRequest` returns and nothing is ever
 * called back.
 *
 * **The cause is now known, and it was ours** — see `case .install`. `OSSystemExtensionRequest`
 * holds its delegate weakly; the delegate was a local that went out of scope before `sysextd` asked
 * which extension to keep, so nothing answered and the framework cancelled the connection. Two
 * earlier guesses are recorded because they cost time and were both wrong: accumulated versions
 * "waiting to uninstall on reboot" (a restart cleared the list to one and the next replacement
 * stalled identically), and `lsregister -f` (no difference). Neither could have helped — nothing was
 * wrong with the system's state.
 *
 * **The deadline stays.** It is the only bound on a request that calls no delegate method at all, and
 * this cause is not proof there is no other.
 *
 * This is the case the approval deadline claimed to close and did not: it closed one branch. This
 * bounds the whole request from the moment it is submitted, and every delegate path cancels it.
 */
private let activationDeadline: TimeInterval = 45

/**
 * How long to wait for a user who has been sent to System Settings.
 *
 * **Sized for the caller that can actually approve, which is not the agent.** `SimulatorNetwork`
 * kills this process at 15s, so approval never completes on that path and exit 4 never reaches it —
 * the agent's own timeout is what bounds it there, and the tester is not looking at a terminal
 * anyway. The caller this serves is a person running the binary by hand to install the filter, and
 * for them the number has to cover opening System Settings and authenticating. Shortening it to fit
 * under the agent's ceiling would only kill approvals that were about to succeed.
 *
 * The bound exists at all because nothing else ends the run loop on that path.
 */
private let approvalDeadline: TimeInterval = 120

/**
 * The host's log, and **not a temporary one** — it was labelled TEMP while it was a probe and then
 * shipped, which is how a debugging aid becomes an unbounded file nobody owns.
 *
 * It exists because `os_log` from these processes does not surface in this host's `log show`
 * (measured), and the exit reasons above have nowhere else to go: the agent `exec`s this binary and
 * a code alone does not say *which* preference failed or what the framework said about it. #639,
 * which is about reporting layer 1's health, will read from here rather than invent a channel.
 *
 * The host runs as uid 501, so `/tmp` is writable here. **The claim that used to sit on this line —
 * that the extension, being root, cannot write `/tmp` — was never tested and is false.** The
 * provider now writes its own state file, and the path it picked was measured rather than assumed:
 * `/Library/Application Support/tapflow/tapflow-netfilter-state.json`, root-owned and world-readable,
 * which is how the agent sees what the running filter is holding.
 *
 * **Bounded, because nothing else bounds it.** `arm()` runs on every device boot, so this appends a
 * handful of lines per boot for as long as the Mac is up — and while macOS clears `/tmp` across
 * restarts, it does not do so within a session. Rotating at a size the last few runs always fit
 * inside keeps the file useful for exactly what it is read for: what happened *this* time.
 */
private let logSizeLimit = 64 * 1024

private func hlog(_ s: String) {
    os_log("%{public}@", log: log, type: .info, s)
    let url = URL(fileURLWithPath: "/tmp/tapflow-netfilter-host.log")
    guard let line = (s + "\n").data(using: .utf8) else { return }
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    if size > logSizeLimit { try? FileManager.default.removeItem(at: url) }
    if let fh = try? FileHandle(forWritingTo: url) { defer { try? fh.close() }; fh.seekToEndOfFile(); fh.write(line) }
    else { try? line.write(to: url) }
}

final class Host: NSObject, OSSystemExtensionRequestDelegate {
    private let add: [String]
    private let remove: [String]
    private let clearAll: Bool
    /// The approval deadline, held only so both terminal callbacks can cancel it.
    private var approvalTimeout: DispatchWorkItem?
    /// The overall activation deadline. Cancelled by every delegate callback, including the one that
    /// only reports approval is needed — from there the longer, human-scale deadline takes over.
    private var activationTimeout: DispatchWorkItem?

    init(add: [String], remove: [String], clearAll: Bool) {
        self.add = add
        self.remove = remove
        self.clearAll = clearAll
        super.init()
    }

    func activate() {
        hlog("requesting activation of \(extensionBundleID)")
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: extensionBundleID, queue: .main)
        request.delegate = self
        // Armed before submitting, so a request that is never answered is still bounded.
        let stalled = DispatchWorkItem {
            die(.activationStalled, "no answer from the system extension manager within "
                + "\(Int(activationDeadline))s — not a refusal, no delegate callback at all. "
                + "The known cause of this is a released delegate (`OSSystemExtensionRequest` holds "
                + "it weakly); if you are reading this from a build that keeps it, check System "
                + "Settings > General > Login Items & Extensions > Network Extensions for an "
                + "approval nobody granted, and `systemextensionsctl list` for versions waiting to "
                + "uninstall on reboot.")
        }
        activationTimeout = stalled
        DispatchQueue.main.asyncAfter(deadline: .now() + activationDeadline, execute: stalled)
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    func request(_ request: OSSystemExtensionRequest,
                 actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        activationTimeout?.cancel()   // the system answered; the human-scale deadline takes over
        hlog("needs user approval in System Settings")
        // Approval is a human walking to System Settings, and it may never come.
        //
        // **Held so it can be cancelled, and cancelled the moment the request resolves.** A bare
        // `asyncAfter` cannot be called off, so it fired on a run that had already been approved and
        // was part-way through writing the rule — killing it with "no approval came" while the
        // approval was granted and the configuration was half-written. Approving takes tens of
        // seconds, so that window is the normal case for this path, not an edge of it.
        let deadline = DispatchWorkItem {
            die(.needsUserApproval, "no approval within \(Int(approvalDeadline))s — approve the extension in System Settings and run this again")
        }
        approvalTimeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + approvalDeadline, execute: deadline)
    }

    func request(_ request: OSSystemExtensionRequest,
                 didFinishWithResult result: OSSystemExtensionRequest.Result) {
        hlog("sysext activated (result \(result.rawValue))")
        activationTimeout?.cancel()
        approvalTimeout?.cancel()
        // **A result is not automatically a success**, and `willCompleteAfterReboot` is the one that
        // is not: the extension this build installed is not the one that will run until the Mac
        // restarts. It used to exit 0 here like any other result, so a tester was told the new filter
        // was in place when the old one was still the one enforcing.
        //
        // **But it must not skip the rule.** A first draft exited immediately, and that was worse
        // than the silence it replaced. This binary takes the whole offline set on every run and is
        // therefore the only way a device is put back *online* — so exiting here left the previous
        // provider running with the previous rule, still dropping, with nothing able to clear it
        // short of a reboot. The premise was wrong too: `willCompleteAfterReboot` means the old
        // extension is alive and enforcing, and it reads `vendorConfiguration` like any other.
        //
        // So the rule is written either way and only the exit code differs.
        let pendingReboot = result == .willCompleteAfterReboot
        // The earlier transparent-proxy attempt left a NETunnelProvider config behind, and
        // NETunnelProvider keeps its provider PROCESS alive as long as that config exists — which is
        // why replacing the bundle never swapped in the new content-filter code. Remove it first so
        // the stale provider exits, then enable the filter (which spawns the provider fresh).
        // Exit once the rule is written. The provider keeps running and the configuration persists, so
        // a resident container app would buy nothing — and leaving one behind is what made `open` a
        // silent no-op on the next invocation (it activates a running app instead of re-running main).
        cleanupOldProxy { [add, remove, clearAll] in
            configureFilter(add: add, remove: remove, clearAll: clearAll, exitCode: pendingReboot ? .completesAfterReboot : .ok)
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        activationTimeout?.cancel()
        approvalTimeout?.cancel()
        hlog("sysext activation FAILED: \((error as NSError).domain) code=\((error as NSError).code): \(error.localizedDescription)")
        die(.activationFailed, error.localizedDescription)
    }
}

private func cleanupOldProxy(_ done: @escaping () -> Void) {
    NETransparentProxyManager.loadAllFromPreferences { managers, error in
        if let error { hlog("loadAllFromPreferences (proxy) failed: \(error.localizedDescription)") }
        let managers = managers ?? []
        if managers.isEmpty { hlog("no old proxy config"); done(); return }
        let group = DispatchGroup()
        for m in managers {
            group.enter()
            m.removeFromPreferences { err in
                if let err { hlog("remove proxy config failed: \(err.localizedDescription)") }
                group.leave()
            }
        }
        group.notify(queue: .main) {
            hlog("removed \(managers.count) old proxy config(s)")
            done()
        }
    }
}

// The rule change arrives on the command line as a **delta**:
// `TapflowNetFilter [--add <udid>[,<udid>…]] [--remove <udid>[,<udid>…]]`.
// **Neither flag means clear the rule**, not "leave what is there". A delta with nothing in it would
// be a no-op, and that would leave no way at all to empty a rule whose udids nobody remembers — which
// is the only recovery a person has when an agent died holding one. So the delta flags are how the
// rule is *changed*, and their absence is how it is *reset*.
/**
 * **Activation is a setup step, not something every rule write should do.**
 *
 * This binary used to submit an `OSSystemExtensionRequest` on every invocation, and the agent runs
 * it on every single network toggle — so each toggle asked macOS to install or replace a system
 * extension in order to change one string in a configuration. That is a lot of machinery for a rule
 * write, and it is exposure to a failure that has been measured: the request can go unanswered
 * entirely, which the deadline now catches but cannot fix.
 *
 * So the modes are separated. `--install` activates and configures — the once-per-release path a
 * person or `tapflow setup` runs. Everything else touches only `NEFilterManager`, which is what the
 * agent needs and is the fast, boring path.
 */
private enum Mode { case install, configure, disable, confirm }

private func parseMode() -> Mode {
    if CommandLine.arguments.contains("--confirm") { return .confirm }
    if CommandLine.arguments.contains("--off") { return .disable }
    if CommandLine.arguments.contains("--install") { return .install }
    return .configure
}

/// `--off` disables the filter without uninstalling the extension.
///
/// It exists for two reasons and both are worth stating. A self-hoster needs a way to turn this off
/// that is not "remove a system extension", and `stopFilter` — the path that removes the provider's
/// state file — had no way to be exercised at all. `SIGKILL` does not reach it: measured, the
/// provider dies, the file freezes, and launchd restarts it about seven seconds later.
private func disableFilter() {
    let manager = NEFilterManager.shared()
    manager.loadFromPreferences { error in
        if let error { die(.loadPreferencesFailed, error.localizedDescription) }
        // **Nothing to turn off is a success, not a failure.** `saveToPreferences` needs a
        // `providerConfiguration` and there is none when no filter was ever configured — so saving
        // here would fail and report "could not disable" about a filter that does not exist.
        // Turning something off twice has to be allowed to succeed twice.
        guard manager.providerConfiguration != nil else {
            hlog("no filter configuration — nothing to disable")
            exit(ExitCode.ok.rawValue)
        }
        manager.isEnabled = false
        manager.saveToPreferences { error in
            if let error { die(.savePreferencesFailed, error.localizedDescription) }
            hlog("filter disabled")
            exit(ExitCode.ok.rawValue)
        }
    }
}

// Rule injection goes through NEFilterProviderConfiguration.vendorConfiguration — the channel the
// framework provides for exactly this, and the one that survives a provider restart, since the
// provider re-reads it at `startFilter`.
//
// **It is durable and unacknowledged, and this comment used to claim there was no alternative.** It
// said "the XPC mach service never registered in the system domain", which was measured false: a
// build that starts a listener on `NEMachServiceName` answers in 0.26–0.74 ms. **This build starts
// none** — the measurement is from a probe, and whether to adopt that channel is a separate
// decision. What the old sentence did was stop anyone trying. What is true is that `saveToPreferences`
// returning means only that the save was accepted: the framework hands the configuration on
// afterwards with nothing coming back, so exit 0 here is not evidence the provider has the rule.
private func configureFilter(add: [String], remove: [String], clearAll: Bool, exitCode: ExitCode) {
    let manager = NEFilterManager.shared()
    manager.loadFromPreferences { error in
        if let error {
            die(.loadPreferencesFailed, error.localizedDescription)
        }
        // vendorConfiguration must be set on every run, not only when the configuration is first
        // created — otherwise the second invocation, the one that actually changes the rule, is a no-op.
        let config = manager.providerConfiguration ?? NEFilterProviderConfiguration()
        config.filterSockets = true
        config.filterPackets = false
        // **Read-modify-write, and the read is the point.** The rule this run publishes is whatever
        // was already there plus what this caller named — so a caller that names nothing removes
        // nothing, which is what makes a second agent harmless to the first.
        //
        // Not serialised against another Host doing the same thing: `saveToPreferences` was measured
        // to accept a save made against a stale load, 4/4, silently. Two Hosts interleaving can still
        // lose one delta. That is a smaller window than the whole-set replacement it replaces — the
        // agent's own `serialize()` orders its runs, so it takes two *agents* toggling inside the same
        // few milliseconds — and closing it needs an interlock whose read-your-writes behaviour is
        // unmeasured. Stated rather than implied.
        let existing = (config.vendorConfiguration?["offlineUDIDs"] as? [String]) ?? []
        let offline = clearAll ? [] : mergeRule(existing: existing, add: add, remove: remove)
        config.vendorConfiguration = ["offlineUDIDs": offline]
        manager.providerConfiguration = config
        manager.localizedDescription = "tapflow network filter"
        manager.isEnabled = true
        manager.saveToPreferences { error in
            // The branch that mattered: declining the filter in System Settings lands here, and it
            // used to log and exit 0 like the success beside it.
            if let error {
                die(.savePreferencesFailed, error.localizedDescription)
            }
            hlog("filter enabled, offline=\(offline) (add=\(add) remove=\(remove))")
            // Not always `.ok`: the rule is written on the reboot path too, and the code is what says
            // which provider will be enforcing it.
            if exitCode == .ok { exit(ExitCode.ok.rawValue) }
            die(exitCode, "rule written, but the extension that will run it needs this Mac restarted")
        }
    }
}

/**
 * `--confirm` — ask the running provider what it is enforcing, and print the answer.
 *
 * **This is the only thing that can answer "did the rule land".** A rule write exits when the *save*
 * was accepted; the framework hands `vendorConfiguration` to the running provider afterwards with
 * nothing coming back, so the exit code of a configure run is "nothing refused" and no more.
 *
 * Prints one JSON line — `{"enforcing":Bool,"rule":[udid],"pid":Int}` — and exits 0. Any failure to
 * get that answer exits 7 with nothing on stdout, because every one of them means the same thing to
 * the caller.
 *
 * **The caller owns the real deadline, and it has to.** A call made while the provider is dead does
 * not fail — it blocks, measured 3/3 to the caller's own timeout, with neither the invalidation nor
 * the interruption handler firing, because launchd holds the mach name while the process is away. So
 * the deadline below is a backstop for a process nobody is waiting on; the agent kills this binary on
 * its own, much shorter, budget. Sizing this one *down* to be the effective bound would put a
 * host-side number in charge of a decision the agent has to make.
 */
private func confirmEnforcement() {
    let conn = NSXPCConnection(machServiceName: netFilterMachServiceName, options: [])
    conn.remoteObjectInterface = NSXPCInterface(with: NetFilterControl.self)
    // Both, and they cover different failures: `invalidation` is a service that is not there at all
    // (never installed, or the extension disabled), `interruption` is a provider that died mid-call.
    // Neither fires for the case above, which is why the deadline exists as well.
    conn.invalidationHandler = { die(.notConfirmed, "no listener at \(netFilterMachServiceName)") }
    conn.interruptionHandler = { die(.notConfirmed, "provider went away mid-call") }
    conn.resume()

    let proxy = conn.remoteObjectProxyWithErrorHandler { err in
        die(.notConfirmed, "xpc error: \(err.localizedDescription)")
    } as? NetFilterControl
    guard let proxy else { die(.notConfirmed, "no proxy for \(netFilterMachServiceName)") }

    proxy.ping { data in
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(ExitCode.ok.rawValue)
    }

    DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
        die(.notConfirmed, "no reply within 5s")
    }
}

/// The activation delegate, held for the process lifetime. See `case .install`.
///
/// **Declared above the `switch` on purpose**: top-level code in `main.swift` executes in order, so a
/// declaration below its use is a use before declaration.
private var installHost: Host?

hlog("host launched at \(Bundle.main.bundlePath) args=\(CommandLine.arguments.dropFirst())")
// **Parsed before anything is dispatched, so an argument this build does not understand refuses
// instead of being ignored.** The old `parseMode` fell through to `.configure` for every unknown
// flag, and `.configure` with nothing to add or remove used to mean "replace the rule with nothing".
let add: [String]
let remove: [String]
let clearAll: Bool
do {
    try rejectUnknownArguments(CommandLine.arguments)
    add = try parseUDIDs(CommandLine.arguments, flag: "--add")
    remove = try parseUDIDs(CommandLine.arguments, flag: "--remove")
    clearAll = !CommandLine.arguments.contains("--add") && !CommandLine.arguments.contains("--remove")
} catch ArgError.unknown(let flag) {
    die(.badArguments, "unknown argument \(flag) — this build does not understand it")
} catch ArgError.missingValue(let flag) {
    die(.badArguments, "\(flag) needs a comma-separated udid list")
} catch {
    die(.badArguments, "\(error)")
}

switch parseMode() {
case .confirm:
    // Reads only. It must not configure anything on the way — a confirmation that writes is not one.
    confirmEnforcement()
case .disable:
    // No activation request: turning the filter off must not also install or replace the extension.
    disableFilter()
case .install:
    // **Held for the life of the process, and that is the whole fix for exit 6.**
    //
    // `OSSystemExtensionRequest.delegate` is **weak**. This used to be a `let` local to the case, and
    // nothing else retained it — the stall timer is a `DispatchWorkItem` calling a global `die`, so it
    // captures no `self`, and `activationTimeout` points the other way. So the delegate was gone the
    // moment `activate()` returned.
    //
    // What that produced looked like a system fault and was ours. Replacing an installed extension
    // makes `sysextd` ask the app which one to keep — `initial activation decision:
    // requestAppReplaceAction`, logged as an "activation conflict" — and with the delegate collected
    // there was nobody to answer, so the framework cancelled the connection and **no callback of any
    // kind ever fired.** The 45s deadline was the only thing left to report, which is why this was
    // recorded three times as "cause unknown; the deadline exists because the failure is silent".
    //
    // It only ever bit a *replace* because a first install has no existing entry to ask about.
    installHost = Host(add: add, remove: remove, clearAll: clearAll)
    installHost?.activate()
case .configure:
    // The agent's path. The extension is already installed by the time anyone is toggling a
    // simulator's network, so this writes the rule and leaves the extension alone.
    configureFilter(add: add, remove: remove, clearAll: clearAll, exitCode: .ok)
}
RunLoop.main.run()
