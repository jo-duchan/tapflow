import Foundation

// The host binary's pure half, kept in its own file **so it can be tested** (#690).
//
// `main.swift` is top-level code: it cannot be compiled into a test bundle, because its statements
// become a `main` entry point. Everything here is decidable from its arguments alone, so it is the
// part a test can hold — the same split `Extension/FlowIdentity.swift` makes on the other side.
//
// The two functions that read the argument vector take it as a parameter rather than reaching for
// `CommandLine.arguments`, which is the only change the move required. Nothing else about them
// moved: the reasoning below is the reasoning that was beside them in `main.swift`, and both
// paragraphs record a defect that shipped.
//
// Declarations are `internal` rather than `private` for the same reason as `FlowIdentity.swift`:
// the test bundle compiles this file directly (`tests.yml`), and `private` would not be visible.

enum ArgError: Error { case missingValue(String), unknown(String) }

/// Every flag this build accepts. Anything else is `badArguments`.
let knownFlags: Set<String> = ["--install", "--confirm", "--off", "--add", "--remove"]

/// A comma-separated udid list behind `flag`. Absent is `[]`; **present with no value is an error**,
/// because `--add` followed by another flag used to consume that flag as a udid.
///
/// **`split` is what drops `A,,B`'s empty entry, and a `filter` here was dead code.** It read
/// `.filter { !$0.isEmpty }` and could never remove anything: `split(separator:)` defaults to
/// `omittingEmptySubsequences: true`. The mutation that deletes a redundant filter changes no
/// behaviour, so the test paired with it passed either way — which is how the line survived being
/// written. It is gone, and the mutation now flips the flag that actually decides, so an empty udid
/// reaching the offline rule stays something a test can see.
func parseUDIDs(_ args: [String], flag: String) throws -> [String] {
    guard let i = args.firstIndex(of: flag) else { return [] }
    guard i + 1 < args.count, !args[i + 1].hasPrefix("--") else { throw ArgError.missingValue(flag) }
    return args[i + 1].split(separator: ",").map(String.init)
}

/**
 * Every argument has to be one this build consumes — **including the ones that are not flags.**
 *
 * Checking only `--`-prefixed words left the same hole one door over: `TapflowNetFilter typo` matched
 * no flag, so `clearAll` came out true and the run wiped the rule. A word this binary does not
 * understand must never be the reason a rule is emptied.
 *
 * Starts at index 1, so the caller passes the whole argument vector and the executable's own path is
 * not judged as a flag.
 */
func rejectUnknownArguments(_ args: [String]) throws {
    var i = 1
    while i < args.count {
        let arg = args[i]
        if arg.hasPrefix("--") {
            if !knownFlags.contains(arg) { throw ArgError.unknown(arg) }
            // `--add` and `--remove` take a value; the mode flags do not.
            if arg == "--add" || arg == "--remove" { i += 1 }
        } else {
            throw ArgError.unknown(arg)
        }
        i += 1
    }
}

/**
 * **The rule is a delta the caller names, not a set it replaces.**
 *
 * Replacing was the defect. The agent wrote its *whole* offline set on every run, and `arm()` runs on
 * every device boot knowing nothing — so a second agent starting put every device the first had taken
 * offline back online, silently, while its tester watched an offline control over working traffic.
 *
 * A delta cannot do that: an agent names only the devices it is handling, so it removes nothing it
 * does not know about. The cleanup the unconditional write used to provide survives in a more precise
 * form — `arm(udid)` names that udid in `--remove`, and arm runs whenever a device boots, so a rule
 * left by a dead process is cleared the next time that device comes up rather than by wiping the host.
 */
func mergeRule(existing: [String], add: [String], remove: [String]) -> [String] {
    var out = Set(existing)
    out.formUnion(add)
    out.subtract(remove)
    return out.sorted()
}

/// Which of the four things this invocation is.
///
/// Kept next to `knownFlags` on purpose: **the two have to agree, and nothing but a test can say so.**
/// A flag added to `knownFlags` without a case here is accepted by `rejectUnknownArguments`, falls
/// through to `.configure`, and — carrying no `--add` or `--remove` — makes `clearsTheRule` true. The
/// run then erases the offline rule. That is the same failure `rejectUnknownArguments` exists to
/// close, reached through the one door it does not watch, and `testEveryKnownFlagThatIsNotAValueFlagSelectsAMode`
/// is what watches it.
enum Mode { case install, configure, disable, confirm }

/// **The order is a decision, not an accident.** `--confirm` reads and must never configure on the
/// way, so it wins outright; `--off` beats `--install` so that turning the filter off cannot
/// re-install it first. Pinned because nothing else records it.
func parseMode(_ args: [String]) -> Mode {
    if args.contains("--confirm") { return .confirm }
    if args.contains("--off") { return .disable }
    if args.contains("--install") { return .install }
    return .configure
}

/// **Naming no delta means "replace the rule with nothing".**
///
/// This is the destructive branch, and it is reached by *absence* — which is why it is worth a name
/// and a test rather than an inline conjunction. `configureFilter` takes this as `clearAll` and, when
/// true, writes an empty offline set no matter what was there. `tapflow setup` and a bare run are the
/// callers that mean it.
///
/// Inverting it would make every `--add` wipe the host's rule instead of extending it; leaving it
/// always false would make the filter impossible to clear.
func clearsTheRule(_ args: [String]) -> Bool {
    !args.contains("--add") && !args.contains("--remove")
}
