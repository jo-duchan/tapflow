// The main bundle's identifier with no Objective-C, for the gates every process of the simulator runs before `main`.
// Why it matters is in `hook-decisions.h`, beside `tf_exe_in_app_bundle_decision`.
#include "main-bundle.h"

#include <CoreFoundation/CoreFoundation.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <string.h>

#include "hook-decisions.h"

int tf_main_bundle_id(char *out, size_t n) {
  if (out == NULL || n < 2) return 0;
  char exe[PATH_MAX];
  uint32_t size = sizeof exe;
  // A path longer than the buffer is refused rather than read cut: a cut path could end in `.app/x` when it does not.
  if (_NSGetExecutablePath(exe, &size) != 0) return 0;
  if (!tf_exe_in_app_bundle_decision(exe)) return 0;

  CFBundleRef main = CFBundleGetMainBundle();
  if (main == NULL) return 0;
  CFStringRef ident = CFBundleGetIdentifier(main);
  if (ident == NULL) return 0;
  CFIndex length = CFStringGetLength(ident);
  CFIndex used = 0;
  CFIndex converted = CFStringGetBytes(ident, CFRangeMake(0, length), kCFStringEncodingUTF8, 0, false,
                                       (UInt8 *)out, (CFIndex)(n - 1), &used);
  if (converted != length) return 0;   // did not fit: a prefix of an identifier is not the identifier
  out[used] = '\0';
  if (strlen(out) != (size_t)used) return 0;   // an embedded NUL
  return 1;
}
