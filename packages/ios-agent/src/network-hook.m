// tapflow — tell an iOS simulator's app that it is off the network (#607).
//
// The simulator has no NIC to attach a shaper to: it is native processes on the host kernel sharing
// the host's network stack, so Network Link Conditioner, `dnctl`, and every other traffic-shaping
// route reach the whole Mac or nothing. Apple ships no per-simulator conditioning API — checked
// across `simctl`, CoreSimulator's private selectors and the runtime itself on Xcode 26.6.
//
// **Blocking the traffic is not this file's job.** The host content filter (`ios-netfilter`) drops
// the flows of one simulator at the kernel. What no host-side filter can do is change what the app
// *believes*: an app reads `nw_path_get_status` inside its update handler, the real path never
// changed — the Mac is still on Wi-Fi — so the handler never fires again and the offline banner
// never appears. Measured: traffic dead, `path=satisfied` for the life of the process. That half
// needs a hook inside the app, and it is what remains here.
//
// **Inline patching, because neither of the pointer-rewriting techniques reaches.** dyld's
// `__DATA,__interpose` does not fire in a real `.app`, and fishhook — which rewrites indirect symbol
// pointers — reaches only images outside the dyld shared cache, where every system framework calls
// its neighbours with direct branches. Both were measured here, and fishhook's apparent success was
// this dylib's own imports being rebound, which is also what made the first self-check pass while
// nothing was blocked. `inline-hook.c` patches the target function's body instead.
//
// This is deliberately a **QA instrument that lies to one app**, so everything here is built around
// one question: can it lie *silently*? A hook that does not install produces a false QA result —
// someone signs off "offline handling works" on an app that was never offline. `rebind_symbols`
// returns 0 whether or not it rebound anything, so nothing here trusts that it worked;
// `tf_self_check` proves it by trying.

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <Network/Network.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <arpa/inet.h>
#import <netdb.h>
#import <netinet/in.h>
#import <stdlib.h>
#import <sys/resource.h>
#import <sys/socket.h>

// The decidable half, in plain C so a test can compile it with no simulator SDK. See the note at the
// top of that file for what is in it and why it is a header rather than a `.c`.
#include "hook-decisions.h"
#include "main-bundle.h"

#import <os/log.h>
#import <stdatomic.h>
#import <stdio.h>
#import <string.h>
#import <sys/stat.h>
#import <unistd.h>

#import "inline-hook.h"

static os_log_t tf_log(void) {
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ log = os_log_create("io.tapflow.nethook", "hook"); });
  return log;
}

// ── what makes this process a target ─────────────────────────────────────────

/**
 * The dylib is delivered simulator-wide (`launchctl setenv DYLD_INSERT_LIBRARIES`), so it loads in
 * every process in the simulator — SpringBoard, backboardd, the lot — and the defence is **this
 * function, not the delivery**. Anything not recognised gets no hooks at all.
 *
 * **The reason originally given for that breadth has been measured false.** It said simulator-wide
 * delivery was the only way to reach an app's WebView, `WebKit.Networking` being a sibling process
 * under `launchd_sim` that `SIMCTL_CHILD_…` could not follow. The sibling part is true; the reach is
 * not. Measured 2026-08-23 with an app holding a real `WKWebView`: `WebKit.Networking`,
 * `WebKit.WebContent` and `WebKit.GPU` all spawned, and **not one of them loaded this library** —
 * they are restricted enough that dyld drops `DYLD_*`. Ordinary daemons in the same simulator loaded
 * it in the same run, so the delivery itself works.
 *
 * **The `com.apple.WebKit.` branch that measurement made dead is gone** (#635), and with it the only
 * reason this file ever had two kinds of activated process. What is left is one: the target app.
 *
 * **A hybrid app's web half is therefore not told it is offline**, and that is a limitation rather
 * than a bug to find later. Its traffic is still blocked — the host content filter works at the
 * kernel, for every process — so a `fetch` inside the web view fails. What it does not get is the
 * path status, so a WebView that renders its own offline banner from `navigator.onLine` will not
 * show it. Nothing in this process can reach that one.
 *
 * **Simulator-wide delivery stays, on a different reason than it was chosen for.** The WebView reach
 * is gone, but the breadth still buys the case per-launch environment cannot: a tester who taps the
 * app's icon on the springboard, rather than launching it through tapflow, gets a hooked app.
 * `simctl launch --env` would cover only the launches tapflow itself performs, and a manual relaunch
 * mid-session is ordinary. The cost is that this is the mechanism that could take a whole simulator
 * down at once, which is why the gate below refuses by default.
 *
 * **The default is off.** With no target named, or no bundle identifier to compare, this returns
 * false: a bug in the identification leaves the simulator unhooked rather than hooking the system.
 */

/**
 * The simulator this process belongs to, or `NULL`.
 *
 * **Everything this library writes is keyed by it, so without it there is nothing safe to do.** The
 * host's `/tmp` is the same `/tmp` inside every simulator on the Mac, and both the condition file and
 * the verdict used to fall back to a literal `"unknown"` when the variable was missing — one shared
 * path for every session, which is precisely the collision the udid exists to prevent. A fallback
 * that defeats the invariant its own doc block states is worse than no fallback.
 *
 * CoreSimulator sets this in every process it launches, so the absence is not a case anyone has seen.
 * It is refused rather than papered over because this file's rule is that a hook which cannot be
 * installed correctly is not installed.
 */
static const char *tf_udid(void) {
  const char *udid = getenv("SIMULATOR_UDID");
  return (udid != NULL && *udid != '\0') ? udid : NULL;
}

/**
 * **The target app, and nothing else.** The WebKit branch this used to carry was measured never to
 * match (#635), so activation and "is the target" are now the same question — which is why the
 * verdict, the self-check and the watcher below need no second case.
 */
static BOOL tf_should_activate(void) {
  /**
   * **The two cheap reads come first, and that ordering is the point rather than style.** This runs
   * in a `constructor` in **every** process the simulator starts — SpringBoard, backboardd, every
   * daemon — and all but one of them fail here. Reading the main bundle (`tf_main_bundle_id`) parses
   * the main executable's `Info.plist`, so doing it before the environment is checked would put that cost on
   * every process on the device for an answer that is `NO`. The first version of this refactor did
   * exactly that, by making the bundle id an argument.
   *
   * The decision function repeats these two guards. That is deliberate: it stays total so a test can
   * reach every branch, while the ordering that saves the work lives where the work is.
   */
  const char *udid = tf_udid();
  if (udid == NULL) return NO;
  const char *target = getenv("TAPFLOW_TARGET_BUNDLE");
  if (target == NULL || *target == '\0') return NO;

  // **The condition path has to fit, and this is the last moment it can be refused.** It is built
  // from the udid, which arrives from the environment; a truncated one stats a file the agent never
  // writes, so the device could never be taken offline — and two long udids sharing a prefix would
  // share a flag. `tf_start_watching` runs after `tf_hook_install`, and the patch cannot be removed,
  // so checking there would leave irreversible hooks in a process that can never honour them.
  // `tf_condition_path_decision` reports the length it wanted, which is what makes this checkable.
  char probe[PATH_MAX];
  if (tf_condition_path_decision(probe, sizeof probe, udid) >= (int)sizeof probe) return NO;
  // **Every path derived from the udid, not only the one this function came for.** The verdict's
  // temporary name is the longest of them, and a udid can fit the condition path while overflowing
  // it. `tf_write_verdict` refuses a truncated name and returns — correct there, useless here: by
  // then the hooks are in and cannot be removed, so the process runs hooked while the agent reads
  // whatever verdict was on disk before. Raised by CodeRabbit on #763, which is also where the
  // condition path itself came from.
  if (snprintf(probe, sizeof probe, "/tmp/tapflow-nethook-%s.json.%d.tmp", udid, getpid())
      >= (int)sizeof probe) return NO;

  // **Read with no Objective-C** (`tf_main_bundle_id`): a daemon aborts on `NSBundle`'s autorelease
  // here, with no pool, and two it killed held every web view in the simulator white
  // (`tf_exe_in_app_bundle_decision`). It also refuses an embedded NUL: `CFBundleIdentifier` is read
  // from a binary plist, which can carry one, and `com.x\0z` compares equal to `com.x` byte-wise.
  char me[256];
  if (!tf_main_bundle_id(me, sizeof me)) return NO;

  return tf_should_activate_decision(udid, target, me) ? YES : NO;
}



// ── the condition file ───────────────────────────────────────────────────────

/**
 * `/tmp/tapflow-offline-<udid>`, and the udid is not decoration.
 *
 * The host's `/tmp` is visible at the same path inside **every** simulator on that Mac — measured
 * with two runtimes reading a file written once on the host. Without the udid, one session going
 * offline takes every other session on the machine with it, and `TAPFLOW_TARGET_BUNDLE` above does
 * not help: both simulators activate correctly and then read the same flag.
 */
static const char *tf_condition_path(void) {
  static char path[PATH_MAX];
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // `tf_should_activate` has already refused a process with no udid, so this cannot be NULL by
    // the time anything calls it.
    tf_condition_path_decision(path, sizeof(path), tf_udid());

  });
  return path;
}

/**
 * Read on every call rather than cached, which is what makes the toggle live.
 *
 * dyld injects at process start, so arming on demand would mean relaunching the app — and "I got to
 * the payment screen and now I want to cut the network" is the scenario this feature is for. The
 * cost is a `stat` per outbound call; with no condition file present the hooks are a `stat` and a
 * tail call to the original.
 */
static BOOL tf_offline(void) {
  struct stat st;
  return stat(tf_condition_path(), &st) == 0;
}

// A self-check in progress forces `tf_offline` true for this process only, without touching the file
// that every other process reads.
static atomic_bool g_forced_offline = ATOMIC_VAR_INIT(false);

/**
 * **"Every hook, or none" — the half that the loop below could not deliver on its own.**
 *
 * The install refuses as a set, but a refusal on the second target cannot undo the first: there is
 * no uninstall, by design, so a partially patched process keeps whatever went in. That left
 * `getaddrinfo` permanently live in a process whose verdict says `installed:false` — the agent
 * reporting that layer 2 does not work while a piece of it quietly does.
 *
 * The patch cannot be removed, so the replacement is neutered instead: until this is set, every
 * replacement behaves as the function it replaced. Set once, after the whole set is in.
 */
static atomic_bool g_hooks_live = ATOMIC_VAR_INIT(false);

static BOOL tf_blocking(void) {
  // **Both short circuits are preserved here, and they are about cost rather than about the answer.**
  // `tf_offline()` stats the condition file on every hooked call; the install gate and the forced
  // flag each existed to not pay for it. Handing all three to the decision as plain arguments would
  // evaluate the stat unconditionally — including in a process where the install failed and the
  // replacements are live but neutered, which is the one place it buys nothing at all.
  //
  // The orderings stay here too: acquire on the install gate, relaxed on the flag, because they are
  // a property of these loads rather than of the decision they feed.
  const int live = atomic_load_explicit(&g_hooks_live, memory_order_acquire);
  const int forced = live ? atomic_load_explicit(&g_forced_offline, memory_order_relaxed) : 0;
  const int file = (live && !forced) ? tf_offline() : 0;
  return tf_blocking_decision(live, forced, file) ? YES : NO;


}

// ── the name lookup ──────────────────────────────────────────────────────────

/**
 * **`connect` and `sendto` used to be hooked here, and are not any more.**
 *
 * They cannot be. Both share a 16K page of libsystem_kernel with `mach_vm_protect`, and
 * `inline-hook.c` refuses that page by design — patching it un-maps the code performing the patch
 * and the app dies in its dyld initialisers (measured three times, see the comment there). Since the
 * install is all-or-none, keeping them meant **no hooks installed at all**, which is what shipped:
 * measured on iOS 17.2 and 26.4, `installed:false` with `connect: refused` and the path hooks never
 * even attempted. The three that remain were measured patchable on both runtimes.
 *
 * That is not a loss, because blocking traffic is no longer this dylib's job. The host content
 * filter (`ios-netfilter`) drops the flows, at the kernel, for **every** process in the simulator
 * rather than the one app these hooks reach — which is strictly wider, and is what covers the web
 * half of a hybrid app that this library was measured never to load into (#635).
 *
 * The plan recorded that hand-off on 2026-08-22 ("앱-내부 dylib으로 실제 트래픽을 끊는 길이 불가로
 * 확정된 뒤의 재설계"); this file, written the day before, had not caught up.
 *
 * What is left here is the half only an in-process hook can do: **what the app is told.**
 */
static int (*o_getaddrinfo)(const char *, const char *, const struct addrinfo *, struct addrinfo **);

static int tf_getaddrinfo(const char *node, const char *service,
                          const struct addrinfo *hints, struct addrinfo **res) {
  if (tf_blocking() && node != NULL) {
    // Names only, and `localhost` is exempt: tapflow's own instrumentation runs inside the simulator
    // and talks to itself (the UI-tree runner on a fixed port, #433), and a dev build talking to a
    // local Metro server keeps that connection — the honest reading of "no internet", and a line for
    // the user docs. A numeric address is not a lookup at all; `127.0.0.1` arrives here as a string.
    struct in_addr v4;
    struct in6_addr v6;
    BOOL numeric = inet_pton(AF_INET, node, &v4) == 1 || inet_pton(AF_INET6, node, &v6) == 1;
    BOOL local = strcmp(node, "localhost") == 0;
    if (!numeric && !local) return EAI_NONAME;
  }
  return o_getaddrinfo(node, service, hints, res);
}

// ── what the app is told ─────────────────────────────────────────────────────

/**
 * Blocking the traffic is not enough on its own: the offline banner does not appear.
 *
 * An app reads `nw_path_get_status` **inside its update handler** and nowhere else. The real path
 * has not changed — the host is still on Wi-Fi — so the handler never fires again and the app keeps
 * the status it was given at startup. Measured: traffic dead, `path=1` (satisfied) forever.
 *
 * So this captures the app's block, keeps the last `nw_path_t` it was called with, and calls it
 * again when the flag changes. A read hook alone cannot do it; something has to **push**.
 */
static nw_path_status_t (*o_nw_path_get_status)(nw_path_t);
static void (*o_nw_path_monitor_set_update_handler)(nw_path_monitor_t, nw_path_monitor_update_handler_t);
static void (*o_nw_path_monitor_set_queue)(nw_path_monitor_t, dispatch_queue_t);

static nw_path_status_t tf_nw_path_get_status(nw_path_t path) {
  if (tf_blocking()) return nw_path_status_unsatisfied;
  return o_nw_path_get_status(path);
}

// The app's handlers, and the last path each was called with. Multiple monitors are ordinary —
// `URLSession` keeps its own alongside the app's.
static NSMutableArray *g_handlers;   // of nw_path_monitor_update_handler_t (copied)
static NSMutableArray *g_paths;      // of nw_path_t, index-aligned with the above
static NSMutableArray *g_monitors;   // of nw_path_monitor_t, index-aligned with the above
static NSMutableDictionary *g_queues;   // monitor pointer → the dispatch queue its owner set
static dispatch_queue_t g_handler_queue;

/**
 * Record the queue the owner chose, so `tf_push_path_update` can fire on it.
 *
 * **`NWPathMonitor` promises the handler runs on this queue, and until now tapflow broke that
 * promise** (#640): it re-fired on its own utility queue, which can run a third-party handler
 * concurrently with the framework's own call and puts UI work off the main thread. A crash there is
 * in the app under test and would be blamed on tapflow, rightly.
 *
 * Keyed by the monitor's pointer rather than index-aligned, because the two setters may be called in
 * either order — and often are.
 *
 * **A freed monitor's address can be reused, and that is harmless here rather than merely unlikely.**
 * `nw_path_monitor_start` requires a queue, so any monitor created after these hooks are live calls
 * this one before it can deliver anything — overwriting a stale entry at that address before it could
 * be read. An entry that is never overwritten belongs to a monitor that never started, whose path
 * stays `NSNull`, and the replay skips those. tapflow's own self-check bypasses this hook entirely so
 * it cannot contribute the one entry that would otherwise be guaranteed and stale.
 *
 * What is left is a bounded leak of the same shape as `g_monitors`: one entry per monitor that sets a
 * queue and never a handler, which is a monitor that can report nothing.
 */
static void tf_nw_path_monitor_set_queue(nw_path_monitor_t monitor, dispatch_queue_t queue) {
  if (monitor != NULL && queue != NULL) {
    dispatch_sync(g_handler_queue, ^{ g_queues[@((uintptr_t)monitor)] = queue; });
  }
  o_nw_path_monitor_set_queue(monitor, queue);
}

static void tf_nw_path_monitor_set_update_handler(nw_path_monitor_t monitor,
                                                  nw_path_monitor_update_handler_t handler) {
  // Clearing a handler is legal and captures nothing — there is no block to re-fire. A stale entry
  // for this monitor may remain; calling it later is redundant, not unsafe, because of the ownership
  // below.
  if (handler == NULL) {
    o_nw_path_monitor_set_update_handler(monitor, handler);
    return;
  }

  // **Own everything we will later call.** This used to store the block as passed, reasoning that
  // ARC copies it on assignment to a strong local. It does not reliably, and the monitor was not
  // retained at all — so the first live toggle jumped to address 0 inside `tf_push_path_update`
  // (SIGSEGV, measured 2026-08-23, the first run in which the hooks ever installed). A caller that
  // sets a handler and then lets its monitor go is ordinary: `URLSession` does it, and so did this
  // file's own self-check.
  //
  // The monitor is held for the life of the process. That is a bounded leak — a handful of monitors
  // — and it is the price of being able to re-fire a handler at a moment of tapflow's choosing.
  nw_path_monitor_update_handler_t app = [handler copy];

  // The slot is read **inside** the queue. Reading `count` after the barrier let two concurrent
  // registrations derive the same index, which would leave one monitor writing over the other's path.
  __block NSUInteger slot;
  dispatch_sync(g_handler_queue, ^{
    [g_handlers addObject:app];
    [g_paths addObject:[NSNull null]];
    [g_monitors addObject:monitor];
    slot = g_handlers.count - 1;
  });

  o_nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
    dispatch_sync(g_handler_queue, ^{ g_paths[slot] = path; });
    app(path);
  });
}

/**
 * Re-run every captured handler with the path it last saw. `tf_nw_path_get_status` answers.
 *
 * **Snapshot under the queue, call outside it.** These are the app's blocks and they run arbitrary
 * code: a handler that registers another monitor — `URLSession` does — would re-enter this serial
 * queue through `dispatch_sync` and deadlock the app inside its own network callback.
 */
/**
 * Replay each captured handler with the last path its monitor delivered — **on that monitor's own
 * queue** (#640).
 *
 * `nw_path_monitor_set_queue` is what the owner used to say where its handler runs, and this used to
 * ignore it and call inline on tapflow's utility queue. Two things were wrong with that: the handler
 * could run concurrently with a genuine framework callback, and a handler that touches UI — a normal
 * thing for a path handler to do — did it off the main thread.
 *
 * `dispatch_async`, not `sync`: this is called from the condition-file watcher, and a handler that
 * blocks on its own queue would otherwise stall the watcher for every later monitor. It also removes
 * any chance of deadlocking against a queue the app already holds.
 *
 * **A monitor with no recorded queue is skipped rather than fired anywhere.** It should not be
 * reachable — `nw_path_monitor_start` requires a queue, and a path is only recorded once the monitor
 * has delivered one, so anything replayed here has started. It would mean a monitor built before
 * these hooks installed, and the honest answer for that case is that we do not know where its
 * handler belongs; guessing is what this change exists to stop.
 */
static void tf_push_path_update(void) {
  __block NSArray *handlers, *paths, *monitors;
  __block NSDictionary *queues;
  dispatch_sync(g_handler_queue, ^{
    handlers = [g_handlers copy];
    paths = [g_paths copy];
    monitors = [g_monitors copy];
    queues = [g_queues copy];
  });

  for (NSUInteger i = 0; i < handlers.count; i++) {
    id path = paths[i];
    if (path == [NSNull null]) continue;   // never delivered one; nothing to replay
    dispatch_queue_t q = queues[@((uintptr_t)monitors[i])];
    if (q == nil) {
      os_log_error(tf_log(), "no queue recorded for a started monitor — not re-firing its handler");
      continue;
    }
    nw_path_monitor_update_handler_t h = handlers[i];
    dispatch_async(q, ^{ h((nw_path_t)path); });
  }
}

// ── the connections the app already holds ────────────────────────────────────

/**
 * Cutting the connections that were open before the toggle, from inside the app.
 *
 * The host content filter cannot do this, and that is not a gap in tapflow's use of it — Apple is
 * explicit that the decision is one-way: "Once you've allowed a connection to proceed, there's no way
 * to go back on that decision. That's true for both content filter and transparent proxy."
 * (https://developer.apple.com/forums/thread/710166). Keeping every simulator flow under a data
 * verdict instead was built and measured, and `peekBytes` leaves no usable setting: 8192 delivered
 * zero callbacks (an HTTP request never reaches the threshold), 1 delivered 815,869 in forty seconds
 * and timed out even the simulator no rule had named.
 *
 * It matters because `URLSession` holds one connection for a whole session. Without this, a tester
 * who goes offline mid-session watches the app keep talking over the socket it already had, while
 * every *new* request fails — the half-state this feature exists to prevent.
 *
 * `shutdown`, not `close`. The descriptor stays open and owned, so nothing can reuse the number
 * underneath `URLSession` and no other thread's write lands in a stranger's socket; the owner simply
 * sees the connection go away, which is what a phone losing signal looks like.
 */
static BOOL tf_peer_is_loopback(const struct sockaddr *addr) {
  return tf_peer_is_loopback_decision(addr) ? YES : NO;
}


/**
 * The descriptors are walked with plain POSIX rather than `libproc`, which the simulator SDK does not
 * expose. It is not a workaround — the two calls answer exactly the questions that need asking, and
 * their *failures* are the filter:
 *
 *  - `getsockopt(SO_TYPE)` fails on anything that is not a socket, so files and pipes fall out
 *  - `getpeername` fails with `ENOTCONN` on a listening or unconnected socket, so tapflow's own
 *    in-simulator listener (the UI-tree runner, #433) is never touched
 */
// `TF_MAX_FD_SCAN` and the bound it feeds are in `hook-decisions.h`, where a test reaches them.

/**
 * Shut down the app's own external TCP connections.
 *
 * **The descriptor is read twice and can change underneath, which cannot be closed — only narrowed
 * and made visible** (#643). Nothing pins an fd across two syscalls: another thread may close and
 * reopen it between the peer check and the `shutdown`, in which case the verdict formed about one
 * socket lands on whatever now holds that number. Inside a simulator the realistic damage is a
 * loopback connection cut on an external socket's verdict — Metro, or tapflow's own in-simulator
 * runner, going down while the tester is looking at something else.
 *
 * So the descriptor is re-read afterwards. That does not undo anything; it turns a silent,
 * unreproducible failure into a line naming the descriptor.
 *
 * **The identity has to be something our own `shutdown` does not destroy, and two earlier versions
 * of this check got that wrong in opposite directions.** The first compared the *peer* and treated
 * any change as a race — but a successful cut disconnects the socket, so the peer always changes,
 * and it reported all four connections as raced. The second excluded that case and became blind:
 * with the peer unreadable after a cut, the only window it could still see was the harmless one
 * *after* the `shutdown`, while the window that does the damage is between `getpeername` and
 * `shutdown`. A counter that cannot observe the failure it is named for reads zero forever.
 *
 * The **local** address is what survives. Measured on macOS: after `shutdown(SHUT_RDWR)`,
 * `getpeername` fails (`EINVAL`) while `getsockname` returns the same address and port it did
 * before. A descriptor recycled in either window is a different socket with a different local port,
 * so comparing that is a check with something to say.
 *
 * It is read **three** times, and the first two are what make this more than a report: before the
 * classification, again just before the `shutdown`, and once after. A change across the first pair
 * means the verdict belongs to a socket that is gone, and the descriptor is skipped — the damage is
 * avoided rather than described. Only the last pair is unavoidable, because nothing can hold a
 * descriptor across `shutdown` itself.
 */
static void tf_cut_open_connections(void) {
  // Initialised because `rl.rlim_cur` is now an *argument*, evaluated whether or not `getrlimit`
  // wrote it. The old ternary short-circuited and never touched it on failure; passing it to a
  // function does not.
  struct rlimit rl = { 0, 0 };
  const int haveLimit = (getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY);
  int capped = 0;
  const int max = tf_fd_scan_bound(haveLimit, (unsigned long long)rl.rlim_cur, &capped);
  if (capped) {
    os_log(tf_log(), "fd scan capped at %{public}d of %{public}llu", max, (unsigned long long)rl.rlim_cur);
  }

  int cut = 0, raced = 0;
  for (int fd = 0; fd < max; fd++) {
    int type = 0;
    socklen_t tlen = sizeof(type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &tlen) != 0) continue;
    if (type != SOCK_STREAM) continue;   // UDP has nothing to tear down; its next send is refused anyway

    // **The identity is taken before anything is decided, not after.** A first version read it
    // between the peer check and the `shutdown`, which left the classification and the identity on
    // opposite sides of the window that matters: a descriptor recycled there was classified as the
    // old socket, identified as the new one, cut, and then compared new-against-new — reporting no
    // race while cutting the loopback connection the peer check exists to protect.
    //
    // **A descriptor that cannot be identified is not cut at all.** `getsockname` does not fail on a
    // connected socket for any ordinary reason — an unbound one answers with `AF_UNSPEC` rather than
    // erroring — so a failure here means the fd went away between the type check and this line.
    // Treating that as "carry on without the identity" was the worse of the two options: it disabled
    // every later check as well, so `shutdown` could land on whatever took the descriptor's place,
    // judged by the *previous* socket's type, with nothing left to notice that it had.
    struct sockaddr_storage self0;
    socklen_t s0len = sizeof(self0);
    if (getsockname(fd, (struct sockaddr *)&self0, &s0len) != 0) {
      raced++;
      os_log_error(tf_log(), "fd %{public}d went away before it could be identified — not cutting it", fd);
      continue;
    }

    struct sockaddr_storage peer;
    socklen_t plen = sizeof(peer);
    if (getpeername(fd, (struct sockaddr *)&peer, &plen) != 0) continue;
    if (peer.ss_family != AF_INET && peer.ss_family != AF_INET6) continue;   // AF_UNIX is not the internet
    if (tf_peer_is_loopback((struct sockaddr *)&peer)) continue;             // Metro, and our own runner

    // Re-read immediately before acting. This window can be *avoided* rather than only reported:
    // if the descriptor moved while we were classifying it, the verdict belongs to a socket that is
    // gone, and cutting anyway is the damage.
    struct sockaddr_storage self1;
    socklen_t s1len = sizeof(self1);
    if (getsockname(fd, (struct sockaddr *)&self1, &s1len) != 0
        || s1len != s0len || memcmp(&self1, &self0, s0len) != 0) {
      raced++;
      os_log_error(tf_log(), "fd %{public}d moved while being classified — not cutting it", fd);
      continue;
    }

    if (shutdown(fd, SHUT_RDWR) != 0) continue;
    cut++;

    // Is this still the socket we decided about? The local address outlives our own shutdown; the
    // peer does not. **This last window can only be reported** — the two checks above avoid a cut,
    // this one happens after it, and there is no undoing a `shutdown`.
    int atype = 0;
    socklen_t atlen = sizeof(atype);
    struct sockaddr_storage after;
    socklen_t alen = sizeof(after);
    const char *moved = NULL;
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &atype, &atlen) != 0) moved = "is no longer a socket";
    else if (atype != type) moved = "is a different kind of socket";
    else if (getsockname(fd, (struct sockaddr *)&after, &alen) != 0) moved = "lost the local address we read";
    else if (alen != s0len || memcmp(&after, &self0, s0len) != 0) moved = "is bound somewhere else";
    if (moved != NULL) {
      raced++;
      os_log_error(tf_log(), "fd %{public}d %{public}s under the cut — it was not the socket we checked",
                   fd, moved);
    }
  }
  os_log(tf_log(), "cut %{public}d open connection(s), %{public}d raced", cut, raced);
}

/**
 * Watch the condition file and push on change.
 *
 * Polled rather than watched with a `DISPATCH_SOURCE_TYPE_VNODE`: the interesting transitions are
 * the file being *created* and *deleted*, and a vnode source needs an open descriptor on a file that
 * does not exist yet. Half a second is below what a tester perceives as a delay and costs one
 * `stat` — the same call the hooks already make per connection.
 */
// **Held in a static, not a local.** Dispatch objects are ARC-managed here, so a
// `dispatch_source_t` local is released when the function returns and the timer stops — measured:
// the install line logged, `installed: true` was written, and not one condition change was ever seen
// because the source had already been torn down.
static dispatch_source_t g_watch_timer;

// Defined with the reachability hooks further down, which need the hooked getter in scope. The
// watcher is the only caller and it lives up here, next to the path push it mirrors.
static void tf_push_reachability_update(void);

static void tf_start_watching(void) {
  static BOOL last;
  last = tf_offline();
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                                   dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  g_watch_timer = timer;
  dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 500ull * NSEC_PER_MSEC, 100ull * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{
    BOOL now = tf_offline();
    if (now == last) return;
    last = now;
    os_log(tf_log(), "condition changed: offline=%{public}d — pushing path update", now);
    // **Cut first, then tell — and the order is explicit because it stopped being implicit.**
    // `tf_push_path_update` used to call the app's handlers synchronously, so the cut ran after they
    // had returned. It now hands them to their own queues (#640) and returns immediately, which left
    // these two racing: the scan walked descriptors while a just-notified handler was opening new
    // ones, and the comment here still claimed a sequence that no longer existed.
    //
    // Cutting first is the half that has to be ordered. The scan should act on the connections the
    // app held when it went offline; a handler told first can start a request the scan then sees
    // half-open, which is the descriptor race above with the odds raised deliberately.
    if (now) tf_cut_open_connections();
    // Coming back needs nothing torn down — the app reconnects on its next request.
    tf_push_path_update();
    // The other API an app may be listening on. Same push, same reason.
    tf_push_reachability_update();
  });
  dispatch_resume(timer);
}

// ── proving the hooks took ───────────────────────────────────────────────────

/**
 * Prove the hooks took — **through the API the app uses, never through our own imports**.
 *
 * The first version of this called `connect()` from inside this dylib. That is the one binding a
 * symbol-rebinding hook is guaranteed to catch, so it reported success while real `URLSession`
 * traffic went completely unhooked, and every judgement built on that was wrong. The technique has
 * changed and the trap has not: a probe that exercises our own call sites measures our own call
 * sites.
 *
 * So this drives the stack a real app drives — a real `nw_path_monitor`, which must report
 * `unsatisfied` — with this process forced offline, so the verdict is about the hooks and not about
 * the condition file.
 *
 * **One assertion, deliberately, and the missing one is not an omission.** This used to also require
 * `-1009` from a `URLSession` against a documentation address (RFC 5737 TEST-NET-3), which is what a
 * hooked `connect` yielded. That hook is gone — traffic is the content filter's job now — and no
 * honest in-process replacement exists for it:
 *
 *  - the filter runs on the host, so nothing here can force it on for one process the way
 *    `g_forced_offline` does, and a probe that needed the real toggle would report on the tester's
 *    current state rather than on the hooks
 *  - `getaddrinfo` is still hooked, but its effect cannot be told apart from an unhooked stack
 *    without real DNS traffic: a name that resolves to nothing (`.invalid`, RFC 2606) fails with
 *    `-1003` either way, and a name that does resolve means this self-check phones a real host on
 *    every app launch. The rule this file lives by is *require the specific failure, not any
 *    failure* — for that hook the specific failure is unobservable, so nothing is claimed about it
 *
 * It is still installed, and the install itself is verified: `wanted[]` is all-or-none, so a refused
 * `getaddrinfo` fails the whole install before this runs. What is not verified here is its *effect*.
 * The other half of the feature — that traffic is actually blocked — is verified where it can be, by
 * the agent against the content filter, and reported through `NetworkState`.
 */
static BOOL tf_self_check(void) {
  atomic_store_explicit(&g_forced_offline, true, memory_order_relaxed);

  __block BOOL layer2 = NO;

  nw_path_monitor_t monitor = nw_path_monitor_create();
  // Through the ORIGINAL, for the same reason the handler below bypasses its hook: this monitor is
  // tapflow's, it is cancelled before this function returns, and registering its queue would leave a
  // permanent entry keyed on an address that is about to be freed.
  o_nw_path_monitor_set_queue(monitor, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  dispatch_semaphore_t sawPath = dispatch_semaphore_create(0);
  // **Registered through the original, so this handler is never captured.** It is tapflow's, not the
  // app's: there is no reason to re-fire it later, and capturing it made `tf_push_path_update` call
  // into a monitor this function had already cancelled and a frame it had already left. The hook it
  // bypasses is verified by the install itself (`wanted[]` is all-or-none), and its *effect* —
  // re-firing on a condition change — has nothing to fire against at install time anyway. The
  // assertion below still runs through the hook that matters: `nw_path_get_status`.
  o_nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
    if (!layer2) {
      layer2 = nw_path_get_status(path) == nw_path_status_unsatisfied;
      dispatch_semaphore_signal(sawPath);
    }
  });
  nw_path_monitor_start(monitor);

  dispatch_semaphore_wait(sawPath, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));
  nw_path_monitor_cancel(monitor);

  atomic_store_explicit(&g_forced_offline, false, memory_order_relaxed);

  if (!layer2) os_log_error(tf_log(), "self-check: the path was not reported unsatisfied");
  return layer2;
}

/**
 * Where the verdict goes.
 *
 * The agent runs on the host and cannot see into the process, so the result is written where it can
 * read it — beside the condition file, in the same udid-scoped namespace and for the same reason.
 * It is written on **every** launch, including a failing one: an absent file and a failing one mean
 * different things, and only one of them is "no app has run yet".
 *
 * **Written beside the target and renamed onto it, never written in place.** `fopen(path, "w")`
 * truncates the file the agent may be reading at that instant. It reads this on every `state()`,
 * which the relay triggers on `device:ready`, on a viewer's re-join and after every toggle — so a
 * read landing inside the write is reachable on a completely healthy session, and what it gets is a
 * truncated file. The reader cannot tell that from an answer, so a working app reported
 * `state-unconfirmed` for no reason (#653). `rename(2)` within one filesystem is atomic: a reader
 * sees the whole old file or the whole new one and never a piece of either.
 *
 * The pid is in the temp name because two processes can be writing one udid's verdict — a relaunched
 * app races its own predecessor — and a shared temp path would put them back in each other's way.
 *
 * **Nothing collects a temp file left by a process that died between the `fopen` and the `rename`,**
 * and that is a decision rather than an oversight. The reader opens the exact verdict path, so a
 * stray `…json.<pid>.tmp` is inert; the simulator's `/tmp` is cleaned by macOS; and a collector here
 * would have to guess which of them belongs to a process still running.
 */
static void tf_write_verdict(BOOL ok) {
  char path[PATH_MAX];
  snprintf(path, sizeof(path), "/tmp/tapflow-nethook-%s.json", tf_udid());
  char tmp[PATH_MAX];
  // **Checked, because truncation here reinstates the defect silently.** `tf_udid()` is an
  // environment variable and unbounded by type; at a udid long enough to fill `path`, `snprintf`
  // drops the `.<pid>.tmp` suffix entirely and `tmp` comes back equal to `path`. `fopen(tmp, "w")`
  // is then the in-place truncation this function exists to remove, and the `rename` below succeeds
  // as a no-op, so nothing anywhere reports it. Not reachable through CoreSimulator, whose udid is a
  // 36-character UUID — which is why it would have gone unnoticed.
  int n = snprintf(tmp, sizeof(tmp), "%s.%d.tmp", path, getpid());
  if (n < 0 || n >= (int)sizeof(tmp)) {
    os_log_error(tf_log(), "the verdict path is too long to write beside: %{public}s", path);
    return;
  }

  NSString *bundle = NSBundle.mainBundle.bundleIdentifier ?: @"";
  NSString *json = [NSString stringWithFormat:
      @"{\"installed\":%@,\"bundleId\":\"%@\",\"at\":%.0f}\n",
      ok ? @"true" : @"false", bundle, NSDate.date.timeIntervalSince1970];

  FILE *f = fopen(tmp, "w");
  if (f == NULL) {
    os_log_error(tf_log(), "could not write the verdict to %{public}s", tmp);
    return;
  }
  // **Both are checked, and `fclose` is the one that matters.** A buffered write reports nothing at
  // `fputs`; a full disk or a bad descriptor surfaces when the buffer is flushed. Renaming a short
  // file over a good one would install exactly the torn read this function exists to prevent, with
  // the difference that it would then be permanent.
  int wrote = fputs(json.UTF8String, f);
  if (fclose(f) != 0 || wrote == EOF) {
    os_log_error(tf_log(), "could not finish the verdict at %{public}s", tmp);
    unlink(tmp);
    return;
  }
  if (rename(tmp, path) != 0) {
    os_log_error(tf_log(), "could not put the verdict at %{public}s", path);
    unlink(tmp);
  }
}

// ── reachability: the other API an app asks "am I online?" ───────────────────
//
// **The path set does not cover `SCNetworkReachability`, and that was measured rather than assumed.**
// SystemConfiguration's modern implementation sits on Network.framework but reaches it through the
// `nw_path_create_evaluator_for_*` family rather than `nw_path_get_status`, so the hook that already
// fakes the path for `NWPathMonitor` leaves this API answering truthfully. Alamofire's
// `NetworkReachabilityManager` and the older `Reachability.swift` both read it, so an app built on
// either showed no offline banner at all.
//
// **Five hooks, and none of them is the optional one.**
//
//   `GetFlags`          — what a poll returns.
//   `SetCallback`       — **what a consumer actually reads.** These libraries do not poll: they
//                         register a callback, cache what it last said, and recompute only inside it.
//                         Measured with `netprobe/` before this existed: the getter flipped within one
//                         tick while the listener sat on `reachable` for the whole offline period.
//   `SetDispatchQueue`  — where a replayed callback is allowed to run (#640).
//   `ScheduleWithRunLoop` / `UnscheduleFromRunLoop`
//                       — the same question for a consumer that uses a run loop instead.
//
// **The app's callout is wrapped rather than registered, and the reason is narrower than it looks.**
// An earlier version handed the app's own function straight to `SCNetworkReachabilitySetCallback`,
// and a review predicted that the framework's own callbacks would then arrive unmasked — breaking the
// case a tester reaches first: take a device offline, *then* launch the app, where
// `tf_start_watching` records `last = tf_offline()` at start and so never pushes.
//
// **Measured, that does not happen**: with only the getter patched, SC's registration callback in that
// exact scenario carried `flags=0x0`, not the real ones. The inference — not verified beyond the
// measurement — is that SC computes the flags it delivers through the public getter this file
// patches. So the prediction was wrong and the trampoline fixes no reproduced defect.
//
// It is kept for the weaker reason that survives: **that behaviour is an undocumented internal.**
// Nothing promises SC will keep routing its own notifications through the public entry point, there is
// no CI for any of this (`AGENTS.md`), and the failure if it changes is silent — a consumer told it is
// online while its traffic is dead, which is the one direction this whole feature exists to prevent.
// The trampoline makes the masking happen in one place that cannot stop being on the path. The cost is
// one `dispatch_sync` per callback, and it is recorded here rather than argued as a bug fix.
//
// **All-or-none within this set, and it additionally requires the path set.** The path set is
// interdependent on its own terms; the same holds inside this one. What does not hold is the reverse:
// if these three cannot be patched, an `NWPathMonitor` app still gets a correct banner and an SC app
// is left where it was. That is why they are two sets rather than one — but the dependency that does
// exist runs one way and is enforced below, because these replacements read `tf_blocking`.
static Boolean (*o_SCNetworkReachabilityGetFlags)(SCNetworkReachabilityRef, SCNetworkReachabilityFlags *);
static Boolean (*o_SCNetworkReachabilitySetCallback)(SCNetworkReachabilityRef, SCNetworkReachabilityCallBack,
                                                     SCNetworkReachabilityContext *);
static Boolean (*o_SCNetworkReachabilitySetDispatchQueue)(SCNetworkReachabilityRef, dispatch_queue_t);
static Boolean (*o_SCNetworkReachabilityScheduleWithRunLoop)(SCNetworkReachabilityRef, CFRunLoopRef, CFStringRef);
static Boolean (*o_SCNetworkReachabilityUnscheduleFromRunLoop)(SCNetworkReachabilityRef, CFRunLoopRef, CFStringRef);

/// Gates this set alone. Same technique and reason as `g_hooks_live`: the patch cannot be removed, so
/// a half-installed set is neutered rather than uninstalled.
static atomic_bool g_reach_live = ATOMIC_VAR_INIT(false);

static BOOL tf_reach_live(void) {
  return atomic_load_explicit(&g_reach_live, memory_order_acquire);
}

static BOOL tf_reach_blocking(void) {
  return tf_reach_live() && tf_blocking();
}

/// Registered listeners, keyed by target. Guarded by `g_handler_queue` — the same serial queue the
/// path handlers use, for the same reason.
static NSMutableDictionary *g_reach;

/// Snapshot of one registration, taken under the queue and used outside it.
typedef struct {
  SCNetworkReachabilityRef target;
  SCNetworkReachabilityCallBack callout;
  void *info;
  const void *(*retain)(const void *);
  void (*release)(const void *);
  dispatch_queue_t __unsafe_unretained queue;
  /// `@[@{@"rl": NSValue(CFRunLoopRef), @"mode": NSString}]`. A target may be scheduled on more than
  /// one, which the framework allows, so this is a list rather than a slot.
  NSArray *__unsafe_unretained runloops;
} tf_reach_entry;

/// Reads one entry out of the dictionary. **Caller must already hold `g_handler_queue`.**
static BOOL tf_reach_read(id key, tf_reach_entry *out) {
  NSDictionary *e = g_reach[key];
  if (e == nil || e[@"callout"] == nil) return NO;
  out->target  = (SCNetworkReachabilityRef)[e[@"target"] pointerValue];
  out->callout = (SCNetworkReachabilityCallBack)[e[@"callout"] pointerValue];
  out->info    = [e[@"info"] pointerValue];
  out->retain  = (const void *(*)(const void *))[e[@"retain"] pointerValue];
  out->release = (void (*)(const void *))[e[@"release"] pointerValue];
  out->queue    = e[@"queue"];
  out->runloops = e[@"runloops"];
  return YES;
}

static Boolean tf_SCNetworkReachabilityGetFlags(SCNetworkReachabilityRef target,
                                                SCNetworkReachabilityFlags *flags) {
  Boolean ok = o_SCNetworkReachabilityGetFlags(target, flags);
  // Only the one bit. Every consumer decides "reachable" from it first — Alamofire returns
  // `.notReachable` the moment it is absent — and clearing the rest would be inventing a link state
  // rather than removing one.
  if (ok && flags != NULL && tf_reach_blocking()) *flags &= ~kSCNetworkReachabilityFlagsReachable;
  return ok;
}

/**
 * What the framework calls. Masks, then hands over to the app's own callout.
 *
 * A C function pointer, so it captures nothing and finds the app's callout by the target it is given.
 * Registered with a NULL context: the app's `info` is stored here rather than round-tripped through
 * the framework, which keeps one owner for it.
 */
static void tf_reach_trampoline(SCNetworkReachabilityRef target,
                                SCNetworkReachabilityFlags flags,
                                void *unused) {
  (void)unused;
  if (tf_reach_blocking()) flags &= ~kSCNetworkReachabilityFlagsReachable;
  // **A reference is taken here for the same reason the push takes one.** `info` is a raw pointer,
  // and the unregister path releases it; between reading it and calling the app with it, another
  // thread's `SetCallback(NULL)` can make it the app's freed object. The push was fixed for this and
  // this function was not, one definition away.
  __block SCNetworkReachabilityCallBack callout = NULL;
  __block void *info = NULL;
  __block void (*releaseFn)(const void *) = NULL;
  dispatch_sync(g_handler_queue, ^{
    tf_reach_entry e = {0};
    if (!tf_reach_read(@((uintptr_t)target), &e)) return;
    callout = e.callout;
    info = e.info;
    releaseFn = e.release;
    if (e.retain != NULL && info != NULL) info = (void *)e.retain(info);
  });
  if (callout == NULL) return;
  // **Called outside the queue**, because it is the app's code and may re-register — which would
  // re-enter this serial queue through `dispatch_sync` and deadlock it inside its own callback.
  callout(target, flags, info);
  if (releaseFn != NULL && info != NULL) releaseFn(info);
}

static Boolean tf_SCNetworkReachabilitySetCallback(SCNetworkReachabilityRef target,
                                                   SCNetworkReachabilityCallBack callout,
                                                   SCNetworkReachabilityContext *context) {
  // **Gated, like every other replacement.** Without this a half-installed set still took references
  // on the app's objects — the cost of participating — while `tf_reach_blocking` guaranteed nothing
  // would ever be replayed, which is the risk with the benefit removed. The store that opens this gate
  // runs in the library's constructor, before any app code, so nothing can register in the window it
  // leaves.
  if (!tf_reach_live()) return o_SCNetworkReachabilitySetCallback(target, callout, context);

  // The framework gets the trampoline, never the app's function — see the note on the set above.
  Boolean ok = o_SCNetworkReachabilitySetCallback(target, callout == NULL ? NULL : tf_reach_trampoline,
                                                  NULL);
  // **Only a registration the framework accepted is recorded.** Replaying a callout it refused would
  // deliver an update to a consumer that believes it never subscribed.
  if (!ok || target == NULL) return ok;

  void *info = (context != NULL) ? context->info : NULL;
  const void *(*retain)(const void *) = (context != NULL) ? context->retain : NULL;
  void (*release)(const void *) = (context != NULL) ? context->release : NULL;
  // **Taken only when there is a registration to hold it for.** Reference-counting an `info` and then
  // returning through the unregister path below leaks one reference per call, and
  // `SetCallback(target, NULL, &ctx)` with a populated context is legal.
  if (callout != NULL && retain != NULL && info != NULL) info = (void *)retain(info);

  // **A consumer that passes `info` unretained and then drops its target without unregistering can be
  // replayed through a stale pointer**, and that risk is created here rather than inherited: the
  // `CFRetain` below keeps the target alive past the point where the framework would have destroyed
  // it. Refusing such registrations was considered and rejected — Alamofire passes
  // `Unmanaged.passUnretained(self)` with no retain/release, so refusing would exclude the main
  // consumer this set exists for. What makes it acceptable is that both Alamofire and current
  // `Reachability.swift` call `stopListening()` from `deinit`, which reaches the unregister path here.
  id key = @((uintptr_t)target);
  __block void (*orel)(const void *) = NULL;
  __block void *oinfo = NULL;
  __block SCNetworkReachabilityRef otarget = NULL;
  dispatch_sync(g_handler_queue, ^{
    NSDictionary *old = g_reach[key];
    NSMutableDictionary *e = [old mutableCopy] ?: [NSMutableDictionary dictionary];
    if (old[@"callout"] != nil) {
      // **Handed out, not called here.** These are the consumer's release functions and they run its
      // `dealloc`; a `dealloc` that touches another target would re-enter this serial queue and
      // deadlock. The rule is the same one `tf_push_reachability_update` states.
      orel    = (void (*)(const void *))[old[@"release"] pointerValue];
      oinfo   = [old[@"info"] pointerValue];
      otarget = (SCNetworkReachabilityRef)[old[@"target"] pointerValue];
      // The queue survives the callout being cleared: `SetCallback(NULL)` unregisters the callback,
      // not the schedule, and a consumer that re-registers without touching its queue again would
      // otherwise come back unfireable.
      for (NSString *k in @[@"callout", @"info", @"retain", @"release", @"target"]) [e removeObjectForKey:k];
    }
    if (callout != NULL) {
      CFRetain(target);
      e[@"target"]  = [NSValue valueWithPointer:target];
      e[@"callout"] = [NSValue valueWithPointer:(void *)callout];
      e[@"info"]    = [NSValue valueWithPointer:info];
      e[@"retain"]  = [NSValue valueWithPointer:(void *)retain];
      e[@"release"] = [NSValue valueWithPointer:(void *)release];
    }
    // **An entry with nothing in it is removed rather than kept.** A bare `@{}` is unreachable state
    // that nothing would ever clear.
    g_reach[key] = e.count > 0 ? e : nil;
  });
  if (orel != NULL && oinfo != NULL) orel(oinfo);
  if (otarget != NULL) CFRelease(otarget);
  return ok;
}

static Boolean tf_SCNetworkReachabilitySetDispatchQueue(SCNetworkReachabilityRef target,
                                                        dispatch_queue_t queue) {
  if (!tf_reach_live()) return o_SCNetworkReachabilitySetDispatchQueue(target, queue);
  Boolean ok = o_SCNetworkReachabilitySetDispatchQueue(target, queue);
  if (!ok || target == NULL) return ok;
  // **Recorded even when no callout has been registered yet.** The two calls have no required order
  // and the first draft assumed one: it returned early when there was no entry, so a consumer that
  // set its queue *before* its callback ended up with a registration this file could never re-fire —
  // silently, since the push logs a missing queue as if the consumer had never set one. Alamofire
  // happens to call them the other way round, which is exactly the kind of luck a hook should not
  // depend on.
  id key = @((uintptr_t)target);
  dispatch_sync(g_handler_queue, ^{
    NSMutableDictionary *e = [g_reach[key] mutableCopy] ?: [NSMutableDictionary dictionary];
    if (queue == nil) [e removeObjectForKey:@"queue"];
    else e[@"queue"] = queue;
    g_reach[key] = e.count > 0 ? e : nil;
  });
  return ok;
}

/**
 * Where a run-loop-scheduled callout is allowed to run — the run-loop twin of `SetDispatchQueue`.
 *
 * **An earlier version left this unhooked and said the reason was that we could not know which run
 * loop a callback belonged to. That was simply false**: the API is handed both the run loop and the
 * mode, and passes them straight through. What the claim actually described was a symbol nobody had
 * looked up. It cost a limitation in the user guide before anyone checked.
 *
 * A list rather than a slot, because the framework lets one target be scheduled on several.
 */
static Boolean tf_SCNetworkReachabilityScheduleWithRunLoop(SCNetworkReachabilityRef target,
                                                           CFRunLoopRef runLoop,
                                                           CFStringRef runLoopMode) {
  if (!tf_reach_live()) return o_SCNetworkReachabilityScheduleWithRunLoop(target, runLoop, runLoopMode);
  Boolean ok = o_SCNetworkReachabilityScheduleWithRunLoop(target, runLoop, runLoopMode);
  if (!ok || target == NULL || runLoop == NULL || runLoopMode == NULL) return ok;
  id key = @((uintptr_t)target);
  NSString *mode = (__bridge NSString *)runLoopMode;
  dispatch_sync(g_handler_queue, ^{
    NSMutableDictionary *e = [g_reach[key] mutableCopy] ?: [NSMutableDictionary dictionary];
    NSMutableArray *rls = [e[@"runloops"] mutableCopy] ?: [NSMutableArray array];
    for (NSDictionary *r in rls) {
      if ([r[@"rl"] pointerValue] == (void *)runLoop && [r[@"mode"] isEqualToString:mode]) return;
    }
    // Retained for as long as it is recorded: a run loop belonging to a thread that has since exited
    // would otherwise be a freed object by the time the push reaches it. **That keeps the wake-up from
    // crashing and is not otherwise harmless** — an earlier note here called it that. Holding the
    // `CFRunLoop` alive is also what stops CF's own finalise path from draining the blocks queued on
    // it, so a push aimed at a dead run loop leaks the references its block carries. See the push.
    CFRetain(runLoop);
    [rls addObject:@{ @"rl": [NSValue valueWithPointer:runLoop], @"mode": mode }];
    e[@"runloops"] = rls;
    g_reach[key] = e;
  });
  return ok;
}

static Boolean tf_SCNetworkReachabilityUnscheduleFromRunLoop(SCNetworkReachabilityRef target,
                                                             CFRunLoopRef runLoop,
                                                             CFStringRef runLoopMode) {
  if (!tf_reach_live()) return o_SCNetworkReachabilityUnscheduleFromRunLoop(target, runLoop, runLoopMode);
  Boolean ok = o_SCNetworkReachabilityUnscheduleFromRunLoop(target, runLoop, runLoopMode);
  if (target == NULL || runLoop == NULL || runLoopMode == NULL) return ok;
  // **Recorded whatever the call returned.** A consumer tearing down asks to be unscheduled; if the
  // framework says it was not scheduled, continuing to replay to it is the wrong half to keep.
  id key = @((uintptr_t)target);
  NSString *mode = (__bridge NSString *)runLoopMode;
  __block CFRunLoopRef drop = NULL;
  dispatch_sync(g_handler_queue, ^{
    NSMutableDictionary *e = [g_reach[key] mutableCopy];
    if (e == nil) return;
    NSMutableArray *rls = [e[@"runloops"] mutableCopy];
    for (NSUInteger i = 0; i < rls.count; i++) {
      if ([rls[i][@"rl"] pointerValue] == (void *)runLoop && [rls[i][@"mode"] isEqualToString:mode]) {
        drop = runLoop;
        [rls removeObjectAtIndex:i];
        break;
      }
    }
    if (rls.count > 0) e[@"runloops"] = rls; else [e removeObjectForKey:@"runloops"];
    g_reach[key] = e.count > 0 ? e : nil;
  });
  if (drop != NULL) CFRelease(drop);
  return ok;
}

/**
 * Re-fire every registered reachability callout with what the getter now says.
 *
 * **This covers the change the framework has no reason to report** — the condition file moving. The
 * trampoline covers everything SC itself delivers.
 *
 * Mirrors `tf_push_path_update`, including the two things learned there: the snapshot is taken under
 * the queue and the calls are made outside it, and each callout runs on **its owner's** queue.
 *
 * **And it takes a reference on what it is about to call with**, which the mirror did not. The path
 * version snapshots into an `NSArray`, so the blocks and paths it replays are retained for it; here
 * the target and `info` are raw pointers out of `NSValue`, and an unregister landing between the
 * snapshot and the async call would free both before the app's callout ran. That is reachable on the
 * correct path, not only the careless one: a consumer told it is offline, tearing down the screen it
 * showed, calls `stopListening()` from exactly there.
 *
 * **Both delivery paths, because a consumer chooses one and the choice is not ours.** A dispatch queue
 * and a run loop are the two ways `SCNetworkReachability` can be scheduled; covering only the first
 * was a control that worked for Alamofire and silently did nothing for anything older. A target
 * scheduled on neither is skipped without a log — the framework does not call it either, so there is
 * nothing anomalous to report.
 */
static void tf_push_reachability_update(void) {
  __block NSArray *keys;
  dispatch_sync(g_handler_queue, ^{ keys = [g_reach.allKeys copy]; });

  for (id key in keys) {
    // **Everything the delivery needs is copied out under the lock, collections included.**
    //
    // A first version read them through a struct of `__unsafe_unretained` fields and used them after
    // the lock. The two schedule hooks replace the whole entry dictionary on every call, so the array
    // they hold can be the last reference — and a consumer scheduling or unscheduling while a push was
    // in flight left this iterating a freed `NSArray`. The `dispatch_queue_t` had the same shape.
    __block SCNetworkReachabilityRef target = NULL;
    __block SCNetworkReachabilityCallBack callout = NULL;
    __block void *info = NULL;
    __block const void *(*retainFn)(const void *) = NULL;
    __block void (*releaseFn)(const void *) = NULL;
    __block dispatch_queue_t queue = nil;
    __block NSArray *runloops = nil;
    dispatch_sync(g_handler_queue, ^{
      tf_reach_entry e = {0};
      if (!tf_reach_read(key, &e)) return;
      // Nowhere to deliver: a consumer that registered a callout and scheduled nothing gets no
      // callbacks from the framework either, so replaying to it would be inventing a delivery.
      if (e.queue == nil && e.runloops.count == 0) return;
      queue = e.queue;
      runloops = [e.runloops copy];
      callout = e.callout;
      info = e.info;
      retainFn = e.retain;
      releaseFn = e.release;
      target = e.target;
      // Taken under the lock, so the unregister path cannot run between the read and the retain.
      CFRetain(target);
      if (retainFn != NULL && info != NULL) info = (void *)retainFn(info);
    });
    if (target == NULL) continue;

    SCNetworkReachabilityFlags f = 0;
    // Through the hooked getter, so the replayed value and a poll cannot disagree.
    BOOL got = SCNetworkReachabilityGetFlags(target, &f);

    // **One reference pair per delivery, and they are all taken before any of them is given back.**
    //
    // The version this replaces released the pair inline when there was no dispatch queue and then
    // re-took one inside the run-loop loop. Between those two statements the push held nothing, so an
    // unregister landing there — `stopListening()` from inside the offline callback, which is the
    // sequence this file already names as reachable — dropped the last reference and the retain that
    // followed reached freed memory. Counting first removes the window rather than narrowing it.
    NSUInteger deliveries = runloops.count + (queue != nil ? 1 : 0);
    for (NSUInteger i = 1; i < deliveries; i++) {
      CFRetain(target);
      if (retainFn != NULL && info != NULL) retainFn(info);
    }

    SCNetworkReachabilityRef t = target;
    SCNetworkReachabilityCallBack cb = callout;
    void *ci = info;
    void (*rel)(const void *) = releaseFn;
    if (queue != nil) {
      dispatch_async(queue, ^{
        if (got) cb(t, f, ci);
        if (rel != NULL && ci != NULL) rel(ci);
        CFRelease(t);
      });
    }
    for (NSDictionary *r in runloops) {
      CFRunLoopRef rl = (CFRunLoopRef)[r[@"rl"] pointerValue];
      // **On the run loop and mode its owner named** — the same #640 discipline the queue path
      // follows. `CFRunLoopPerformBlock` only enqueues; without the wake-up a run loop already
      // sleeping does not notice until something else stirs it.
      //
      // **A block that never runs holds its pair forever.** `CFRunLoopPerformBlock` has no
      // cancellation, so a run loop whose thread has exited, or one that never re-enters this mode,
      // keeps one target reference and one `info` reference for the life of the process. That is a
      // leak rather than a crash, and closing it needs a cancellable source rather than a block —
      // see the issue this is filed under.
      CFRunLoopPerformBlock(rl, (__bridge CFStringRef)r[@"mode"], ^{
        if (got) cb(t, f, ci);
        if (rel != NULL && ci != NULL) rel(ci);
        CFRelease(t);
      });
      CFRunLoopWakeUp(rl);
    }
  }
}

// ── install ──────────────────────────────────────────────────────────────────

__attribute__((constructor))
static void tf_install(void) {
  if (!tf_should_activate()) return;   // every other process in the simulator stops here

  g_handlers = [NSMutableArray array];
  g_paths = [NSMutableArray array];
  g_monitors = [NSMutableArray array];
  g_queues = [NSMutableDictionary dictionary];
  g_handler_queue = dispatch_queue_create("io.tapflow.nethook.handlers", DISPATCH_QUEUE_SERIAL);
  g_reach = [NSMutableDictionary dictionary];

  // Every hook, or none — and the rule is narrower now than the set it used to guard, not weaker.
  // Faking the status without capturing the handlers gives an app a lie it is never told (nothing
  // re-fires), and capturing them without faking the status re-delivers `satisfied`. Either half
  // alone is a control that appears to work; the first refusal is reported rather than worked around.
  static const struct { const char *name; void *replacement; void **original; } wanted[] = {
    {"getaddrinfo", tf_getaddrinfo, (void **)&o_getaddrinfo},
    {"nw_path_get_status", tf_nw_path_get_status, (void **)&o_nw_path_get_status},
    {"nw_path_monitor_set_update_handler", tf_nw_path_monitor_set_update_handler,
     (void **)&o_nw_path_monitor_set_update_handler},
    // Part of the all-or-none set: without it the re-fire has nowhere correct to run, and firing
    // anywhere else is the defect #640 closed.
    {"nw_path_monitor_set_queue", tf_nw_path_monitor_set_queue,
     (void **)&o_nw_path_monitor_set_queue},
  };

  BOOL installed = YES;
  for (size_t i = 0; i < sizeof(wanted) / sizeof(wanted[0]); i++) {
    void *target = dlsym(RTLD_DEFAULT, wanted[i].name);
    if (target == NULL) {
      os_log_error(tf_log(), "%{public}s: not found", wanted[i].name);
      installed = NO;
      break;
    }
    tf_hook_error_t err;
    // The slot is handed over rather than assigned from the result: the patch goes live inside this
    // call, so anything written after it returns is written a thread too late.
    if (!tf_hook_install(target, wanted[i].replacement, wanted[i].original, &err)) {
      // Logged after the fact by design — `tf_hook_install` never logs from inside a thread
      // suspension, where `os_log` would deadlock on a lock a stopped thread holds.
      os_log_error(tf_log(), "%{public}s: refused — %{public}s", wanted[i].name, tf_hook_strerror(err));
      installed = NO;
      break;
    }
  }

  // **Not attempted at all when the set above failed.** Every replacement here reads `tf_blocking`,
  // which is gated on `g_hooks_live`, so patching them over a dead layer 2 buys nothing — and it is
  // not free: `SetCallback` takes references on the app's objects, and `CFRetain` on a target outlives
  // the point the framework would have destroyed it. An earlier version left this ungated and logged
  // `reachability hooks installed` one line after writing a verdict of `installed:false`.
  //
  // The set is all-or-none **with itself**, and not with the set above: if these three cannot be
  // patched, an `NWPathMonitor` app still gets a correct banner, while folding them together would let
  // one unpatchable symbol take layer 2 down for apps it already serves.
  static const struct { const char *name; void *replacement; void **original; } reach[] = {
    {"SCNetworkReachabilityGetFlags", tf_SCNetworkReachabilityGetFlags,
     (void **)&o_SCNetworkReachabilityGetFlags},
    // Without this the one above moves a number nobody reads — measured, `netprobe/`.
    {"SCNetworkReachabilitySetCallback", tf_SCNetworkReachabilitySetCallback,
     (void **)&o_SCNetworkReachabilitySetCallback},
    {"SCNetworkReachabilitySetDispatchQueue", tf_SCNetworkReachabilitySetDispatchQueue,
     (void **)&o_SCNetworkReachabilitySetDispatchQueue},
    // The run-loop twin. Not optional either: without it a consumer scheduled that way is registered
    // and never replayed, which is a control that works for some apps and silently not for others.
    {"SCNetworkReachabilityScheduleWithRunLoop", tf_SCNetworkReachabilityScheduleWithRunLoop,
     (void **)&o_SCNetworkReachabilityScheduleWithRunLoop},
    {"SCNetworkReachabilityUnscheduleFromRunLoop", tf_SCNetworkReachabilityUnscheduleFromRunLoop,
     (void **)&o_SCNetworkReachabilityUnscheduleFromRunLoop},
  };
  BOOL reachInstalled = NO;
  if (installed) {
  reachInstalled = YES;
  for (size_t i = 0; i < sizeof(reach) / sizeof(reach[0]); i++) {
    void *target = dlsym(RTLD_DEFAULT, reach[i].name);
    if (target == NULL) {
      os_log_error(tf_log(), "%{public}s: not found", reach[i].name);
      reachInstalled = NO;
      break;
    }
    tf_hook_error_t err;
    if (!tf_hook_install(target, reach[i].replacement, reach[i].original, &err)) {
      os_log_error(tf_log(), "%{public}s: refused — %{public}s", reach[i].name, tf_hook_strerror(err));
      reachInstalled = NO;
      break;
    }
  }
  }
  // **The store runs in the constructor, before any app code**, so no consumer can register in the
  // window between the patches going in and the gate opening. That is what lets the capture hooks
  // refuse outright while the gate is shut instead of having to record and discard.
  if (reachInstalled) atomic_store_explicit(&g_reach_live, true, memory_order_release);
  os_log(tf_log(), "reachability hooks %{public}s", reachInstalled ? "installed" :
         (installed ? "NOT installed" : "not attempted — layer 2 is not live"));

  // **The verdict is the target app's answer, and now only the target app can write it** — because
  // only the target app activates at all (#635).
  //
  // That was not always true, and the file is keyed by udid alone, so whichever process wrote last
  // used to win: a web view starting anywhere could report `installed:true` while the app under test
  // had never run, and the control then claimed hooks over an app that had none — the exact sign-off
  // this file's preamble calls the worst failure available. The gate is what closes it; the scoping
  // here is the second lock and stays, because a future reason to widen activation must not silently
  // reopen the first one.
  // **Before the self-check, and that order is required rather than tidy.** The check drives
  // `g_forced_offline` through the hooked `nw_path_get_status`, which reads the gate below — so a
  // store placed after it would make the check assert against neutered replacements and fail every
  // time.
  if (installed) atomic_store_explicit(&g_hooks_live, true, memory_order_release);

  // Only the target app reaches here, so there is one answer rather than two: the hooks went in and
  // the check drove them, or they did not.
  BOOL ok = installed && tf_self_check();
  tf_write_verdict(ok);
  os_log(tf_log(), "hooks %{public}s in %{public}@",
         ok ? "verified" : "DID NOT INSTALL", NSBundle.mainBundle.bundleIdentifier);

  // **Gated on the self-check, not merely on the hooks going in**, so a 3s timeout leaves the hooks
  // live and the watcher never started. Deliberate: the same failure makes the agent report
  // `hooks-not-installed`, so the control is drawn as unusable and layer 2 genuinely is. Watching
  // while reporting failure would be the half-state this file's preamble is about, pointed the other
  // way.
  if (ok) tf_start_watching();
}
