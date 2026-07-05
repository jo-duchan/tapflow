// accessibility-helper: reads the iOS UI tree of a booted simulator via the
// macOS AXUIElement API applied to the Simulator.app process — no WebDriverAgent,
// nothing installed inside the device.
//
// Usage: accessibility-helper <deviceName>
//   deviceName matches the Simulator window title prefix ("iPhone 16 Pro – iOS 18.5").
//
// Output (stdout, single JSON object):
//   { "elements": [ { "role", "subrole"?, "label", "identifier"?, "value"?,
//                     "enabled", "frame": { x, y, width, height } } ] }
//   Frames are normalized 0-1 relative to the device screen (the window's
//   AXGroup with subrole "iOSContentGroup"), so they match the touch path's
//   coordinate space directly.
//
// Exit codes: 0 ok · 2 Accessibility permission missing · 3 Simulator window
// not found · 4 device screen group not found inside the window.

import AppKit
import ApplicationServices

let MAX_DEPTH = 100
let MAX_ELEMENTS = 5000

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func stringAttr(_ el: AXUIElement, _ name: String) -> String? {
    attr(el, name) as? String
}

func frameOf(_ el: AXUIElement) -> CGRect? {
    guard let posV = attr(el, kAXPositionAttribute), let sizeV = attr(el, kAXSizeAttribute) else { return nil }
    var pos = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posV as! AXValue, .cgPoint, &pos),
          AXValueGetValue(sizeV as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: pos, size: size)
}

func childrenOf(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

guard AXIsProcessTrusted() else {
    fail(2, "NOT_TRUSTED: macOS Accessibility permission is required")
}

guard CommandLine.arguments.count > 1 else {
    fail(64, "usage: accessibility-helper <deviceName>")
}
let deviceName = CommandLine.arguments[1]

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first else {
    fail(3, "Simulator.app is not running")
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
guard let windows = attr(axApp, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty else {
    fail(3, "Simulator.app has no windows (is the device window visible?)")
}

// Window titles look like "iPhone 16 Pro – iOS 18.5". Prefix-match the device
// name; fall back to the only window when just one device is open.
let titled = windows.map { (win: $0, title: stringAttr($0, kAXTitleAttribute) ?? "") }
let window: AXUIElement
if let match = titled.first(where: { $0.title == deviceName || $0.title.hasPrefix(deviceName + " ") }) {
    window = match.win
} else if windows.count == 1 {
    window = windows[0]
} else {
    fail(3, "no Simulator window matches \"\(deviceName)\" (open: \(titled.map { $0.title }.joined(separator: ", ")))")
}

// The device screen is the window child AXGroup with subrole iOSContentGroup —
// its frame is the normalization basis, and Simulator chrome (hardware buttons,
// toolbar) lives outside it so traversal never sees non-device elements.
func findContentGroup(_ el: AXUIElement, depth: Int) -> AXUIElement? {
    if stringAttr(el, kAXSubroleAttribute) == "iOSContentGroup" { return el }
    if depth >= 4 { return nil }
    for child in childrenOf(el) {
        if let found = findContentGroup(child, depth: depth + 1) { return found }
    }
    return nil
}

guard let content = findContentGroup(window, depth: 0), let screen = frameOf(content),
      screen.width > 0, screen.height > 0 else {
    fail(4, "device screen (iOSContentGroup) not found in the Simulator window")
}

var elements: [[String: Any]] = []

func visit(_ el: AXUIElement, depth: Int) {
    if depth > MAX_DEPTH || elements.count >= MAX_ELEMENTS { return }

    if let f = frameOf(el), f.width > 0, f.height > 0 {
        // Normalize against the device screen; clamp so partially scrolled-out
        // rows stay tappable and fully outside elements are dropped.
        let x0 = max((f.minX - screen.minX) / screen.width, 0)
        let y0 = max((f.minY - screen.minY) / screen.height, 0)
        let x1 = min((f.maxX - screen.minX) / screen.width, 1)
        let y1 = min((f.maxY - screen.minY) / screen.height, 1)
        if x1 > x0 && y1 > y0 {
            let role = stringAttr(el, kAXRoleAttribute) ?? ""
            var entry: [String: Any] = [
                "role": role,
                "frame": ["x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0],
                "enabled": (attr(el, kAXEnabledAttribute) as? Bool) ?? true,
            ]
            if let subrole = stringAttr(el, kAXSubroleAttribute) { entry["subrole"] = subrole }
            let label = stringAttr(el, kAXDescriptionAttribute) ?? stringAttr(el, kAXTitleAttribute) ?? ""
            entry["label"] = label
            if let ident = stringAttr(el, "AXIdentifier"), !ident.isEmpty { entry["identifier"] = ident }
            if let value = attr(el, kAXValueAttribute) as? String, !value.isEmpty { entry["value"] = value }
            if role != "AXGroup" || !label.isEmpty {
                elements.append(entry)
            }
        }
    }

    for child in childrenOf(el) {
        visit(child, depth: depth + 1)
    }
}

for child in childrenOf(content) {
    visit(child, depth: 0)
}

let out: [String: Any] = ["elements": elements]
let data = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
