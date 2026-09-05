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

    /// The value is written into the file as an integer, and a reader sizes its staleness threshold
    /// from what it reads. A rate that does not survive that round trip would have the reader
    /// waiting on a threshold nobody set.
    func testBothRatesSurviveBeingWrittenAsIntegers() {
        XCTAssertEqual(Int(pulseSeconds(enforcing: true)), 1)
        XCTAssertEqual(Int(pulseSeconds(enforcing: false)), 5)
    }
}
