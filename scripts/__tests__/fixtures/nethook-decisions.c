/*
 * A harness around `packages/ios-agent/src/hook-decisions.h`, driven one call per run.
 *
 * **It answers, it does not judge.** Every expectation lives in
 * `scripts/__tests__/nethookDecisions.test.mjs`; this prints what the function returned and exits.
 * Putting the assertions in C would move them out of reach of the mutation runner's report and make
 * a failure one opaque exit code instead of a named case.
 *
 * `--null` is how the caller says NULL, because an empty argv string is a case of its own — `getenv`
 * returns `""` for an exported-but-blank variable, and the decision has to tell the two apart.
 *
 *   nethook-decisions loopback4 <ip>
 *   nethook-decisions loopback6 <ip>
 *   nethook-decisions loopback-family <af_number>
 *   nethook-decisions blocking <hooksLive> <forced> <conditionFilePresent>
 *   nethook-decisions activate <udid|--null> <target|--null> <bundleId|--null>
 *   nethook-decisions condpath <udid> [buffer size]
 */
#include "hook-decisions.h"

#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/un.h>

static const char *arg(const char *v) { return strcmp(v, "--null") == 0 ? NULL : v; }

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s <case> ...\n", argv[0]); return 2; }
  const char *what = argv[1];

  if (strcmp(what, "loopback4") == 0 && argc == 3) {
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    if (inet_pton(AF_INET, argv[2], &a.sin_addr) != 1) { fprintf(stderr, "bad v4: %s\n", argv[2]); return 2; }
    printf("%d\n", tf_peer_is_loopback_decision((const struct sockaddr *)&a));
    return 0;
  }
  if (strcmp(what, "loopback6") == 0 && argc == 3) {
    struct sockaddr_in6 a;
    memset(&a, 0, sizeof a);
    a.sin6_family = AF_INET6;
    if (inet_pton(AF_INET6, argv[2], &a.sin6_addr) != 1) { fprintf(stderr, "bad v6: %s\n", argv[2]); return 2; }
    printf("%d\n", tf_peer_is_loopback_decision((const struct sockaddr *)&a));
    return 0;
  }
  /* A socket that is neither v4 nor v6 — a unix domain peer, which `getpeername` can return for a
   * descriptor the scan reached. It must not read as loopback and must not read as external either;
   * the caller's contract is only that it is not cut. */
  if (strcmp(what, "loopback-family") == 0 && (argc == 3 || argc == 4)) {
    /* Shaped as a `sockaddr_in6` so an optional payload lands exactly where the v6 branch would read
     * it. An all-zero body answers the same with or without the family guard, which is how a test
     * built only from those reads as covering a branch it cannot see. */
    struct sockaddr_in6 a;
    memset(&a, 0, sizeof a);
    a.sin6_family = (sa_family_t)atoi(argv[2]);
    if (argc == 4 && inet_pton(AF_INET6, argv[3], &a.sin6_addr) != 1) {
      fprintf(stderr, "bad v6 payload: %s\n", argv[3]);
      return 2;
    }
    printf("%d\n", tf_peer_is_loopback_decision((const struct sockaddr *)&a));
    return 0;
  }
  if (strcmp(what, "blocking") == 0 && argc == 5) {
    printf("%d\n", tf_blocking_decision(atoi(argv[2]), atoi(argv[3]), atoi(argv[4])));
    return 0;
  }
  if (strcmp(what, "activate") == 0 && argc == 5) {
    printf("%d\n", tf_should_activate_decision(arg(argv[2]), arg(argv[3]), arg(argv[4])));
    return 0;
  }
  if (strcmp(what, "condpath") == 0 && (argc == 3 || argc == 4)) {
    size_t n = argc == 4 ? (size_t)atoi(argv[3]) : 256;
    char *buf = calloc(n ? n : 1, 1);
    int wrote = tf_condition_path_decision(buf, n, argv[2]);
    /* Both halves: what landed in the buffer, and what `snprintf` says it wanted. A truncated path
     * is silent otherwise, and a silently truncated condition path is a device that can never be
     * taken offline. */
    printf("%s\t%d\n", buf, wrote);
    free(buf);
    return 0;
  }
  if (strcmp(what, "fdscan") == 0 && argc == 4) {
    int capped = -1;
    int max = tf_fd_scan_bound(atoi(argv[2]), strtoull(argv[3], NULL, 10), &capped);
    /* Both halves: the bound, and whether it says it trimmed. A cap nothing reports is
     * indistinguishable from a process with nothing left to cut. */
    printf("%d\t%d\n", max, capped);
    return 0;
  }
  if (strcmp(what, "inapp") == 0 && argc == 3) {
    printf("%d\n", tf_exe_in_app_bundle_decision(arg(argv[2])));
    return 0;
  }
  fprintf(stderr, "unknown case: %s (argc %d)\n", what, argc);
  return 2;
}
