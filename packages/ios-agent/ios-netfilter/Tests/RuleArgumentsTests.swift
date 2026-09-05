import XCTest

/// The host binary's argument handling and the rule arithmetic behind it (#690).
///
/// **Two of these pin defects that shipped**, which is why they are worth more than their size
/// suggests. `mergeRule` was a replacement before it was a delta, and a second agent starting put
/// every device the first had taken offline back online while its tester watched an offline control
/// over working traffic. `rejectUnknownArguments` checked only `--`-prefixed words, so
/// `TapflowNetFilter typo` matched no flag, `clearAll` came out true, and the run wiped the rule.
///
/// Every `XCTAssertThrowsError` here was verified by the mutation that removes the throw — a test
/// asserting that something is refused passes when nothing is refused. `run-tests.sh --mutate`
/// re-runs those. See `contributing/test-and-guard-coverage.md` rule 2.
final class RuleArgumentsTests: XCTestCase {

    // MARK: - mergeRule

    /// The delta adds to what is already there. **This is the one the replacement bug broke**: a
    /// caller that names only its own devices must not disturb another agent's.
    func testAddIsAUnionAndNotAReplacement() {
        XCTAssertEqual(mergeRule(existing: ["A", "B"], add: ["C"], remove: []), ["A", "B", "C"])
    }

    /// Removing something this caller does not hold leaves the rest alone. The other half of the
    /// same property: `arm(udid)` names one device in `--remove` on every boot, and that must not
    /// be a way to empty the host's rule.
    func testRemoveTakesOnlyWhatItNames() {
        XCTAssertEqual(mergeRule(existing: ["A", "B"], add: [], remove: ["C"]), ["A", "B"])
    }

    /// **Order is a decision, not an accident.** Union then subtract means a udid named in both
    /// ends up removed; the other order would leave it offline. Written down because a caller that
    /// passes the same device to both is asking to take it online.
    func testRemoveWinsOverAddForTheSameDevice() {
        XCTAssertEqual(mergeRule(existing: [], add: ["A"], remove: ["A"]), [])
    }

    func testDoesNotProduceDuplicates() {
        XCTAssertEqual(mergeRule(existing: ["A"], add: ["A"], remove: []), ["A"])
    }

    /// **The output is sorted, and the rule is compared for equality downstream.** The agent's
    /// confirmation reads the published rule back and checks it against what it asked for, so an
    /// order that varies between runs is an equality that fails for no reason.
    ///
    /// Six elements rather than two: an unsorted implementation has to be caught by more than a coin
    /// flip, and `Set` iteration order is not defined.
    func testOutputIsSorted() {
        XCTAssertEqual(mergeRule(existing: ["F", "E", "D", "C", "B", "A"], add: [], remove: []),
                       ["A", "B", "C", "D", "E", "F"])
    }

    // MARK: - parseUDIDs

    /// **Absent is not an error.** `--add` is optional, and a run that only names `--remove` has to
    /// work.
    func testAnAbsentFlagIsEmptyRatherThanAnError() throws {
        XCTAssertEqual(try parseUDIDs(["tapflow", "--install"], flag: "--add"), [])
    }

    /// The flag consumed the next word whatever it was, so `--add --off` took `--off` as a device
    /// identifier — and the mode flag was silently gone.
    func testAFlagInTheValuePositionIsAnError() {
        XCTAssertThrowsError(try parseUDIDs(["tapflow", "--add", "--off"], flag: "--add")) { error in
            guard case ArgError.missingValue(let flag) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(flag, "--add")
        }
    }

    func testAFlagAtTheEndIsAnError() {
        XCTAssertThrowsError(try parseUDIDs(["tapflow", "--add"], flag: "--add")) { error in
            guard case ArgError.missingValue = error else { return XCTFail("\(error)") }
        }
    }

    /// A trailing or doubled comma is a typo, not a device named the empty string — and an empty
    /// string in the offline set is a rule entry nothing can ever match or clear.
    func testEmptyEntriesAreDropped() throws {
        XCTAssertEqual(try parseUDIDs(["tapflow", "--add", "A,,B"], flag: "--add"), ["A", "B"])
        XCTAssertEqual(try parseUDIDs(["tapflow", "--add", "A,"], flag: "--add"), ["A"])
    }

    // MARK: - rejectUnknownArguments

    /// **A word this binary does not understand must never be the reason a rule is emptied.**
    /// `TapflowNetFilter typo` used to reach `configureFilter` with `clearAll` true.
    func testABareWordIsRejected() {
        XCTAssertThrowsError(try rejectUnknownArguments(["tapflow", "typo"])) { error in
            guard case ArgError.unknown(let arg) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(arg, "typo")
        }
    }

    func testAnUnknownFlagIsRejected() {
        XCTAssertThrowsError(try rejectUnknownArguments(["tapflow", "--nope"])) { error in
            guard case ArgError.unknown(let arg) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(arg, "--nope")
        }
    }

    /// The value belonging to `--add` is skipped rather than judged as an argument of its own.
    /// Without the skip a perfectly ordinary `--add <udid>` is rejected as an unknown word.
    func testTheValueOfAFlagIsNotJudgedAsAnArgument() throws {
        XCTAssertNoThrow(try rejectUnknownArguments(["tapflow", "--add", "752C0B5F"]))
        XCTAssertNoThrow(try rejectUnknownArguments(["tapflow", "--install", "--add", "A", "--remove", "B"]))
    }

    /// **`--confirm` and `--off` were in `knownFlags` and nothing ever judged them against it.**
    /// Every other case reaches that set through `--install`, `--add` or `--remove`; the two mode
    /// flags appear in these tests only in `--add`'s *value* position, where the loop skips them
    /// with `i += 1` without consulting the set at all. Dropping both from `knownFlags` left the
    /// whole file green — and `TapflowNetFilter --confirm`, which is how the agent confirms the
    /// kernel is enforcing, would exit 8 as a bad argument.
    func testEveryModeFlagIsAnAcceptedArgument() {
        XCTAssertNoThrow(try rejectUnknownArguments(["tapflow", "--confirm"]))
        XCTAssertNoThrow(try rejectUnknownArguments(["tapflow", "--off"]))
        XCTAssertNoThrow(try rejectUnknownArguments(["tapflow", "--install"]))
    }

    /// **A floor, not a fence: a repeated flag reads only its first occurrence.**
    /// `--add A --add B` is accepted, parses to `["A"]`, and B stays online with nothing said. The
    /// agent does not reach it — `SimulatorNetwork.ts` joins its udids into one `--add` — so this
    /// pins today's behaviour rather than blessing it. Throwing instead would be a CLI flag change,
    /// which is its own decision; this test is what makes taking it a visible one.
    func testARepeatedFlagIsReadOnlyOnce() throws {
        XCTAssertNoThrow(try rejectUnknownArguments(["tapflow", "--add", "A", "--add", "B"]))
        XCTAssertEqual(try parseUDIDs(["tapflow", "--add", "A", "--add", "B"], flag: "--add"), ["A"])
    }

    // MARK: - mode, and the branch that erases the rule

    /// **The structural half of `knownFlags`.** `rejectUnknownArguments` proves a flag is *accepted*;
    /// this proves it is *wired*. A flag in the set with no case in `parseMode` is accepted, falls
    /// through to `.configure`, carries no delta, and so erases the offline rule — the same failure
    /// `TapflowNetFilter typo` used to cause, reached through the one door that check does not watch.
    ///
    /// Written as a loop over the set rather than as four assertions, so adding a flag to
    /// `knownFlags` is what makes this fail rather than remembering to extend a list here.
    func testEveryKnownFlagThatIsNotAValueFlagSelectsAMode() {
        let valueFlags: Set<String> = ["--add", "--remove"]
        for flag in knownFlags where !valueFlags.contains(flag) {
            XCTAssertNotEqual(
                parseMode(["tapflow", flag]), .configure,
                "\(flag) is accepted but selects no mode, so it reaches configure with nothing to add "
                + "or remove — which erases the offline rule")
        }
    }

    /// The precedence, which nothing else records. `--confirm` reads and must not configure on the
    /// way, so it wins outright; `--off` beats `--install` so turning the filter off cannot
    /// re-install it first.
    func testTheModeOrderIsConfirmThenOffThenInstall() {
        XCTAssertEqual(parseMode(["tapflow", "--confirm", "--off", "--install"]), .confirm)
        XCTAssertEqual(parseMode(["tapflow", "--off", "--install"]), .disable)
        XCTAssertEqual(parseMode(["tapflow", "--install"]), .install)
        XCTAssertEqual(parseMode(["tapflow", "--add", "A"]), .configure)
        XCTAssertEqual(parseMode(["tapflow"]), .configure)
    }

    /// **The destructive branch, reached by absence.** True means `configureFilter` writes an empty
    /// offline set whatever was there. Inverted, every `--add` would wipe the host's rule instead of
    /// extending it; always false and the filter could never be cleared.
    func testTheRuleIsClearedOnlyWhenNoDeltaIsNamed() {
        XCTAssertTrue(clearsTheRule(["tapflow"]))
        XCTAssertTrue(clearsTheRule(["tapflow", "--install"]))
        XCTAssertFalse(clearsTheRule(["tapflow", "--add", "A"]))
        XCTAssertFalse(clearsTheRule(["tapflow", "--remove", "A"]))
        XCTAssertFalse(clearsTheRule(["tapflow", "--add", "A", "--remove", "B"]))
    }

    /// **Where the two functions divide, recorded because neither can see it alone.** A flag sitting
    /// in `--add`'s value position is skipped here — this function accepts it — and it is
    /// `parseUDIDs` that refuses. Each is right on its own and the pair is what closes the hole, so
    /// changing either without the other reopens it.
    func testAFlagInAValuePositionIsSkippedHereAndCaughtByTheParse() {
        XCTAssertNoThrow(try rejectUnknownArguments(["tapflow", "--add", "--off"]))
        XCTAssertThrowsError(try parseUDIDs(["tapflow", "--add", "--off"], flag: "--add"))
    }
}
