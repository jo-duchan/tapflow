#!/usr/bin/env bash
# Mutation testing for `src/hook-decisions.h` — the decidable half of the injected library.
#
# **A green run of `nethookDecisions.test.mjs` is not evidence on its own.** Several of its cases
# assert that something is *not* loopback, *not* blocking, *not* activated — and a test asserting
# absence passes when nothing happens, which is its definition
# (`contributing/test-and-guard-coverage.md` rule 2). The mutations below break the header in the ways
# those cases claim to catch; any that still passes is decoration.
#
#   ./mutate-nethook.sh
#
# **The checkout is never written to.** The header is copied elsewhere, broken there, and the test is
# pointed at the copy through `NETHOOK_HEADER_DIR`. That is deliberate rather than tidy: layer 1's
# equivalent mutated its sources in place, and three times in one day `build-nethook.sh`'s netfilter
# counterpart compiled, signed and notarized a source a mutation had broken. There is no window here.
set -euo pipefail
cd "$(dirname "$0")"

REPO=../..
SRC=src/hook-decisions.h
# **Portable forms on purpose: this runs in CI on ubuntu, not only on a Mac.** BSD `mktemp -d -t x`
# and GNU `mktemp -d -t x.XXXXXX` disagree, and `sed -i ''` — which every other script in this repo
# uses — makes GNU sed read `''` as a filename. The template-with-suffix form below works on both.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/nethook-mutate.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT
cp "$SRC" "$WORK/hook-decisions.h"
ORIG="$WORK/orig.h"
cp "$SRC" "$ORIG"

run () {   # the suite, against whatever is in $WORK
  ( cd "$REPO" && NETHOOK_HEADER_DIR="$WORK" pnpm vitest run scripts/__tests__/nethookDecisions.test.mjs ) \
    > "$WORK/log" 2>&1
}

echo "=== baseline (must PASS) ==="
run && echo "  PASS" || { echo "  FAIL — fix the tests before mutating"; tail -20 "$WORK/log"; exit 1; }

# Three ways a mutation can fail to prove anything, and they must not print the same word.
#
#   DID NOT APPLY — the `sed` matched nothing. Says the mutation drifted from the code, not that a
#                   test is weak.
#   SURVIVED      — it compiled and every test still passed. The finding this mode exists for.
#   BUILD BROKE   — it did not compile, so nothing judged it. Reporting that as `killed` is how a
#                   suite that tests nothing reads as green. `beforeAll` fails loudly on a compile
#                   error, and the log carries `-Werror` output rather than a test name.
mutate () {   # $1 = label, $2 = sed program
  cp "$ORIG" "$WORK/hook-decisions.h"
  sed -i.bak "$2" "$WORK/hook-decisions.h" && rm -f "$WORK/hook-decisions.h.bak"
  if cmp -s "$ORIG" "$WORK/hook-decisions.h"; then
    echo "  DID NOT APPLY: $1   <-- the sed matched nothing; the header moved under it"
    return 1
  fi
  # **Compiled here, before the suite runs.** Whether a mutation built is a fact this script can
  # establish directly; asking vitest for it is not. Two attempts to read it out of the runner's
  # summary were wrong — `Tests ` matches a skipped suite, and `Tests N failed` matched locally while
  # reporting every mutation as broken on the ubuntu runner. The compiler's exit code says the same
  # thing on both, and its first error line says why.
  if ! cc -O2 -Wall -Wextra -Werror -I "$WORK" -o "$WORK/probe" \
       "$REPO/scripts/__tests__/fixtures/nethook-decisions.c" 2> "$WORK/cc.log"; then
    echo "  BUILD BROKE: $1   <-- it did not compile, so nothing judged it"
    grep -m1 "error:" "$WORK/cc.log" | sed 's/^/      /'
    return 1
  fi
  if run; then
    echo "  SURVIVED: $1   <-- it compiled and every test still passed; one of them is decoration"
    return 1
  fi
  echo "  killed:   $1"
}

echo "=== mutations (each must make a test FAIL) ==="
fails=0

# tf_peer_is_loopback_decision — what a cut must leave alone
mutate "loop: /8 becomes /9"        's|>> 24) == 127|>> 25) == 127|g'                          || fails=1
mutate "loop: the wrong /8"         's|>> 24) == 127|>> 24) == 128|g'                          || fails=1
mutate "loop: v6 loopback ignored"  's|if (IN6_IS_ADDR_LOOPBACK(&v6->sin6_addr)) return 1;||'  || fails=1
mutate "loop: v4-mapped ignored"    's|if (IN6_IS_ADDR_V4MAPPED(&v6->sin6_addr)) {|if (0) {|'  || fails=1
mutate "loop: mapped reads the wrong octets" 's|s6_addr\[12\]|s6_addr[8]|'                     || fails=1
mutate "loop: everything is loopback" 's|^  return 0;$|  return 1;|'                           || fails=1
mutate "loop: v4 family ignored"    's|if (addr->sa_family == AF_INET) {|if (1) {|'            || fails=1
# **This one survived the first version of the suite.** Every family case fed an all-zero body, and a
# zeroed body answers 0 with or without the guard. The payload cases are what made it observable.
mutate "loop: v6 family ignored"    's|if (addr->sa_family == AF_INET6) {|if (1) {|'           || fails=1

# **These keep every parameter used, and that is not style.** The harness compiles with
# `-Wall -Wextra -Werror`, so a mutation that deletes a parameter's only use fails on
# `-Wunused-parameter` — and until the discriminator was corrected, five of them were reported as
# `killed` on the strength of a compile error. Flipping an answer or neutering a term with `&& 0`
# keeps the parameter live, so what the mutation moves is the decision rather than the build.
# tf_blocking_decision — the install gate is the one that outranks everything
mutate "block: a partial install blocks" 's|if (!hooksLive) return 0;|if (!hooksLive) return 1;|' || fails=1
mutate "block: the file is ignored"      's@return forced || conditionFilePresent;@return forced || (conditionFilePresent \&\& 0);@' || fails=1
mutate "block: the flag is ignored"      's@return forced || conditionFilePresent;@return (forced \&\& 0) || conditionFilePresent;@' || fails=1
mutate "block: both required"            's@return forced || conditionFilePresent;@return forced \&\& conditionFilePresent;@' || fails=1

# tf_should_activate_decision — every other process in the simulator stops here
mutate "act: a missing udid activates"   's@^  if (udid == NULL.*return 0;$@  if (udid == NULL || *udid == 0) return 1;@' || fails=1
# **The NULL guard is kept, and that is the difference between a mutation and a coin flip.**
# Rewriting the `||` to `&&` also kills this, but the mutant then dereferences NULL on the
# `--null` case — undefined behaviour whose result is whatever the compiler decided. Measured:
# clang at `-O2` folded it away and the blank case did the killing; gcc need not. Dropping only
# the empty-string term leaves defined code, and the case the mutation is named for is the one
# that fails on every platform. Raised by CodeRabbit on #763.
mutate "act: blank udid counts"          's@if (udid == NULL.*) return 0;@if (udid == NULL) return 0;@' || fails=1
# **Flipped rather than deleted, and the difference is a finding.** Deleting this guard survives:
# an empty target reaches `strcmp` and never matches a real bundle id, so the outcome is identical,
# and a NULL target is undefined behaviour that `-O2` is free to assume away — neither is something a
# test can pin. The guard is still load-bearing (it is what keeps NULL out of `strcmp`); what is
# testable is the answer it gives, so that is what this moves.
mutate "act: a missing target activates" 's@^  if (target == NULL.*return 0;$@  if (target == NULL || *target == 0) return 1;@' || fails=1
mutate "act: any bundle matches"    's|return strcmp(myBundleId, target) == 0;|return 1;|'     || fails=1
mutate "act: the wrong bundle"      's|strcmp(myBundleId, target) == 0|strcmp(myBundleId, target) != 0|' || fails=1
mutate "act: nil bundle accepted"   's|if (myBundleId == NULL) return 0;||'                    || fails=1

# tf_condition_path_decision — a contract with the agent, in another language
mutate "path: the prefix moves"     's|/tmp/tapflow-offline-|/tmp/tapflow-off-|'               || fails=1
mutate "path: the directory moves"  's|/tmp/tapflow-offline-|/var/tmp/tapflow-offline-|'       || fails=1
mutate "path: the udid is dropped"      's|"/tmp/tapflow-offline-%s", udid|"/tmp/tapflow-offline-%.0s", udid|' || fails=1

# --- how far the descriptor scan goes ---
mutate "fd: the cap is ignored"      's@const int trimmed = want > (unsigned long long)TF_MAX_FD_SCAN;@const int trimmed = want > 0 \&\& 0;@' || fails=1
mutate "fd: off by one at the cap"   's@want > (unsigned long long)TF_MAX_FD_SCAN@want >= (unsigned long long)TF_MAX_FD_SCAN@' || fails=1
mutate "fd: no fallback"             's@haveLimit ? soft : 1024ULL@haveLimit >= 0 ? soft : 1024ULL@' || fails=1
mutate "fd: casts before clamping"   's@return trimmed ? TF_MAX_FD_SCAN : (int)want;@return (int)want;@' || fails=1
mutate "fd: trims without saying so" 's@\*capped = trimmed;@*capped = 0 \&\& trimmed;@' || fails=1

# tf_exe_in_app_bundle_decision — a daemon that reaches the bundle read aborts (fileproviderd, GSSCred)
mutate "app: a missing path is an app"   's@  if (exe == NULL) return 0;@  if (exe == NULL) return 1;@' || fails=1
mutate "app: no executable named counts" "s@if (slash == NULL || slash\[1\] == '\\\\0') return 0;@if (slash == NULL) return 0;@" || fails=1
mutate "app: a bare .app directory counts" "s@ || slash\[-5\] == '/') return 0;@) return 0;@" || fails=1
# Review: the bound that keeps `slash[-5]` inside the string. Moved, `.app/X` reads the byte before it.
mutate "app: the bound admits a bare .app" 's@slash - exe < 5@slash - exe < 4@' || fails=1
mutate "app: any path is an app"         's@return strncmp(slash - 4, ".app", 4) == 0;@return strncmp(slash - 4, ".app", 4) <= 0 || 1;@' || fails=1
mutate "app: the suffix is not anchored" 's@return strncmp(slash - 4, ".app", 4) == 0;@return strstr(exe, ".app") != NULL;@' || fails=1

[[ $fails -eq 0 ]] && echo "=== all mutations killed ===" || { echo "=== a mutation survived ==="; exit 1; }
