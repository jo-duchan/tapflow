#!/usr/bin/env bash
# The netfilter's Swift tests (#690). Needs Xcode and xcodegen.
#
# **CI runs `--mutate`, not the plain mode.** `.github/workflows/ci.yml` has a `test-swift` job on
# `macos-15` that calls this script with the flag, and it is part of the `ci` rollup — so a Mac
# contributor is no longer the only thing standing between a decorative test and a merge. Running the
# expensive mode there is deliberate: a green suite is not evidence on its own, and the whole reason
# this file exists is that the cheap mode cannot tell the difference.
#
# **That makes every mutation added below a cost paid on every push.** One `xcodebuild` launch each,
# and `timeout-minutes` on that job is the ceiling — a mutation is worth adding when it aims at a
# decision, not at a line.
#
# **An earlier version of this header said CI could not run these at all**, which was true when it
# was written and stopped being true without anything here noticing.
#
#   ./run-tests.sh            run them
#   ./run-tests.sh --mutate   run them, then re-run under mutations that must make them FAIL
#
# The second mode is the point. `contributing/test-and-guard-coverage.md` rule 2: a test asserting
# absence passes when nothing happens, so a green run is not evidence it holds anything. The mutations
# below break the parse in the ways the tests claim to catch; any that still passes is decoration.
set -euo pipefail
cd "$(dirname "$0")"

PROJ=TapflowNetFilterTests.xcodeproj
LOG=$(mktemp -t netfilter-tests)

# **Returns xcodebuild's own status.** An earlier version piped into `grep` and reported *its* exit
# code, so a compile error read as a passing run.
#
# **That fixed half of it, and the comment here used to claim the whole.** A non-zero status still says
# only "something went wrong", and `--mutate` below read any non-zero as "a test caught it" — so a
# mutation that does not compile was indistinguishable from one a test killed.
#
# **The discriminator is `Test Case`, and two more obvious ones are wrong.** `** TEST FAILED **` is
# printed for a compile error too — measured: `xcodebuild test` reports the *action* failing, not the
# build, so that line appears either way (a review proposed it and it does not work). `error:` is no
# good either; an XCTest assertion prints those. What a compile failure never produces is a test case
# running at all: measured, `Test Case` appears 0 times when the mutation does not build and 30 times
# when a test kills it.
run () {
  # **Emptied first, and that is not tidiness.** The `return` below leaves `$LOG` untouched, so a
  # failing `xcodegen` would hand `mutate` the *previous* mutation's log — which contains `Test Case`,
  # and would therefore be read as this mutation having been killed by a test that never ran. The
  # same hole this file already closed once, reached through a different door.
  : > "$LOG"
  xcodegen generate --spec tests.yml >/dev/null || return 1
  xcodebuild test -project "$PROJ" -scheme FilterLogicTests -destination 'platform=macOS,arch=arm64' \
    CODE_SIGNING_ALLOWED=NO > "$LOG" 2>&1
}

if [[ "${1:-}" != "--mutate" ]]; then
  if run; then grep -E "Executed .* tests|TEST SUCCEEDED" "$LOG" | tail -2; exit 0
  else grep -E "error:|Test Case.*failed|TEST FAILED" "$LOG" | head -20; exit 1; fi
fi

echo "=== baseline (must PASS) ==="
run && echo "  PASS" || { echo "  FAIL — fix the tests before mutating"; grep -E "error:" "$LOG" | head; exit 1; }

# **Two files carry pure code now**, so a mutation names the one it aims at. The extension's half and
# the host binary's half are tested by one bundle (`tests.yml`) but they are different targets in the
# shipping project, and — see the note in `tests.yml` — they carry different version stamps.
EXT_SRC=Extension/FlowIdentity.swift
HOST_SRC=Host/RuleArguments.swift

# **`mktemp`, not a fixed path.** The interesting half is not the backup but the restore: a name
# anything else on the machine can pre-create is a name it can replace, and `restore` writes whatever
# is there back into a source file that gets built into a signed system extension.
EXT_ORIG=$(mktemp -t FlowIdentity.orig) || exit 1
HOST_ORIG=$(mktemp -t RuleArguments.orig) || exit 1
cp "$EXT_SRC" "$EXT_ORIG"
cp "$HOST_SRC" "$HOST_ORIG"
restore () { cp "$EXT_ORIG" "$EXT_SRC"; cp "$HOST_ORIG" "$HOST_SRC"; }
cleanup () { restore; rm -f "$EXT_ORIG" "$HOST_ORIG"; }
trap cleanup EXIT

# The backup a given source is compared against, so `DID NOT APPLY` stays honest per file.
orig_for () { [[ "$1" == "$EXT_SRC" ]] && echo "$EXT_ORIG" || echo "$HOST_ORIG"; }

# **Three ways a mutation can fail to prove anything, and they used to print the same word.**
#
#   DID NOT APPLY — the `sed` matched nothing, so the source was never mutated. Says the mutation has
#                   drifted from the code, not that a test is weak.
#   SURVIVED      — it compiled, it ran, and every test still passed. The finding this mode exists for.
#   BUILD BROKE   — it did not compile, so no test ever judged it. Reporting this as `killed` is how a
#                   suite that tests nothing reads as green, which is the whole failure this file
#                   guards against.
mutate () {   # $1 = label, $2 = sed program, $3 = file (default: the extension's)
  restore
  local src="${3:-$EXT_SRC}" orig
  orig=$(orig_for "$src")
  /usr/bin/sed -i '' "$2" "$src"
  if cmp -s "$orig" "$src"; then
    echo "  DID NOT APPLY: $1   <-- the sed matched nothing; the source moved under it"
    return 1
  fi
  if run >/dev/null 2>&1; then
    echo "  SURVIVED: $1   <-- it compiled and every test still passed; one of them is decoration"
    return 1
  fi
  if ! grep -q "Test Case" "$LOG"; then
    echo "  BUILD BROKE: $1   <-- no test case ran, so nothing judged it"
    return 1
  fi
  echo "  killed:   $1"
}

echo "=== mutations (each must make a test FAIL) ==="
fails=0
mutate "always nil"              's/return udid.count == 36 ? String(udid) : nil/return nil/' || fails=1
mutate "no length check"         's/udid.count == 36 ? String(udid) : nil/String(udid)/'      || fails=1
mutate "length 35"               's/udid.count == 36/udid.count == 35/'                        || fails=1
mutate "scan past separators"    's/prefix { \$0 != "\/" }/prefix { _ in true }/'              || fails=1
mutate "last marker not first"   's/text.range(of: "\/Devices\/")/text.range(of: "\/Devices\/", options: .backwards)/' || fails=1
mutate "dns: always allow"       's/remotePort == dnsPort/true/'                               || fails=1
mutate "dns: never allow"        's/remotePort == dnsPort/false/'                              || fails=1
mutate "dns: nil allowed too"    's/remotePort == dnsPort/remotePort == dnsPort || remotePort == nil/' || fails=1
mutate "dns: port 853 too"       's/let dnsPort = 53/let dnsPort = 853/'                       || fails=1
mutate "dns: ignore protocol"    's/isOutbound \&\& isUDP \&\& remotePort == dnsPort/isOutbound \&\& remotePort == dnsPort/' || fails=1
mutate "dns: ignore direction"   's/isOutbound \&\& isUDP \&\& remotePort == dnsPort/isUDP \&\& remotePort == dnsPort/'     || fails=1
mutate "port: 0 is a port"       's/raw > 0, raw <= 65535/raw >= 0, raw <= 65535/'                 || fails=1
mutate "port: no upper bound"    's/raw > 0, raw <= 65535/raw > 0/'                                || fails=1
mutate "channels: reversed"      's/if let s = hostEndpointPort/if let f = flowEndpointPort, let p = normalisedPort(Int(f)) { return (p, "remoteFlowEndpoint") }; if let s = hostEndpointPort/' || fails=1
mutate "channels: first unguarded" 's/if let s = hostEndpointPort, let p = normalisedPort(Int(s))/if let s = hostEndpointPort, let p = Int(s)/' || fails=1

# --- the audit token, the identity cache and what the heartbeat publishes ---
#
# `size >= 20` rather than deleting the guard: with no guard at all a 31-byte blob reads a plausible
# word and an empty one traps, so the mutation would be judged on a crash rather than on the
# assertion it is aimed at. Loosening it keeps every fixture in the function and lets the test speak.
mutate "token: pid from word 4"  's/UInt32.self)\[5\]/UInt32.self)[4]/'                        || fails=1
mutate "token: asid from word 7" 's/UInt32.self)\[6\]/UInt32.self)[7]/'                        || fails=1
mutate "token: size guard loose" 's/data.count == MemoryLayout<audit_token_t>.size/data.count >= 20/' || fails=1
# The pid-reuse bug, planted exactly as it would arrive: a cache keyed on the number the kernel hands
# back rather than on the boot it belongs to.
mutate "cache: keyed on pid only" 's/\[ProcIdentity: String\]/[pid_t: String]/; s/return byRoot\[root\]/return byRoot[root.pid]/; s/byRoot\[root\] = udid/byRoot[root.pid] = udid/' || fails=1
mutate "prune: keeps everything" 's/counts.filter { rule.contains($0.key) }/counts/'           || fails=1
mutate "prune: empty rule keeps" 's/counts.filter { rule.contains($0.key) }/rule.isEmpty ? counts : counts.filter { rule.contains($0.key) }/' || fails=1
mutate "pulse: rates swapped"    's/enforcing ? 1 : 5/enforcing ? 5 : 1/'                      || fails=1
mutate "pulse: always fast"      's/enforcing ? 1 : 5/1/'                                      || fails=1
# **The one mutation here that kills by crashing rather than by asserting.** A bare Swift `Dictionary`
# mutated from two threads corrupts its storage, so the test process takes SIGSEGV — which `run` reads
# as a non-zero exit with `Test Case` present, exactly as a failed assertion does. That is the honest
# outcome: the lock's absence is not observable any other way.
mutate "cache: no lock"          's/lock.lock(); defer { lock.unlock() }//'                     || fails=1

# --- the host binary's arguments and rule arithmetic ---
#
# **These name the third argument**, because the file they aim at is not the extension's.
mutate "merge: drops the existing set" 's/var out = Set(existing)/var out = Set<String>()/' "$HOST_SRC" || fails=1
mutate "merge: remove wipes"           's/out.subtract(remove)/out.removeAll()/'            "$HOST_SRC" || fails=1
# Swaps the two lines rather than deleting one, so it is the ORDER under test and not the presence of
# a subtract — `remove` winning over `add` for the same udid is the property, and only a flip moves it.
mutate "merge: union after subtract"   '/out.formUnion(add)/{s/.*/    out.subtract(remove)/;n;s/.*/    out.formUnion(add)/;}' "$HOST_SRC" || fails=1
# **This one could survive by luck, and the fixture is what stops it.** Swift seeds its hasher per
# process, so `Array(out)` is an arbitrary permutation each run. Measured over 300 fresh processes:
# a six-element set matched `sorted()` **once**, a twelve-element set **zero** times — so
# `testOutputIsSorted` uses twelve. Raised from six after CodeRabbit pointed out that a flaky
# `SURVIVED` sends someone after a hole that is not there.
mutate "merge: unsorted output"        's/return out.sorted()/return Array(out)/'            "$HOST_SRC" || fails=1
mutate "args: absent flag throws"      's/else { return \[\] }/else { throw ArgError.missingValue(flag) }/' "$HOST_SRC" || fails=1
mutate "args: value may be a flag"     's/, !args\[i + 1\].hasPrefix("--")//'                "$HOST_SRC" || fails=1
mutate "args: no bounds check"         's/i + 1 < args.count/i + 1 <= args.count/'           "$HOST_SRC" || fails=1
# **This one replaced a mutation that survived, and the survivor was right.** Deleting a
# `.filter { !$0.isEmpty }` changed nothing, because `split(separator:)` already omits empty
# subsequences — the filter was dead code and the test passed either way. Flipping the flag that
# actually decides is the mutation that was meant.
mutate "args: keeps empty entries"     's/split(separator: ",")/split(separator: ",", omittingEmptySubsequences: false)/' "$HOST_SRC" || fails=1
mutate "reject: bare word allowed"     's/^            throw ArgError.unknown(arg)$/            _ = arg/' "$HOST_SRC" || fails=1
mutate "reject: any flag is known"     's/if !knownFlags.contains(arg)/if false/'            "$HOST_SRC" || fails=1
mutate "reject: the value is judged"   's/if arg == "--add" || arg == "--remove" { i += 1 }//' "$HOST_SRC" || fails=1
mutate "reject: mode flags unknown"    's/"--confirm", "--off", //'                        "$HOST_SRC" || fails=1
mutate "args: last flag wins"          's/args.firstIndex(of: flag)/args.lastIndex(of: flag)/' "$HOST_SRC" || fails=1
mutate "mode: --off unwired"           's/if args.contains("--off") { return .disable }//' "$HOST_SRC" || fails=1
mutate "mode: install beats off"       '/if args.contains("--confirm")/{n;s/.*/    if args.contains("--install") { return .install }/;n;s/.*/    if args.contains("--off") { return .disable }/;}' "$HOST_SRC" || fails=1
mutate "clear: inverted"               's/!args.contains("--add") \&\& !args.contains("--remove")/args.contains("--add") || args.contains("--remove")/' "$HOST_SRC" || fails=1
mutate "clear: never clears"           's/!args.contains("--add") \&\& !args.contains("--remove")/false/' "$HOST_SRC" || fails=1
restore
[[ $fails -eq 0 ]] && echo "=== all mutations killed ===" || { echo "=== a mutation survived ==="; exit 1; }
