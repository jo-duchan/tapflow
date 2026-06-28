// audiotap-helper — captures an iOS-simulator's audio with a macOS Core Audio process tap
// (macOS 14.2+). Simulator processes are host processes, so we tap their PIDs directly: no routing,
// no dylib injection, no host-output hijack. Streams the tapped PCM to the agent over loopback TCP.
//
// WHY a .app launched via LaunchServices (not a CLI the agent spawns): a process tap returns silence
// unless the *responsible process* holds the audio-recording TCC grant. A CLI child inherits the
// agent/terminal's (ungranted) responsibility → silence. Launched via `open`, the helper is its own
// responsible process with its own one-time grant. So the agent runs a loopback TCP server and
// `open`s this helper pointed at that port.
//
// The loopback socket is BIDIRECTIONAL:
//   helper → agent : [u32 BE len][S16LE PCM]            audio frames (normalized 44100 / stereo)
//   agent  → helper : [u32 BE count][pid:u32 BE × count] tap-set updates (whole-sim, dynamic pids)
// `open` gives the child no stdin, so pid updates can't come over stdin like the other helpers —
// they ride the same loopback socket. On an update the helper tears down the old tap/aggregate and
// rebuilds it for the new pid set (the socket and the agent's frame stream survive).
//
// Args: <port> <pid> [<pid>...]   — loopback port + the initial simulator PID(s) to tap.
//
// Build (macOS, like the other ios-agent helpers — see AudioCaptureStreamer.ensureHelperApp):
//   swiftc src/audiotap-helper.swift -o <app>/Contents/MacOS/audiotap-helper -framework CoreAudio -framework AudioToolbox
import CoreAudio
import AudioToolbox
import Foundation

let DST_SR = 44100.0

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

// Build a global tap + aggregate + IOProc and START capture briefly, then exit. Capture start (not tap
// creation) is what raises the audio-capture TCC prompt, so this is enough to prime the grant from
// `tapflow setup ios`. Self-contained (defined before the normal-mode helpers it doesn't share) so it
// can run from the early --request-permission branch. exit 0 = granted/ok, non-0 = failed.
func primePermissionAndExit() -> Never {
  func defOut() -> AudioObjectID {
    var d = AudioObjectID(0); var s = UInt32(4)
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &s, &d)
    return d
  }
  func uidOf(_ id: AudioObjectID) -> String {
    var r: Unmanaged<CFString>?; var s = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    if AudioObjectGetPropertyData(id, &a, 0, nil, &s, &r) == noErr, let str = r?.takeRetainedValue() { return str as String }
    return ""
  }
  let d = CATapDescription(monoGlobalTapButExcludeProcesses: [])
  d.isPrivate = true; d.muteBehavior = .unmuted
  var tapID = AudioObjectID(0)
  guard AudioHardwareCreateProcessTap(d, &tapID) == noErr, tapID != 0 else { err("permission: create tap failed"); exit(1) }
  var tapUID = d.uuid.uuidString
  do {
    var u: Unmanaged<CFString>?; var us = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var ua = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    if AudioObjectGetPropertyData(tapID, &ua, 0, nil, &us, &u) == noErr, let s = u?.takeRetainedValue() { tapUID = s as String }
  }
  let clockUID = uidOf(defOut())
  let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "tapflow-audiotap-perm",
    kAudioAggregateDeviceUIDKey: "tapflow-audiotap-perm-\(getpid())",
    kAudioAggregateDeviceIsPrivateKey: 1,
    kAudioAggregateDeviceTapAutoStartKey: 1,
    kAudioAggregateDeviceMainSubDeviceKey: clockUID,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: clockUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: 1]],
  ]
  var aggID = AudioObjectID(0)
  guard AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID) == noErr, aggID != 0 else { err("permission: create aggregate failed"); exit(1) }
  var procID: AudioDeviceIOProcID?
  let block: AudioDeviceIOBlock = { _, _, _, _, _ in } // discard — we only need capture to start to raise the prompt
  guard AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, DispatchQueue(label: "tapflow.audiotap.perm"), block) == noErr else { err("permission: IOProc create failed"); exit(1) }
  AudioDeviceStart(aggID, procID)
  Thread.sleep(forTimeInterval: 2.0) // give the prompt time to appear / be answered
  AudioDeviceStop(aggID, procID)
  if let p = procID { AudioDeviceDestroyIOProcID(aggID, p) }
  AudioHardwareDestroyAggregateDevice(aggID)
  AudioHardwareDestroyProcessTap(tapID)
  err("permission request: capture started ok")
  exit(0)
}

let args = CommandLine.arguments

// Permission-priming mode (run from `tapflow setup ios`): force the audio-capture TCC prompt up front
// — when the operator is present — instead of at first simulator boot, which they'd likely miss. Needs
// no port/pid/sim: a global process tap triggers the same grant a per-pid tap needs (TCC keys on the
// app's cdhash + service, not the tap shape). The prompt appears when capture actually STARTS (tap
// creation alone doesn't), so this builds an aggregate + IOProc and runs it briefly. exit 0 = granted.
if args.contains("--request-permission") { primePermissionAndExit() }

guard args.count >= 3, let port = UInt16(args[1]) else { err("usage: audiotap-helper <port> <pid>... [--mute]"); exit(64) }
// --mute: mute only the TAPPED sim processes' output on the host (process-tap scope — other Mac apps
// are unaffected), for an unattended/dedicated agent Mac. Default (.unmuted) keeps the sim audible on
// the host too, like a real device.
let muted = args.contains("--mute")
let initialPids = args[2...].filter { $0 != "--mute" }.compactMap { pid_t($0) }
guard !initialPids.isEmpty else { err("no valid pid"); exit(64) }

// ---- loopback connect (helper reaches the agent's 127.0.0.1 server) ----
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

// ---- conversion: interleaved Float32 (host rate) → S16 interleaved stereo @ 44100 ----
// Source format is read per-rebuild from the live aggregate (rate/channels can differ per tap).
var srcSR = 48000.0
var srcCh = 2
var connectedOK = true

@inline(__always) func f2s16(_ f: Float) -> Int16 {
  let c = f > 1 ? 1 : (f < -1 ? -1 : f)
  return Int16(c * 32767)
}

// Reused scratch; the socket write is the only per-callback alloc-free hot path.
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

// ---- the live tap/aggregate/IOProc — rebuilt on every pid-set change ----
// IOProc runs on ioQueue; rebuildTap runs on a SEPARATE serial controlQueue. They must differ:
// destroyTap()'s AudioDeviceStop waits for the in-flight IOProc to finish, so if a rebuild (triggered
// by the property listener on a video switch's stop/start audio churn) ran on the IOProc's own queue
// it would wait on itself → the tap stalls and audio never recovers. controlQueue also serializes all
// rebuilds + lastPids access so the listener and the agent's pid updates can't race.
let ioQueue = DispatchQueue(label: "tapflow.audiotap.io")
let controlQueue = DispatchQueue(label: "tapflow.audiotap.control")
var curTapID = AudioObjectID(0)
var curAggID = AudioObjectID(0)
var curProcID: AudioDeviceIOProcID?
var aggSeq = 0

func destroyTap() {
  if curAggID != 0, let p = curProcID { AudioDeviceStop(curAggID, p); AudioDeviceDestroyIOProcID(curAggID, p) }
  if curAggID != 0 { AudioHardwareDestroyAggregateDevice(curAggID) }
  if curTapID != 0 { AudioHardwareDestroyProcessTap(curTapID) }
  curProcID = nil; curAggID = 0; curTapID = 0
}

// Build (or rebuild) the tap for `pids`. Returns false if no process objects resolve (e.g. all pids
// gone) — the caller keeps the socket open so a later update can recover. AudioDeviceStop in
// destroyTap() drains the IOProc before teardown, so the rebuild never races a live callback.
@discardableResult
func rebuildTap(_ pids: [pid_t]) -> Bool {
  destroyTap()
  let procObjs = pids.map(processObject).filter { $0 != 0 }
  guard !procObjs.isEmpty else { err("audiotap: no process objects for pids \(pids)"); return false }

  let tapDesc = CATapDescription(stereoMixdownOfProcesses: procObjs)
  tapDesc.isPrivate = true
  tapDesc.muteBehavior = muted ? .muted : .unmuted // .unmuted: apps still play on the host; we capture a copy
  guard AudioHardwareCreateProcessTap(tapDesc, &curTapID) == noErr, curTapID != 0 else { err("create tap failed"); return false }

  // the tap object's actual UID (not necessarily the description's uuid) drives the aggregate's tap list
  var tapUID = tapDesc.uuid.uuidString
  do {
    var u: Unmanaged<CFString>?
    var us = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var ua = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    if AudioObjectGetPropertyData(curTapID, &ua, 0, nil, &us, &u) == noErr, let s = u?.takeRetainedValue() { tapUID = s as String }
  }

  // a private aggregate device drives the tap's IOProc; the host default output supplies its clock
  let clockUID = deviceUID(defaultOutput())
  aggSeq += 1
  let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "tapflow-audiotap",
    kAudioAggregateDeviceUIDKey: "tapflow-audiotap-\(getpid())-\(aggSeq)",
    kAudioAggregateDeviceIsPrivateKey: 1,
    kAudioAggregateDeviceTapAutoStartKey: 1,
    kAudioAggregateDeviceMainSubDeviceKey: clockUID,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: clockUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: 1]],
  ]
  guard AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &curAggID) == noErr, curAggID != 0 else { err("create aggregate failed"); curAggID = 0; return false }

  // tap input format (typically Float32 interleaved stereo @ 48000)
  var fmt = AudioStreamBasicDescription()
  var fsz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  var faddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamFormat, mScope: kAudioObjectPropertyScopeInput, mElement: 0)
  AudioObjectGetPropertyData(curAggID, &faddr, 0, nil, &fsz, &fmt)
  srcSR = fmt.mSampleRate > 0 ? fmt.mSampleRate : 48000.0
  srcCh = Int(fmt.mChannelsPerFrame > 0 ? fmt.mChannelsPerFrame : 2)
  err("audiotap: tapping \(procObjs.count)/\(pids.count) pids — src \(srcSR)Hz \(srcCh)ch → 44100/stereo/S16")

  let block: AudioDeviceIOBlock = { (_, inInputData, _, _, _) in
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    guard let buf = abl.first, let m = buf.mData else { return }
    sendBuffer(m, buf.mDataByteSize)
  }
  guard AudioDeviceCreateIOProcIDWithBlock(&curProcID, curAggID, ioQueue, block) == noErr else { err("IOProc create failed"); return false }
  AudioDeviceStart(curAggID, curProcID)
  return true
}

// teardown on signal / when the agent closes the socket
signal(SIGTERM) { _ in exit(0) }
atexit { destroyTap(); close(sock) }

// initial tap; even if it fails we keep reading — a later update may carry valid pids
var lastPids = initialPids
controlQueue.sync { _ = rebuildTap(lastPids) }

// Listen for audio-object-list changes. TranslatePIDToProcessObject only resolves a process that is
// CURRENTLY producing audio (a HAL client), so a sim process that *starts* playback (e.g. WebKit
// WebContent on a YouTube tap) becomes tappable only at that moment — its pid never changes, so the
// agent's ps-based pid polling can't see it. This listener fires when that happens and rebuilds the
// tap for the current sim pid set, mixing the newly-audible process in.
var plAddr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
                                        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
let plListener: AudioObjectPropertyListenerBlock = { _, _ in rebuildTap(lastPids) }
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &plAddr, controlQueue, plListener)

// ---- read agent → helper tap-set updates off the same socket ----
// Frame: [u32 BE count][pid:u32 BE × count]. count is bounded to reject a desynced stream.
let MAX_PIDS = 1024
var cmd = [UInt8]()
@inline(__always) func beU32(_ b: [UInt8], _ off: Int) -> UInt32 {
  return UInt32(b[off]) << 24 | UInt32(b[off + 1]) << 16 | UInt32(b[off + 2]) << 8 | UInt32(b[off + 3])
}
var tmp = [UInt8](repeating: 0, count: 4096)
while connectedOK {
  let n = read(sock, &tmp, tmp.count)
  if n <= 0 { break } // agent closed
  cmd.append(contentsOf: tmp[0..<n])
  while cmd.count >= 4 {
    let count = Int(beU32(cmd, 0))
    if count > MAX_PIDS { err("audiotap: bogus pid count \(count), bailing"); connectedOK = false; break }
    let need = 4 + count * 4
    if cmd.count < need { break }
    var newPids = [pid_t]()
    for i in 0..<count { newPids.append(pid_t(bitPattern: beU32(cmd, 4 + i * 4))) }
    cmd.removeSubrange(0..<need)
    let pidsToApply = newPids
    controlQueue.async { // serialize with the listener; never rebuild on the read thread directly
      lastPids = pidsToApply
      err("audiotap: update → \(pidsToApply.count) pids")
      rebuildTap(pidsToApply)
    }
  }
}
err("audiotap: socket closed, exiting")
exit(0)
