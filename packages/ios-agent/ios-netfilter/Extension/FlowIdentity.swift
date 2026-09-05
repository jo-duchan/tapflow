import Foundation

// The pure half of flow handling, kept in its own file **so it can be tested** (#690).
//
// Everything else on the attribution path reads the live kernel — `sysctl(KERN_PROC)` for the parent
// walk, `KERN_PROCARGS2` for the arguments, `proc_pidpath` for the executable — and none of that can
// be stood up in a unit test. What is left once those are peeled away is this: a string arrived, and a
// device identifier has to come out of it. That part is decidable from its inputs alone, so it is the
// part a test can hold.
//
// It is `internal` rather than `private` for the same reason: the test bundle compiles this file
// directly (`tests.yml`), and a `private` function would not be visible to it.

/// The simulator a `launchd_sim` argument string belongs to, or `nil`.
///
/// The argument string looks like this, with the NULs between arguments already replaced by spaces
/// (`procArgs`):
///
/// ```text
/// launchd_sim /Users/<u>/Library/Developer/CoreSimulator/Devices/<UDID>/data/var/run/launchd_bootstrap.plist
/// ```
///
/// **The UDID appears in exactly one observable place — these arguments.** It is not in the executable
/// path (every simulator on a runtime shares one `launchd_sim` binary in the simruntime) and not in the
/// working directory (measured: `/`). `Provider.swift` has the rest of that reasoning.
///
/// The 36-character length check is what separates a real identifier from a `/Devices/` that happens to
/// appear elsewhere in the arguments. **It is a length check and not a UUID check**, which is a floor
/// rather than a fence: 36 characters of anything but `/` passes. That is deliberate for now — a
/// stricter parse would have to be sure it agrees with CoreSimulator about what a device identifier may
/// look like, and being wrong there drops attribution for a real device, which fails *open* and lets a
/// simulator the tester took offline keep talking. A test pins the current behaviour so that tightening
/// it later is a visible decision rather than a silent one.
func extractUDID(from text: String) -> String? {
    guard let marker = text.range(of: "/Devices/") else { return nil }
    let udid = text[marker.upperBound...].prefix { $0 != "/" }
    return udid.count == 36 ? String(udid) : nil
}


// MARK: - what passes whatever the rule says

/// The port name resolution uses. Plain DNS only — see `passesRegardlessOfRule`.
let dnsPort = 53

/**
 * A port from an endpoint, or `nil` when there is not one.
 *
 * **`0` is not a port and must not read as one.** The two endpoint properties disagree about it: one
 * of them reports an unconnected flow as port `0` while the other reports nothing at all, so without
 * this the log records a different channel for the same condition — and that log is what is supposed
 * to make "the OS emptied a channel" visible rather than silent. Normalising here is what keeps the
 * two answers comparable.
 */
func normalisedPort(_ raw: Int?) -> Int? {
    guard let raw, raw > 0, raw <= 65535 else { return nil }
    return raw
}

/**
 * Which of the two endpoint channels yielded a port, and what it was.
 *
 * **The choosing is here and the reading is not**, which is the whole reason this function exists.
 * `NEFilterSocketFlow` cannot be built in a unit test, so the downcast and the two property reads stay
 * in `Provider.swift` where nothing can cover them — but everything decided *from* those values is
 * decidable from the values alone, and that is the part with a test.
 *
 * **Order is load-bearing and so is the normalisation on both branches.** `remoteEndpoint` is
 * deprecated and `remoteFlowEndpoint` replaces it, so the deprecated one is asked first while it still
 * answers; and one of them reports an unconnected flow as `0` while the other omits it, so without
 * normalising both the same condition reads as two different channels — which defeats the one thing
 * the channel name in the log is for.
 */
func portFromChannels(hostEndpointPort: String?, flowEndpointPort: UInt16?) -> (port: Int?, how: String) {
    if let s = hostEndpointPort, let p = normalisedPort(Int(s)) { return (p, "remoteEndpoint") }
    if let f = flowEndpointPort, let p = normalisedPort(Int(f)) { return (p, "remoteFlowEndpoint") }
    return (nil, "unreadable")
}

/**
 * Whether a flow must be allowed even when its simulator is in the offline set.
 *
 * **Outbound UDP to port 53, and nothing else. Each of the three conditions is the reason, not a
 * belt-and-braces check.**
 *
 * A dropped UDP flow gives its sender nothing — no error, no reset — so a resolver whose query is
 * dropped waits out its own timeout. Measured on an offline simulator: a name already in the cache
 * failed its connection in 6ms, while a name that had to be resolved took **25 seconds** in `curl`
 * and left Safari on a white screen past 35. A tester reads that as the toggle not working. Allowing
 * resolution turns every case into the first one: the name resolves, and the connection that follows
 * is dropped at 6ms.
 *
 * **TCP is excluded because it never had the problem.** A dropped TCP flow fails in 6ms, measured —
 * so opening TCP/53 would buy nothing and would leave a simulator reported offline holding a
 * bidirectional connection to anything listening on 53, which is the shape a DNS tunnel takes.
 *
 * **Inbound is excluded because `remotePort` means the other end.** For an inbound flow that is the
 * *sender's* port, so a peer sending from source port 53 would otherwise reach a device the tester
 * was told is offline.
 *
 * **It is not the fidelity loss it looks like, but it is more than nothing** — see the note in
 * `AGENTS.md`. The app under test keeps failing name resolution only where it uses POSIX
 * `getaddrinfo`; `URLSession` resolves through Network.framework, which layer 2 does not reach, so
 * that path now resolves and fails at connect instead.
 *
 * **Encrypted DNS is not covered.** DNS-over-TLS has a port of its own (853) and could be added;
 * DNS-over-HTTPS shares 443 and could not. Neither is here because nothing has measured whether a
 * simulator whose host is configured for either actually uses it.
 */
func passesRegardlessOfRule(remotePort: Int?, isUDP: Bool, isOutbound: Bool) -> Bool {
    isOutbound && isUDP && remotePort == dnsPort
}

// MARK: - the audit token

// `audit_token_t` is 8 x uint32 (auid, euid, egid, ruid, rgid, pid, asid, pidversion). The framework
// hands it over as `Data`, so reading a field is an index into that run of words — and an index is
// exactly the kind of thing that is right until someone counts wrong. Both functions are here rather
// than in `Provider.swift` because a `Data` is something a test can build.

/// The flow's process, or `nil` when the blob is not an audit token.
///
/// **The size guard is not defensive dressing.** Without it the read runs off whatever the framework
/// handed over, and the pid that comes back attributes the flow to a process that has nothing to do
/// with it — which is a device cut that nobody asked for, or a simulator that stays online.
func pidFromAuditToken(_ data: Data) -> pid_t? {
    guard data.count == MemoryLayout<audit_token_t>.size else { return nil }
    return data.withUnsafeBytes { pid_t(bitPattern: $0.bindMemory(to: UInt32.self)[5]) }
}

/// The audit session, or `0` when the blob is not an audit token.
///
/// `0` rather than `nil` because the caller logs it and no session identifier is not an error worth
/// a branch there.
func asidFromToken(_ data: Data) -> UInt32 {
    guard data.count == MemoryLayout<audit_token_t>.size else { return 0 }
    return data.withUnsafeBytes { $0.bindMemory(to: UInt32.self)[6] }
}

// MARK: - process identity, and caching by it

/**
 * A process's pid and its **start time**.
 *
 * The start time is what makes a pid an identity. macOS reuses pids, and `launchd_sim`'s is reused
 * readily — every simulator boot starts one, and a Mac that has booted a few dozen wraps the range.
 * A cache keyed on the number alone therefore answers for a simulator that no longer exists, and the
 * consequence is not a stale label: it is `handleNewFlow` cutting a device nobody asked to cut, with
 * every log line agreeing that the udid was right. `(pid, start)` is unique for the life of the Mac.
 *
 * Not `pidversion` from the audit token, which is there at word 7 and would be the obvious source:
 * it identifies the *flow's* process, and what has to be identified is its `launchd_sim` ancestor,
 * which has no token here.
 *
 * `procSysctl` fills this in from `KERN_PROC` and stays in `Provider.swift` — the kernel read is the
 * half a test cannot stand up. What a test can hold is that two different starts are two different
 * devices, which is the whole point of the field.
 */
struct ProcIdentity: Hashable {
    let pid: pid_t
    let startSec: Int64
    let startUsec: Int32
}

// launchd_sim outlives every flow of the simulator it hosts, so caching by its identity holds for the
// whole boot and the per-flow cost stays at the parent walk. Only positive results are cached: a host
// flow is rejected by the launchd_sim path check before any argument read, so it never pays for the
// miss.
//
// **Keyed on the identity and not the pid**, for the reason on `ProcIdentity`. Entries are never
// evicted, which is affordable because the key is a boot rather than a process — one per simulator
// started while the provider has been running — and because it is *wrong* to evict on the same signal
// that inserts: a pid whose entry is dropped is looked up again and re-cached from `KERN_PROCARGS2`,
// which reads the CURRENT process's arguments. The stale answer would simply be re-derived. Keying it
// away is the only fix that does not depend on noticing the exit.
final class UDIDCache {
    private var byRoot: [ProcIdentity: String] = [:]
    private let lock = NSLock()

    func lookup(_ root: ProcIdentity) -> String? {
        lock.lock(); defer { lock.unlock() }
        return byRoot[root]
    }

    func store(_ root: ProcIdentity, _ udid: String) {
        lock.lock(); defer { lock.unlock() }
        byRoot[root] = udid
    }
}

// MARK: - what the heartbeat publishes

/// How often the state file is refreshed with nothing happening — **1s while a device is offline, 5s
/// otherwise.** The rate in force is written into the file, so a reader sizes its threshold from what
/// it reads rather than from a constant it has to keep in sync with this one.
///
/// **A reader should allow at least three of these before calling the provider gone.** The numbers
/// are measured rather than chosen: `SIGKILL` on the provider freezes the file immediately, launchd
/// brings it back in about **5.8 seconds** (4 of 5 runs; one took 21.3), and the kernel passes that
/// simulator's traffic for the whole of it — 23 to 27 requests per occurrence. At 5s pulses the
/// threshold is 15s, so the commonest outage would be arithmetically invisible.
///
/// The fast rate is spent only where it buys something. An empty rule enforces nothing, so there is
/// nothing to lose track of, and a file write every second for the life of the Mac would buy exactly
/// that.
func pulseSeconds(enforcing: Bool) -> TimeInterval { enforcing ? 1 : 5 }

/**
 * The per-device drop counts that belong in the next state file — **a prune, not a copy.**
 *
 * The difference is the whole value of the field. `filter` returns a new dictionary, so an earlier
 * version left the counts in memory while publishing a pruned view: take a device offline, drop
 * twelve flows, bring it back online, take it offline again, and the very next file said
 * `{"A": 12}` before a single flow had been dropped in that episode. The agent reads that as
 * "enforcement observed" — the exact lie the field exists to close, told with a number attached.
 *
 * So the caller assigns the result back. A count has to be per *episode*, not per provider lifetime,
 * or "has it dropped anything since I took it offline" has no answer here.
 *
 * **Pruning too eagerly is the safe direction.** A transient unreadable `vendorConfiguration` would
 * read as an empty rule and wipe the counts; they then restart from zero, and zero proves nothing by
 * design. The other way round produces a false proof.
 */
func prunedDrops(_ counts: [String: Int], rule: Set<String>) -> [String: Int] {
    counts.filter { rule.contains($0.key) }
}
