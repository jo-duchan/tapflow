#ifndef TAPFLOW_HOOK_DECISIONS_H
#define TAPFLOW_HOOK_DECISIONS_H

/*
 * The decidable half of `network-hook.m`, kept here **so it can be tested**.
 *
 * Everything else in that file reaches something a unit test cannot stand up: `dlopen`ing the
 * process's own libraries, patching 16K pages, walking live file descriptors, re-firing an
 * `nw_path_monitor` handler on the queue its owner chose. What is left once those are peeled away is
 * this — four questions answered from their arguments alone.
 *
 * **Plain C on purpose, and no Foundation.** These compile with a bare `clang` on any host, with no
 * iOS simulator SDK, which is what lets the tests run in the ordinary `test` job rather than on a
 * macOS runner. `scripts/__tests__/nethookDecisions.test.mjs` compiles this header into a harness and
 * runs it; `network-hook.m` includes the same header, so the tests judge the shipping code rather
 * than a copy of it.
 *
 * `static inline` rather than a `.c`: one translation unit includes it in production and one in the
 * harness, so there is nothing to link and `build-nethook.sh` does not change. It is still an input
 * to the dylib's hash — `scripts/lib/nethook-artifact.mjs` refuses a local `#include` that is not in
 * `SOURCE_FILES`, which is how this file got added there rather than by anyone remembering.
 */

#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>

/**
 * Whether a connected peer is this device talking to itself.
 *
 * **The one thing `tf_cut_open_connections` must not cut.** tapflow's own UI-tree runner listens
 * inside the simulator (#433) and Metro serves over the host's loopback; cutting either turns "take
 * this device offline" into "break the session". Everything external is fair game, and this is the
 * line between them.
 */
static inline int tf_peer_is_loopback_decision(const struct sockaddr *addr) {
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *v4 = (const struct sockaddr_in *)addr;
    return (ntohl(v4->sin_addr.s_addr) >> 24) == 127;
  }
  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)addr;
    if (IN6_IS_ADDR_LOOPBACK(&v6->sin6_addr)) return 1;
    /* ::ffff:127.0.0.0/8 — a v4 loopback reached through a v6 socket, which is what a dual-stack
     * resolver hands back for `localhost` here. */
    if (IN6_IS_ADDR_V4MAPPED(&v6->sin6_addr)) {
      return (ntohl(*(const uint32_t *)&v6->sin6_addr.s6_addr[12]) >> 24) == 127;
    }
  }
  return 0;
}

/**
 * Whether a call should be refused, from the three things that decide it.
 *
 * **`hooksLive` gates everything, and that is the half the install loop cannot deliver on its own.**
 * The patch cannot be removed, so a refusal on the second target leaves the first one live: without
 * this gate `getaddrinfo` stayed permanently hooked in a process whose verdict said
 * `installed:false` — the agent reporting that layer 2 does not work while a piece of it quietly
 * did. Until every hook is in, every replacement tail-calls the original.
 *
 * `forced` is the in-process flag; `conditionFilePresent` is the file the agent writes. Either one
 * blocks, because the file is the live toggle and the flag is what a self-check arms.
 */
static inline int tf_blocking_decision(int hooksLive, int forced, int conditionFilePresent) {
  if (!hooksLive) return 0;
  return forced || conditionFilePresent;
}

/**
 * Whether this process is the one to hook.
 *
 * dyld injects into **every** process the simulator starts, and the hooks belong in exactly one: the
 * app under test. A udid is required first because it is the only per-simulator namespace this
 * library has — the host's `/tmp` is visible at the same path inside every simulator on the Mac, so
 * without it one session going offline takes every other session with it.
 *
 * Empty is not set. `getenv` returns `""` for an exported-but-blank variable, and treating that as a
 * value makes the bundle comparison succeed against a bundle id nobody chose.
 */
static inline int tf_should_activate_decision(const char *udid, const char *target,
                                              const char *myBundleId) {
  if (udid == NULL || *udid == '\0') return 0;
  if (target == NULL || *target == '\0') return 0;
  if (myBundleId == NULL) return 0;
  return strcmp(myBundleId, target) == 0;
}

/**
 * Where the offline flag for one simulator lives.
 *
 * **This string is a contract with the agent, in another language.** `SimulatorNetwork.ts` writes
 * `${conditionDir}/tapflow-offline-${udid}` with `conditionDir` defaulting to `/tmp`; this reads it.
 * Nothing compiles both, so `scripts/__tests__/nethookDecisions.test.mjs` compares them — a drift
 * makes the toggle do nothing at all, silently, with the control still saying offline.

 *
 * Returns the number of characters that would have been written, `snprintf`-style, so a caller can
 * tell a truncated path from a complete one.
 */
static inline int tf_condition_path_decision(char *out, size_t n, const char *udid) {
  return snprintf(out, n, "/tmp/tapflow-offline-%s", udid);
}

// MARK: - how far the descriptor scan goes

/**
 * The scan bound, and what it costs when it truncates.
 *
 * `tf_cut_open_connections` walks descriptors to shut down the app's external sockets. `RLIMIT_NOFILE`
 * can be enormous — `OPEN_MAX` — and walking millions of them on a toggle is worse than missing the
 * tail of a process holding more than this.
 *
 * **`capped` is why this returns two things.** A silent cap looks exactly like a process with nothing
 * left to cut, so the caller logs when it trims — and a boolean nothing sets is a log line nothing
 * fires. Passing it back is what lets a test hold the difference.
 *
 * `haveLimit` is the caller's `getrlimit(…) == 0 && rl.rlim_cur != RLIM_INFINITY`: an unreadable limit
 * and an infinite one are the same answer here, which is to fall back rather than to walk forever.
 */
#define TF_MAX_FD_SCAN 8192

static inline int tf_fd_scan_bound(int haveLimit, unsigned long long soft, int *capped) {
  // **Decided in 64 bits, cast only once it fits.** `rlim_t` is 64-bit and `(int)` of anything above
  // `INT_MAX` is negative or zero, which makes the caller's `for (int fd = 0; fd < max; ...)` walk
  // nothing — no connection shut down, and `capped` reporting that nothing was trimmed, so the log
  // that exists to make a truncated scan audible never fires. That is an "offline" control over open
  // connections, reached through an integer conversion. The caller's `!= RLIM_INFINITY` test does not
  // cover it: any finite value above `INT_MAX` passes that and truncates here.
  //
  // Asking whether it trimmed *before* trimming is the other half. Clamping first and then comparing
  // the clamped value answers "no" every time, which is the same silence by a different route.
  const unsigned long long want = haveLimit ? soft : 1024ULL;
  const int trimmed = want > (unsigned long long)TF_MAX_FD_SCAN;
  if (capped != NULL) *capped = trimmed;
  return trimmed ? TF_MAX_FD_SCAN : (int)want;
}

/**
 * Whether the process runs from directly inside an app bundle (`…/Name.app/Executable`), asked before
 * anything reads the bundle.
 *
 * **Every process in the simulator runs both gates, and most of them may not touch Objective-C there.**
 * The library is delivered with `DYLD_INSERT_LIBRARIES` to every process, daemons included, and its
 * constructors run before `main`, with no autorelease pool. `+[NSBundle mainBundle]` autoreleases;
 * measured on iOS 26.5, `fileproviderd` and `GSSCred` abort on it (`autoreleaseNoPage` →
 * `_objc_fatal`, inside the pool push itself), so a gate that read the bundle id first left both
 * daemons crashing in a loop for as long as a target was named — 95 reports in one day — and
 * WebKit's navigations, which wait on them, never finished: Safari and every web view stayed white.
 * No daemon is the target of either gate, and none runs from an app bundle, so the path settles it
 * with no Objective-C at all. An app extension (`.appex`) is not an app either.
 */
static inline int tf_exe_in_app_bundle_decision(const char *exe) {
  if (exe == NULL) return 0;
  const char *slash = strrchr(exe, '/');
  if (slash == NULL || slash[1] == '\0') return 0;
  // `x.app/`: at least one character before the extension, so a directory named `.app` is not one.
  if (slash - exe < 5 || slash[-5] == '/') return 0;
  return strncmp(slash - 4, ".app", 4) == 0;
}

#endif /* TAPFLOW_HOOK_DECISIONS_H */
