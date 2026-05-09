// touch-helper.swift
// Injects touch events into iOS Simulator via SimDeviceLegacyHIDClient (SimulatorKit)
//
// Usage: touch-helper <udid|booted>
//
// Stdin protocol: 9-byte frames
//   byte  0   : event type — 1=start · 2=move · 3=end
//   bytes 1–4 : x as float32 big-endian (normalized 0.0–1.0)
//   bytes 5–8 : y as float32 big-endian (normalized 0.0–1.0)
//
// Architecture (Xcode 26+):
//   IndigoHIDMessageForMouseNSEvent(position, delta, target=0x32, NSEventType, size, edge)
//   → SimDeviceLegacyHIDClient.sendWithMessage:freeWhenDone:completionQueue:completion:
//
// Reference: baguette (tddworks/baguette), SimulatorKit _hidEventFilterCallback analysis.

import Foundation
import CoreGraphics
import ObjectiveC

// MARK: - Args

guard CommandLine.arguments.count == 2 else {
    fputs("usage: touch-helper <udid|booted>\n", stderr)
    exit(1)
}
let targetUDID = CommandLine.arguments[1]

// MARK: - Framework loading

func findDeveloperDir() -> String {
    let pipe = Pipe()
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    task.arguments = ["-p"]
    task.standardOutput = pipe
    do { try task.run() } catch { return "/Applications/Xcode.app/Contents/Developer" }
    task.waitUntilExit()
    let dir = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    func hasSimKit(_ d: String) -> Bool {
        FileManager.default.fileExists(atPath: (d as NSString).appendingPathComponent(
            "Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"))
    }
    if !dir.isEmpty && hasSimKit(dir) { return dir }
    let apps = (try? FileManager.default.contentsOfDirectory(atPath: "/Applications")) ?? []
    for app in apps.sorted() where app.hasPrefix("Xcode") && app.hasSuffix(".app") {
        let d = "/Applications/\(app)/Contents/Developer"
        if hasSimKit(d) { return d }
    }
    return dir.isEmpty ? "/Applications/Xcode.app/Contents/Developer" : dir
}

let developerDir = findDeveloperDir()

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
             RTLD_NOW | RTLD_GLOBAL) != nil else {
    if let e = dlerror() { fputs("error: CoreSimulator: \(String(cString: e))\n", stderr) }
    exit(1)
}
let simkitPath = (developerDir as NSString)
    .appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit")
guard let skHandle = dlopen(simkitPath, RTLD_NOW | RTLD_GLOBAL) else {
    if let e = dlerror() { fputs("error: SimulatorKit: \(String(cString: e))\n", stderr) }
    exit(1)
}

// MARK: - IndigoHID function pointers

// IndigoHIDMessageForMouseNSEvent(p1, p2, target, eventType, size, edge) -> IndigoHIDMessageStruct*
// C signature: (CGPoint*, CGPoint*, IndigoHIDTarget, NSEventType, NSSize, IndigoHIDEdge)
// p1: pointer to current position (normalized 0.0–1.0)
// p2: pointer to movement delta (zero for tap/drag)
// target: IndigoHIDTarget = 0x32
// eventType: NSEventType raw value — NSUInteger (1=leftMouseDown, 2=leftMouseUp, 6=leftMouseDragged)
// size: coordinate space size (1.0×1.0 for normalized coords)
// edge: 0
typealias IndigoMouseFn = @convention(c) (
    UnsafePointer<CGPoint>, UnsafePointer<CGPoint>, UInt32, UInt, CGSize, UInt32
) -> UnsafeMutableRawPointer?

// IndigoHIDMessageForHIDArbitrary(target, usagePage, usage, op) -> IndigoHIDMessageStruct*
// Used for hardware button injection (volume, power, action, mute).
// op: 1=down, 2=up. target: 0x32 (same digitizer target as touch).
typealias IndigoHIDArbitraryFn = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?

// IndigoHIDMessageForButton(buttonCode, op, target) -> IndigoHIDMessageStruct*
// Legacy button path — used for home (code=0) and lock (code=1) buttons.
// op: 1=down, 2=up. target: 0x33.
typealias IndigoHIDButtonFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?

func requireSym<T>(_ handle: UnsafeMutableRawPointer?, _ name: String) -> T {
    guard let sym = dlsym(handle, name) else {
        fputs("error: symbol not found: \(name)\n", stderr)
        exit(1)
    }
    return unsafeBitCast(sym, to: T.self)
}

let indigoMouse: IndigoMouseFn = requireSym(skHandle, "IndigoHIDMessageForMouseNSEvent")

let indigoArbitrary: IndigoHIDArbitraryFn? = {
    guard let sym = dlsym(skHandle, "IndigoHIDMessageForHIDArbitrary") else {
        fputs("warn: IndigoHIDMessageForHIDArbitrary not found — HID button injection disabled\n", stderr)
        return nil
    }
    return unsafeBitCast(sym, to: IndigoHIDArbitraryFn.self)
}()

let indigoButton: IndigoHIDButtonFn? = {
    guard let sym = dlsym(skHandle, "IndigoHIDMessageForButton") else {
        fputs("warn: IndigoHIDMessageForButton not found — legacy button injection disabled\n", stderr)
        return nil
    }
    return unsafeBitCast(sym, to: IndigoHIDButtonFn.self)
}()

// MARK: - ObjC runtime helpers

func classInvoke(_ cls: AnyClass, _ sel: Selector, _ arg: AnyObject,
                 err: inout NSError?) -> NSObject? {
    guard let meta = object_getClass(cls),
          let imp  = class_getMethodImplementation(meta, sel) else { return nil }
    typealias Fn = @convention(c) (AnyClass, Selector, AnyObject,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(cls, sel, arg, &err) as? NSObject
}

func instanceInvoke(_ obj: NSObject, _ sel: Selector,
                    err: inout NSError?) -> NSObject? {
    guard let imp = class_getMethodImplementation(type(of: obj), sel) else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(obj, sel, &err) as? NSObject
}

// MARK: - Device resolution

func resolveDevice(udid: String) -> NSObject? {
    guard let cls = NSClassFromString("SimServiceContext") else { return nil }
    var err: NSError?
    guard let ctx = classInvoke(cls,
        NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
        developerDir as NSString, err: &err) else { return nil }
    guard let set = instanceInvoke(ctx,
        NSSelectorFromString("defaultDeviceSetWithError:"), err: &err) else { return nil }
    let devices = (set.value(forKey: "availableDevices") as? [NSObject]) ?? []
    if udid == "booted" {
        return devices.first { ($0.value(forKey: "state") as? NSNumber)?.uintValue == 3 }
    }
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
}

guard let device = resolveDevice(udid: targetUDID) else {
    fputs("error: device not found (udid=\(targetUDID))\n", stderr)
    exit(1)
}

// MARK: - SimDeviceLegacyHIDClient

func createHIDClient(device: NSObject) -> NSObject? {
    guard let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
        fputs("error: SimDeviceLegacyHIDClient class not found\n", stderr)
        return nil
    }
    guard let metaCls = object_getClass(cls),
          let allocImp = class_getMethodImplementation(metaCls, NSSelectorFromString("alloc")) else { return nil }
    typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject
    let allocSel = NSSelectorFromString("alloc")
    let allocated = unsafeBitCast(allocImp, to: AllocFn.self)(cls, allocSel) as! NSObject

    let initSel = NSSelectorFromString("initWithDevice:error:")
    guard let initImp = class_getMethodImplementation(type(of: allocated), initSel) else { return nil }
    typealias InitFn = @convention(c) (NSObject, Selector, NSObject,
                                       AutoreleasingUnsafeMutablePointer<NSError?>) -> NSObject?
    var initErr: NSError?
    let client = unsafeBitCast(initImp, to: InitFn.self)(allocated, initSel, device, &initErr)
    if let err = initErr {
        fputs("error: initWithDevice: \(err.localizedDescription)\n", stderr)
    }
    return client
}

guard let hidClient = createHIDClient(device: device) else {
    fputs("error: failed to create SimDeviceLegacyHIDClient\n", stderr)
    exit(1)
}
fputs("info: touch-helper ready (udid=\(targetUDID))\n", stderr)

// MARK: - sendWithMessage IMP

let sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
guard let sendImp = class_getMethodImplementation(type(of: hidClient), sendSel) else {
    fputs("error: sendWithMessage:freeWhenDone:completionQueue:completion: not found\n", stderr)
    exit(1)
}
typealias SendFn = @convention(c) (NSObject, Selector, UnsafeMutableRawPointer, Bool,
                                   AnyObject?, AnyObject?) -> Void
let sendMsg = unsafeBitCast(sendImp, to: SendFn.self)

// MARK: - Touch injection

// NSEventType (NSUInteger) raw values
let kNSLeftMouseDown: UInt    = 1
let kNSLeftMouseUp: UInt      = 2
let kNSLeftMouseDragged: UInt = 6

// IndigoHIDTarget for digitizer/touch (from SimulatorKit + baguette analysis)
let kIndigoHIDTargetDigitizer: UInt32 = 0x32

let kNormalizedSize = CGSize(width: 1.0, height: 1.0)

func inject(x: Double, y: Double, eventType: UInt) {
    var position = CGPoint(x: x, y: y)
    var delta    = CGPoint.zero

    guard let msgPtr = indigoMouse(&position, &delta, kIndigoHIDTargetDigitizer,
                                   eventType, kNormalizedSize, 0) else {
        fputs("warn: IndigoHIDMessageForMouseNSEvent returned nil\n", stderr)
        return
    }
    // freeWhenDone:YES — SimulatorKit owns and frees the message buffer
    sendMsg(hidClient, sendSel, msgPtr, true, nil, nil)
}

// MARK: - Button injection

let kIndigoHIDTargetButton: UInt32 = 0x33  // legacy button service target
let kHIDOpDown: UInt32 = 1
let kHIDOpUp:   UInt32 = 2

// HIDArbitrary: for volume, power, action, mute — uses usagePage+usage from chrome.json
func pressButton(usagePage: UInt32, usage: UInt32) {
    guard let indigoArb = indigoArbitrary else {
        fputs("warn: HID button unavailable (page=\(usagePage) usage=\(usage))\n", stderr)
        return
    }
    if let msgDown = indigoArb(kIndigoHIDTargetDigitizer, usagePage, usage, kHIDOpDown) {
        sendMsg(hidClient, sendSel, msgDown, true, nil, nil)
    }
    Thread.sleep(forTimeInterval: 0.05)
    if let msgUp = indigoArb(kIndigoHIDTargetDigitizer, usagePage, usage, kHIDOpUp) {
        sendMsg(hidClient, sendSel, msgUp, true, nil, nil)
    }
}

// Legacy button: for home (code=0) and lock (code=1)
func pressLegacyButton(code: UInt32) {
    guard let indigoBtn = indigoButton else {
        fputs("warn: legacy button unavailable (code=\(code))\n", stderr)
        return
    }
    if let msgDown = indigoBtn(code, kHIDOpDown, kIndigoHIDTargetButton) {
        sendMsg(hidClient, sendSel, msgDown, true, nil, nil)
    }
    Thread.sleep(forTimeInterval: 0.05)
    if let msgUp = indigoBtn(code, kHIDOpUp, kIndigoHIDTargetButton) {
        sendMsg(hidClient, sendSel, msgUp, true, nil, nil)
    }
}

// MARK: - Stdin read loop

var lastX: Double = 0
var lastY: Double = 0

let stdinFH = FileHandle.standardInput

DispatchQueue.global(qos: .userInteractive).async {
    while true {
        let data = stdinFH.readData(ofLength: 9)
        guard data.count == 9 else { exit(0) }

        let type = data[0]
        let xBits = data.subdata(in: 1..<5).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
        let yBits = data.subdata(in: 5..<9).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
        let x = Double(Float(bitPattern: xBits))
        let y = Double(Float(bitPattern: yBits))

        switch type {
        case 1:
            lastX = x; lastY = y
            inject(x: x, y: y, eventType: kNSLeftMouseDown)
        case 2:
            lastX = x; lastY = y
            inject(x: x, y: y, eventType: kNSLeftMouseDragged)
        case 3:
            inject(x: lastX, y: lastY, eventType: kNSLeftMouseUp)
        case 4:
            // HIDArbitrary button: bytes 1-4 = usagePage, bytes 5-8 = usage (both uint32BE)
            let usagePage = data.subdata(in: 1..<5).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
            let usage     = data.subdata(in: 5..<9).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
            pressButton(usagePage: usagePage, usage: usage)
        case 5:
            // Legacy button: bytes 1-4 = button code (uint32BE); home=0, lock=1
            let code = data.subdata(in: 1..<5).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
            pressLegacyButton(code: code)
        default: break
        }
    }
}

RunLoop.main.run()
