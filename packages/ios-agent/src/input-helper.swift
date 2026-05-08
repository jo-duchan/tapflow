// input-helper.swift
// Injects tap or swipe into iOS Simulator via CGEvent mouse injection.
// Requires Accessibility permission for the calling process.
//
// Usage:
//   input-helper tap   <compositeW> <compositeH> <screenX> <screenY> <screenW> <screenH> <normX> <normY>
//   input-helper swipe <compositeW> <compositeH> <screenX> <screenY> <screenW> <screenH> <fromX> <fromY> <toX> <toY>
//
// All geometry values are in DeviceKit composite PDF points (1x).
// normX/normY are normalized 0-1 coordinates within the screen area.

import Cocoa
import ApplicationServices

// Check Accessibility permission — required for CGEvent injection.
// If not trusted, prompt the user via the macOS system dialog (one-time).
let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
if !trusted {
    fputs("error: Accessibility permission required for touch injection.\n" +
          "  → System Settings > Privacy & Security > Accessibility → add Terminal\n" +
          "  Then retry. This is a one-time setup.\n", stderr)
    exit(1)
}

guard CommandLine.arguments.count >= 10,
      let compositeW = Double(CommandLine.arguments[2]),
      let compositeH = Double(CommandLine.arguments[3]),
      let screenX    = Double(CommandLine.arguments[4]),
      let screenY    = Double(CommandLine.arguments[5]),
      let screenW    = Double(CommandLine.arguments[6]),
      let screenH    = Double(CommandLine.arguments[7]),
      let normX      = Double(CommandLine.arguments[8]),
      let normY      = Double(CommandLine.arguments[9])
else {
    fputs("usage: input-helper tap|swipe compositeW compositeH screenX screenY screenW screenH normX normY [toNormX toNormY]\n", stderr)
    exit(1)
}

let action = CommandLine.arguments[1]
_ = NSApplication.shared

// Find the Simulator window in the on-screen window list.
// CGWindowListCopyWindowInfo returns Quartz screen coordinates (top-left origin, Y down).
let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []

guard let win = infos.first(where: {
    let owner = ($0[kCGWindowOwnerName as String] as? String) ?? ""
    let title = ($0[kCGWindowName  as String] as? String) ?? ""
    return owner.contains("Simulator") && !title.isEmpty
}), let bounds = win[kCGWindowBounds as String] as? [String: CGFloat]
else {
    fputs("error: Simulator window not found\n", stderr)
    exit(1)
}

let winX = bounds["X"] ?? 0
let winY = bounds["Y"] ?? 0
let winW = bounds["Width"] ?? 0
let winH = bounds["Height"] ?? 0

// S = Simulator zoom factor (same formula as screencapture-helper)
let S        = winW / CGFloat(compositeW)
let macOSH   = winH - CGFloat(compositeH) * S

func toScreenPt(_ nx: Double, _ ny: Double) -> CGPoint {
    CGPoint(
        x: winX + CGFloat(screenX) * S + CGFloat(nx) * CGFloat(screenW) * S,
        y: winY + macOSH + CGFloat(screenY) * S + CGFloat(ny) * CGFloat(screenH) * S
    )
}

func postDown(_ p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
}
func postDrag(_ p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
}
func postUp(_ p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
}

if action == "tap" {
    let p = toScreenPt(normX, normY)
    fputs("info: tap at (\(Int(p.x)), \(Int(p.y)))\n", stderr)
    postDown(p)
    Thread.sleep(forTimeInterval: 0.05)
    postUp(p)
} else if action == "swipe",
          CommandLine.arguments.count >= 12,
          let toNX = Double(CommandLine.arguments[10]),
          let toNY = Double(CommandLine.arguments[11]) {
    let from  = toScreenPt(normX, normY)
    let to    = toScreenPt(toNX, toNY)
    let steps = 20
    fputs("info: swipe from (\(Int(from.x)), \(Int(from.y))) to (\(Int(to.x)), \(Int(to.y)))\n", stderr)
    postDown(from)
    Thread.sleep(forTimeInterval: 0.02)
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        let mid = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        postDrag(mid)
        Thread.sleep(forTimeInterval: 0.3 / Double(steps))
    }
    postUp(to)
} else {
    fputs("error: unknown action or missing arguments\n", stderr)
    exit(1)
}
