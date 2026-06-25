// audiotap-helper — captures an iOS-simulator app's audio with a macOS Core Audio process tap
// (macOS 14.2+). Simulator apps are host processes, so we tap their PIDs directly: no routing, no
// dylib injection, no host-output hijack. Streams the tapped PCM to the agent over loopback TCP.
//
// WHY a .app launched via LaunchServices (not a CLI the agent spawns): a process tap returns silence
// unless the *responsible process* holds the audio-recording TCC grant. A CLI child inherits the
// agent/terminal's (ungranted) responsibility → silence. Launched via `open`, the helper is its own
// responsible process with its own one-time grant. So the agent runs a loopback TCP server and
// `open`s this helper pointed at that port.
//
// Args: <port> <pid> [<pid>...]   — loopback port + the simulator process PID(s) to tap.
// Wire: [u32 BE len][S16LE PCM] frames, normalized to 44100 / stereo (matches android-agent + dashboard).
//
// Build (macOS, like the other ios-agent helpers — see AudioCaptureStreamer.ensureHelperApp):
//   swiftc src/audiotap-helper.swift -o <app>/Contents/MacOS/audiotap-helper -framework CoreAudio -framework AudioToolbox
import CoreAudio
import AudioToolbox
import Foundation

let DST_SR = 44100.0

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let args = CommandLine.arguments
guard args.count >= 3, let port = UInt16(args[1]) else { err("usage: audiotap-helper <port> <pid>..."); exit(64) }
let pids = args[2...].compactMap { pid_t($0) }
guard !pids.isEmpty else { err("no valid pid"); exit(64) }

// ---- loopback connect (guest reaches the agent's 127.0.0.1 server) ----
let sock = socket(AF_INET, SOCK_STREAM, 0)
guard sock >= 0 else { exit(65) }
var addr = sockaddr_in()
addr.sin_family = sa_family_t(AF_INET)
addr.sin_port = port.bigEndian
addr.sin_addr.s_addr = inet_addr("127.0.0.1")
let connected = withUnsafePointer(to: &addr) {
  $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
}
guard connected == 0 else { err("connect 127.0.0.1:\(port) failed"); exit(65) }

// ---- translate PID(s) → process objects ----
func processObject(_ pid: pid_t) -> AudioObjectID {
  var p = pid
  var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
                                     mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var obj = AudioObjectID(0)
  var sz = UInt32(MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, UInt32(MemoryLayout<pid_t>.size), &p, &sz, &obj)
  return obj
}
let procObjs = pids.map(processObject).filter { $0 != 0 }
guard !procObjs.isEmpty else { err("no process objects for pids \(pids)"); exit(2) }

// ---- create the process tap (unmuted: the app still plays normally; we capture a copy) ----
let tapDesc = CATapDescription(stereoMixdownOfProcesses: procObjs)
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted
var tapID = AudioObjectID(0)
guard AudioHardwareCreateProcessTap(tapDesc, &tapID) == noErr, tapID != 0 else { err("create tap failed"); exit(3) }

// the tap object's actual UID (not necessarily the description's uuid) drives the aggregate's tap list
var tapUID = tapDesc.uuid.uuidString
do {
  var u: Unmanaged<CFString>?
  var us = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  var ua = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  if AudioObjectGetPropertyData(tapID, &ua, 0, nil, &us, &u) == noErr, let s = u?.takeRetainedValue() { tapUID = s as String }
}

// ---- a private aggregate device drives the tap's IOProc; the host default output supplies its clock ----
func defaultOutput() -> AudioObjectID {
  var d = AudioObjectID(0); var s = UInt32(4)
  var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &s, &d)
  return d
}
func deviceUID(_ id: AudioObjectID) -> String {
  var r: Unmanaged<CFString>?; var s = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  if AudioObjectGetPropertyData(id, &a, 0, nil, &s, &r) == noErr, let str = r?.takeRetainedValue() { return str as String }
  return ""
}
let clockUID = deviceUID(defaultOutput())
let aggDesc: [String: Any] = [
  kAudioAggregateDeviceNameKey: "tapflow-audiotap",
  kAudioAggregateDeviceUIDKey: "tapflow-audiotap-\(pids[0])",
  kAudioAggregateDeviceIsPrivateKey: 1,
  kAudioAggregateDeviceTapAutoStartKey: 1,
  kAudioAggregateDeviceMainSubDeviceKey: clockUID,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: clockUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: 1]],
]
var aggID = AudioObjectID(0)
guard AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID) == noErr, aggID != 0 else { err("create aggregate failed"); exit(4) }

// tap input format (typically Float32 interleaved stereo @ 48000)
var fmt = AudioStreamBasicDescription()
var fsz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
var faddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamFormat, mScope: kAudioObjectPropertyScopeInput, mElement: 0)
AudioObjectGetPropertyData(aggID, &faddr, 0, nil, &fsz, &fmt)
let srcSR = fmt.mSampleRate > 0 ? fmt.mSampleRate : 48000.0
let srcCh = Int(fmt.mChannelsPerFrame > 0 ? fmt.mChannelsPerFrame : 2)
err("audiotap: tapping pids \(pids) — src \(srcSR)Hz \(srcCh)ch → 44100/stereo/S16")

@inline(__always) func f2s16(_ f: Float) -> Int16 {
  let c = f > 1 ? 1 : (f < -1 ? -1 : f)
  return Int16(c * 32767)
}

// Convert one interleaved Float32 buffer → S16 interleaved stereo @ 44100, linear-resampling when
// the source rate differs. Reused scratch buffer; the socket write is the only per-callback alloc-free hot path.
var connectedOK = true
func sendBuffer(_ data: UnsafeMutableRawPointer, _ byteSize: UInt32) {
  guard connectedOK else { return }
  let inFrames = Int(byteSize) / 4 / srcCh
  if inFrames == 0 { return }
  let src = data.assumingMemoryBound(to: Float.self)
  let ratio = DST_SR / srcSR
  let outFrames = max(1, Int(Double(inFrames) * ratio))
  var out = [Int16](repeating: 0, count: outFrames * 2)
  for j in 0..<outFrames {
    let srcPos = Double(j) / ratio
    let i0 = min(Int(srcPos), inFrames - 1)
    let i1 = min(i0 + 1, inFrames - 1)
    let frac = Float(srcPos - Double(i0))
    // interleaved: channel c at index i*srcCh + c. mono → duplicate; stereo → L/R.
    let l0 = src[i0 * srcCh], l1 = src[i1 * srcCh]
    let r0 = srcCh > 1 ? src[i0 * srcCh + 1] : l0
    let r1 = srcCh > 1 ? src[i1 * srcCh + 1] : l1
    out[j * 2]     = f2s16(l0 + (l1 - l0) * frac)
    out[j * 2 + 1] = f2s16(r0 + (r1 - r0) * frac)
  }
  out.withUnsafeBytes { raw in
    var len = UInt32(raw.count).bigEndian
    let hOK = withUnsafeBytes(of: &len) { write(sock, $0.baseAddress, 4) == 4 }
    let bOK = write(sock, raw.baseAddress, raw.count) == raw.count
    if !hOK || !bOK { connectedOK = false } // agent closed → stop
  }
}

var procID: AudioDeviceIOProcID?
let block: AudioDeviceIOBlock = { (_, inInputData, _, _, _) in
  let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
  guard let buf = abl.first, let m = buf.mData else { return }
  sendBuffer(m, buf.mDataByteSize)
}
guard AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, DispatchQueue(label: "tapflow.audiotap"), block) == noErr else { err("IOProc create failed"); exit(5) }
AudioDeviceStart(aggID, procID)

// teardown on signal / when the agent closes the socket
func teardown() {
  AudioDeviceStop(aggID, procID)
  if let p = procID { AudioDeviceDestroyIOProcID(aggID, p) }
  AudioHardwareDestroyAggregateDevice(aggID)
  AudioHardwareDestroyProcessTap(tapID)
  close(sock)
}
signal(SIGTERM) { _ in exit(0) }
atexit(teardown)
// run until the agent closes the socket (connectedOK flips) or we're killed
while connectedOK { Thread.sleep(forTimeInterval: 0.25) }
err("audiotap: socket closed, exiting")
exit(0)
