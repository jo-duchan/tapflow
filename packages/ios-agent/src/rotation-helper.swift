// rotation-helper.swift
// Rotates iOS Simulator via GSEvent over PurpleWorkspacePort.
// No Simulator.app required. No Accessibility permission required.
//
// Usage: rotation-helper <portrait|landscapeLeft|landscapeRight|portraitUpsideDown> <udid|booted>
//
// UIDeviceOrientation rawValues sent in the GSEvent record:
//   portrait             = 1  (home button bottom)
//   portraitUpsideDown   = 2  (home button top)
//   landscapeRight       = 3  (home button right)
//   landscapeLeft        = 4  (home button left)

import Foundation
import ObjectiveC

let ORIENTATIONS: [String: UInt32] = [
    "portrait":           1,
    "portraitUpsideDown": 2,
    "landscapeRight":     3,
    "landscapeLeft":      4,
]

guard CommandLine.arguments.count == 3,
      let orientationValue = ORIENTATIONS[CommandLine.arguments[1]] else {
    fputs("usage: rotation-helper <portrait|landscapeLeft|landscapeRight|portraitUpsideDown> <udid|booted>\n", stderr)
    exit(1)
}

let targetUD = CommandLine.arguments[2]

// MARK: - Developer dir

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
    return dir.isEmpty ? "/Applications/Xcode.app/Contents/Developer" : dir
}

let developerDir = findDeveloperDir()

// MARK: - Load CoreSimulator

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
             RTLD_NOW | RTLD_GLOBAL) != nil else {
    if let e = dlerror() { fputs("error: CoreSimulator: \(String(cString: e))\n", stderr) }
    exit(1)
}

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
    guard let cls = NSClassFromString("SimServiceContext") else {
        fputs("error: SimServiceContext class not found\n", stderr)
        return nil
    }
    var err: NSError?
    guard let ctx = classInvoke(cls,
        NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
        developerDir as NSString, err: &err) else {
        fputs("error: sharedServiceContextForDeveloperDir: \(err?.localizedDescription ?? "nil")\n", stderr)
        return nil
    }
    guard let set = instanceInvoke(ctx,
        NSSelectorFromString("defaultDeviceSetWithError:"), err: &err) else {
        fputs("error: defaultDeviceSetWithError: \(err?.localizedDescription ?? "nil")\n", stderr)
        return nil
    }
    let devices = (set.value(forKey: "availableDevices") as? [NSObject]) ?? []
    if udid == "booted" {
        return devices.first { ($0.value(forKey: "state") as? NSNumber)?.uintValue == 3 }
    }
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
}

guard let device = resolveDevice(udid: targetUD) else {
    fputs("error: device not found (udid=\(targetUD))\n", stderr)
    exit(1)
}

// MARK: - Lookup PurpleWorkspacePort
//
// SimDevice exposes mach port names via:
//   - (mach_port_t)lookup:(NSString *)portName error:(NSError **)error

typealias LookupFn = @convention(c) (
    NSObject, Selector, AnyObject,
    AutoreleasingUnsafeMutablePointer<NSError?>
) -> UInt32  // mach_port_t

let lookupSel = NSSelectorFromString("lookup:error:")
guard let lookupImp = class_getMethodImplementation(type(of: device), lookupSel) else {
    fputs("error: lookup:error: not found on SimDevice\n", stderr)
    exit(1)
}

var lookupErr: NSError?
let port = unsafeBitCast(lookupImp, to: LookupFn.self)(
    device, lookupSel, "PurpleWorkspacePort" as NSString, &lookupErr)

guard port != 0 else {
    fputs("error: PurpleWorkspacePort not found: \(lookupErr?.localizedDescription ?? "port=0")\n", stderr)
    exit(1)
}

// MARK: - Build and send GSEvent mach message
//
// Wire format (112-byte buffer, little-endian, msgh_size = 108):
//
//   0x00  msgh_bits         = 0x13  (MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0))
//   0x04  msgh_size         = 108
//   0x08  msgh_remote_port  = <PurpleWorkspacePort>
//   0x0C  msgh_local_port   = MACH_PORT_NULL
//   0x10  msgh_voucher_port = 0
//   0x14  msgh_id           = 0x7B (GSEventMachMessageID)
//   0x18  GSEvent.type      = 50 | 0x20000 (GSEventTypeDeviceOrientationChanged | GSEventHostFlag)
//   0x1C–0x47               = 0 (subtype, location, timestamp, windowLevel, flags, etc.)
//   0x48  record_info_size  = 4
//   0x4C  record_info_data  = UIDeviceOrientation rawValue

var msg = [UInt8](repeating: 0, count: 112)

func w32(le value: UInt32, at offset: Int) {
    msg[offset]   = UInt8(value & 0xFF)
    msg[offset+1] = UInt8((value >> 8) & 0xFF)
    msg[offset+2] = UInt8((value >> 16) & 0xFF)
    msg[offset+3] = UInt8((value >> 24) & 0xFF)
}

w32(le: 0x00000013,        at: 0x00)  // msgh_bits
w32(le: 108,               at: 0x04)  // msgh_size
w32(le: port,              at: 0x08)  // msgh_remote_port
w32(le: 0x0000007B,        at: 0x14)  // msgh_id: GSEventMachMessageID
w32(le: 50 | 0x00020000,   at: 0x18)  // GSEvent type
w32(le: 4,                 at: 0x48)  // record_info_size
w32(le: orientationValue,  at: 0x4C)  // UIDeviceOrientation rawValue

let kr = msg.withUnsafeMutableBytes { rawPtr in
    mach_msg(
        rawPtr.baseAddress!.assumingMemoryBound(to: mach_msg_header_t.self),
        MACH_SEND_MSG,
        108,
        0,
        mach_port_t(MACH_PORT_NULL),
        MACH_MSG_TIMEOUT_NONE,
        mach_port_t(MACH_PORT_NULL)
    )
}

if kr != KERN_SUCCESS {
    fputs("error: mach_msg failed (kr=\(kr))\n", stderr)
    exit(1)
}
