import XCTest

/// `decideFlow` is the half of `handleNewFlow` that does not read the kernel — and it is the function
/// that decides whether a connection lives (#690).
///
/// **A mistake here is one of two things**, and the issue that asked for these says so: a tester
/// signing off on offline behaviour that never happened, or the user's own browser being cut. The
/// walk, the audit token and the endpoint are read elsewhere; by the time this runs, everything it
/// needs is a value.
final class FlowVerdictTests: XCTestCase {

    private let udid = "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3"
    private let https = FlowShape(port: 443, how: "remoteEndpoint", isUDP: false, isOutbound: true)
    private let dns = FlowShape(port: 53, how: "remoteEndpoint", isUDP: true, isOutbound: true)

    /// The empty rule enforces nothing, so no flow is judged and none is attributed. `idle` rather
    /// than `host` because nothing decided the flow belonged to the Mac.
    func testAnEmptyRuleAllowsWithoutJudgingAnything() {
        XCTAssertEqual(decideFlow(rule: [], attribution: .simulator(udid), shape: https), .allow(.idle))
        XCTAssertEqual(decideFlow(rule: [], attribution: nil, shape: https), .allow(.idle))
    }

    func testTheMacsOwnTrafficIsAllowed() {
        XCTAssertEqual(decideFlow(rule: [udid], attribution: .host, shape: https), .allow(.host))
    }

    /// **Fails open, and that is a decision rather than an oversight** (#642). Failing closed on a
    /// transient `sysctl` error would cut the user's own browser, which is worse than the hole — the
    /// filter is host-wide and the promise is that only the device you toggled is affected.
    func testAFailedWalkAllowsAndIsCountedApartFromAHostFlow() {
        XCTAssertEqual(decideFlow(rule: [udid], attribution: .unresolved("sysctl failed"), shape: https),
                       .allow(.unresolved))
        XCTAssertEqual(decideFlow(rule: [udid], attribution: nil, shape: https), .allow(.unresolved),
                       "no audit token is a failed attribution, not a host flow")
    }

    /// A simulator the tester did not name keeps working while another is offline. This is the case
    /// that makes the feature per-device rather than a switch on the whole Mac.
    func testASimulatorTheRuleDoesNotNameIsAllowed() {
        XCTAssertEqual(decideFlow(rule: ["OTHER"], attribution: .simulator(udid), shape: https),
                       .allow(.simulator(dropped: false, udid: udid)))
    }

    func testASimulatorTheRuleNamesIsDropped() {
        XCTAssertEqual(decideFlow(rule: [udid], attribution: .simulator(udid), shape: https),
                       .drop(.simulator(dropped: true, udid: udid)))
    }

    /// **The hole that makes the toggle fast instead of a 25-second hang**, and it is counted as
    /// `dns` rather than as an allowed simulator flow so the file says how often it was used.
    func testNameResolutionIsAllowedThroughForADeviceThatIsOffline() {
        XCTAssertEqual(decideFlow(rule: [udid], attribution: .simulator(udid), shape: dns), .allow(.dns))
    }

    /// **The endpoint is read only where it can change the answer.** It costs a property read per
    /// flow, and the original code paid it inside `if drop` for that reason; folding the decision
    /// into one function must not quietly move that onto every flow. `shape` is an `@autoclosure`,
    /// and this is what proves the laziness survived.
    func testTheEndpointIsNotReadOnAPathThatCannotUseIt() {
        var reads = 0
        func shape() -> FlowShape { reads += 1; return https }

        _ = decideFlow(rule: [], attribution: .simulator(udid), shape: shape())
        XCTAssertEqual(reads, 0, "the empty-rule path read the endpoint")

        _ = decideFlow(rule: [udid], attribution: .host, shape: shape())
        XCTAssertEqual(reads, 0, "a host flow read the endpoint")

        _ = decideFlow(rule: [udid], attribution: .unresolved("x"), shape: shape())
        XCTAssertEqual(reads, 0, "a failed walk read the endpoint")

        _ = decideFlow(rule: ["OTHER"], attribution: .simulator(udid), shape: shape())
        XCTAssertEqual(reads, 0, "an allowed simulator flow read the endpoint")

        _ = decideFlow(rule: [udid], attribution: .simulator(udid), shape: shape())
        XCTAssertEqual(reads, 1, "the drop path is the one that needs it")
    }
}
