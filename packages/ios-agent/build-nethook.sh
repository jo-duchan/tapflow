#!/bin/bash
# Build `bin/libtapflow-nethook.dylib` from `src/network-hook.m` + `src/inline-hook.c`, and the app observer
# (`src/app-observer.m`), which rides on the same injection (packages/ios-agent/AGENTS.md, "App observer").
#
# **This file exists because the recipe was nowhere.** The dylib is committed as a prebuilt binary,
# like `ios-netfilter`'s app — but unlike that one it had no build script, so the flags lived only in
# whichever shell last produced it. Changing `network-hook.m` meant guessing them.
#
# They were recovered from the committed binary rather than remembered: `otool -l` gives the platform
# (7 = iOS simulator), `minos 17.0` and the linked frameworks, and `size -m` confirmed the guess —
# every section of a rebuild matched the committed one byte for byte, `__text` included at 9040. That
# is what makes the flags below right rather than plausible.
#
# `-fobjc-arc`: the sources use no retain/release. `-O2`: matches the committed `__text` size; -Os and
# -O0 do not. The install name is the output path, which is what the committed binary carries — it is
# injected by absolute path through `DYLD_INSERT_LIBRARIES`, so nothing reads it.
set -euo pipefail
cd "$(dirname "$0")"

out=bin/libtapflow-nethook.dylib
xcrun --sdk iphonesimulator clang \
  -arch arm64 \
  -mios-simulator-version-min=17.0 \
  -dynamiclib \
  -fobjc-arc \
  -O2 \
  -framework Foundation \
  -framework Network \
  -framework SystemConfiguration \
  -o "$out" \
  src/network-hook.m src/inline-hook.c src/app-observer.m

# The tarball flattens the executable bit (measured on the netfilter app, same cause), and
# `postinstall` puts it back on everything in `bin/`. Set it here so a local build matches.
chmod 755 "$out"
echo "built $out"
otool -l "$out" | grep -A3 LC_BUILD_VERSION | sed 's/^/  /'

# Record in the same step that produced the binary. Separating them is how one of the two ends up
# stale while the other looks right, which is the failure the guard exists for.
node ../../scripts/record-nethook-artifact.mjs --after-build
