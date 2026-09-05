import XCTest

/// What the provider publishes about itself, in the two places the decision is decidable from its
/// inputs (#690). The file write, the clock and the path resolution stay in `Provider.swift`; those
/// need root and a real filesystem.
final class HeartbeatStateTests: XCTestCase {

    /// **A count that outlives the episode it was counted in is a false proof.** The agent reads
    /// `droppedByDevice` as evidence that the kernel is enforcing, so a stale entry says
    /// "enforcement observed" about a device whose traffic is flowing.
    ///
    /// This is what shipped before the prune: take a device offline, drop twelve flows, bring it back
    /// online, take it offline again — and the very next file said `{"A": 12}` before a single flow
    /// had been dropped in that episode.
    func testCountsForDevicesNoLongerInTheRuleAreDropped() {
        XCTAssertEqual(prunedDrops(["A": 12, "B": 3], rule: ["B"]), ["B": 3])
    }

    /// An empty rule enforces nothing, so there is nothing any count can be evidence of.
    ///
    /// **Pruning too eagerly is the safe direction, and this pins that choice.** A transient
    /// unreadable `vendorConfiguration` reads as an empty rule and wipes the counts; they restart
    /// from zero, and zero proves nothing by design. Keeping them would produce the false proof
    /// instead.
    func testAnEmptyRuleKeepsNothing() {
        XCTAssertEqual(prunedDrops(["A": 12, "B": 3], rule: []), [:])
    }

    /// The surviving counts keep their values. A prune that reset them to zero or one would read as
    /// "enforcement just started" on every publication, which is the same lie pointed the other way.
    func testSurvivingCountsAreNotAltered() {
        XCTAssertEqual(prunedDrops(["A": 12, "B": 3], rule: ["A", "B"]), ["A": 12, "B": 3])
    }

    /// A device in the rule that has dropped nothing gets no entry invented for it. Absence here
    /// means "offline, nothing observed yet", which is the state the agent has to be able to tell
    /// apart from "offline and enforcing".
    func testADeviceWithNoDropsIsNotInvented() {
        XCTAssertEqual(prunedDrops([:], rule: ["A"]), [:])
        XCTAssertEqual(prunedDrops(["A": 1], rule: ["A", "B"]), ["A": 1])
    }

    /// **1 and 5 are measured, not chosen.** `SIGKILL` on the provider freezes the file, launchd
    /// brings it back in about 5.8 seconds, and the kernel passes that simulator's traffic for the
    /// whole of it. A reader allows three pulses before calling the provider gone, so at the idle
    /// rate the threshold is 15s and the commonest outage is arithmetically invisible.
    ///
    /// The fast rate is spent only where it buys something: an empty rule enforces nothing, so there
    /// is nothing to lose track of.
    func testThePulseIsFastOnlyWhileSomethingIsEnforced() {
        XCTAssertEqual(pulseSeconds(enforcing: true), 1)
        XCTAssertEqual(pulseSeconds(enforcing: false), 5)
    }

    // **A test asserting `Int(pulseSeconds(…))` used to sit here, and it could not fail on its own.**
    // `XCTAssertEqual` on `Double` is exact, so `d == 1.0` already implies `Int(d) == 1`; the case it
    // claimed to guard — a fractional rate losing its remainder at `Provider.swift`'s `Int(...)` — is
    // the one case it passed. Set the rate to 1.5 and the test above fails while that one did not.
    // Covering the round trip for real needs the rendered JSON, and `renderLocked` is private to
    // `Provider.swift`, which no test bundle compiles.

    // MARK: - the counters

    private let udid = "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3"

    /// **`dns` is a subset of `simulator`, not a sibling.** The first draft made it a sibling, so
    /// `simulator − dropped` silently stopped meaning "allowed simulator flows" for anyone reading
    /// the file. It stays out of `dropped` because that is the number the agent reads as evidence the
    /// filter is enforcing, and a DNS allow is not that.
    func testADNSAllowCountsAsASimulatorFlowButNotAsADrop() {
        var c = FlowCounts()
        c.record(.dns, walkNanos: nil)
        XCTAssertEqual(c.simulator, 1)
        XCTAssertEqual(c.dns, 1)
        XCTAssertEqual(c.dropped, 0)
        XCTAssertTrue(c.droppedByUDID.isEmpty, "a DNS allow is not evidence of enforcement")
    }

    /// A drop is the one outcome that can be attributed by construction, so it is the only one that
    /// lands in the per-device map.
    func testADropCountsInThreePlacesAndOnlyADropDoes() {
        var c = FlowCounts()
        c.record(.simulator(dropped: true, udid: udid), walkNanos: nil)
        XCTAssertEqual(c.simulator, 1)
        XCTAssertEqual(c.dropped, 1)
        XCTAssertEqual(c.droppedByUDID, [udid: 1])

        c.record(.simulator(dropped: false, udid: udid), walkNanos: nil)
        XCTAssertEqual(c.simulator, 2)
        XCTAssertEqual(c.dropped, 1, "an allowed simulator flow is not a drop")
        XCTAssertEqual(c.droppedByUDID, [udid: 1])
    }

    /// **`idle` does not fold into `host`.** Those flows were never attributed — the walk was skipped
    /// because the rule was empty. Counting them as host flows would put a number in the file meaning
    /// "we decided this belonged to the Mac", when nothing decided anything.
    func testTheOtherThreeOutcomesEachHaveTheirOwnCounter() {
        var c = FlowCounts()
        c.record(.host, walkNanos: nil)
        c.record(.unresolved, walkNanos: nil)
        c.record(.idle, walkNanos: nil)
        XCTAssertEqual(c.host, 1)
        XCTAssertEqual(c.unresolved, 1)
        XCTAssertEqual(c.idle, 1)
        XCTAssertEqual(c.simulator, 0)
    }

    /// **Only a walk that ran is a walk.** Counting the `pid <= 0` short circuit diluted the average
    /// with samples that measured nothing, so the caller passes `nil` there.
    func testAFlowWithNoWalkDoesNotDiluteTheAverage() {
        var c = FlowCounts()
        c.record(.host, walkNanos: 2_000)
        c.record(.host, walkNanos: nil)
        XCTAssertEqual(c.walks, 1)
        XCTAssertEqual(c.averageWalkMicros, 2.0, accuracy: 0.001)
        XCTAssertEqual(FlowCounts().averageWalkMicros, 0, "no walks is zero, not a division by zero")
    }

    // MARK: - the state file's shape

    /// **The five names the agent reads, pinned.** `SimulatorNetwork.ts` picks `at`, `pulseSeconds`,
    /// `rule`, `pid` and `droppedByDevice` out of this file by name; renaming one here is a silent
    /// failure there, in a different language, with nothing that compiles both.
    func testTheFileCarriesEveryFieldTheAgentReads() throws {
        var c = FlowCounts()
        c.record(.simulator(dropped: true, udid: udid), walkNanos: 1_500)
        var counts = c
        let json = renderState(&counts, rule: [udid], pid: 4242, at: 1_788_540_210)

        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(obj["at"] as? Int, 1_788_540_210, "the clock is a parameter, not a read")
        XCTAssertEqual(obj["pid"] as? Int, 4242, "which provider wrote this, during a replacement")
        XCTAssertEqual(obj["pulseSeconds"] as? Int, 1, "a rule in force means the fast rate")
        XCTAssertEqual(obj["rule"] as? [String], [udid])
        XCTAssertEqual(obj["droppedByDevice"] as? [String: Int], [udid: 1])
    }

    /// The diagnostic half. Not read by the agent, which is exactly why it would rot unnoticed.
    func testTheFileCarriesTheDiagnosticCountsToo() throws {
        var counts = FlowCounts()
        counts.record(.dns, walkNanos: nil)
        counts.record(.host, walkNanos: 3_000)
        let json = renderState(&counts, rule: [udid], pid: 1, at: 0)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])

        let flows = try XCTUnwrap(obj["flows"] as? [String: Int])
        XCTAssertEqual(flows["simulator"], 1)
        XCTAssertEqual(flows["dnsAllowed"], 1)
        XCTAssertEqual(flows["host"], 1)
        XCTAssertEqual(flows["dropped"], 0)
        let attribution = try XCTUnwrap(obj["attribution"] as? [String: Any])
        XCTAssertEqual(attribution["walks"] as? Int, 1)
    }

    /// **The prune happens inside the render, and this is what says so.** An earlier shape returned
    /// the pruned map for the caller to assign back; a caller that dropped the assignment re-created
    /// the `{"A": 12}`-before-a-single-drop bug with every test green.
    func testRenderingPrunesTheCountsItRenders() {
        var counts = FlowCounts()
        counts.record(.simulator(dropped: true, udid: "A"), walkNanos: nil)
        counts.record(.simulator(dropped: true, udid: "B"), walkNanos: nil)
        _ = renderState(&counts, rule: ["B"], pid: 1, at: 0)
        XCTAssertEqual(counts.droppedByUDID, ["B": 1], "A left the rule, so its count cannot survive")
    }

    /// A rule carrying a quote or a backslash used to make the whole file invalid JSON, and an
    /// unparseable file reads as "not enforcing" — the wrong answer, stated confidently.
    func testARuleIsQuotedRatherThanPastedIn() throws {
        var counts = FlowCounts()
        let awkward = #"a"b\c"#
        let json = renderState(&counts, rule: [awkward], pid: 1, at: 0)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(obj["rule"] as? [String], [awkward])
    }

    func testAnEmptyRuleReportsTheIdleRate() throws {
        var counts = FlowCounts()
        let json = renderState(&counts, rule: [], pid: 1, at: 0)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(obj["pulseSeconds"] as? Int, 5)
        XCTAssertEqual(obj["rule"] as? [String], [])
    }

    // MARK: - when a write is due

    /// A rule change publishes whatever the clock says: a reader waiting on a confirmation should not
    /// wait out a rate limit for it.
    func testARuleChangeIsDueImmediatelyAndAnUnchangedRuleIsRateLimited() {
        XCTAssertTrue(writeIsDue(force: true, now: 100.0, lastWrite: 99.9))
        XCTAssertFalse(writeIsDue(force: false, now: 100.0, lastWrite: 99.9))
        XCTAssertTrue(writeIsDue(force: false, now: 100.0, lastWrite: 99.0))
        XCTAssertTrue(writeIsDue(force: false, now: 100.0, lastWrite: 98.0))
    }

    /// **The 0.25 is the timer's leeway, not a rounding.** Without it a 1s tick against a 1s
    /// threshold misses by a few milliseconds and writes every *other* tick, halving the rate this
    /// exists to set.
    func testTheTimerToleratesItsOwnJitter() {
        XCTAssertTrue(pulseIsDue(unpublished: false, now: 100.0, lastWrite: 99.24, enforcing: true),
                      "a 1s tick landing a few ms early must still write")
        XCTAssertFalse(pulseIsDue(unpublished: false, now: 100.0, lastWrite: 99.8, enforcing: true))
        XCTAssertFalse(pulseIsDue(unpublished: false, now: 100.0, lastWrite: 96.0, enforcing: false),
                       "the idle threshold is 4.75s, not 0.75")
        XCTAssertTrue(pulseIsDue(unpublished: false, now: 100.0, lastWrite: 95.0, enforcing: false))
    }

    /// **A rule this file has not published is due whatever the clock says.** A Mac with no
    /// connections has only this timer, and the threshold it checks is the idle rate whenever the new
    /// rule is empty — bringing the last device back online there published nothing for 4.75 seconds,
    /// and the agent reads that silence as the rule not having landed.
    func testAnUnpublishedRuleIgnoresTheClock() {
        XCTAssertTrue(pulseIsDue(unpublished: true, now: 100.0, lastWrite: 100.0, enforcing: false))
    }

    // MARK: - where the file goes

    /// **Both candidates have to be readable by the agent**, which runs as the user while the
    /// provider runs as root. That rules out `/var/root` and root's `NSTemporaryDirectory()`, where a
    /// write succeeds, logs a cheerful path, and is invisible to the only reader.
    ///
    /// The order mirrors the agent's own fallback list in `SimulatorNetwork.ts`. The two must not
    /// drift, and nothing but this compares them.
    func testTheCandidatesAreTheTwoTheAgentAlsoLooksIn() {
        XCTAssertEqual(stateFileCandidates,
                       ["/Library/Application Support/tapflow", "/tmp"])
    }
}
