// keyboard-helper.swift
// Toggles iOS Simulator software keyboard via CoreSimulator SimDevice API.
// No macOS Accessibility permission required.
//
// Usage: keyboard-helper <show|hide> <udid|booted>
//
// show: setHardwareKeyboardEnabled(false) — disconnects hardware keyboard,
//       software keyboard appears on next text-field focus.
// hide: setHardwareKeyboardEnabled(true)  — connects hardware keyboard,
//       software keyboard is dismissed immediately.

import Foundation
import ObjectiveC

guard CommandLine.arguments.count == 3,
      ["show", "hide"].contains(CommandLine.arguments[1]) else {
    fputs("usage: keyboard-helper <show|hide> <udid|booted>\n", stderr)
    exit(1)
}

let action   = CommandLine.arguments[1]
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

// MARK: - setHardwareKeyboardEnabled

// - (BOOL)setHardwareKeyboardEnabled:(BOOL)enabled keyboardType:(NSInteger)keyboardType error:(NSError **)error
typealias SetHwKbdFn = @convention(c) (
    NSObject,
    Selector,
    Bool,   // enabled
    Int,    // keyboardType (0 = default)
    AutoreleasingUnsafeMutablePointer<NSError?>
) -> Bool

let sel = NSSelectorFromString("setHardwareKeyboardEnabled:keyboardType:error:")
guard let imp = class_getMethodImplementation(type(of: device), sel) else {
    fputs("error: setHardwareKeyboardEnabled:keyboardType:error: not found on SimDevice\n", stderr)
    exit(1)
}

// show → hardware disabled (false) → software keyboard appears on focus
// hide → hardware enabled  (true)  → software keyboard dismissed
let hwEnabled = (action == "hide")
var kbdErr: NSError?
let ok = unsafeBitCast(imp, to: SetHwKbdFn.self)(device, sel, hwEnabled, 0, &kbdErr)

if let e = kbdErr {
    fputs("error: \(e.localizedDescription)\n", stderr)
    exit(1)
}
if !ok {
    fputs("error: setHardwareKeyboardEnabled returned false\n", stderr)
    exit(1)
}
