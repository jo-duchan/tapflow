// keyboard-helper.swift
// Toggles iOS Simulator software keyboard via CoreSimulator SimDevice API.
// No macOS Accessibility permission required.
//
// Single-shot:  keyboard-helper <show|hide> <udid|booted>
// Daemon mode:  keyboard-helper --daemon
//   stdin:  "show <udid>\n"  |  "hide <udid>\n"
//   stdout: "ok\n"           |  "err <message>\n"
//
// show: setHardwareKeyboardEnabled(false) — disconnects hardware keyboard,
//       software keyboard appears on next text-field focus.
// hide: setHardwareKeyboardEnabled(true)  — connects hardware keyboard,
//       software keyboard is dismissed immediately.
// Both modes kickstart com.apple.kbd after toggling so iOS re-syncs the
// active input source, preventing HW↔SW context mismatch on repeated toggles.

import Foundation
import ObjectiveC

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

// MARK: - Shared context (initialized once per process)

let developerDir = findDeveloperDir()

guard let simCtxCls = NSClassFromString("SimServiceContext") else {
    fputs("error: SimServiceContext class not found\n", stderr)
    exit(1)
}

var ctxErr: NSError?
guard let sharedCtx = classInvoke(simCtxCls,
    NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
    developerDir as NSString, err: &ctxErr) else {
    fputs("error: sharedServiceContextForDeveloperDir: \(ctxErr?.localizedDescription ?? "nil")\n", stderr)
    exit(1)
}

// MARK: - Device resolution (called per command to handle reboots)

func resolveDevice(udid: String) -> NSObject? {
    var err: NSError?
    guard let set = instanceInvoke(sharedCtx,
        NSSelectorFromString("defaultDeviceSetWithError:"), err: &err) else { return nil }
    let devices = (set.value(forKey: "availableDevices") as? [NSObject]) ?? []
    if udid == "booted" {
        return devices.first { ($0.value(forKey: "state") as? NSNumber)?.uintValue == 3 }
    }
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
}

// MARK: - setHardwareKeyboardEnabled IMP (resolved once)

typealias SetHwKbdFn = @convention(c) (
    NSObject, Selector,
    Bool,   // enabled
    Int,    // keyboardType (0 = default)
    AutoreleasingUnsafeMutablePointer<NSError?>
) -> Bool

let hwKbdSel = NSSelectorFromString("setHardwareKeyboardEnabled:keyboardType:error:")

// Resolve IMP lazily from the first device we can find (class method lookup).
func resolveSetHwKbdImp(device: NSObject) -> IMP? {
    class_getMethodImplementation(type(of: device), hwKbdSel)
}

// MARK: - kickstart com.apple.kbd

// Re-syncs the iOS input source after HW keyboard enable state changes.
// Prevents the HW↔SW toggle from leaving the active input source in a stale state.
func kickstartKbd(udid: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    task.arguments = ["simctl", "spawn", udid, "launchctl", "kickstart", "-k", "system/com.apple.kbd"]
    task.standardOutput = FileHandle.nullDevice
    task.standardError  = FileHandle.nullDevice
    try? task.run()
    // fire-and-forget — errors are expected on some iOS versions
}

// MARK: - Toggle logic

func toggle(action: String, udid: String) -> String {
    guard let device = resolveDevice(udid: udid) else {
        return "err device not found (udid=\(udid))"
    }
    guard let imp = resolveSetHwKbdImp(device: device) else {
        return "err setHardwareKeyboardEnabled:keyboardType:error: not found"
    }
    let hwEnabled = (action == "hide")
    var kbdErr: NSError?
    let ok = unsafeBitCast(imp, to: SetHwKbdFn.self)(device, hwKbdSel, hwEnabled, 0, &kbdErr)
    if let e = kbdErr { return "err \(e.localizedDescription)" }
    if !ok { return "err setHardwareKeyboardEnabled returned false" }
    kickstartKbd(udid: udid)
    return "ok"
}

// MARK: - Entry point

let args = CommandLine.arguments

if args.count == 2 && args[1] == "--daemon" {
    // Daemon mode: read commands from stdin, write responses to stdout.
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        let parts = trimmed.split(separator: " ", maxSplits: 1).map(String.init)
        guard parts.count == 2, ["show", "hide"].contains(parts[0]) else {
            print("err invalid command: \(trimmed)")
            fflush(stdout)
            continue
        }
        let response = toggle(action: parts[0], udid: parts[1])
        print(response)
        fflush(stdout)
    }
} else if args.count == 3, ["show", "hide"].contains(args[1]) {
    // Single-shot mode (backward compatible).
    let result = toggle(action: args[1], udid: args[2])
    if result.hasPrefix("err") {
        fputs("\(result)\n", stderr)
        exit(1)
    }
} else {
    fputs("usage: keyboard-helper <show|hide> <udid|booted>\n", stderr)
    fputs("       keyboard-helper --daemon\n", stderr)
    exit(1)
}
