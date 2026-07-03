---
type: reference
topics: [ios, simulator, reverse-engineering]
status: living
---

# SimulatorKit Internals — Reverse-Engineering Notes

> This document records the SimulatorKit reverse-engineering done while implementing iOS touch/button injection for tapflow. It is a reference.
> It is based on Xcode 26 (the SimulatorKit version at that time) and may change with future Xcode upgrades.
>
> During the reverse engineering we referenced the analysis from [tddworks/baguette](https://github.com/tddworks/baguette) (Apache-2.0).

---

## 1. Binary overview

**Path:** `$DEVELOPER_DIR/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit`

- **Format:** Fat binary (Universal)
  - slice 0: x86_64, file offset `0x4000`, size `0x113e70`
  - slice 1: ARM64e, file offset `0x118000`, size `0x133740`
- **Language:** mixed Swift + ObjC (Swift classes are exposed under mangled names)
- **Public headers:** none — extract symbols with `nm`, `otool`, `strings`

Basic symbol-extraction commands:

```bash
# List ARM64 global symbols (works even on the Fat binary)
nm -gU $SIMKIT | grep <keyword>

# Extract C function prototypes (when strings captured the actual parameter types)
strings $SIMKIT | grep "IndigoHIDMessage \*"
# Example output:
#   IndigoHIDMessage *IndigoHIDMessageForHIDArbitrary(IndigoHIDTarget, uint32_t, uint32_t, IndigoHIDButtonOp)
#   IndigoHIDMessage *IndigoHIDMessageForButton(IndigoHIDButtonKeyCode, IndigoHIDButtonOp, IndigoHIDTarget)
#   IndigoHIDMessage *IndigoHIDMessageForMouseNSEvent(CGPoint *, CGPoint *, IndigoHIDTarget, NSEventType, NSSize, IndigoHIDEdge)

# List ObjC methods (at runtime)
# object_getClass(instance) → enumerate via class_copyMethodList
```

> **Tip**: a single line, `strings $SIMKIT | grep "IndigoHIDMessage \*"`, reveals C prototypes together with parameter types. A fast way to trust a signature without disassembling.

---

## 2. Touch-injection architecture (Xcode 26)

### 2-1. Old approach (before Xcode 25, removed)

```
SimDevice.sendHIDEvent:(IOHIDEventRef)
```

On Xcode 26 that selector no longer exists on `SimDevice`. If you obtain the IMP via `class_getMethodImplementation` without a `responds(to:)` check, you get a non-NULL **forwarding trampoline**, and calling it crashes with `unrecognized selector`.

> **Lesson:** `class_getMethodImplementation` must not be used to check whether a selector exists. Always use `responds(to:)` together with `class_getInstanceMethod`.

### 2-2. New approach (Xcode 26+) — confirmed working

```
IndigoHIDMessageForMouseNSEvent(position, delta=zero, target=0x32, NSEventType, size=(1,1), edge=0)
  └─ SimDeviceLegacyHIDClient.sendWithMessage:freeWhenDone:completionQueue:completion:
```

- **Coordinates**: normalized 0.0–1.0 values. Pass `NSSize(1.0, 1.0)` as the size to declare the coordinate space.
- **target**: `0x32` (digitizer) — not `0x35` (trackpad).
- **NSEventType**: `1`=leftMouseDown, `2`=leftMouseUp, `6`=leftMouseDragged
- No IOHIDEvent hierarchy (parent/child) needed — this function builds the IndigoHIDMessageStruct directly.

#### ⚠️ Limitation of the mouse class: cannot touch system layers like UIBackdropView

`IndigoHIDMessageForMouseNSEvent` (mouse-class) works on ordinary UIKit views but is ignored by the layers below:

- `UIBackdropView` — folder blur background, the dismiss area for notifications / Control Center
- Notification Center / Control Center gesture layers

These layers accept **digitizer-class events only**. You must use the IOHIDDigitizerDispatch path in §2-3.

#### ⚠️ Earlier failed approach (three mistakes)

In the initial attempt, `IndigoHIDMessageForTrackpadEventFromHIDEventRef` returned nil due to three overlapping causes:

1. **Wrong parent-event creation function**: `IOHIDEventCreate(type=0xB)` must be replaced with `IOHIDEventCreateDigitizerEvent`.
2. **Wrong argument count for the wrapper**: `IndigoHIDMessageForTrackpadEventFromHIDEventRef` takes only one argument (`event`). Adding `target=0x35` as a second argument was a miscall.
3. **Missing routing-tag patch**: without patching the returned message with `storeBytes(of: UInt32(0x32), toByteOffset: 0x6c)`, iOS does not route the event to the digitizer subsystem and **every touch is ignored** (not just UIBackdropView — ordinary UI stops working too).

### 2-3. UIBackdropView / system gesture layers — IOHIDDigitizerDispatch path (verified 2026-05-18)

```
IOHIDEventCreateDigitizerEvent(parent, transducerType=2, ...)
  └─ IOHIDEventCreateDigitizerFingerEvent(finger, ...)
       └─ IOHIDEventAppendEvent(parent, finger, 0)
            └─ IndigoHIDMessageForTrackpadEventFromHIDEventRef(parent)  → msgPtr
                 └─ storeBytes(UInt32(0x32), offset: 0x6c)  ← routing tag required
                      └─ SimDeviceLegacyHIDClient.sendWithMessage:freeWhenDone:
```

#### Loading symbols

IOKit symbols live in the dyld shared cache, so `dlopen` them first and `dlsym` against that handle.
`RTLD_DEFAULT` can be expressed in Swift as `UnsafeMutableRawPointer(bitPattern: -2)`, or just use the `dlopen` return value directly.

```swift
let ioKitHandle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW | RTLD_GLOBAL)
// skHandle = SimulatorKit handle (already loaded)
```

#### Swift typealias

```swift
// IOKit — IOHIDEventCreateDigitizerEvent
// (allocator, ts, transducerType, index, identity, eventMask, buttonMask,
//  x, y, z, tipPressure, barrelPressure, range, touch, options)
typealias CreateDigitizerFn = @convention(c) (
    OpaquePointer?, UInt64,
    UInt32, UInt32, UInt32, UInt32, UInt32,
    Double, Double, Double, Double, Double,
    UInt32, UInt32, UInt32
) -> OpaquePointer?

// IOKit — IOHIDEventCreateDigitizerFingerEvent
// (allocator, ts, index, identity, eventMask,
//  x, y, z, tipPressure, twist, range, touch, options)
typealias CreateFingerFn = @convention(c) (
    OpaquePointer?, UInt64,
    UInt32, UInt32, UInt32,
    Double, Double, Double, Double, Double,
    UInt32, UInt32, UInt32
) -> OpaquePointer?

typealias AppendEventFn   = @convention(c) (OpaquePointer, OpaquePointer, UInt32) -> Void
typealias TrackpadWrapFn  = @convention(c) (OpaquePointer) -> UnsafeMutableRawPointer?
```

#### eventMask / range / touch

| phase | eventMask | range | touch |
|-------|-----------|-------|-------|
| down  | `0x07` (Range\|Touch\|Position) | 1 | 1 |
| move  | `0x07` | 1 | 1 |
| up    | `0x06` (Touch\|Position) | 0 | 0 |

#### Full implementation pattern

```swift
let ts       = mach_absolute_time()
let isUp     = (eventType == kNSLeftMouseUp)
let mask: UInt32    = isUp ? 0x06 : 0x07
let contact: UInt32 = isUp ? 0 : 1

guard let parent = createDigitizer(nil, ts, 2, 0, 1, mask, 0, x, y, 0, 0, 0, contact, contact, 0),
      let finger = createFinger(nil, ts, 0, 1, mask, x, y, 0, 0, 0, contact, contact, 0) else { return }
appendEvent(parent, finger, 0)

guard let msgPtr = trackpadWrap(parent) else { return }
// routing tag: iOS reads this value to route to the digitizer subsystem
msgPtr.storeBytes(of: UInt32(0x32), toByteOffset: 0x6c, as: UInt32.self)
if malloc_size(msgPtr) >= 0x110 {
    msgPtr.storeBytes(of: UInt32(0x32), toByteOffset: 0x10c, as: UInt32.self)
}
sendMsg(hidClient, sendSel, msgPtr, true, nil, nil)
```

#### Key cautions

- **`bytes[0x6c] = 0x32` (a 1-byte UInt8 write) is not enough.** You must write with `storeBytes(of: UInt32(0x32), ...)` (4 bytes).
- **Check size with `malloc_size(msgPtr)`.** Reading the message-header offset 4 returns something other than the size field, causing the patch to be skipped.
- Sending the message without the routing-tag patch makes iOS **ignore all touches**, ordinary UI as well as UIBackdropView.
- Keep an `IndigoHIDMessageForMouseNSEvent` fallback for environments where `IOHIDEventCreateDigitizerEvent` / `IOHIDEventCreateDigitizerFingerEvent` are absent (symbols missing).

**Note**: the `IndigoHIDMessageForMouseNSEvent` + target=`0x32` combination still works for ordinary UIKit touches. If there is no UIBackdropView problem, the mouse class is sufficient.

---

## 3. Core class: SimDeviceLegacyHIDClient

### Symbol name

Swift mangled: `_TtC12SimulatorKit24SimDeviceLegacyHIDClient`
ObjC exposure: `NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient")`

### Main methods

| Method | Description |
|--------|------|
| `-initWithDevice:error:` | create a client from a SimDevice |
| `-initWithDevice:sessionResetQueue:error:sessionResetHandler:` | create with a session-reset handler |
| `-sendWithMessage:freeWhenDone:completionQueue:completion:` | send an IndigoHIDMessageStruct |
| `-resetHIDSession` | reset the HID session |

### Creation (ObjC runtime)

```swift
let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient")!

// +alloc
let metaCls = object_getClass(cls)!
let allocImp = class_getMethodImplementation(metaCls, NSSelectorFromString("alloc"))!
typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject
let allocated = unsafeBitCast(allocImp, to: AllocFn.self)(cls, NSSelectorFromString("alloc")) as! NSObject

// -initWithDevice:error:
let initSel = NSSelectorFromString("initWithDevice:error:")
let initImp = class_getMethodImplementation(type(of: allocated), initSel)!
typealias InitFn = @convention(c) (NSObject, Selector, NSObject,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> NSObject?
var err: NSError?
let client = unsafeBitCast(initImp, to: InitFn.self)(allocated, initSel, simDevice, &err)
```

### Calling sendWithMessage:

```swift
let sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
let sendImp = class_getMethodImplementation(type(of: client), sendSel)!
typealias SendFn = @convention(c) (NSObject, Selector, UnsafeMutableRawPointer, Bool,
                                   AnyObject?, AnyObject?) -> Void
// freeWhenDone:YES → SimulatorKit frees the message-buffer memory itself
unsafeBitCast(sendImp, to: SendFn.self)(client, sendSel, msgPtr, true, nil, nil)
```

---

## 4. The IndigoHIDMessage functions

C functions SimulatorKit uses internally. Reachable via `dlsym`.
`strings $SIMKIT | grep "IndigoHIDMessage \*"` reveals the prototypes including parameter types.

| Function | C prototype | Purpose |
|------|--------|------|
| `IndigoHIDMessageForMouseNSEvent` | `(CGPoint*, CGPoint*, IndigoHIDTarget, NSEventType, NSSize, IndigoHIDEdge)` | touch/mouse (6 args on Xcode 26) |
| `IndigoHIDMessageForHIDArbitrary` | `(IndigoHIDTarget, uint32_t usagePage, uint32_t usage, IndigoHIDButtonOp)` | physical buttons (volume/power/action/mute) |
| `IndigoHIDMessageForButton` | `(IndigoHIDButtonKeyCode, IndigoHIDButtonOp, IndigoHIDTarget)` | legacy buttons (home/lock) |
| `IndigoHIDMessageForKeyboardArbitrary` | `(uint32_t keycode, IndigoHIDButtonOp)` | arbitrary keyboard key |
| `IndigoHIDMessageForTrackpadEventFromHIDEventRef` | `(IOHIDEventRef)` | Digitizer (0xB) event → IndigoHIDMessage (§2-3) |
| `IndigoHIDMessageForPointerEventFromHIDEventRef` | `(IOHIDEventRef, IndigoHIDTarget)` | Collection (0x11) event → pointer |
| `IndigoHIDMessageForScrollEventFromHIDEventRef` | `(IOHIDEventRef, IndigoHIDTarget)` | scroll |
| `IndigoHIDMessageForTrackpadMoveEvent` | `(CGPoint, IndigoHIDTarget)` | trackpad move |

Every function returns an `IndigoHIDMessageStruct*` allocated with `calloc`.
If you pass it with `sendWithMessage:freeWhenDone:YES`, SimulatorKit takes care of freeing it.

### IndigoHIDButtonOp

A `UInt32` type. **1 = down, 2 = up**. It is not a `Bool`.

```swift
let kHIDOpDown: UInt32 = 1
let kHIDOpUp:   UInt32 = 2
```

### Physical-button injection — HIDArbitrary path (volume/power/action/mute)

```swift
typealias IndigoHIDArbitraryFn = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
let indigoArbitrary: IndigoHIDArbitraryFn = requireSym(skHandle, "IndigoHIDMessageForHIDArbitrary")

// usagePage, usage are read from chrome.json inputs[].usagePage / .usage
// e.g. volume+ usagePage=12(0x0C), usage=233(0xE9)
//      power   usagePage=12(0x0C), usage=48(0x30)
//      action  usagePage=11(0x0B), usage=45(0x2D)
if let msgDown = indigoArbitrary(0x32, usagePage, usage, 1) {   // target=0x32, op=down
    sendMsg(hidClient, sendSel, msgDown, true, nil, nil)
}
Thread.sleep(forTimeInterval: 0.05)
if let msgUp = indigoArbitrary(0x32, usagePage, usage, 2) {     // op=up
    sendMsg(hidClient, sendSel, msgUp, true, nil, nil)
}
```

> **Caution**: the parameter order is `(target, usagePage, usage, op)`. Implementing it wrong as `(usagePage, usage, Bool)` routes the message to the wrong service and nothing responds.

### Physical-button injection — legacy path (home/lock)

```swift
typealias IndigoHIDButtonFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
let indigoButton: IndigoHIDButtonFn = requireSym(skHandle, "IndigoHIDMessageForButton")

// IndigoHIDButtonKeyCode: home=0x0, lock=0x1
// target: 0x33 (legacy button service) — different from 0x32 (digitizer)
if let msgDown = indigoButton(0x0, 1, 0x33) {   // home down
    sendMsg(hidClient, sendSel, msgDown, true, nil, nil)
}
Thread.sleep(forTimeInterval: 0.05)
if let msgUp = indigoButton(0x0, 2, 0x33) {     // home up
    sendMsg(hidClient, sendSel, msgUp, true, nil, nil)
}
```

> **Caution**: as of Xcode 26 the legacy path (`IndigoHIDMessageForButton`) is confirmed working only for home/lock. Volume/power must use the HIDArbitrary path.

---

## 5. Keyboard injection — keyboard service target

### Key finding: iOS recognition depends on the target

IndigoHID functions use different internal HID service targets per purpose. **Confusing the target by going on the function name alone makes iOS misrecognize the event.**

| Function | Internal target | iOS recognition |
|------|-------------|---------|
| `IndigoHIDMessageForHIDArbitrary(0x32, 0x07, usage, op)` | 0x32 = digitizer | ❌ touch path — not recognized as a hardware keyboard |
| `IndigoHIDMessageForKeyboardArbitrary(usage, op)` | keyboard service (built-in) | ✅ hardware-keyboard path |
| `IndigoHIDMessageForKeyboardNSEvent(NSEvent*)` | keyboard service (built-in) | ✅ hardware-keyboard path |
| `IndigoHIDMessageForModifierKeyBit(bit, op)` | keyboard service (built-in) | ✅ modifiers only |

`IndigoHIDMessageForKeyboardArbitrary` has no target parameter — the correct keyboard-service target is hardcoded inside the function. It is not caller-specified the way `IndigoHIDMessageForHIDArbitrary` is.

### Why the target matters

iOS manages its character-conversion cache (input-source mapping) according to the HID event's service target.

- **Sending keyboard usage codes to the digitizer target (0x32)**: iOS does not recognize a hardware keyboard → input-source switching is ignored → the character-conversion cache is not refreshed → input is locked to a fixed language regardless of the software-keyboard language.
- **Sending to the keyboard-service target**: iOS treats it as a genuine hardware-keyboard event → CapsLock/Lang1 toggle → the Korean/English switch HUD appears → characters switch with the active input source.

### Symptom pattern when the digitizer target is misused

- Pressing CapsLock does not show the Korean/English switch HUD.
- Ctrl+Space changes the software key layout but not the hardware-key input language.
- Tapping a software key directly makes the hardware key type that language too — because the soft key updates the cache through the correct keyboard-service path.
- When the software key is Korean, jamo combine; when English, jamo separate (cache mismatch).

### Usage in touch-helper.swift

```swift
// ❌ wrong way (digitizer path — Korean/English switch impossible)
indigoArbitrary(0x32, 0x07, usage, kHIDOpDown)

// ✅ correct way (keyboard-service path)
indigoKeyboard(usage, kHIDOpDown)   // IndigoHIDMessageForKeyboardArbitrary
```

Fallback structure (fall back to `indigoArbitrary` if `indigoKeyboard` is nil):
```swift
func kbdMsg(_ u: UInt32, _ op: UInt32) {
    let ptr: UnsafeMutableRawPointer?
    if let fn = indigoKeyboard { ptr = fn(u, op) }
    else if let fn = indigoArbitrary { ptr = fn(0x32, 0x07, u, op) }
    else { return }
    if let p = ptr { sendMsg(hidClient, sendSel, p, true, nil, nil) }
}
```

---

### SimKeyboardInputController / SimKeyboardInputDefaultDelegate

The official SimulatorKit classes that Simulator.app uses in "Connect Hardware Keyboard" mode.
Reference when an NSEvent-based path is needed instead of `IndigoHIDMessageForKeyboardArbitrary`.

**Symbols** (Xcode 26, found via `nm -gU $SIMKIT | xcrun swift-demangle | grep -i keyboard`):

| Symbol | ObjC selector | Description |
|------|------------|------|
| `SimKeyboardInputDefaultDelegate.init(hidClient:)` | — (pure Swift) | initialize with a hidClient |
| `SimKeyboardInputDefaultDelegate.handleEvent(_ event: NSEvent) -> NSEvent?` | `handleEvent:` | NSEvent → keyboard HID → hidClient |
| `SimKeyboardInputDefaultDelegate.isEnabled: Bool` | `isEnabled` | |
| `SimKeyboardInputController.init()` | — (pure Swift) | no arguments |
| `SimKeyboardInputController.handle(event: NSEvent) -> NSEvent?` | `handleWithEvent:` | route an NSEvent to the delegate |
| `SimKeyboardInputController.isEnabled: Bool` | `isEnabled` | |
| `SimKeyboardInputController.delegate: SimKeyboardInputControllerDelegate?` | `delegate` | |
| `SimKeyboardInputController.clearModifiers()` | | reset modifier state |

ObjC class names:
- `_TtC12SimulatorKit31SimKeyboardInputDefaultDelegate`
- `_TtC12SimulatorKit26SimKeyboardInputController`

**Direct usage** (the `SimKeyboardInputDefaultDelegate.handleEvent:` path):
```swift
// init(hidClient:) is pure Swift — not directly reachable via the ObjC runtime.
// Create the instance via NSClassFromString + alloc, then note that the
// initWithHidClient: selector (the Swift→ObjC bridged name) is not registered,
// so if you need SimKeyboardInputDefaultDelegate, re-verify with nm before accessing.
```

> **tapflow currently solves the Korean/English switch problem by using `IndigoHIDMessageForKeyboardArbitrary` directly. The SimKeyboardInputController/Delegate path is considered only when NSEvent-level control is needed.**

---

## 6. IndigoHIDTarget

A `UInt32` type. Encodes the input-device type and the screen.

### Value list (confirmed via reverse engineering)

| Value | Meaning | How confirmed |
|----|------|-----------|
| `0x32` (50) | digitizer/touch (`IndigoHIDMessageForMouseNSEvent` default target) | confirmed working in touch-helper.swift |
| `0x33` (51) | legacy button service (home/lock) | confirmed working |
| `0x35` (53) | trackpad (Digitizer IOHIDEvent path) | `_hidEventFilterCallback`: `cinc w25, #0x35, ne` |
| `0x36` (54) | mouse / other pointer | `_hidEventFilterCallback`: increment on the `ne` condition |
| `0x40000000 \| screenID` | screen-based target | `IndigoHIDTargetForScreen(screenID)` — see below |

> **Summary**: touch and HIDArbitrary volume/power → `0x32`, home/lock legacy → `0x33`. Confusing the two leaves the event unrouted.

### Screen-based target (reference)

```swift
func IndigoHIDTargetForScreen(_ screenID: UInt32) -> UInt32 {
    return screenID | 0x40000000
}
// main screen (ID=0) → target = 0x40000000
```

This function is implemented in exactly two lines in the binary:
```asm
_IndigoHIDTargetForScreen:
    orr w0, w0, #0x40000000
    ret
```

The `SimDeviceScreen.buttonTarget` property returns this value.
However, the `screen` property on `SimDevice` is **not reachable via KVC** (NSUnknownKeyException). Access it directly via the ObjC runtime.

### _hidEventFilterCallback flow summary

```
Check the event type (w23)
  ├─ 0x11 (Collection): IndigoHIDMessageForPointerEventFromHIDEventRef(event, x25)
  │                      x25 = 0x35 if it includes trackpadSenders, 0x36 if mouseSenders
  ├─ 0xB  (Digitizer):  IndigoHIDMessageForTrackpadEventFromHIDEventRef(event, 0x35) ← hardcoded
  └─ 0x6  (Scroll):     IndigoHIDMessageForScrollEventFromHIDEventRef(event, x25)
```

---

## 7. ROCK Remote Proxy issue

Obtaining the descriptor of the `com.apple.CoreSimulator.HID.LegacyHID` IO port returns a ROCK proxy:

```
ROCKRemoteProxy-{UUID}-ROCKImpersonateable-SimDeviceIOPortDescriptorInterface-SimLegacyHIDDescriptor-SimEnvironmentProvider
```

**ROCK (Remote Objects Communications Kit)** is a Mach-port-based, XPC-like IPC framework where a proxy object forwards messages to a remote process.

### Problem

`responds(to:)` always returns `false` on the ROCK proxy.
→ The existing selector-discovery approach (`trySelectors`) cannot find the methods.

### Conclusion

The correct approach is to create and use `SimDeviceLegacyHIDClient` directly instead of the ROCK proxy. The ROCK proxy is a structure used by Simulator.app's internal view layer; it is not a public path for external processes to use directly.

---

## 8. Status and unverified items

| Item | Status |
|------|------|
| Single-pointer touch (ordinary UI) | ✅ **implemented** — IOHIDDigitizerDispatch path (§2-3). mouse-class fallback kept. |
| Single-pointer touch (UIBackdropView / system layers) | ✅ **implemented** — IOHIDDigitizerDispatch + routing-tag patch (§2-3). Verified 2026-05-18. |
| Multi-touch / pinch | ✅ **implemented** — the 9-arg version of `IndigoHIDMessageForMouseNSEvent` (two-finger form). |
| Physical buttons (volume/power/action) | ✅ **implemented** — `IndigoHIDMessageForHIDArbitrary(0x32, usagePage, usage, op)` |
| Physical buttons (home/lock) | ✅ **implemented** — `IndigoHIDMessageForButton(code, op, 0x33)`. home=code 0, lock=code 1 |
| Keyboard (including Korean/English switch) | ✅ **implemented** — `IndigoHIDMessageForKeyboardArbitrary(usage, op)`. See §5. |
| Device rotation | ✅ **implemented** — `rotation-helper`: sends a `GSEventTypeDeviceOrientationChanged` mach message directly to `PurpleWorkspacePort`. No Simulator.app needed. |
| Scroll | not implemented — the `IndigoHIDMessageForScrollEventFromHIDEventRef` path is confirmed |
| Xcode version compatibility | `SimDeviceLegacyHIDClient` + IOHIDDigitizerDispatch are for Xcode 26. Earlier versions use `SimDevice.sendHIDEvent:` |

---

## 9. Exploration methodology

Reference order for re-exploring when SimulatorKit changes in the future:

```bash
# 1. Confirm the core class/function exists
lipo -thin arm64e $SIMKIT -output /tmp/simkit_arm64e
nm -U /tmp/simkit_arm64e | grep <keyword>

# 2. Determine the function signature (arg count, types)
otool -tv /tmp/simkit_arm64e | awk '/^_FunctionName:/{found=1} found{print; ...}'

# 3. List ObjC protocol methods
otool -oV /tmp/simkit_arm64e | grep -A 20 <ProtocolName>

# 4. Trace the actual call flow
# — trace backward which function calls which
otool -tv /tmp/simkit_arm64e | grep <target_function>
# → identify the calling function → disassemble that function

# 5. Runtime verification (Swift test binary)
# dlopen + dlsym to confirm a symbol exists, then test the call
```
