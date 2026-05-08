// screencapture-helper.swift
// Captures ONLY the iOS screen content (no bezel/chrome) from the Simulator window.
// Writes length-prefixed JPEG frames to stdout.
//
// Frame format: [4 bytes big-endian uint32 = JPEG byte length][JPEG bytes]
// Usage: screencapture-helper <fps> <ios_width> <ios_height>

import ScreenCaptureKit
import AppKit
import Foundation
import ImageIO

guard CommandLine.arguments.count == 4,
      let fps       = Double(CommandLine.arguments[1]),
      let iosWidth  = Double(CommandLine.arguments[2]),
      let iosHeight = Double(CommandLine.arguments[3])
else {
    fputs("usage: screencapture-helper <fps> <ios_width> <ios_height>\n", stderr)
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

    // Calculate the iOS screen rect within the Simulator window.
    // The device bezel is symmetric left/right and bottom; top also has the Simulator toolbar.
    let hInset = (winW - iosWidth) / 2          // horizontal bezel width
    let bInset = hInset                          // bottom bezel ≈ horizontal bezel
    let tInset = winH - iosHeight - bInset       // top chrome (titlebar + device top)
    let screenRect = CGRect(x: hInset, y: tInset, width: iosWidth, height: iosHeight)

    fputs("info: window=\(Int(winW))x\(Int(winH)) ios=\(Int(iosWidth))x\(Int(iosHeight)) crop=\(screenRect) at \(Int(fps))fps\n", stderr)

    sharedFilter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    // sourceRect crops the capture to just the iOS screen area
    config.sourceRect = screenRect
    // Output at 2x logical resolution for retina quality
    config.width  = Int(iosWidth)  * 2
    config.height = Int(iosHeight) * 2
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
