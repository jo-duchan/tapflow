import XCTest

/// Reading a flow's process out of an audit token, and remembering which simulator a process tree
/// belongs to (#690).
///
/// **What is at stake here is not a label.** Both halves feed `handleNewFlow`'s attribution: get the
/// word index wrong, or key the cache on a number the kernel reuses, and the filter cuts a device
/// nobody asked to cut — with every log line agreeing that the udid was right.
///
/// The `nil` assertions were each verified by the mutation that creates the absence; see
/// `run-tests.sh --mutate`.
final class ProcessIdentityTests: XCTestCase {

    /// `audit_token_t` as the framework hands it over: eight `UInt32` in native order, pid at word 5
    /// and audit session at word 6.
    private func token(pid: UInt32 = 0, asid: UInt32 = 0) -> Data {
        var words = [UInt32](repeating: 0, count: 8)
        words[5] = pid
        words[6] = asid
        return words.withUnsafeBytes { Data($0) }
    }

    // MARK: - the audit token

    /// **The index is the whole function.** Word 5 and not 4 (`rgid`) or 6 (`asid`), and nothing at
    /// runtime would say otherwise — a wrong index returns a plausible number for a real process.
    func testReadsThePIDFromWordFive() {
        XCTAssertEqual(pidFromAuditToken(token(pid: 4242, asid: 7)), 4242)
    }

    func testReadsTheAuditSessionFromWordSix() {
        XCTAssertEqual(asidFromToken(token(pid: 4242, asid: 7)), 7)
    }

    /// **A short or long blob is refused rather than read off the end.** The size check is what keeps
    /// a framework that hands over something else from producing a pid that attributes the flow to an
    /// unrelated process.
    func testABlobThatIsNotAnAuditTokenIsRefused() {
        XCTAssertEqual(MemoryLayout<audit_token_t>.size, 32, "eight UInt32; the fixtures assume it")
        XCTAssertNil(pidFromAuditToken(Data(repeating: 0xFF, count: 31)))
        XCTAssertNil(pidFromAuditToken(Data(repeating: 0xFF, count: 33)))
        XCTAssertNil(pidFromAuditToken(Data()))
        XCTAssertEqual(asidFromToken(Data(repeating: 0xFF, count: 31)), 0)
        XCTAssertEqual(asidFromToken(Data()), 0)
    }

    /// A pid of zero is what a token that was never filled in carries, and it reads back as zero
    /// rather than as an absence. Pinned because the caller's `pid <= 0` short circuit is what
    /// handles it, and moving that decision in here would change which counter the flow lands on.
    func testAZeroPIDIsAValueRatherThanAnAbsence() {
        XCTAssertEqual(pidFromAuditToken(token(pid: 0)), 0)
    }

    // MARK: - the cache

    private let boot = ProcIdentity(pid: 501, startSec: 1_788_540_210, startUsec: 123_456)

    func testAStoredIdentityIsFoundAgain() {
        let cache = UDIDCache()
        XCTAssertNil(cache.lookup(boot), "nothing was stored yet")
        cache.store(boot, "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3")
        XCTAssertEqual(cache.lookup(boot), "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3")
    }

    /// **The reason the identity carries a start time at all.** macOS reuses pids and `launchd_sim`'s
    /// is reused readily — every simulator boot starts one. A cache keyed on the number alone answers
    /// for a simulator that no longer exists, and `handleNewFlow` then drops a device the tester never
    /// took offline.
    func testTheSamePIDFromADifferentBootIsADifferentDevice() {
        let cache = UDIDCache()
        cache.store(boot, "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")
        let reused = ProcIdentity(pid: boot.pid, startSec: boot.startSec + 1, startUsec: boot.startUsec)
        XCTAssertNil(cache.lookup(reused))
    }

    /// The microsecond half of the start time counts too. Two `launchd_sim`s started in the same
    /// second is not a hypothetical — booting a pair of simulators together does it.
    func testTheMicrosecondsArePartOfTheIdentity() {
        let cache = UDIDCache()
        cache.store(boot, "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")
        let sameSecond = ProcIdentity(pid: boot.pid, startSec: boot.startSec, startUsec: boot.startUsec + 1)
        XCTAssertNil(cache.lookup(sameSecond))
    }

    func testADifferentPIDIsAMiss() {
        let cache = UDIDCache()
        cache.store(boot, "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")
        let other = ProcIdentity(pid: boot.pid + 1, startSec: boot.startSec, startUsec: boot.startUsec)
        XCTAssertNil(cache.lookup(other))
    }

    /// **The lock, which every other test here is blind to.** `UDIDCache` is the only shared mutable
    /// state in the pure half, and `attribute()` reaches it from `handleNewFlow` — which
    /// `Provider.swift` says outright can be "mid-flight on another thread". Deleting
    /// `lock.lock(); defer { lock.unlock() }` from both methods leaves every other assertion in this
    /// file passing, because nothing else here starts a second thread.
    ///
    /// **The failure is a crash, not a wrong answer**, so this asserts the entries survive rather
    /// than trying to catch a torn read: a bare Swift `Dictionary` mutated from two threads corrupts
    /// its own storage. Measured on a copy with the lock removed — `exit=139` (SIGSEGV) on 5 runs of
    /// 5, against `exit=0` on 5 of 5 with it. `run-tests.sh` plants that mutation.
    func testConcurrentStoresAndLookupsKeepEveryEntry() {
        let cache = UDIDCache()
        let count = 2_000
        let ids = (0..<count).map { ProcIdentity(pid: pid_t($0), startSec: 1_788_540_210, startUsec: 0) }
        DispatchQueue.concurrentPerform(iterations: count) { i in
            cache.store(ids[i], "UDID-\(i)")
            _ = cache.lookup(ids[(i + 1) % count])
        }
        for (i, id) in ids.enumerated() {
            XCTAssertEqual(cache.lookup(id), "UDID-\(i)", "entry \(i) was lost")
        }
    }

    /// Two simulators running at once, which is the case the cache exists for. Recorded because a
    /// cache that held one entry would pass every test above.
    func testTwoBootsAreHeldAtOnce() {
        let cache = UDIDCache()
        let second = ProcIdentity(pid: 777, startSec: boot.startSec + 30, startUsec: 0)
        cache.store(boot, "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")
        cache.store(second, "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")
        XCTAssertEqual(cache.lookup(boot), "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")
        XCTAssertEqual(cache.lookup(second), "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")
    }
}
