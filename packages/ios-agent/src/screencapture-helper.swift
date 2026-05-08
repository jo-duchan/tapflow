// screencapture-helper.swift
// Captures ONLY the iOS screen content (no bezel/chrome) from the Simulator window.
// Writes length-prefixed JPEG frames to stdout.
//
// Frame format: [4 bytes big-endian uint32 = JPEG byte length][JPEG bytes]
// Usage: screencapture-helper <fps> <compositeW> <compositeH> <screenX> <screenY> <screenW> <screenH>
//   All dimensions are in DeviceKit composite PDF points (1x).

import ScreenCaptureKit
import AppKit
import Foundation
import ImageIO

guard CommandLine.arguments.count == 8,
      let fps        = Double(CommandLine.arguments[1]),
      let compositeW = Double(CommandLine.arguments[2]),
      let compositeH = Double(CommandLine.arguments[3]),
      let screenX    = Double(CommandLine.arguments[4]),
      let screenY    = Double(CommandLine.arguments[5]),
      let screenW    = Double(CommandLine.arguments[6]),
      let screenH    = Double(CommandLine.arguments[7])
else {
    fputs("usage: screencapture-helper <fps> <compositeW> <compositeH> <screenX> <screenY> <screenW> <screenH>\n", stderr)
    exit(1)
}

let stdout = FileHandle.standardOutput
_ = NSApplication.shared

func writeFrame(_ jpeg: Data) {
    var len = UInt32(jpeg.count).bigEndian
    withUnsafeBytes(of: &len) { stdout.write(Data($0)) }
    stdout.write(jpeg)
}

func encodeJPEG(_ image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? (data as Data) : nil
}

let setupSema = DispatchSemaphore(value: 0)
var sharedFilter: SCContentFilter?
var sharedConfig: SCStreamConfiguration?

SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
    defer { setupSema.signal() }
    guard error == nil, let window = content?.windows.first(where: {
        $0.owningApplication?.applicationName.contains("Simulator") == true &&
        $0.title?.isEmpty == false
    }) else {
        fputs("error: Simulator window not found\n", stderr); exit(1)
    }

    let winW = window.frame.width
    let winH = window.frame.height

    // S = Simulator zoom scale factor (window width = composite PDF width × S)
    // Works correctly at any zoom level (Point Accurate, Fit to Screen, Pixel Accurate, etc.)
    let S = winW / compositeW
    let macOSChromeH = winH - compositeH * S   // macOS title bar + Simulator toolbar height

    let cropX = screenX * S
    let cropY = macOSChromeH + screenY * S
    let cropW = screenW * S
    let cropH = screenH * S
    let screenRect = CGRect(x: cropX, y: cropY, width: cropW, height: cropH)

    fputs("info: window=\(Int(winW))x\(Int(winH)) S=\(String(format: "%.3f", S)) macOSChrome=\(Int(macOSChromeH)) crop=\(screenRect) at \(Int(fps))fps\n", stderr)

    sharedFilter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    config.showsCursor = false
    config.sourceRect = screenRect
    // Capture at 2x for retina quality
    config.width  = Int(screenW) * 2
    config.height = Int(screenH) * 2
    sharedConfig = config
}
setupSema.wait()

guard let filter = sharedFilter, let config = sharedConfig else { exit(1) }

let runSema = DispatchSemaphore(value: 0)

for _ in 0..<3 {
    func loop() {
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, _ in
            if let image = image, let jpeg = encodeJPEG(image) {
                writeFrame(jpeg)
            }
            loop()
        }
    }
    loop()
}

runSema.wait()
