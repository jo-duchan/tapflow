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
