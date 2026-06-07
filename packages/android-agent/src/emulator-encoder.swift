// emulator-encoder.swift
// Host-side H.264 encoder for the Android emulator: reads raw RGBA8888 frames (captured by the
// TS gRPC client from the emulator's streamScreenshot) and encodes them with Mac VideoToolbox,
// bypassing the emulator's slow guest software H.264 encoder. Mirrors ios-agent's VT path so
// both platforms share one encode pipeline (baseline, B-frames off, BT.709, force-IDR on demand).
//
// Usage: emulator-encoder <fps>
//
// stdin protocol (length-delimited, big-endian):
//   frame:     [0x00][width:u32][height:u32][len:u32][RGBA8888 bytes (len)]
//   force-IDR: [0x01]                          — re-encode the last frame as a keyframe
// stdout framing (matches screencapture-helper h264): [len:u32][flags:u8][Annex B NALs]
//   len counts the flags byte; flags bit0 = keyframe (IDR, carries SPS+PPS).
//
// The emulator's screenshot stream is frame-driven (no frames while static), so — unlike iOS —
// this encoder needs no seed-based static-skip: it simply encodes whatever arrives.

import Foundation
import CoreVideo
import VideoToolbox
import CoreMedia
import Darwin

let args = CommandLine.arguments
guard args.count == 2, let fps = Double(args[1]), fps > 0 else {
    fputs("usage: emulator-encoder <fps>\n", stderr)
    exit(1)
}

// H.264 average bitrate (bits/s), soft target. Matches the iOS/scrcpy 8 Mbps cap so scroll
// bursts fit a WiFi LAN without sustained relay backpressure. Tunable via env.
let h264Bitrate: Int = {
    guard let raw = ProcessInfo.processInfo.environment["TAPFLOW_ANDROID_H264_BITRATE"],
          let b = Int(raw), b > 0 else { return 8_000_000 }
    return b
}()
let h264Timescale = Int32(max(1, Int(fps)))

// MARK: - Output (stdout), serialized off the VT callback thread

let stdoutFH = FileHandle.standardOutput
let writeQueue = DispatchQueue(label: "com.tapflow.android.write", qos: .userInitiated)

func writeFrameWithFlags(_ payload: Data, flags: UInt8) {
    writeQueue.async {
        var len = UInt32(payload.count + 1).bigEndian
        withUnsafeBytes(of: &len) { stdoutFH.write(Data($0)) }
        stdoutFH.write(Data([flags]))
        stdoutFH.write(payload)
    }
}

// MARK: - VideoToolbox H.264 (identical config to ios-agent's screencapture-helper)

var h264Session: VTCompressionSession?
var h264Width = 0
var h264Height = 0
var h264FrameIndex: Int64 = 0
var didForceInitialIDR = false

let h264OutputCallback: VTCompressionOutputCallback = { _, _, status, _, sampleBuffer in
    guard status == noErr, let sample = sampleBuffer, CMSampleBufferDataIsReady(sample) else { return }

    var keyframe = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[CFString: Any]], let first = attachments.first,
       let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
        keyframe = !notSync
    }

    let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
    var out = Data()

    // Prepend SPS/PPS on keyframes so (re)joiners can start decoding.
    if keyframe, let fmt = CMSampleBufferGetFormatDescription(sample) {
        var idx = 0
        var setCount = 0
        repeat {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            let s = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fmt, parameterSetIndex: idx,
                parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
                parameterSetCountOut: &setCount, nalUnitHeaderLengthOut: nil)
            if s != noErr || ptr == nil { break }
            out.append(contentsOf: startCode)
            out.append(ptr!, count: size)
            idx += 1
        } while idx < setCount
    }

    // AVCC (4-byte length-prefixed) NALs → Annex B start codes.
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
    var totalLength = 0
    var dataPtr: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &dataPtr) == noErr,
          let base = dataPtr else { return }
    let bytes = UnsafeRawPointer(base).assumingMemoryBound(to: UInt8.self)
    var offset = 0
    while offset + 4 <= totalLength {
        var nalLen: UInt32 = 0
        memcpy(&nalLen, bytes + offset, 4)
        nalLen = CFSwapInt32BigToHost(nalLen)
        offset += 4
        if nalLen == 0 || offset + Int(nalLen) > totalLength { break }
        out.append(contentsOf: startCode)
        out.append(UnsafeBufferPointer(start: bytes + offset, count: Int(nalLen)))
        offset += Int(nalLen)
    }

    writeFrameWithFlags(out, flags: keyframe ? 0x01 : 0x00)
}

func setupH264Session(width: Int, height: Int) -> Bool {
    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(width), height: Int32(height),
        codecType: kCMVideoCodecType_H264,
        encoderSpecification: nil, imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: h264OutputCallback, refcon: nil,
        compressionSessionOut: &session)
    guard status == noErr, let s = session else {
        fputs("error: VTCompressionSessionCreate failed (\(status))\n", stderr)
        return false
    }
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel,
                         value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                         value: NSNumber(value: Int(fps) * 2))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                         value: NSNumber(value: 2.0))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate,
                         value: NSNumber(value: h264Bitrate))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ColorPrimaries,
                         value: kCVImageBufferColorPrimaries_ITU_R_709_2)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_TransferFunction,
                         value: kCVImageBufferTransferFunction_ITU_R_709_2)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_YCbCrMatrix,
                         value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
    VTCompressionSessionPrepareToEncodeFrames(s)
    h264Session = s
    h264Width = width
    h264Height = height
    return true
}

// The emulator's gRPC streamScreenshot delivers RGBA8888 already top-down (the proto's "bottom
// up" note is pre-orientation-transform; verified visually it arrives upright). We build a BGRA
// CVPixelBuffer — the format VideoToolbox is proven to hw-encode (same as iOS) — swizzling R↔B.
func makePixelBuffer(_ rgba: Data, width: Int, height: Int) -> CVPixelBuffer? {
    var pbRaw: CVPixelBuffer?
    let attrs: [CFString: Any] = [
        kCVPixelBufferIOSurfacePropertiesKey: [:],  // IOSurface-backed → enables the hw encode path
    ]
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height,
            kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pbRaw) == kCVReturnSuccess,
          let pb = pbRaw else { return nil }

    CVPixelBufferLockBaseAddress(pb, [])
    defer { CVPixelBufferUnlockBaseAddress(pb, []) }
    guard let dstBase = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let dst = dstBase.assumingMemoryBound(to: UInt8.self)
    let dstStride = CVPixelBufferGetBytesPerRow(pb)
    let srcStride = width * 4

    rgba.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let src = raw.bindMemory(to: UInt8.self).baseAddress else { return }
        for row in 0..<height {
            let srcRow = src + row * srcStride
            let dstRow = dst + row * dstStride
            var x = 0
            while x < width {
                let s = srcRow + x * 4
                let d = dstRow + x * 4
                d[0] = s[2]  // B ← src.B
                d[1] = s[1]  // G
                d[2] = s[0]  // R ← src.R
                d[3] = s[3]  // A
                x += 1
            }
        }
    }
    return pb
}

// Retain the last buffer so a force-IDR on a static screen (viewer (re)join via relay
// request-idr) can re-emit a decodable keyframe even when no new frame is arriving.
var lastBuffer: CVPixelBuffer?

func encode(_ pb: CVPixelBuffer, width: Int, height: Int, forceIDR: Bool) {
    if h264Session == nil || width != h264Width || height != h264Height {
        if let old = h264Session { VTCompressionSessionInvalidate(old); h264Session = nil }
        didForceInitialIDR = false
        guard setupH264Session(width: width, height: height) else { return }
    }
    guard let session = h264Session else { return }

    let pts = CMTime(value: h264FrameIndex, timescale: h264Timescale)
    h264FrameIndex += 1
    var frameProps: CFDictionary?
    if !didForceInitialIDR || forceIDR {
        frameProps = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
        didForceInitialIDR = true
    }
    VTCompressionSessionEncodeFrame(
        session, imageBuffer: pb, presentationTimeStamp: pts,
        duration: CMTime(value: 1, timescale: h264Timescale),
        frameProperties: frameProps, sourceFrameRefcon: nil, infoFlagsOut: nil)
}

// MARK: - stdin frame reader

func readExactly(_ n: Int) -> Data? {
    var buf = [UInt8](repeating: 0, count: n)
    var got = 0
    while got < n {
        let r = buf.withUnsafeMutableBytes { read(0, $0.baseAddress!.advanced(by: got), n - got) }
        if r <= 0 { return nil }  // EOF or error
        got += r
    }
    return Data(buf)
}

func beU32(_ d: Data, _ offset: Int) -> Int {
    return (Int(d[d.startIndex + offset]) << 24) | (Int(d[d.startIndex + offset + 1]) << 16)
         | (Int(d[d.startIndex + offset + 2]) << 8) | Int(d[d.startIndex + offset + 3])
}

fputs("info: emulator-encoder started (\(Int(fps))fps)\n", stderr)

while let typeData = readExactly(1) {
    let type = typeData[typeData.startIndex]
    if type == 0x01 {
        // force-IDR: re-encode the last frame as a keyframe (covers static-screen joins).
        if let lb = lastBuffer {
            encode(lb, width: h264Width, height: h264Height, forceIDR: true)
        }
        continue
    }
    if type != 0x00 {
        fputs("error: bad frame type 0x\(String(type, radix: 16))\n", stderr)
        break
    }
    guard let header = readExactly(12) else { break }
    let w = beU32(header, 0), h = beU32(header, 4), len = beU32(header, 8)
    guard len == w * h * 4, let rgba = readExactly(len) else {
        fputs("error: bad frame header w=\(w) h=\(h) len=\(len)\n", stderr)
        break
    }
    guard let pb = makePixelBuffer(rgba, width: w, height: h) else { continue }
    lastBuffer = pb
    encode(pb, width: w, height: h, forceIDR: false)
}

// Drain any in-flight encodes before exiting so the last frames reach stdout.
if let s = h264Session { VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid) }
writeQueue.sync {}
