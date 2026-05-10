// screencapture-helper.swift
// Captures iOS Simulator screen via SimulatorKit IOSurface callbacks.
// Reads com.apple.framebuffer.display directly — no window geometry needed.
//
// Usage: screencapture-helper <fps> <udid|booted>
// Output: [4-byte big-endian uint32 frame length][JPEG bytes] ...
//
// Adapted from https://github.com/tddworks/baguette (Apache-2.0)

import Foundation
import IOSurface
import CoreVideo
import CoreGraphics
import ImageIO
import ObjectiveC

// MARK: - Args

guard CommandLine.arguments.count == 3,
      let fps = Double(CommandLine.arguments[1]),
      fps > 0
else {
    fputs("usage: screencapture-helper <fps> <udid>\n", stderr)
    exit(1)
}
let targetUDID = CommandLine.arguments[2]

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
    // xcode-select may point to CLT which lacks SimulatorKit — scan /Applications
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
    if let e = dlerror() { fputs("error: CoreSimulator load failed: \(String(cString: e))\n", stderr) }
    exit(1)
}
guard dlopen((developerDir as NSString)
    .appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"),
             RTLD_NOW | RTLD_GLOBAL) != nil else {
    if let e = dlerror() { fputs("error: SimulatorKit load failed: \(String(cString: e))\n", stderr) }
    exit(1)
}

// MARK: - ObjC runtime helpers

func classInvoke(_ cls: AnyClass, _ sel: Selector, _ arg: AnyObject, err: inout NSError?) -> NSObject? {
    guard let meta = object_getClass(cls),
          let imp = class_getMethodImplementation(meta, sel) else { return nil }
    typealias Fn = @convention(c) (AnyClass, Selector, AnyObject,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(cls, sel, arg, &err) as? NSObject
}

func instanceInvoke(_ obj: NSObject, _ sel: Selector, err: inout NSError?) -> NSObject? {
    guard let imp = class_getMethodImplementation(type(of: obj), sel) else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(obj, sel, &err) as? NSObject
}

// MARK: - Device resolution

func resolveDevice(udid: String) -> NSObject? {
    guard let cls = NSClassFromString("SimServiceContext") else {
        fputs("error: SimServiceContext not found — CoreSimulator not loaded?\n", stderr)
        return nil
    }
    var err: NSError?
    guard let ctx = classInvoke(cls,
        NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
        developerDir as NSString, err: &err) else {
        fputs("error: SimServiceContext: \(err?.localizedDescription ?? "nil")\n", stderr)
        return nil
    }
    guard let set = instanceInvoke(ctx,
        NSSelectorFromString("defaultDeviceSetWithError:"), err: &err) else {
        fputs("error: defaultDeviceSet: \(err?.localizedDescription ?? "nil")\n", stderr)
        return nil
    }
    let devices = (set.value(forKey: "availableDevices") as? [NSObject]) ?? []
    if udid == "booted" {
        // CoreSimulator state 3 == booted
        return devices.first { ($0.value(forKey: "state") as? NSNumber)?.uintValue == 3 }
    }
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
}

// MARK: - IOSurface → JPEG

func encodeJPEG(_ surface: IOSurface) -> Data? {
    var raw: Unmanaged<CVPixelBuffer>?
    guard CVPixelBufferCreateWithIOSurface(
        kCFAllocatorDefault, surface,
        [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
        &raw) == kCVReturnSuccess,
          let buf = raw?.takeRetainedValue() else { return nil }

    CVPixelBufferLockBaseAddress(buf, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }

    let w = CVPixelBufferGetWidth(buf)
    let h = CVPixelBufferGetHeight(buf)
    guard let base = CVPixelBufferGetBaseAddress(buf),
          let ctx = CGContext(
              data: base, width: w, height: h,
              bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf),
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                        | CGBitmapInfo.byteOrder32Little.rawValue),
          let image = ctx.makeImage()
    else { return nil }

    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(dest, image,
        [kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? (out as Data) : nil
}

// MARK: - Frame output

let stdoutFH = FileHandle.standardOutput
let writeQueue = DispatchQueue(label: "com.tapflow.write", qos: .userInitiated)

func writeFrame(_ jpeg: Data) {
    writeQueue.async {
        var len = UInt32(jpeg.count).bigEndian
        withUnsafeBytes(of: &len) { stdoutFH.write(Data($0)) }
        stdoutFH.write(jpeg)
    }
}

// MARK: - Framebuffer setup

guard let device = resolveDevice(udid: targetUDID) else {
    fputs("error: device not found (udid=\(targetUDID)) — is the simulator booted?\n", stderr)
    exit(1)
}

// Retry acquiring device.io — it may not be available immediately when multiple
// simulators are booting simultaneously (e.g. iOS 17.x + iOS 18+ co-boot)
var io: NSObject?
for attempt in 1...10 {
    io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject
    if io != nil { break }
    fputs("info: device.io not ready (attempt \(attempt)/10), retrying in 300ms...\n", stderr)
    Thread.sleep(forTimeInterval: 0.3)
}
guard let io else {
    fputs("error: device.io unavailable — is the simulator fully booted?\n", stderr)
    exit(1)
}

// Retry updateIOPorts — older runtimes (iOS 17.x) may need multiple calls
// before deviceIOPorts is populated when another simulator is already active
var ports: [NSObject] = []
for attempt in 1...15 {
    io.perform(NSSelectorFromString("updateIOPorts"))
    ports = (io.value(forKey: "deviceIOPorts") as? [NSObject]) ?? []
    if !ports.isEmpty { break }
    fputs("info: deviceIOPorts empty (attempt \(attempt)/15), retrying in 500ms...\n", stderr)
    Thread.sleep(forTimeInterval: 0.5)
}
guard !ports.isEmpty else {
    fputs("error: deviceIOPorts not available after retries\n", stderr)
    exit(1)
}

let pidSel  = NSSelectorFromString("portIdentifier")
let descSel = NSSelectorFromString("descriptor")
let surfSel = NSSelectorFromString("framebufferSurface")

var descriptors: [NSObject] = []
for port in ports where port.responds(to: pidSel) {
    guard let pid = port.perform(pidSel)?.takeUnretainedValue(),
          "\(pid)" == "com.apple.framebuffer.display",
          port.responds(to: descSel),
          let desc = port.perform(descSel)?.takeUnretainedValue() as? NSObject,
          desc.responds(to: surfSel)
    else { continue }
    descriptors.append(desc)
}

guard !descriptors.isEmpty else {
    fputs("error: no com.apple.framebuffer.display port — is the simulator booted?\n", stderr)
    exit(1)
}

// MARK: - Capture loop
//
// Strategy: IOSurface callbacks update `latestSurface` whenever the framebuffer
// changes. A DispatchSourceTimer emits JPEG frames at the configured FPS,
// reading `latestSurface` each tick. This guarantees smooth FPS even when
// the simulator screen is static (no callbacks firing).

let captureQueue = DispatchQueue(label: "com.tapflow.capture", qos: .userInteractive)
var latestSurface: IOSurface?
var callbackBlocks: [AnyObject] = []  // retain ObjC blocks

func updateLatestSurface() {
    var best: IOSurface?
    var bestArea = 0
    for desc in descriptors {
        guard let obj = desc.perform(surfSel)?.takeUnretainedValue() else { continue }
        let surf = unsafeBitCast(obj, to: IOSurface.self)
        let area = IOSurfaceGetWidth(surf) * IOSurfaceGetHeight(surf)
        if area > bestArea { best = surf; bestArea = area }
    }
    if let best { latestSurface = best }
}

let regSel = NSSelectorFromString(
    "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:" +
    "surfacesChangedCallback:propertiesChangedCallback:"
)

for desc in descriptors where desc.responds(to: regSel) {
    guard let imp = class_getMethodImplementation(type(of: desc), regSel) else { continue }
    let uuid = NSUUID()
    let onFrame:    @convention(block) () -> Void = { captureQueue.async { updateLatestSurface() } }
    let onSurfaces: @convention(block) () -> Void = { captureQueue.async { updateLatestSurface() } }
    let onProps:    @convention(block) () -> Void = {}
    callbackBlocks += [onFrame as AnyObject, onSurfaces as AnyObject, onProps as AnyObject]
    typealias RegFn = @convention(c) (
        AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject) -> Void
    unsafeBitCast(imp, to: RegFn.self)(
        desc, regSel,
        uuid, captureQueue as AnyObject,
        onFrame as AnyObject, onSurfaces as AnyObject, onProps as AnyObject)
}

// Seed latestSurface — retry for older runtimes where the surface may not be
// readable immediately after port enumeration (iOS 17.x co-boot scenario)
captureQueue.sync {
    for attempt in 1...10 {
        updateLatestSurface()
        if latestSurface != nil { break }
        fputs("info: framebufferSurface nil (attempt \(attempt)/10), retrying in 300ms...\n", stderr)
        Thread.sleep(forTimeInterval: 0.3)
    }
}
if latestSurface == nil {
    fputs("warning: initial framebufferSurface seed failed — relying on callbacks\n", stderr)
}

// Watchdog: exit(1) if no frames produced within 8 seconds of startup.
// This lets ScreenCaptureStreamer surface the error so the agent can clean up.
var firstFrameSent = false
DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
    guard !firstFrameSent else { return }
    fputs("error: no frames produced within 8s — framebuffer may be unavailable\n", stderr)
    exit(1)
}

// Timer-driven emission: fires at the target FPS and encodes the latest surface
let timer = DispatchSource.makeTimerSource(queue: captureQueue)
timer.schedule(deadline: .now(), repeating: 1.0 / fps)
timer.setEventHandler {
    guard let surf = latestSurface, let jpeg = encodeJPEG(surf) else { return }
    firstFrameSent = true
    writeFrame(jpeg)
}
timer.resume()

fputs("info: streaming started (\(Int(fps))fps, udid=\(targetUDID))\n", stderr)
RunLoop.main.run()
