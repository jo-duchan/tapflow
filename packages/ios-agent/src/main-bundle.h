#ifndef TAPFLOW_MAIN_BUNDLE_H
#define TAPFLOW_MAIN_BUNDLE_H

#include <stddef.h>

/**
 * The main bundle's identifier as UTF-8 into `out`, for the two gates (`network-hook.m`, `app-observer.m`) that run
 * in a constructor in every process of the simulator. Returns 1 with `out` filled, or 0: not an app
 * (`tf_exe_in_app_bundle_decision`), no identifier, an identifier that does not fit, or one carrying an embedded NUL
 * (which would compare equal byte-wise to a bundle id nobody named).
 *
 * **No Objective-C**, so a daemon that aborts on an autorelease with no pool is never reached by one. A process that
 * is not an app stops at its executable's path; an app's identifier is read through CoreFoundation, which returns it
 * under the Get rule and autoreleases nothing.
 */
int tf_main_bundle_id(char *out, size_t n);

#endif /* TAPFLOW_MAIN_BUNDLE_H */
