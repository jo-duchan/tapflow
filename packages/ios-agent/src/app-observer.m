// The app observer: the soft keyboard and the focused field, read from inside the app under test, so a person's
// Capture my steps no longer needs an XCUITest runner attached to their app (an attached runner made a busy SwiftUI app
// visibly lag, with no query running). Linked into libtapflow-nethook.dylib, which `DYLD_INSERT_LIBRARIES` loads into
// every process of the simulator; the gate below keeps it to the one app `TAPFLOW_OBSERVE_BUNDLE` names.
//
// It answers only when asked, once per request, in the XCUITest runner's own shapes (`/keyboard`, `/field`), so the
// agent parses both the same way (`toKeyboardState`, `toFocusedField`). The protocol and its rules are in
// packages/ios-agent/AGENTS.md, "App observer".
//
// **No UIKit or CoreGraphics at link time.** Every process loads this, daemons included, and the gate runs only after
// load: UIKit is reached at run time, after the gate, by class name, selector and the string values of its constants.
#import <Foundation/Foundation.h>
#import <fcntl.h>
#import <time.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <stdlib.h>
#import <string.h>
#import <sys/stat.h>
#import <unistd.h>

typedef struct { double x, y, w, h; } TFORect;

static NSString *g_dir;          // /tmp/tapflow-observe-<udid>, 0700
static NSString *g_bundle;
static TFORect g_keyboard;       // the last end frame, screen points
static BOOL g_have_keyboard;
static BOOL g_keyboard_down = YES;
static BOOL g_coming_up = YES;   // launched or entering the foreground, not yet active

// ── run-time UIKit ───────────────────────────────────────────────────────────

static id tfo_send(id target, const char *sel) {
  SEL s = sel_registerName(sel);
  return [target respondsToSelector:s] ? ((id (*)(id, SEL))objc_msgSend)(target, s) : nil;
}

static BOOL tfo_bool(id target, const char *sel) {
  SEL s = sel_registerName(sel);
  return [target respondsToSelector:s] ? ((BOOL (*)(id, SEL))objc_msgSend)(target, s) : NO;
}

static NSInteger tfo_int(id target, const char *sel) {
  SEL s = sel_registerName(sel);
  return [target respondsToSelector:s] ? ((NSInteger (*)(id, SEL))objc_msgSend)(target, s) : 0;
}

// A CGRect is four doubles on arm64; read and return it without naming CGRect.
static TFORect tfo_rect(id target, const char *sel) {
  SEL s = sel_registerName(sel);
  if (![target respondsToSelector:s]) return (TFORect){0, 0, 0, 0};
  return ((TFORect (*)(id, SEL))objc_msgSend)(target, s);
}

static TFORect tfo_rect_of(NSValue *v) {
  TFORect r = {0, 0, 0, 0};
  NSUInteger size = 0;
  if (v) NSGetSizeAndAlignment(v.objCType, &size, NULL);
  if (size == sizeof r) [v getValue:&r size:sizeof r];
  return r;
}

static id tfo_app(void) { return tfo_send((id)NSClassFromString(@"UIApplication"), "sharedApplication"); }

static id tfo_key_window(void) {
  Class sceneClass = NSClassFromString(@"UIWindowScene");
  for (id scene in tfo_send(tfo_app(), "connectedScenes")) {
    if (![scene isKindOfClass:sceneClass]) continue;
    for (id w in tfo_send(scene, "windows")) if (tfo_bool(w, "isKeyWindow")) return w;
  }
  return nil;
}

// The first responder, found the way UIKit finds it: an action sent to nil goes to it. `-[UIWindow firstResponder]`
// named a SwiftUI field while a UIKit one had focus on iOS 27 (measured with the probe app).
static __weak id g_responder;
static void tfo_capture(id self, SEL _cmd, id sender) { g_responder = self; }
static id tfo_first_responder(void) {
  static dispatch_once_t once;
  SEL sel = sel_registerName("tapflow_captureFirstResponder:");
  dispatch_once(&once, ^{ class_addMethod(NSClassFromString(@"UIResponder"), sel, (IMP)tfo_capture, "v@:@"); });
  g_responder = nil;
  SEL send = sel_registerName("sendAction:to:from:forEvent:");
  id app = tfo_app();
  if ([app respondsToSelector:send]) ((BOOL (*)(id, SEL, SEL, id, id, id))objc_msgSend)(app, send, sel, nil, nil, nil);
  return g_responder;
}

static BOOL tfo_active(void) { return tfo_int(tfo_app(), "applicationState") == 0; }  // UIApplicationStateActive

// ── the answer, in the runner's shapes ───────────────────────────────────────

/**
 * The runner's `/keyboard`: `shown` true with `rect` (normalised to the key window, its top clipped to the window and
 * its height running to the window's bottom) or false, the interface orientation, and the app's state
 * (`applicationState`), from which the agent judges whether the app is in front (`AppObserver.keyboardOf`). Shown only when the end frame overlaps the window by more
 * than a point each way (EarlGrey's rule), so an input accessory alone (hardware keyboard) or a frame parked below the
 * screen is not a keyboard.
 */
static NSDictionary *tfo_keyboard(id window) {
  NSNumber *orientation = @(tfo_int(tfo_send(window, "windowScene"), "interfaceOrientation"));
  // The app's state rides along: an app keeps running for a while after it leaves the foreground (measured on iOS 27:
  // answering 3 s after Home, after its own DidEnterBackground), so being able to answer does not mean being in front.
  // The agent reads background as the runner's "not in front", and an inactive app's keyboard as unknown when it is
  // up — Home was just pressed, or an alert sits over it — and as itself when it is down (a permission alert's tap).
  NSNumber *state = @(tfo_int(tfo_app(), "applicationState"));
  // No key window (a scene going away): nothing to say where the keyboard is. Without `shown` the agent reads unknown;
  // "down" would turn a touch on the home screen into an app tap.
  if (!window) return @{ @"orientation": orientation, @"state": state };
  TFORect w = tfo_rect(window, "frame");
  if (g_keyboard_down || !g_have_keyboard || w.w <= 0 || w.h <= 0) return @{ @"shown": @NO, @"orientation": orientation, @"state": state };
  TFORect k = g_keyboard;
  double ox = fmax(k.x, w.x), oy = fmax(k.y, w.y);
  double ow = fmin(k.x + k.w, w.x + w.w) - ox, oh = fmin(k.y + k.h, w.y + w.h) - oy;
  if (ow <= 1 || oh <= 1) return @{ @"shown": @NO, @"orientation": orientation, @"state": state };
  return @{ @"shown": @YES, @"orientation": orientation, @"state": state, @"rect": @{
    @"x": @((k.x - w.x) / w.w), @"y": @((oy - w.y) / w.h), @"width": @(k.w / w.w), @"height": @((w.y + w.h - oy) / w.h),
  } };
}

/**
 * The runner's `/field`: the focused field's identifier, placeholder, frame (points, in the window: the runner's
 * screen points for a full-screen window, which an iPhone app's always is; an iPad split view would differ), `type`, and its
 * value when it is not secure; or `{reason}`. Secure is believed only from UIKit's own text classes (SwiftUI's and React
 * Native's fields are subclasses); any other responder — a WKWebView, whose field lives in another process, Flutter, a
 * custom UITextInput — answers `reason: secure`, which flow-runner treats as a secret. An app that is not active takes
 * no typing, so what is typed then goes elsewhere (a system sign-in alert's password field among them): `secure` too.
 */
static NSDictionary *tfo_field(id window, NSDictionary *keyboard) {
  if (!tfo_active()) return @{ @"reason": @"secure", @"keyboard": keyboard };
  id r = tfo_first_responder();
  if (r == nil) return @{ @"reason": @"no-focus", @"keyboard": keyboard };
  BOOL text = [r isKindOfClass:NSClassFromString(@"UITextField")] || [r isKindOfClass:NSClassFromString(@"UITextView")];
  if (!text) return @{ @"reason": @"secure", @"keyboard": keyboard };
  BOOL secure = tfo_bool(r, "isSecureTextEntry");
  NSString *ident = tfo_send(r, "accessibilityIdentifier");
  NSString *placeholder = [r isKindOfClass:NSClassFromString(@"UITextField")] ? tfo_send(r, "placeholder") : nil;
  TFORect f = {0, 0, 0, 0};
  SEL convert = sel_registerName("convertRect:toView:");
  if ([r respondsToSelector:convert]) {
    TFORect bounds = tfo_rect(r, "bounds");
    f = ((TFORect (*)(id, SEL, TFORect, id))objc_msgSend)(r, convert, bounds, window);
  }
  NSMutableDictionary *out = [@{
    @"identifier": [ident isKindOfClass:NSString.class] ? ident : @"",
    @"placeholder": [placeholder isKindOfClass:NSString.class] ? placeholder : @"",
    @"frame": @{ @"x": @(f.x), @"y": @(f.y), @"width": @(f.w), @"height": @(f.h) },
    @"type": secure ? @"secure" : @"text",
    @"keyboard": keyboard,
  } mutableCopy];
  if (secure) { out[@"reason"] = @"secure"; return out; }
  NSString *value = tfo_send(r, "text");
  out[@"value"] = [value isKindOfClass:NSString.class] ? value : @"";
  return out;
}

/** One answer to request `nonce`, written 0600 under the 0700 directory and renamed into place whole. */
static void tfo_answer(uint64_t nonce) {
  id window = tfo_key_window();
  NSDictionary *keyboard = tfo_keyboard(window);
  NSDictionary *body = @{
    @"nonce": [NSString stringWithFormat:@"%llu", nonce], @"bundle": g_bundle, @"pid": @(getpid()),
    @"keyboard": keyboard, @"field": tfo_field(window, keyboard),
  };
  NSData *json = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
  if (!json) return;
  NSString *path = [g_dir stringByAppendingFormat:@"/%llu.json", nonce];
  NSString *tmp = [path stringByAppendingString:@".tmp"];
  int fd = open(tmp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
  if (fd < 0) return;
  BOOL whole = write(fd, json.bytes, json.length) == (ssize_t)json.length;
  close(fd);
  if (whole) rename(tmp.fileSystemRepresentation, path.fileSystemRepresentation);
  else unlink(tmp.fileSystemRepresentation);
}

/**
 * The app left the foreground (the home screen, another app): a marker the agent reads when no answer comes, since a
 * suspended app cannot answer. `DidEnterBackground`, never resign-active, which a permission alert, Control Center and
 * the app switcher also send (measured on iOS 26.5 and 27.0).
 */
static void tfo_mark_background(BOOL away) {
  NSString *marker = [g_dir stringByAppendingPathComponent:@"background"];
  if (!away) { unlink(marker.fileSystemRepresentation); return; }
  NSData *body = [g_bundle dataUsingEncoding:NSUTF8StringEncoding];
  int fd = open(marker.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
  if (fd < 0) return;
  (void)write(fd, body.bytes, body.length);
  close(fd);
}

// ── gate and setup ───────────────────────────────────────────────────────────

/**
 * The app `TAPFLOW_OBSERVE_BUNDLE` names, on a simulator with a udid, and nothing else. The same refusals as
 * network-hook.m's gate: a bundle id carrying an embedded NUL would compare equal byte-wise to one nobody named, and
 * a path that does not fit is refused rather than truncated.
 */
static BOOL tfo_should_activate(const char *udid) {
  const char *target = getenv("TAPFLOW_OBSERVE_BUNDLE");
  if (udid == NULL || *udid == '\0' || target == NULL || *target == '\0') return NO;
  if (strlen(udid) > 64) return NO;
  NSString *me = NSBundle.mainBundle.bundleIdentifier;
  const char *bytes = me.UTF8String;
  if (bytes == NULL || strlen(bytes) != [me lengthOfBytesUsingEncoding:NSUTF8StringEncoding]) return NO;
  return strcmp(bytes, target) == 0;
}

__attribute__((constructor))
static void tfo_install(void) {
  const char *udid = getenv("SIMULATOR_UDID");
  if (!tfo_should_activate(udid)) return;   // every other process in the simulator stops here
  g_bundle = NSBundle.mainBundle.bundleIdentifier;
  g_dir = [NSString stringWithFormat:@"/tmp/tapflow-observe-%s", udid];
  // The agent makes the directory 0700 before it asks; one that is missing, or a symlink, gets no answers.
  struct stat st;
  if (lstat(g_dir.fileSystemRepresentation, &st) != 0 || !S_ISDIR(st.st_mode)) {
    if (mkdir(g_dir.fileSystemRepresentation, 0700) != 0) return;
  }
  // A new process is in front: a marker a previous one left (killed while in the background) is not about it.
  tfo_mark_background(NO);
  NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
  NSOperationQueue *main = NSOperationQueue.mainQueue;
  // The UIKit constants' string values: naming the constants would be a UIKit data symbol bound at load.
  void (^frame)(NSNotification *) = ^(NSNotification *n) {
    NSValue *end = n.userInfo[@"UIKeyboardFrameEndUserInfoKey"];
    if (end) { g_keyboard = tfo_rect_of(end); g_have_keyboard = YES; }
  };
  for (NSString *name in @[@"UIKeyboardWillChangeFrameNotification", @"UIKeyboardWillShowNotification", @"UIKeyboardDidShowNotification"]) {
    [nc addObserverForName:name object:nil queue:main usingBlock:^(NSNotification *n) { frame(n); g_keyboard_down = NO; }];
  }
  for (NSString *name in @[@"UIKeyboardWillHideNotification", @"UIKeyboardDidHideNotification"]) {
    [nc addObserverForName:name object:nil queue:main usingBlock:^(NSNotification *n) { frame(n); g_keyboard_down = YES; }];
  }
  [nc addObserverForName:@"UIApplicationDidEnterBackgroundNotification" object:nil queue:main
              usingBlock:^(NSNotification *n) { tfo_mark_background(YES); }];
  [nc addObserverForName:@"UIApplicationWillEnterForegroundNotification" object:nil queue:main
              usingBlock:^(NSNotification *n) { tfo_mark_background(NO); g_coming_up = YES; }];
  [nc addObserverForName:@"UIApplicationDidBecomeActiveNotification" object:nil queue:main
              usingBlock:^(NSNotification *n) { g_coming_up = NO; }];

  // A request: the agent writes a nonce and the bundle it asks about, on two lines, to `request` in the directory, by
  // rename, and the observer of that bundle, watching the directory, answers it once. Every app observed since the boot
  // watches here, and one sent behind another can still answer for a few seconds (iOS 27.0): it would answer first, or
  // over the right answer. The host's /tmp is the simulator's, so this costs no process on either side; asking
  // through a Darwin notification needed a `simctl spawn` per request, 441 ms measured. Answered on the main queue,
  // where UIKit is. An app still coming up (launched, or opened from its icon) is given until it is active, up to a
  // deadline, so the first tap's read is not lost to the transition; an app made inactive by an alert answers at once.
  int dirfd = open(g_dir.fileSystemRepresentation, O_EVTONLY);
  if (dirfd < 0) return;
  dispatch_source_t watch = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)dirfd, DISPATCH_VNODE_WRITE,
                                                   dispatch_get_main_queue());
  static uint64_t last = 0;
  NSString *request = [g_dir stringByAppendingPathComponent:@"request"];
  void (^handle)(void) = ^{
    NSString *text = [NSString stringWithContentsOfFile:request encoding:NSUTF8StringEncoding error:nil];
    NSArray<NSString *> *lines = [text componentsSeparatedByString:@"\n"];
    if (lines.count != 2 || ![lines[1] isEqualToString:g_bundle]) return;
    uint64_t nonce = strtoull(lines[0].UTF8String ?: "0", NULL, 10);
    if (nonce == 0 || nonce == last) return;
    last = nonce;
    __block int waited = 0;
    __block void (^answer)(void);
    answer = ^{
      if (g_coming_up && !tfo_active() && waited < 20) {   // 20 × 50 ms
        waited++;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), answer);
        return;
      }
      tfo_answer(nonce);
      answer = nil;
    };
    answer();
  };
  dispatch_source_set_event_handler(watch, handle);
  dispatch_source_set_cancel_handler(watch, ^{ close(dirfd); });
  dispatch_resume(watch);
  static dispatch_source_t g_watch;   // held for the life of the process
  g_watch = watch;
  // A request written before this process was watching (the agent asks right after a launch returns) sends no event:
  // answered now, if it is fresh — one the agent has given up on is left alone, and its stale answer would only sit on
  // disk.
  struct stat rq;
  if (stat(request.fileSystemRepresentation, &rq) == 0 && time(NULL) - rq.st_mtimespec.tv_sec <= 2) {
    dispatch_async(dispatch_get_main_queue(), handle);
  }
}
