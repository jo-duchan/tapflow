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
#import <dlfcn.h>
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

/** `json` at `path`, written 0600 under the 0700 directory and renamed into place whole. */
static void tfo_write_data(NSString *path, NSData *json) {
  NSString *tmp = [path stringByAppendingString:@".tmp"];
  int fd = open(tmp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
  if (fd < 0) return;
  BOOL whole = write(fd, json.bytes, json.length) == (ssize_t)json.length;
  close(fd);
  if (whole) rename(tmp.fileSystemRepresentation, path.fileSystemRepresentation);
  else unlink(tmp.fileSystemRepresentation);
}

/** `body` as JSON at `path`. */
static void tfo_write(NSString *path, NSDictionary *body) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
  if (json) tfo_write_data(path, json);
}

/** One answer to request `nonce`. */
static void tfo_answer(uint64_t nonce) {
  id window = tfo_key_window();
  NSDictionary *keyboard = tfo_keyboard(window);
  NSDictionary *body = @{
    @"nonce": [NSString stringWithFormat:@"%llu", nonce], @"bundle": g_bundle, @"pid": @(getpid()),
    @"keyboard": keyboard, @"field": tfo_field(window, keyboard),
  };
  tfo_write([g_dir stringByAppendingFormat:@"/%llu.json", nonce], body);
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

// ── touches: what each touch-down hit (record-time observation) ─────────────

/*
 * While the agent records a person (a `touches` file in the directory), each touch-down is written as
 * `touch-<seq>.json`: where it landed, whether the list under it was still moving, and the accessibility element it hit
 * with its nearest button. The agent pairs it with the input it sent and gives it to the relay's capture. Measured on
 * iOS 26.5 (P0 of the record-time observation plan): with app accessibility on, SwiftUI, UIKit and React Native name
 * the element; a tap on a gliding list reads `isDecelerating`, one on the bounce at its end only `_isBouncing`.
 *
 * Nothing it writes is a value: a text field is named by its identifier only (its label can be what was typed), and a
 * touch on the keyboard, a web view or Flutter is written as the surface it landed on and nothing more.
 */
typedef struct { double x, y; } TFOPoint;
static IMP g_send_event;
static uint64_t g_touch_seq;

static BOOL tfo_touches_on(void) {
  struct stat st;
  return lstat([g_dir stringByAppendingPathComponent:@"touches"].fileSystemRepresentation, &st) == 0 && S_ISREG(st.st_mode);
}

static double tfo_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

// ── acted: whether the app acted on a touch (P2a) ────────────────────────────

/*
 * Each touch-down's report is followed by a verdict, `touch-<seq>-end.json`: whether the app acted on the touch — a
 * control it listens to fired, an action was sent, a list selected a row, or a gesture recogniser of the app's reached
 * Ended — from the down until `TFO_ACT_GRACE_MS` after the lift. Measured on iOS 26.5 (the plan's "P2a measured"):
 * every such signal comes within 4 ms of the lift, except a single tap waiting for a double tap to fail, at 352 ms.
 *
 * `acted` is left out — unknown, never "no" — whenever "nothing fired" would not mean the app did nothing: a touch on a
 * `surface`, a drag (a pan began), a cancelled touch, a view on the responder chain that handles touches in the app's
 * own code, React Native's touch handler (it recognises every touch), a recogniser on the window that is not one of
 * UIKit's every-touch ones (it may be the app's or UIKit's), a verdict closed late on a busy main queue, an
 * app leaving the foreground, or a private method below that this iOS does not have.
 *
 * Every signal goes to every report still open: two touches under a second apart can each be credited with the
 * other's action, which errs to "acted" — a tap kept, never one dropped. Two fingers lifted far apart (not something
 * the agent sends) would close the first finger's report early; no path reaches that today.
 */
#define TFO_ACT_GRACE_MS 1000   // 352 ms measured for a double tap's single, with room for a triple and a busy queue
#define TFO_ACT_LATE_MS 150     // a close this late may have run before a signal the app had queued
#define TFO_OPEN_MAX 4
#define TFO_OPEN_LIFE_MS 10000

typedef struct {
  uint64_t seq;
  double at;            // the down report's `at`: with the seq, what names this touch to the agent
  uintptr_t touch;      // the UITouch, as an address only: compared, never messaged
  BOOL up, acted, unknown, panned;
  uint64_t heldBy;      // a later touch iOS counts as this one's repeat (a double tap): closed with it
} TFOOpen;
static TFOOpen g_open[TFO_OPEN_MAX];
static int g_open_n;
static BOOL g_hooks_on, g_hooks_whole;

static void tfo_close_seq(uint64_t seq, BOOL unknown);

static void tfo_close_at(int i, BOOL unknown) {
  TFOOpen o = g_open[i];
  g_open[i] = g_open[--g_open_n];
  NSMutableDictionary *out = [@{ @"seq": @(o.seq), @"at": @(o.at), @"bundle": g_bundle } mutableCopy];
  if (!unknown && !o.unknown && !o.panned && g_hooks_whole) out[@"acted"] = @(o.acted);
  NSString *path = [g_dir stringByAppendingFormat:@"/touch-%llu-end.json", o.seq];
  NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
  if (json) dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ if (tfo_touches_on()) tfo_write_data(path, json); });
  // A double tap's first touch waited for its second: it closes with it, the second's action counted for both.
  for (int k = 0; k < g_open_n; k++) {
    if (g_open[k].heldBy == o.seq) { if (o.acted) g_open[k].acted = YES; tfo_close_seq(g_open[k].seq, unknown); k = -1; }
  }
}

static void tfo_close_seq(uint64_t seq, BOOL unknown) {
  for (int i = 0; i < g_open_n; i++) if (g_open[i].seq == seq) { tfo_close_at(i, unknown); return; }
}

static int tfo_open_index(uint64_t seq) {
  for (int i = 0; i < g_open_n; i++) if (g_open[i].seq == seq) return i;
  return -1;
}

static void tfo_mark_all(BOOL acted, BOOL unknown) {
  for (int i = 0; i < g_open_n; i++) { if (acted) g_open[i].acted = YES; if (unknown) g_open[i].unknown = YES; }
}

/** A new touch-down: older reports past their life are closed unknown, and the oldest gives way when all are taken. */
static void tfo_open(uint64_t seq, double at, uintptr_t touch, NSInteger tapCount) {
  // Rescanned from the end after each close: a close takes the touches held for it too, from anywhere in the array.
  for (int i = g_open_n - 1; i >= 0; i--) if (at - g_open[i].at > TFO_OPEN_LIFE_MS) { tfo_close_at(i, YES); i = g_open_n; }
  if (g_open_n == TFO_OPEN_MAX) {
    int oldest = 0;
    for (int i = 1; i < g_open_n; i++) if (g_open[i].at < g_open[oldest].at) oldest = i;
    tfo_close_at(oldest, YES);
  }
  // iOS counts this touch a repeat of the last (a double tap): the touches before it that already lifted wait for it,
  // since a double-tap recogniser acts only on the second and the first would otherwise close having seen nothing.
  if (tapCount >= 2) for (int i = 0; i < g_open_n; i++) if (g_open[i].up && !g_open[i].heldBy) g_open[i].heldBy = seq;
  g_open[g_open_n++] = (TFOOpen){ .seq = seq, .at = at, .touch = touch };
}

static void tfo_lifted(uintptr_t touch, BOOL cancelled) {
  for (int i = 0; i < g_open_n; i++) {
    if (g_open[i].touch != touch || g_open[i].up) continue;
    g_open[i].up = YES;
    uint64_t seq = g_open[i].seq;
    if (cancelled) { tfo_close_at(i, YES); return; }
    double due = tfo_now_ms() + TFO_ACT_GRACE_MS;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, TFO_ACT_GRACE_MS * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      int k = tfo_open_index(seq);
      if (k < 0) return;
      // Held for the repeat that followed it: closed when that one is.
      if (g_open[k].heldBy && tfo_open_index(g_open[k].heldBy) >= 0) return;
      tfo_close_at(k, tfo_now_ms() - due > TFO_ACT_LATE_MS);
    });
    return;
  }
}

/**
 * A class answers touches in the app's own code: one of these methods is defined in the app's bundle (the executable,
 * its frameworks, a debug dylib), not inherited from the system. Such a view can act on a touch with none of the
 * signals above. Cached per class: a responder chain is walked at every touch-down.
 */
static BOOL tfo_handles_touches(Class cls) {
  static NSMutableDictionary<NSValue *, NSNumber *> *cache;
  static NSString *bundlePath;
  if (!cache) { cache = [NSMutableDictionary dictionary]; bundlePath = NSBundle.mainBundle.bundlePath; }
  NSValue *key = [NSValue valueWithPointer:(__bridge const void *)cls];
  NSNumber *known = cache[key];
  if (known) return known.boolValue;
  BOOL own = NO;
  const char *sels[] = { "touchesBegan:withEvent:", "touchesMoved:withEvent:", "touchesEnded:withEvent:",
                         "touchesCancelled:withEvent:", "beginTrackingWithTouch:withEvent:",
                         "continueTrackingWithTouch:withEvent:", "endTrackingWithTouch:withEvent:" };
  for (size_t i = 0; i < sizeof sels / sizeof *sels && !own; i++) {
    Method m = class_getInstanceMethod(cls, sel_registerName(sels[i]));
    Dl_info info;
    if (m && dladdr((const void *)method_getImplementation(m), &info) && info.dli_fname) {
      own = bundlePath.length && strncmp(info.dli_fname, bundlePath.fileSystemRepresentation, strlen(bundlePath.fileSystemRepresentation)) == 0;
    }
  }
  cache[key] = @(own);
  return own;
}

static BOOL tfo_chain_handles_touches(id view) {
  // A SpriteKit view hands its touches to its scene, which is not on the responder chain: a game's own code either way.
  // A HUD button laid over the scene is taken as unknown too — a kept tap, never a dropped one.
  Class sk = NSClassFromString(@"SKView");
  for (id r = view; r; r = tfo_send(r, "nextResponder")) {
    if ((sk && [r isKindOfClass:sk]) || tfo_handles_touches(object_getClass(r))) return YES;
  }
  return NO;
}

static IMP g_set_state, g_send_actions, g_send_action, g_cv_select, g_tv_select;

/** One of UIKit's own recognisers that watch every touch: its ending says nothing about the app. */
static BOOL tfo_ambient(id g) {
  NSString *name = NSStringFromClass([g class]);
  for (NSString *prefix in @[ @"_UITouchDurationObserving", @"_UIFlexInteraction", @"_UISystemGestureGate", @"UIScrollViewDelayedTouchesBegan" ]) {
    if ([name hasPrefix:prefix]) return YES;
  }
  return NO;
}

static void tfo_set_state(id g, SEL cmd, NSInteger state) {
  ((void (*)(id, SEL, NSInteger))g_set_state)(g, cmd, state);
  if (g_open_n == 0 || (state != 1 && state != 3)) return;
  // A pan beginning makes the touch a drag: nothing a drag did is a tap's action.
  if ([g isKindOfClass:NSClassFromString(@"UIPanGestureRecognizer")]) {
    if (state == 1) for (int i = 0; i < g_open_n; i++) if (!g_open[i].up) g_open[i].panned = YES;
    return;
  }
  if (state != 3 || tfo_ambient(g)) return;
  // Any other recogniser on the window may be the app's own (a tap that closes the keyboard) or UIKit's: not "acted",
  // and not "nothing acted" either (CodeRabbit, #1168).
  if ([tfo_send(g, "view") isKindOfClass:NSClassFromString(@"UIWindow")]) { tfo_mark_all(NO, YES); return; }
  // React Native's handler recognises every touch, a tap on nothing included: it says nothing about acting.
  if ([NSStringFromClass([g class]) hasPrefix:@"RCT"]) { tfo_mark_all(NO, YES); return; }
  tfo_mark_all(YES, NO);
}

static void tfo_send_actions(id control, SEL cmd, NSUInteger events, id event) {
  ((void (*)(id, SEL, NSUInteger, id))g_send_actions)(control, cmd, events, event);
  // An event the app listens for on this control: touch-down included, for a control that acts on it.
  if (g_open_n && (events & (NSUInteger)tfo_int(control, "allControlEvents"))) tfo_mark_all(YES, NO);
}

static BOOL tfo_send_action(id app, SEL cmd, SEL action, id target, id sender, id event) {
  BOOL sent = ((BOOL (*)(id, SEL, SEL, id, id, id))g_send_action)(app, cmd, action, target, sender, event);
  // The observer's own first-responder probe (a field read) is not the app acting.
  if (g_open_n && action != sel_registerName("tapflow_captureFirstResponder:")) tfo_mark_all(YES, NO);
  return sent;
}

static void tfo_cv_select(id cv, SEL cmd, id path) {
  ((void (*)(id, SEL, id))g_cv_select)(cv, cmd, path);
  if (g_open_n) tfo_mark_all(YES, NO);
}

static void tfo_tv_select(id tv, SEL cmd, id path) {
  ((void (*)(id, SEL, id))g_tv_select)(tv, cmd, path);
  if (g_open_n) tfo_mark_all(YES, NO);
}

static IMP tfo_hook(NSString *cls, const char *sel, IMP imp) {
  Method m = class_getInstanceMethod(NSClassFromString(cls), sel_registerName(sel));
  return m ? method_setImplementation(m, imp) : NULL;
}

/**
 * Installed the first time a touch arrives while the agent records, never for an app nobody records: until then no
 * UIKit method is replaced. Each replacement calls the one it replaced, so another SDK's wrapper still chains. Five
 * private or semi-private methods; if this iOS lacks any, no verdict is written at all — a missing hook would read as
 * "the app did nothing".
 */
static void tfo_install_act_hooks(void) {
  if (g_hooks_on) return;
  g_hooks_on = YES;
  g_set_state = tfo_hook(@"UIGestureRecognizer", "setState:", (IMP)tfo_set_state);
  g_send_actions = tfo_hook(@"UIControl", "_sendActionsForEvents:withEvent:", (IMP)tfo_send_actions);
  g_send_action = tfo_hook(@"UIApplication", "sendAction:to:from:forEvent:", (IMP)tfo_send_action);
  g_cv_select = tfo_hook(@"UICollectionView", "_userSelectItemAtIndexPath:", (IMP)tfo_cv_select);
  g_tv_select = tfo_hook(@"UITableView", "_userSelectRowAtPendingSelectionIndexPath:", (IMP)tfo_tv_select);
  g_hooks_whole = g_set_state && g_send_actions && g_send_action && g_cv_select && g_tv_select;
  // An app leaving the foreground (a link out, a share sheet) is suspended before a verdict's timer: closed now,
  // unknown unless the app already acted.
  [NSNotificationCenter.defaultCenter addObserverForName:@"UIApplicationWillResignActiveNotification" object:nil
                                                   queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) {
    while (g_open_n) { BOOL acted = g_open[0].acted; tfo_close_at(0, !acted); }
  }];
}

static NSString *tfo_surface(id window, id view) {
  NSString *w = NSStringFromClass([window class]);
  if ([w containsString:@"Keyboard"] || [w containsString:@"TextEffects"]) return @"keyboard";
  if ([NSStringFromClass([view class]) hasPrefix:@"Flutter"]) return @"flutter";
  // The view a touch lands on inside a web view is a plain UIView under WKContentView (iOS 26.5, measured), so the
  // views it sits in are asked too — for the web content only: a native view the app put in the web view's scroll view
  // is the app's, and named as such.
  Class content = NSClassFromString(@"WKContentView");
  for (id v = view; v && v != window; v = tfo_send(v, "superview")) {
    NSString *name = NSStringFromClass([v class]);
    // Reached the scroll view or the web view before any web content: a view of the app's own, laid over the page.
    if ([name isEqualToString:@"WKScrollView"] || [v isKindOfClass:NSClassFromString(@"WKWebView")]) return nil;
    if ((content && [v isKindOfClass:content]) || [name hasPrefix:@"WK"]) return @"web";
  }
  return nil;
}

static BOOL tfo_text_input(id e) {
  if ([e isKindOfClass:NSClassFromString(@"UITextField")] || [e isKindOfClass:NSClassFromString(@"UITextView")]) return YES;
  // UIAccessibilityTraitSearchField, and the trait a text field's element carries (1 << 18, measured on iOS 26.5).
  NSInteger traits = tfo_int(e, "accessibilityTraits");
  return (traits & (1 << 10)) || (traits & (1 << 18));
}

/** An accessibility element as the tree names one: identifier, label (not for a text input), traits, frame in the window. */
static NSDictionary *tfo_element(id e, id window) {
  if (!e) return nil;
  NSMutableDictionary *d = [NSMutableDictionary dictionary];
  NSString *ident = tfo_send(e, "accessibilityIdentifier");
  if ([ident isKindOfClass:NSString.class] && ident.length) d[@"identifier"] = ident;
  BOOL text = tfo_text_input(e);
  if (!text) {
    NSString *label = tfo_send(e, "accessibilityLabel");
    if ([label isKindOfClass:NSString.class] && label.length) d[@"label"] = label;
  }
  d[@"traits"] = @(tfo_int(e, "accessibilityTraits"));
  if (text) d[@"input"] = @YES;
  // `accessibilityFrame` is in screen coordinates; the tree's frames are the window's, normalised.
  TFORect f = tfo_rect(e, "accessibilityFrame");
  TFORect wb = tfo_rect(window, "bounds");
  SEL convert = sel_registerName("convertRect:fromWindow:");
  if ([window respondsToSelector:convert]) f = ((TFORect (*)(id, SEL, TFORect, id))objc_msgSend)(window, convert, f, nil);
  if (wb.w > 0 && wb.h > 0) d[@"frame"] = @{ @"x": @(f.x / wb.w), @"y": @(f.y / wb.h), @"width": @(f.w / wb.w), @"height": @(f.h / wb.h) };
  return d;
}

static void tfo_touch_answer(uint64_t seq, id window, id view, TFOPoint fixed, TFOPoint inWindow, BOOL moving, double at, NSInteger tapCount) {
  NSMutableDictionary *out = [@{
    @"seq": @(seq), @"at": @(at), @"bundle": g_bundle, @"moving": @(moving), @"tapCount": @(tapCount),
    @"point": @{ @"x": @(fixed.x), @"y": @(fixed.y) }, @"windowPoint": @{ @"x": @(inWindow.x), @"y": @(inWindow.y) },
  } mutableCopy];
  NSString *surface = tfo_surface(window, view);
  int open = tfo_open_index(seq);
  // Nothing is said of a touch on a surface, and nothing can be said of one the app's own code may have handled.
  if (open >= 0 && (surface || tfo_chain_handles_touches(view))) g_open[open].unknown = YES;
  if (surface) {
    out[@"surface"] = surface;
  } else {
    TFORect wb = tfo_rect(window, "bounds");
    TFOPoint p = { inWindow.x * wb.w, inWindow.y * wb.h };
    SEL hit = sel_registerName("accessibilityHitTest:withEvent:");   // iOS 18+
    // This runs after the touch-down was delivered: an app that changes screen on touch-down (rather than on lift) has
    // put another view under the point, and its element is not what the person touched. The view UIKit hit before
    // delivery is the touch's own; a different one now names nothing rather than the wrong thing (CodeRabbit, #1166).
    id under = ((id (*)(id, SEL, TFOPoint, id))objc_msgSend)(window, sel_registerName("hitTest:withEvent:"), p, nil);
    BOOL same = !view || under == view;
    id e = same && [window respondsToSelector:hit] ? ((id (*)(id, SEL, TFOPoint, id))objc_msgSend)(window, hit, p, nil) : nil;
    NSDictionary *element = tfo_element(e, window);
    if (element) out[@"element"] = element;
    // The nearest container marked a button: a grid cell rather than its subtitle (measured: "Daytime, Salty").
    id b = e;
    for (int depth = 0; b && depth < 12; depth++) {
      if (tfo_int(b, "accessibilityTraits") & 1) break;   // UIAccessibilityTraitButton
      b = tfo_send(b, "accessibilityContainer");
    }
    // Only a container that is a button: a walk that ran out of depth found none.
    NSDictionary *button = b && b != e && (tfo_int(b, "accessibilityTraits") & 1) ? tfo_element(b, window) : nil;
    // A container over a text input (a row of a label and a field, combined) can carry the field's text in its label:
    // named by its identifier only, as the input is.
    if (button && tfo_text_input(e)) button = button[@"identifier"] ? @{ @"identifier": button[@"identifier"], @"traits": button[@"traits"] } : nil;
    if (button) out[@"button"] = button;
  }
  // Serialised here, written off the main queue (0.3–0.8 ms measured): only bytes cross, nothing the app may still change.
  NSString *path = [g_dir stringByAppendingFormat:@"/touch-%llu.json", seq];
  NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
  // Checked again where it is written: a write still queued when the agent stopped the reports and swept them would
  // leave this one, naming what a person touched, with nothing to sweep it (CodeRabbit, #1166).
  if (json) dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ if (tfo_touches_on()) tfo_write_data(path, json); });
}

/**
 * The first accessibility hit test on a screen costs 10–30 ms (SwiftUI builds its nodes then), later ones 3–5 ms
 * (measured on iOS 26.5, Food Truck). So a hit test is run once the screen has had time to settle — 0.7 s after a touch
 * lifts, or after the app becomes active — when nothing is moving and nobody sees the main queue busy, and the one at
 * the next touch-down finds the nodes built: under 5.5 ms per tap measured, against up to 15 ms without. A touch in the
 * meantime cancels it; that touch warms nothing it needs.
 */
static uint64_t g_warm_gen;
static void tfo_warm_later(id window) {
  if (!window) return;
  uint64_t gen = ++g_warm_gen;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 700 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    if (gen != g_warm_gen || !tfo_touches_on()) return;
    TFORect wb = tfo_rect(window, "bounds");
    // A fling's glide runs 1–3 s: while a list under the centre still moves, wait again rather than cost a frame in it.
    id centre = ((id (*)(id, SEL, TFOPoint, id))objc_msgSend)(window, sel_registerName("hitTest:withEvent:"), (TFOPoint){ wb.w / 2, wb.h / 2 }, nil);
    Class scroll = NSClassFromString(@"UIScrollView");
    for (id v = centre; v; v = tfo_send(v, "superview")) {
      if ([v isKindOfClass:scroll] && (tfo_bool(v, "isDecelerating") || tfo_bool(v, "_isBouncing"))) { tfo_warm_later(window); return; }
    }
    SEL hit = sel_registerName("accessibilityHitTest:withEvent:");
    if ([window respondsToSelector:hit]) (void)((id (*)(id, SEL, TFOPoint, id))objc_msgSend)(window, hit, (TFOPoint){ wb.w / 2, wb.h / 2 }, nil);
  });
}

/**
 * `-[UIApplication sendEvent:]`, wrapped: what was moving is read before the event is delivered (the touch stops the
 * scroll), what was hit after (on the next turn of the main queue, so delivery waits for nothing: the hit test costs
 * 1–14 ms, measured). The original implementation is kept and called, so another SDK's wrapper still chains.
 */
static void tfo_send_event(id app, SEL cmd, id event) {
  NSMutableArray *began = nil;
  BOOL recording = g_dir && tfo_touches_on();
  // Reports left open when recording stopped are dropped: their touches may never end where this can see them.
  if (!recording) g_open_n = 0;
  if (recording) {
    tfo_install_act_hooks();
    for (id t in tfo_send(event, "allTouches")) {
      NSInteger phase = tfo_int(t, "phase");
      // UITouchPhaseEnded: the screen it leaves — the app's key window, since a key's touch ends in the keyboard's.
      if (phase == 3) tfo_warm_later(tfo_key_window());
      // Ended or cancelled: the verdict's window starts (a cancel closes it unknown).
      if (phase == 3 || phase == 4) tfo_lifted((uintptr_t)(__bridge void *)t, phase == 4);
      if (phase != 0) continue;   // UITouchPhaseBegan
      g_warm_gen++;               // a warm-up still pending would run in this touch's frames
      // Two at most: a hit test costs up to 14 ms on the main queue, and the agent never sends more than two fingers.
      if (began.count >= 2) break;
      id window = tfo_send(t, "window"), view = tfo_send(t, "view");
      if (!window) continue;
      TFOPoint p = ((TFOPoint (*)(id, SEL, id))objc_msgSend)(t, sel_registerName("locationInView:"), window);
      BOOL moving = NO;
      Class scroll = NSClassFromString(@"UIScrollView");
      for (id v = view; v && !moving; v = tfo_send(v, "superview")) {
        if ([v isKindOfClass:scroll] && (tfo_bool(v, "isDecelerating") || tfo_bool(v, "_isBouncing"))) moving = YES;
      }
      // The point in the device's portrait space, which the agent's touch was sent in, normalised.
      id screen = tfo_send(window, "screen");
      id fixedSpace = tfo_send(screen, "fixedCoordinateSpace");
      TFOPoint f = p;
      SEL conv = sel_registerName("convertPoint:toCoordinateSpace:");
      if (fixedSpace && [window respondsToSelector:conv]) f = ((TFOPoint (*)(id, SEL, TFOPoint, id))objc_msgSend)(window, conv, p, fixedSpace);
      TFORect fb = tfo_rect(fixedSpace, "bounds"), wb = tfo_rect(window, "bounds");
      if (fb.w <= 0 || fb.h <= 0 || wb.w <= 0 || wb.h <= 0) continue;
      if (!began) began = [NSMutableArray array];
      // Numbered and opened now, before the event is delivered: what the delivery sets off is this touch's.
      uint64_t seq = ++g_touch_seq;
      double at = tfo_now_ms();
      NSInteger tapCount = tfo_int(t, "tapCount");
      tfo_open(seq, at, (uintptr_t)(__bridge void *)t, tapCount);
      [began addObject:@[ @(seq), window, view ?: NSNull.null, @(f.x / fb.w), @(f.y / fb.h), @(p.x / wb.w), @(p.y / wb.h), @(moving), @(at), @(tapCount) ]];
    }
  }
  ((void (*)(id, SEL, id))g_send_event)(app, cmd, event);
  for (NSArray *b in began) {
    dispatch_async(dispatch_get_main_queue(), ^{
      tfo_touch_answer([b[0] unsignedLongLongValue], b[1], b[2] == NSNull.null ? nil : b[2], (TFOPoint){ [b[3] doubleValue], [b[4] doubleValue] },
                       (TFOPoint){ [b[5] doubleValue], [b[6] doubleValue] }, [b[7] boolValue], [b[8] doubleValue], [b[9] integerValue]);
    });
  }
}

/** Wrapped once UIKit is loaded: an inserted library's constructor can run before the app's frameworks are. */
static void tfo_wrap_send_event(void) {
  Method m = class_getInstanceMethod(NSClassFromString(@"UIApplication"), sel_registerName("sendEvent:"));
  if (m && !g_send_event) g_send_event = method_setImplementation(m, (IMP)tfo_send_event);
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
              usingBlock:^(NSNotification *n) { g_coming_up = NO; tfo_warm_later(tfo_key_window()); }];

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
  dispatch_async(dispatch_get_main_queue(), ^{ tfo_wrap_send_event(); });
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
