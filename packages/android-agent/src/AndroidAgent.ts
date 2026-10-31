import os from 'os'
import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import type {
  AndroidButton, BootAbandonReason, ClipboardErrorPayload, Device, DeviceAgent,
  NetworkControlCapability, NetworkStatePayload, UIElement,
} from '@tapflowio/agent-core'
import { avdRotationLockMemory, formFactorOf, osVersionOf, type RotationLockMemory } from './avdConfig.js'
import type {
  AgentControlOutbound, AgentDevicesApplied, DeviceReport, ClipboardReplyBody, OpenUrlReplyBody,
  AppInstallReplyBody, AppLaunchReplyBody, AppLaunchToAgent, LaunchOptions, AppClearStateReplyBody, DevicePosture, FormFactor, RunResetReport, RunResetRequest,
  InputPinchStart, InputTouchStart, PointSpace,
} from '@tapflowio/protocol'
import { appliedKeys, compactLaunchOptions, launchOptionsProblem } from '@tapflowio/protocol/launch'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { createLogger, PlatformError, ValidationError, bootAbandonMessage, BOOT_NO_SESSION_STATE, SHUTDOWN_NO_SESSION_STATE, downloadBuild } from '@tapflowio/agent-core'
import { outcomeMessage, wireReason, type InputOutcome } from './inputOutcome.js'
import {
  MAX_CLIPBOARD_BYTES, clipboardByteLength,
  CLIPBOARD_SENTINEL_PREFIX as SENTINEL_PREFIX, isClipboardSentinel as isSentinel,
  CLIPBOARD_COPY_DEADLINE_MS, CLIPBOARD_WRITE_DEADLINE_MS, CLIPBOARD_RESTORE_DEADLINE_MS, CLIPBOARD_POLL_MS,
  createKeyedSerialQueue,
  type AgentCapability,
} from '@tapflowio/agent-core'
import {
  createResourceSampler,
  registerStreamWs,
  disableNagle,
  createKeyframeAwareSender,
  pickMaxSize,
  createRateLimitedDropWarn,
  createThroughputSampler,
  createSleepBlocker,
  acquireLoopStallWatch,
  describeRelayLoss,
  type RelayLoss,
  type SleepBlocker,
  getMachineId,
  isLocalhostWss,
  DEFAULT_BACKPRESSURE_BYTES,
  writeEnvelopeHeader,
  rewriteLowLatencySpsInFrame,
  CODEC_H264,
  CODEC_AUDIO,
  sendAudioYieldingToVideo,
  resetApps,
  runResetSteps,
  RUN_RESET_BUDGET_MS,
  type RunResetStep,
  DeviceListWatcher,
} from '@tapflowio/agent-core/utils'
import { execFile } from 'child_process'
import { AdbWrapper } from './AdbWrapper.js'
import { EmulatorLauncher, findEmulatorPid, probeEmulator, stopEmulatorProcess } from './EmulatorLauncher.js'
import { ensureHelperApp, launchMuteOnlyTap, isAudioSupported } from '@tapflowio/audiotap-helper'
import { AndroidTouchHelper } from './AndroidTouchHelper.js'
import { parseUiAutomatorDump } from './uiTree.js'
import { ScrcpySession } from './scrcpy/ScrcpySession.js'
import type { ScrcpyFrame } from './scrcpy/ScrcpyVideo.js'
import { EmulatorGrpcClient, type AudioStream } from './emulator/EmulatorGrpcClient.js'
import { discoverGrpcPort, isTcpPortFree } from './emulator/discovery.js'
import type { SkinRotation } from './emulator/EmulatorGrpcClient.js'
import type { DisplayMetrics } from './displayMetrics.js'
import { bootPostureId, parseCurrentPosture, parsePostures } from './postures.js'
import { EmulatorVideo } from './emulator/EmulatorVideo.js'
import { LEAN_MARKER_PATH, reconcileLean, type LeanDevice } from './LeanPackages.js'
import { BootSupersededError, installReclaimingStorage, type ReclaimDevice } from './StorageReclaim.js'

const logger = createLogger('android-agent')

// Typed so a typo cannot ship silently — the viewer gates the whole clipboard bridge on this, and
// since #447 the Full reset toggle too. `full-reset` is honoured in `handleDeviceBoot`, which stops
// an already-running emulator and relaunches it with `-wipe-data`.
// `network-control` claims what the other two claim: this agent has the code. Whether airplane mode
// actually works on a given image is per device, and `network:state.available` carries that — the
// split the protocol documents. Added last, after the handler and the boot-time reset, because the
// string on its own is what puts a control on screen.
const AGENT_CAPABILITIES: AgentCapability[] = ['clipboard', 'full-reset', 'network-control', 'build-download', 'launch-options']

// Parse H.264 SPS NAL unit to extract frame dimensions.
// scrcpy sends a new SPS (inside an IDR keyframe) whenever the capture size changes —
// e.g. portrait→landscape for landscape-aware apps. This lets the agent track the
// actual video dimensions and keep ScrcpyControl.screenSize in sync without guessing.
/**
 * A normalised point on the **displayed** screen, mapped to the display's **natural** space.
 *
 * The emulator's gRPC `sendTouch` takes pixels in the natural orientation — measured, not assumed:
 * sending x=2100 to a Pixel 9 Pro Fold produced `ABS_MT_POSITION_X = 33145` against a 32767 axis
 * maximum, and `2100 × 32767 / 33145 = 2076`, the natural width, while the live display was 2152
 * wide. The viewer normalises against what Android is drawing. Without this map the axes are
 * swapped, which is a tap landing 90° from the finger.
 *
 * **Keyed on Android's display rotation, not the emulator's frame rotation.** The gRPC frame
 * carries a rotation field and it is the device's physical orientation: folded, it still reports
 * `REVERSE_LANDSCAPE` while Android has rotated the screen back to 0. Keying on it was right
 * unfolded and wrong folded.
 *
 * Rotation 0 is the identity, which is why an ordinary phone never needed this.
 */
/**
 * The emulator's per-frame rotation, in degrees clockwise.
 *
 * This is the **skin's** orientation — the proto says it is "derived from the sensor state of the
 * emulator" — and the capture follows it rather than the display. Measured on a Pixel 9 Pro Fold:
 * natural 2076x2152 arrived as 2152x2076 unfolded and natural 1080x2424 arrived as 2424x1080
 * folded, the same turn in both postures, while Android's own rotation went from 270 to 0.
 *
 * **Read per frame, not assumed.** A first version hard-coded 270 from this AVD, which is a value
 * that AVD's startup orientation produced — a device created in portrait would have made it wrong,
 * silently, on a machine nobody was testing on.
 */
/** How often a live session re-reads the display while it is being watched.
 *
 *  **The screen is polled because no single reading can be trusted to be final.** Android rotates a
 *  few hundred milliseconds after the panel changes, and nothing in `dumpsys` marks the gap: sampled
 *  150ms into an unfold, `init`, `cur`, `app` and `mRotation` are all consistent with each other and
 *  all describe the posture being left. So "has it settled?" is not a question the device answers —
 *  it is only answerable in hindsight, by the value changing.
 *
 *  Polling turns that from a race into a delay. A reading taken too early is corrected on the next
 *  pass instead of persisting, which is what made the error look like it accumulated: every other
 *  fold landed inside the gap and stayed wrong until the one after it happened to land outside.
 *
 *  It also covers the case folding merely exposed. `mRotation` changes without any fold — the
 *  toolbar's rotate button, an app asking for a different orientation — and nothing here was
 *  watching for that either. */
const SCREEN_WATCH_INTERVAL_MS = 2_000

/** How `stableDisplayMetrics` decides the display has settled.
 *
 *  **Two equal readings was not enough, and the reason is worth keeping.** The rotation lags the
 *  panel by ~300ms on this machine; with a 250ms gap, the first two samples both land inside that
 *  window, agree with each other, and describe the posture the device is leaving. Measured across
 *  seven folds: six correct and one — an unfold — reading `rot 0` where it should have read 270,
 *  which is a visible quarter turn.
 *
 *  So the run has to be longer than the lag: three readings 300ms apart span 600ms, past the point
 *  where both values had caught up in every sample taken. The ceiling is generous because the cost
 *  of waiting is a spinner the viewer is already showing, while the cost of being early is a
 *  picture rotated the wrong way. */
const METRICS_STABLE_RUN = 3
const METRICS_SAMPLES = 12
const METRICS_SAMPLE_GAP_MS = 300
// A posture is committed by the guest a moment after the emulator console takes it. Polled
// because there is no push, and cheaply: `cmd device_state state` measures 20ms, so the wait is
// the guest's own latency rather than a sampling schedule. The stop is long because a device that
// never commits should still end with an honest report rather than a spinner.
const POSTURE_COMMIT_POLL_MS = 50
const POSTURE_COMMIT_TIMEOUT_MS = 3_000
// `emu rotate` lands at once (the next gRPC frame came 53 ms later, measured); the console read that confirms it
// is tens of ms. The stop is for an emulator that took the command and did not turn.
const BODY_TURN_POLL_MS = 50
const BODY_TURN_SETTLE_MS = 2_000

const SKIN_DEGREES: Record<SkinRotation, 0 | 90 | 180 | 270> = {
  PORTRAIT: 0,
  LANDSCAPE: 90,
  REVERSE_PORTRAIT: 180,
  REVERSE_LANDSCAPE: 270,
}

export function toNaturalPoint(rotation: 0 | 90 | 180 | 270, x: number, y: number): { x: number; y: number } {
  switch (rotation) {
    case 0: return { x, y }
    case 90: return { x: 1 - y, y: x }
    case 180: return { x: 1 - x, y: 1 - y }
    case 270: return { x: y, y: 1 - x }
  }
}

export function parseSpsFromNal(nal: Buffer): { width: number; height: number } | null {
  // Locate NAL header byte after Annex B start code
  let offset = 0
  if (nal.length >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) offset = 4
  else if (nal.length >= 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1) offset = 3
  else return null
  if (offset >= nal.length || (nal[offset]! & 0x1f) !== 7) return null  // not SPS

  // Collect RBSP bytes (remove emulation-prevention 0x03 bytes)
  const bytes: number[] = []
  for (let i = offset + 1; i < nal.length; i++) {
    const b = nal[i]!
    const len = bytes.length
    if (len >= 2 && b === 3 && bytes[len - 1] === 0 && bytes[len - 2] === 0) continue
    bytes.push(b)
  }

  let bit = 0
  const readU = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) {
      if ((bit >> 3) >= bytes.length) throw new Error('truncated')
      v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1)
      bit++
    }
    return v
  }
  const readUE = (): number => {
    let lz = 0
    while (readU(1) === 0) { if (++lz > 31) throw new Error('overflow') }
    return lz === 0 ? 0 : (1 << lz) - 1 + readU(lz)
  }
  const readSE = (): number => { const v = readUE(); return v % 2 === 0 ? -(v >> 1) : (v + 1) >> 1 }

  try {
    const profile = readU(8)
    readU(8); readU(8)           // constraint_flags, level_idc
    readUE()                     // seq_parameter_set_id

    let subWC = 2, subHC = 2    // 4:2:0 defaults
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const cfmt = readUE()
      subWC = cfmt === 0 ? 1 : cfmt === 2 ? 2 : cfmt === 3 ? 1 : 2
      subHC = cfmt === 0 ? 1 : cfmt === 1 ? 2 : 1
      if (cfmt === 3) readU(1)   // separate_colour_plane_flag
      readUE(); readUE()         // bit_depth_luma/chroma_minus8
      readU(1)                   // qpprime_y_zero_transform_bypass_flag
      if (readU(1)) return null  // seq_scaling_matrix_present_flag — skip
    }

    readUE()                     // log2_max_frame_num_minus4
    const pocType = readUE()
    if (pocType === 0) readUE()
    else if (pocType === 1) {
      readU(1); readSE(); readSE()
      const n = readUE(); for (let i = 0; i < n; i++) readSE()
    }
    readUE(); readU(1)           // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag
    const codedW = (readUE() + 1) * 16
    const mapH = readUE()
    const frameMbsOnly = readU(1)
    const codedH = (mapH + 1) * 16 * (frameMbsOnly ? 1 : 2)
    if (!frameMbsOnly) readU(1) // mb_adaptive_frame_field_flag
    readU(1)                    // direct_8x8_inference_flag
    let w = codedW, h = codedH
    if (readU(1)) {             // frame_cropping_flag
      const cl = readUE(), cr = readUE(), ct = readUE(), cb = readUE()
      w = codedW - (cl + cr) * subWC
      h = codedH - (ct + cb) * subHC * (frameMbsOnly ? 1 : 2)
    }
    return { width: w, height: h }
  } catch { return null }
}

const ANDROID_BUTTONS: AndroidButton[] = [
  { name: 'home',        accessibilityTitle: 'Home',        keyCode: 3 },
  { name: 'back',        accessibilityTitle: 'Back',        keyCode: 4 },
  { name: 'recent_apps', accessibilityTitle: 'Recent Apps', keyCode: 187 },
  { name: 'volume_up',   accessibilityTitle: 'Volume Up',   keyCode: 24 },
  { name: 'volume_down', accessibilityTitle: 'Volume Down', keyCode: 25 },
  { name: 'power',       accessibilityTitle: 'Power',       keyCode: 26 },
]

interface DeviceState {
  sessionId: string
  /** Why each abandoned boot was abandoned, keyed by **the seq it lost**. A single slot would tell the
   *  wrong story the moment two boots overlap: boot A, boot B, then a shutdown leaves one slot saying
   *  `shut-down`, which is what B lost to — A lost to B.
   *
   *  **Written only while a boot is running to read it**, which is what keeps it from growing. Every
   *  lifecycle event retires a seq, but the usual one retires a boot that has already answered — an entry
   *  nothing would ever read or delete, one per boot and one per shutdown, for as long as the agent stays
   *  connected. `bootsInFlight` is that guard, and each boot clears its own key on the way out. */
  bootAbandon: Map<number, BootAbandonReason>
  /** Seqs held by a `handleDeviceBoot` that has not returned yet. */
  bootsInFlight: Set<number>
  deviceId: string
  touchHelper: AndroidTouchHelper | null
  // Device-booted flag for truthful input acks — set on device:ready, cleared on shutdown; false after a reconnect until the ack path re-verifies once via adb.
  booted: boolean
  /** The last airplane-mode value actually read off this device, and **only** the fallback for a read
   *  that fails — never the answer. `readNetworkState` still asks the device every time, because a
   *  remembered value cannot see one changed outside tapflow.
   *
   *  It exists because `NetworkNotSteerable.offline` is declared "still the device's real state", and
   *  the re-join report (#614) is the first producer with nothing to pass: the boot path hands over
   *  what it just read and `network:set` hands over what it measured, but a viewer coming back has no
   *  such moment behind it.
   *
   *  **`undefined` until something is observed, rather than `false`.** The two are not the same claim:
   *  `false` says "on the network" and the absent value says "not known", and a boolean spells the
   *  second as the first. Reachable — a boot whose own read failed writes nothing here, and a tester
   *  who then flips airplane mode in the emulator's own UI leaves a device that is offline, unreadable
   *  and never observed. Answering `offline: false` for it is the one direction that hides the
   *  problem this feature exists to show, so every producer answers `NetworkUnobserved` there
   *  instead, and the re-join report stays silent (#667). */
  lastNetworkOffline?: boolean
  streamWs: WebSocket | null
  scrcpySession: ScrcpySession | null
  emulatorVideo: EmulatorVideo | null
  emulatorAudio: AudioStream | null   // gRPC audio stream (on by default; null when TAPFLOW_AUDIO=off)
  audioMuteQemuPid: number | null     // qemu pid silenced by the macOS mute-only tap (#341); null if not muting
  grpcPort: number | null             // gRPC port this device's emulator was launched with; null if we didn't launch it
  grpcClient: EmulatorGrpcClient | null
  /** The panel's baked rounded-corner radius in **device pixels** (0 = square).
   *
   *  Held in pixels and divided by the *shown* width only when `session:chrome` goes out, because
   *  that is the number the viewer scales it against and it swaps when the display rotates. Held
   *  as a fraction it was silently a fraction of the natural width, which is right in portrait and
   *  2.24x too round in landscape on a folded Pixel 9 Pro Fold. */
  cornerRadiusPx: number
  secureContext: boolean // viewer context → downscale tier (native / 1280 / 1000)
  external: boolean
  displayWidth: number
  displayHeight: number
  /** Quarter turns from the panel's natural orientation to what Android is drawing, or null on the
   *  scrcpy backend (which captures natural, so input needs no map). */
  rotation: 0 | 90 | 180 | 270 | null
  /** Quarter turns clockwise the viewer must apply to the video to match the screen. See
   *  `AndroidChrome.streamRotation`. */
  streamRotation: 0 | 90 | 180 | 270
  /** The skin orientation the last frame reported, so a reconcile triggered by something other
   *  than a frame — a rotation, the watcher — can still compute the correction. */
  skin: SkinRotation | null
  /** How far the emulator's body is turned clockwise, from the console accelerometer — read at boot and after a
   *  turn, so a chrome sent before the first frame (which carries the skin) already says where the body is. */
  body: 0 | 90 | 180 | 270 | null
  /** The newest frame's size and skin, recorded the moment it arrives — not when a reconcile commits it. A reconcile
   *  reads this when it starts, whoever asked for it: see `startReconcile`. */
  latestFrame: { w: number; h: number; skin: SkinRotation | null } | null
  /** The size the **emulator** has display 0 configured at, which is what it divides injected
   *  touch pixels by — see `EmulatorGrpcClient.getDisplaySize`. Not the panel the guest is drawing
   *  on: on a foldable those differ, and this is the one input is measured in. Read once per
   *  stream; null means the read failed and the panel size is used instead. */
  touchRange: { width: number; height: number } | null
  /** A posture change is in flight. The device can only be in one posture, and the carry that
   *  follows reads a rotation from before the change — so a second request overlapping the first
   *  restores an orientation the device has already left. */
  posturing: boolean
  /** Polls the display while the session is live. See `SCREEN_WATCH_INTERVAL_MS`. */
  screenWatch: ReturnType<typeof setInterval> | null
  /** A reconcile is in flight; the fold's own and the watcher's must not overlap. */
  reconciling: boolean
  videoWidth: number   // actual scrcpy video frame dimensions — used for touch coordinates
  videoHeight: number
  landscape: boolean   // rotation intent toggle — only to request device rotation on input:rotate
  lastTouchPx: { x: number; y: number }
  /** The gesture in progress and the backend that opened it (#487). See `gestureOwner`. */
  gesture: { kind: 'touch' | 'pinch' } & GestureBackend | null
  bootSeq: number
  restarting: boolean
}

// Low-latency pointer injection, satisfied structurally by both ScrcpyControl (scrcpy backend)
// and EmulatorGrpcClient (gRPC backend) — identical method shapes, so the input handlers stay
// backend-agnostic. Methods may be sync (scrcpy) or async (gRPC); callers fire-and-forget.
interface PointerControl {
  /** Whether a write now reaches the device. Each backend answers from what it actually has — a
   *  socket's local writability for scrcpy, a closed flag for gRPC — because the two have nothing
   *  in common: `socket.write()` never throws, and a gRPC call rejects. See the implementations. */
  isReady(): boolean
  touchDown(pointerId: number, x: number, y: number): void | Promise<void>
  touchMove(pointerId: number, x: number, y: number): void | Promise<void>
  touchUp(pointerId: number, x?: number, y?: number): void | Promise<void>
  pinchStart(x1: number, y1: number, x2: number, y2: number): void | Promise<void>
  pinchMove(x1: number, y1: number, x2: number, y2: number): void | Promise<void>
  pinchEnd(): void | Promise<void>
}

// Video backend per device: emulators (serial `emulator-*`) default to the gRPC host-encode path
// (bypasses the guest SW H.264 encoder); real devices use scrcpy (their SoC has a HW encoder).
// `TAPFLOW_ANDROID_BACKEND=scrcpy|grpc` overrides either way.
export function pickAndroidBackend(serial: string, env: NodeJS.ProcessEnv = process.env): 'grpc' | 'scrcpy' {
  if (env.TAPFLOW_ANDROID_BACKEND === 'scrcpy') return 'scrcpy'
  if (env.TAPFLOW_ANDROID_BACKEND === 'grpc') return 'grpc'
  return serial.startsWith('emulator-') ? 'grpc' : 'scrcpy'
}

export interface AndroidAgentOptions {
  /** How often the device list is re-read for a relay that takes updates. Injectable for tests. */
  deviceRereadMs?: number
  /** An AVD's Android version by name, for one that is not running. Defaults to its system image (`avdConfig`). */
  avdOsVersion?: (avdName: string) => string | undefined
  fps?: number
  /** AVD name or emulator serial to expose. Omit to expose all detected devices. */
  deviceFilter?: string
  reconnectDelays?: number[]
  /** Injectable for tests; defaults to a real macOS power assertion (no-op under vitest). */
  sleepBlocker?: SleepBlocker
  /** Credential for remote relays — sent as `Authorization: Bearer` on every relay WS (#271). */
  token?: string
  /** Handshake(연결~agent:registered) 타임아웃 ms. 기본 10초, 테스트용 주입 가능. */
  handshakeTimeoutMs?: number
  /** Lean mode (`agent.lean`): keep bundled Google apps nobody testing needs disabled. See `LeanPackages`. */
  lean?: boolean
  /** An AVD's form factor by name, for `agent:register`. Defaults to reading its config.ini (`avdConfig`). */
  avdFormFactor?: (avdName: string) => FormFactor | undefined
  /** Each run reset command's bound, in ms. `RUN_RESET_CMD_TIMEOUT_MS` by default; injectable for tests. */
  runResetCmdTimeoutMs?: number
  /** Which AVDs have had their rotation lock freed once. Beside each AVD by default (`avdRotationLockMemory`);
   *  never the real AVD directories under vitest. */
  rotationLockMemory?: RotationLockMemory
}

/** One `pm clear` or clipboard write of a run reset. */
const RUN_RESET_CMD_TIMEOUT_MS = 10_000

// Everything inside the per-device clipboard section must be bounded, or one stuck call wedges
// every later copy/paste on that device. gRPC carries its own deadline; adb does not (and a
// blanket AdbRunner timeout would break legitimately slow calls like app install), so bound it
// here. The child process may outlive this — the point is to release the queue.
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    // The adb child is not killed — `input keyevent` is idempotent for our purposes and killing
    // it mid-write could leave the guest in a worse state. What matters is releasing the section
    // so one stuck call cannot wedge every later clipboard op on this device.
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError(`${what} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
const ADB_KEYEVENT_TIMEOUT_MS = 5_000

// `implements NetworkControlCapability` as well as `DeviceAgent`, and the clause is the whole
// point: without it the two methods are just methods, and a change to the interface reaches this
// class through nothing at all. `AgentRegistry.test.ts` once declared `implements DeviceAgent`
// while missing two members — the clause only works when something checks it, and here that is the
// compiler.
/** Which backend serves a gesture — tagged, because the two are told apart by role, not by class. */
type GestureBackend = { via: 'channel'; owner: PointerControl } | { via: 'helper'; owner: AndroidTouchHelper }

/** Thrown by a stream start whose boot or restart was overtaken. A readable marker only — every
 *  catcher decides on the seq, because a start that lost can also fail with an ordinary error. */
class StreamSuperseded extends Error {
  constructor() { super('a newer boot took over this device while its stream was starting') }
}

/** What one stream start created. See `releaseStream`. */
interface StreamHandles {
  touchHelper?: AndroidTouchHelper
  scrcpySession?: ScrcpySession
  emulatorVideo?: EmulatorVideo
  grpcClient?: EmulatorGrpcClient
}

/** adb no longer lists the emulator. Usually it stopped — a Full reset or a shutdown under way — but an
 *  adb server restart or a console timeout reads the same, so the cause is not claimed. */
const EMULATOR_GONE =
  'adb no longer lists the emulator, so the session could not start. It may have stopped (a Full reset or a shutdown was under way). Boot it again.'
const EMULATOR_GONE_RESTART =
  'adb no longer lists the emulator, so its stream could not be restarted. Boot it again.'

export class AndroidAgent implements DeviceAgent, NetworkControlCapability {
  private readonly adb: AdbWrapper
  private readonly launcher: EmulatorLauncher
  private ws: WebSocket | null = null

  /** Send on the control socket, if there is one. The `?.` is the point: 66 call sites relied on a send
   *  being a no-op between reconnects, and this preserves that exactly.
   *
   *  Typed with `AgentControlOutbound`, which is why this exists — an agent's literal used to reach `ws.send`
   *  with nothing checking it, and #489/#490 are what that cost. *
 *  **The guard is not defensive tidying.** `ws.send` on anything other than OPEN takes the `sendAfterClose`
 *  path, which adds the payload to a buffer nobody will flush and neither throws nor emits — so a reply
 *  sent to a closing socket is indistinguishable from a delivered one at the call site. `reportResources`
 *  has always checked; this did not, and the boot answers this file now owes a caller are exactly the
 *  messages whose purpose is to end someone's wait.
 *
 *  The body is held character for character by `scripts/__tests__/agentSendTyped.test.mjs`, so the comment
 *  lives out here: that check strips comments and matches the body exactly, having watched three earlier
 *  drafts get bypassed by a renamed socket. */
  private sendMsg(msg: AgentControlOutbound): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  /** Send on a socket the caller has already established. Takes the socket **as an argument** rather than
   *  reading `this.ws`, and that is deliberate: the call sites that use it sit behind an entry guard
   *  (`if (!this.ws) return`), and today deleting one of those guards is a compile error. Reading
   *  `this.ws` here — or asserting it with `!` — would make the guard optional to the compiler and turn
   *  its removal into a runtime `TypeError` instead. It also serves the `agent:register` send, which runs
   *  inside `onopen` on a local socket. */
  private sendOn(ws: WebSocket, msg: AgentControlOutbound): void {
    ws.send(JSON.stringify(msg))
  }
  private deviceStates = new Map<string, DeviceState>()
  /**
   * One queue of rotation commands per device (#910). Each `setRotation` is its own `adb` process, so
   * two sent back to back can land in either order, and a held ⌘⇧O or a boot reset racing the first
   * press would leave the device on the earlier target. Keyed here rather than on `DeviceState`
   * because a re-register replaces the states while a command already in flight keeps running — the
   * boot reset that follows has to queue behind it, not start fresh beside it.
   */
  private readonly rotations = new Map<string, Promise<void>>()
  // Holds a macOS power assertion while connected so the host doesn't idle-throttle the
  // emulator (its software H.264 encoder starves badly when the Mac idles). No-op off macOS.
  private readonly sleepBlocker: SleepBlocker
  /** Host-mute helpers being stopped, by qemu pid. A re-boot of the same emulator keeps its qemu pid, and
   *  `pkill` matches by it, so a new mute must wait for the old stop or the stop would kill it. */
  private readonly pendingMuteStops = new Map<number, Promise<void>>()
  /** What the next "relay disconnected" line reports: when the relay last pinged, and the socket's last error. */
  private lastPingAt: number | null = null
  private lastSocketError: string | undefined
  private releaseStallWatch: (() => void) | null = null
  private relayUrl: string | null = null
  private resourcesTimer: ReturnType<typeof setInterval> | null = null
  private resourcesInFlight: WebSocket | null = null
  private readonly resources = createResourceSampler()
  private _stopping = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _reconnectAttempt = 0

  private readonly deviceFilter?: string
  private readonly reconnectDelays: number[]
  private readonly token?: string
  private readonly handshakeTimeoutMs: number
  private readonly runResetCmdTimeoutMs: number
  private readonly lean: boolean
  private readonly avdFormFactor: (avdName: string) => FormFactor | undefined
  private readonly avdOsVersion: (avdName: string) => string | undefined
  /** What each AVD's config says, read once per AVD per connection. The re-read runs every 30 s and the config does
   *  not change under a running agent; a new connection reads it again, which covers an AVD recreated in between. */
  private avdInfo = new Map<string, { formFactor?: FormFactor; osVersion?: string }>()
  /** Re-reads the device list for a relay that takes `agent:devices` (#1085). */
  private readonly deviceWatcher: DeviceListWatcher
  private readonly rotationLock: RotationLockMemory
  /** How long a shutdown whose kill failed watches for the emulator to finish exiting. A field so tests can
   *  shorten it — see `handleDeviceShutdown` for why it waits at all. */
  private shutdownSettleMs = 3_000

  constructor(options: AndroidAgentOptions = {}, adb?: AdbWrapper) {
    this.adb = adb ?? new AdbWrapper()
    this.launcher = new EmulatorLauncher()
    this.deviceFilter = options.deviceFilter
    this.token = options.token
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
    this.runResetCmdTimeoutMs = options.runResetCmdTimeoutMs ?? RUN_RESET_CMD_TIMEOUT_MS
    this.lean = options.lean ?? false
    this.avdFormFactor = options.avdFormFactor ?? ((name) => formFactorOf(name))
    // Never the developer's real AVDs under vitest: a suite's expectations would follow whatever images this Mac has.
    this.avdOsVersion = options.avdOsVersion ?? (process.env.VITEST ? () => undefined : (name) => osVersionOf(name))
    // `peekDevices`, not `listDevices`: the re-read must not sync the serial map a boot is relying on.
    this.deviceWatcher = new DeviceListWatcher({
      read: async () => this.offerDevices(await this.adb.peekDevices()),
      send: (devices) => { if (this.ws) this.sendOn(this.ws, { type: 'agent:devices', devices }) },
      onReadError: (e) => logger.debug(`device list re-read failed, trying again later: ${e instanceof Error ? e.message : String(e)}`),
      intervalMs: options.deviceRereadMs,
    })
    this.rotationLock = options.rotationLockMemory
      ?? (process.env.VITEST ? { freed: () => true, markFreed: () => {}, forget: () => {} } : avdRotationLockMemory)
    this.reconnectDelays = options.reconnectDelays ?? [1000, 2000, 4000, 8000, 16000, 30000]
    // No-op under vitest so the suite never spawns real `caffeinate` processes.
    this.sleepBlocker = options.sleepBlocker ?? (process.env.VITEST ? { acquire() {}, release() {} } : createSleepBlocker())
  }

  /**
   * **The one entry point that still takes the first registered session, and that is a decision.**
   *
   * Every other session-less member goes through `soleLiveOrNone` and refuses when the choice is
   * ambiguous (#617). This one does not, for the reason #617 gives itself: reading and writing are
   * not the same risk. The worst case here is answering about the wrong device; there it is taking
   * someone else's device off the network while they are using it.
   *
   * It also answers *before* any device is chosen — it is what an agent reports about itself — so a
   * refusal would turn "which session am I on" into an error on a healthy multi-device Mac.
   * `IOSAgent.sessionId` is identical, deliberately.
   */
  get sessionId(): string | null {
    const first = this.deviceStates.values().next().value
    return first?.sessionId ?? null
  }

  async connect(relayUrl: string): Promise<void> {
    this._stopping = false
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this.relayUrl = relayUrl
    this.avdInfo.clear()
    const offered = this.offerDevices(await this.adb.listDevices())

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl, this.wsClientOptions())
      let registered = false

      // 등록 응답이 영영 오지 않는 행 방지 — 시간 내 미등록이면 끊고 reject (#271)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new PlatformError(`relay handshake timed out after ${this.handshakeTimeoutMs}ms (${relayUrl})`))
      }, this.handshakeTimeoutMs)

      ws.once('open', () => {
        disableNagle(ws)
        this.sendOn(ws, {
          type: 'agent:register',
          platform: 'android',
          // Lets a viewer tell a clipboard-capable agent from one that predates the
          // feature, instead of inferring it from silence. See agent-core AgentCapability.
          capabilities: AGENT_CAPABILITIES,
          agentId: getMachineId(),
          agentName: os.hostname(),
          devices: offered,
        })
      })

      ws.once('message', (data) => {
        let msg: { type?: string; registeredSessions?: unknown; features?: unknown }
        try {
          msg = JSON.parse(data.toString())
        } catch {
          // malformed 첫 프레임이 핸들러 밖으로 throw되면 connect()가 reject 없이 행된다 (#272)
          clearTimeout(timer)
          ws.terminate()
          reject(new PlatformError('relay sent a malformed handshake response'))
          return
        }
        if (msg.type === 'agent:registered') {
          registered = true
          clearTimeout(timer)
          this.ws = ws
          this.sleepBlocker.acquire() // idempotent across reconnects
          this.initDeviceStates(
            msg.registeredSessions as Array<{ deviceId: string; sessionId: string }>,
          )
          ws.on('message', (d) => {
            try {
              const m = JSON.parse(d.toString()) as { type?: unknown; sessionId?: unknown; added?: unknown; removed?: unknown }
              // The one relay message that names no session: it is about the device list as a whole.
              if (m.type === 'agent:devices-applied') {
                const applied = m as AgentDevicesApplied
                this.applyDevices(applied.added ?? [], applied.removed ?? [])
                return
              }
              // Every type `handleRelayMessage` dispatches is session-scoped, and the relay resolves the
              // session before forwarding — so a message without one did not come from that path. Rejecting
              // it here is what lets the dispatcher declare `sessionId: string` instead of threading an
              // optional through 30 sends and asserting it with `!` at each one.
              if (typeof m.type !== 'string' || typeof m.sessionId !== 'string') return
              this.handleRelayMessage(m as { type: string; sessionId: string; requestId?: string; payload?: unknown })
            } catch { /* ignore malformed */ }
          })
          void this.reportResources()
          this.resourcesTimer = setInterval(() => { void this.reportResources() }, 5000)
          // Only a relay that said it takes `agent:devices`; see the same line in IOSAgent.
          if (Array.isArray(msg.features) && msg.features.includes('device-updates')) this.deviceWatcher.start(offered)
          this.lastPingAt = null
          this.lastSocketError = undefined
          ws.on('ping', () => { this.lastPingAt = Date.now() })
          // After registration the handshake's `once('error', reject)` lands on a settled promise, so the
          // code (ETIMEDOUT, ECONNRESET…) was dropped. It is the network half of the disconnect line.
          ws.on('error', (e: NodeJS.ErrnoException) => { this.lastSocketError = e.code ?? e.message })
          // `now` is taken here, at the close, not when the warning prints: the cleanup in between can run
          // work that holds the event loop and would inflate the ping age.
          ws.on('close', (code, reason) => this._scheduleReconnect({
            code, reason: reason.toString(), errorCode: this.lastSocketError, lastPingAt: this.lastPingAt, now: Date.now(),
          }))
          this.releaseStallWatch ??= acquireLoopStallWatch()
          resolve()
        } else {
          clearTimeout(timer)
          ws.close()
          reject(new PlatformError(`Unexpected message during handshake: ${msg.type}`))
        }
      })

      // 등록 전의 정상 close(예: 릴레이의 1008 인증 거절)는 'error' 없이 도착한다.
      // 사유를 살려 reject해야 무한 대기(스피너 행)가 아니라 진단 가능한 실패가 된다 (#271).
      ws.once('close', (code, reason) => {
        if (registered) return
        clearTimeout(timer)
        const reasonText = reason.toString()
        reject(new PlatformError(
          `relay closed the connection during handshake (code=${code}${reasonText ? `: ${reasonText}` : ''})`,
        ))
      })

      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer)
        ws.terminate()
        reject(new PlatformError(`relay rejected the WebSocket upgrade (HTTP ${res.statusCode})`))
      })

      ws.once('error', (e) => { clearTimeout(timer); reject(e) })
    })
  }

  /**
   * What this agent offers the relay out of `allDevices`: the `--device` filter, and what each AVD's config says — its
   * form factor, and its version when the emulator is not running to say it (#1085). Shared by the register and the
   * periodic re-read, so the two cannot offer different lists.
   */
  private offerDevices(allDevices: Device[]): DeviceReport[] {
    const devices = this.deviceFilter
      ? allDevices.filter((d) => d.name === this.deviceFilter || d.id === this.deviceFilter)
      : allDevices
    return devices.map((d) => {
      let info = this.avdInfo.get(d.name)
      if (!info) {
        info = { formFactor: this.avdFormFactor(d.name), osVersion: this.avdOsVersion(d.name) }
        this.avdInfo.set(d.name, info)
      }
      return {
        id: d.id,
        name: d.name,
        platform: d.platform,
        status: d.status,
        // A running emulator's own answer wins over what its image was built as.
        osVersion: d.osVersion ?? info.osVersion,
        formFactor: info.formFactor,
      }
    })
  }

  /** The relay made sessions for devices that appeared and removed the ones for devices that left (#1085). A removed
   *  session had nobody on it, so its state is retired as a reconnect retires it. */
  private applyDevices(added: Array<{ deviceId: string; sessionId: string }>, removed: Array<{ deviceId: string; sessionId: string }>): void {
    for (const { sessionId } of removed) {
      const state = this.deviceStates.get(sessionId)
      if (!state) continue
      this.bumpBootSeq(state, 'shut-down')
      this.cleanupDeviceState(state)
      this.deviceStates.delete(sessionId)
    }
    this.initDeviceStates(added.filter(({ sessionId }) => !this.deviceStates.has(sessionId)))
  }

  private initDeviceStates(
    registeredSessions: Array<{ deviceId: string; sessionId: string }>,
  ): void {
    registeredSessions.forEach(({ deviceId, sessionId }) => {
      this.deviceStates.set(sessionId, {
        sessionId,
        deviceId,
        touchHelper: null,
        booted: false,
        streamWs: null,
        scrcpySession: null,
        emulatorVideo: null,
        emulatorAudio: null,
        audioMuteQemuPid: null,
        grpcPort: null,
        grpcClient: null,
        cornerRadiusPx: 0,
        secureContext: false,
        external: false,
        rotation: null,
        streamRotation: 0,
        skin: null,
        body: null,
        latestFrame: null,
        touchRange: null,
        posturing: false,
        screenWatch: null,
        reconciling: false,
        displayWidth: 0,
        displayHeight: 0,
        videoWidth: 0,
        videoHeight: 0,
        landscape: false,
        lastTouchPx: { x: 0, y: 0 },
        gesture: null,
        bootSeq: 0,
        bootAbandon: new Map(),
        bootsInFlight: new Set(),
        restarting: false,
      })
    })
  }

  disconnect(): void {
    this._stopping = true
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    if (this.resourcesTimer) { clearInterval(this.resourcesTimer); this.resourcesTimer = null }
    this.deviceWatcher.stop()
    for (const state of this.deviceStates.values()) {
      this.bumpBootSeq(state, 'relay-lost')
      this.cleanupDeviceState(state)
    }
    this.deviceStates.clear()
    this.sleepBlocker.release()
    this.releaseStallWatch?.()
    this.releaseStallWatch = null
    this.ws?.close()
    this.ws = null
    this.relayUrl = null
  }

  /** `loss` is absent when a reconnect attempt failed: there is no close to describe, only a retry. */
  private _scheduleReconnect(loss?: RelayLoss): void {
    if (this._stopping) return
    if (this.resourcesTimer) { clearInterval(this.resourcesTimer); this.resourcesTimer = null }
    this.deviceWatcher.stop()
    for (const state of this.deviceStates.values()) {
      // **Invalidate any boot still in flight, which this agent did not do until now.** The map is dropped
      // just below, but a `handleDeviceBoot` awaiting the emulator holds its own reference and its seq
      // would still match — so it ran to completion against a state nobody owns, standing up a video
      // stream and sending `device:ready` for a session that no longer exists. iOS has invalidated here
      // since its helper-leak fix; the two agents disagreed about the same user action (losing the relay
      // mid-boot), which is the asymmetry the invariant table for #526 was written to surface.
      this.bumpBootSeq(state, 'relay-lost')
      this.cleanupDeviceState(state)
    }
    this.deviceStates.clear()
    this.ws = null

    const delays = this.reconnectDelays
    const delay = delays[Math.min(this._reconnectAttempt, delays.length - 1)]
    this._reconnectAttempt++
    logger.warn(loss
      ? `relay disconnected (${describeRelayLoss(loss)}) — reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`
      : `reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`)

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (this._stopping || !this.relayUrl) return
      this.connect(this.relayUrl).then(() => {
        this._reconnectAttempt = 0
        logger.info('reconnected to relay')
      }).catch((e) => {
        // 실패 원인을 남겨야 인증 거절(1008)과 네트워크 장애를 구분할 수 있다 (#271)
        logger.warn(`reconnect failed: ${e instanceof Error ? e.message : String(e)}`)
        this._scheduleReconnect()
      })
    }, delay)
  }

  /** Samples off the event loop, then reports. One sample at a time per socket, so a slow one (bounded by its
   *  1 s timeout) is not stacked by the next tick; keyed by socket, so a reconnect is not skipped behind the
   *  old socket's sample. Slots and the clock are read after the sample, when the report leaves. */
  private async reportResources(): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || this.resourcesInFlight === ws) return
    this.resourcesInFlight = ws
    try {
      const [{ memUsedMB, memTotalMB }, memoryPressure] = await Promise.all([
        this.resources.getMemoryUsage(),
        this.resources.getMemoryPressure(),
      ])
      // A reconnect while sampling replaced the socket: this report has nowhere to go.
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      const bootedCount = Array.from(this.deviceStates.values()).filter((s) => s.scrcpySession !== null || s.emulatorVideo !== null).length
      const slotsTotal = this.deviceStates.size
      this.sendOn(ws, {
        type: 'agent:resources',
        resources: {
          cpuPercent: this.resources.getCpuPercent(),
          memUsedMB,
          memTotalMB,
          slotsAvailable: Math.max(0, slotsTotal - bootedCount),
          slotsTotal,
          reportedAt: Date.now(),
          memoryPressure,
        },
      })
    } finally {
      if (this.resourcesInFlight === ws) this.resourcesInFlight = null
    }
  }

  private cleanupDeviceState(state: DeviceState): void {
    if (state.screenWatch) clearInterval(state.screenWatch)
    state.screenWatch = null
    const serial = this.adb.getSerial(state.deviceId)
    if (serial && state.scrcpySession) state.scrcpySession.stop(serial)
    state.scrcpySession = null
    state.emulatorVideo?.stop()
    state.emulatorVideo = null
    state.emulatorAudio?.cancel()
    state.emulatorAudio = null
    this.stopHostMute(state)
    this.clearGrpcState(state)
    state.touchHelper?.stop()
    state.touchHelper = null
    state.booted = false
    state.streamWs?.close()
    state.streamWs = null
    state.gesture = null
    // A restart still waiting to start belongs to the stream torn down above; it will see it lost its
    // seq and return. Left set, the next stream's own death would not restart it until then.
    state.restarting = false
  }

  /**
   * Drop everything only the gRPC backend writes, alongside the client itself.
   *
   * **Three paths tear a stream down and any of them can come back on scrcpy** — session
   * cleanup, the auto-restart, and the fallback taken when an emulator's gRPC endpoint cannot be
   * reached (booted externally, moved port). A stream that switches backend while these survive
   * inherits the emulator's coordinate map: a non-null `rotation` double-maps every tap against
   * frames that are already natural, a stale `skin` computes a correction for a capture that does
   * not turn, and `touchRange` divides by a grid scrcpy never injects into. One helper rather than
   * three copies, because the first version fixed the path that was easiest to see.
   */
  private clearGrpcState(state: DeviceState): void {
    // **The watcher is part of this too.** It is started only by the gRPC stream and it writes
    // the very fields below, so leaving it running while they are cleared lets its next tick put
    // them straight back — and a restart that lands on scrcpy never starts a new one, so the old
    // interval keeps a dead stream's `skin` alive for the rest of the session.
    if (state.screenWatch) clearInterval(state.screenWatch)
    state.screenWatch = null
    this.reconcileRunning.delete(state.deviceId)
    this.reconcileQueued.delete(state.deviceId)
    this.reconcileToken.delete(state.deviceId)
    state.grpcClient?.close()
    state.grpcClient = null
    state.cornerRadiusPx = 0
    state.rotation = null
    state.streamRotation = 0
    state.skin = null
    state.latestFrame = null
    state.touchRange = null
  }

  /** Send `session:chrome` for this device's current screen.
   *
   *  Called at boot and again whenever the screen changes under the session — a foldable swaps which
   *  physical display is on, so the size it carries is not settled once per boot the way it was when
   *  this payload only ever described a phone. The relay re-caches it (`setChromeData`) and the
   *  viewer replaces its copy, so re-sending is the whole update path. */
  /** A point the dashboard measured on the frame (`space: 'frame'`), as the screen Android draws — the space
   *  everything below takes. **Turned by the newest frame's skin, not by the chrome's correction**, which lags a
   *  turn by 0.6–3.6 s; a touch turned by that was a quarter off until it caught up, so the dashboard had to drop
   *  every touch in between. With `toDevicePx`'s own turn by `rotation` the two compose to the skin alone, so on
   *  the channel the rotation's lag cancels too. No skin known means the frame is the screen, as the chrome says. */
  private fromFrame(state: DeviceState, x: number, y: number, space: PointSpace | undefined): { x: number; y: number } {
    if (space !== 'frame') return { x, y }
    const skin = state.latestFrame?.skin ?? null
    const skinDegrees = skin === null ? null : SKIN_DEGREES[skin] ?? null
    if (skinDegrees === null) return { x, y }
    const turn = ((((skinDegrees - (state.rotation ?? 0)) % 360) + 360) % 360) as 0 | 90 | 180 | 270
    return toNaturalPoint(turn, x, y)
  }

  /** A normalised viewer point in device pixels, applying the display rotation when one is known.
   *
   *  Only the gRPC backend sets `state.rotation`. scrcpy captures with `capture_orientation=@0`, so
   *  its frames are already in the natural orientation and a rotation here would double-apply. */
  private toDevicePx(state: DeviceState, x: number, y: number): { px: number; py: number } {
    const p = state.rotation ? toNaturalPoint(state.rotation, x, y) : { x, y }
    // **The emulator's display, not the guest's panel.** The emulator converts these pixels into
    // its touch device's range, so the divisor has to be the size *it* holds — see
    // `EmulatorGrpcClient.getDisplaySize`. They agree unfolded, which is why this was invisible
    // until a foldable folded. scrcpy is excluded: its control channel takes the frame's own
    // pixels, so the panel size is already right there.
    const grid = state.grpcClient ? state.touchRange : null
    const px = Math.round(p.x * (grid?.width ?? state.videoWidth))
    const py = Math.round(p.y * (grid?.height ?? state.videoHeight))
    // `TAPFLOW_TOUCH_DEBUG=1` prints the whole transform for one tap. Off by default because it is
    // a line per touch, and worth having at all because every stage of this chain is invisible: a
    // tap that lands in the wrong place says nothing about *which* stage moved it, and the case
    // that fails is always a rotated one, where the viewer's space and the panel's disagree.
    if (process.env.TAPFLOW_TOUCH_DEBUG === '1') {
      logger.info(`touch → viewer ${x.toFixed(4)},${y.toFixed(4)}`
        + ` · shown ${state.displayWidth}×${state.displayHeight} rot ${state.rotation ?? 0}`
        + ` · natural ${p.x.toFixed(4)},${p.y.toFixed(4)}`
        + ` of ${grid ? `${grid.width}×${grid.height} (emulator display)` : `${state.videoWidth}×${state.videoHeight}`}`
        + ` · px ${px},${py}`)
    }
    return { px, py }
  }

  // ── PosturableAgent ────────────────────────────────────────────────────────
  // Android exposes postures through `cmd device_state`. Ordering and labelling live in
  // `postures.ts`; this half is only the adb round trip.

  /** Cached per device: which postures exist is a property of the hardware, not of its current
   *  state, and an uncached read put three adb round trips into every fold — enough for the control
   *  to feel like it had not registered the press. */
  private readonly postureCache = new Map<string, DevicePosture[]>()

  /** Injectable so the suite does not pay the real settling delay on every boot test. */
  private readonly metricsGapMs: number = Number(process.env.TAPFLOW_METRICS_GAP_MS) || METRICS_SAMPLE_GAP_MS

  async listPostures(deviceId: string): Promise<DevicePosture[]> {
    const cached = this.postureCache.get(deviceId)
    if (cached) return cached
    const serial = this.adb.getSerial(deviceId)
    if (!serial) return []
    // A device with no postures still answers, with a list that parses to nothing — which is the
    // empty list the capability contract asks for, so there is nothing to special-case.
    const postures = await this.adb.printDeviceStates(serial).then(parsePostures).catch(() => [])
    this.postureCache.set(deviceId, postures)
    return postures
  }

  async getPosture(deviceId: string): Promise<DevicePosture | null> {
    const serial = this.adb.getSerial(deviceId)
    if (!serial) return null
    const [postures, current] = await Promise.all([
      this.listPostures(deviceId),
      this.adb.deviceState(serial).then(parseCurrentPosture).catch(() => null),
    ])
    return postures.find((p) => p.id === current) ?? null
  }

  /**
   * Put the device into a posture, keeping the orientation it was already in.
   *
   * **Each panel remembers its own rotation, and a person does not think of it that way.** Folding a
   * device held sideways and unfolding it gives you the inner panel's last rotation, not the one you
   * were just looking at — so a landscape session came back landscape only by coincidence, and a
   * portrait one came back landscape. Carrying the rotation across makes the posture control change
   * one thing at a time, which is what a physical hinge does.
   *
   * The rotation is re-applied rather than pre-set: the panels swap during the change, and a lock
   * written before it is overwritten by whatever the incoming panel had.
   */
  async setPosture(deviceId: string, postureId: string): Promise<void> {
    const { serial, before } = await this.beginPosture(deviceId, postureId)
    // `deviceStates` is keyed by session and this entry point takes a device, so the device's live state is looked
    // up: `finishPosture` needs it to tell a body-drawn (gRPC) emulator, which must never get a lock, from one on
    // scrcpy. The capability's callers hold no viewer, so nothing is re-described to them here.
    const live = [...this.deviceStates.values()].find((s) => s.deviceId === deviceId && s.booted) ?? null
    await this.finishPosture(live, serial, before)
  }

  /**
   * Write the posture and wait for the **guest** to commit it — nothing more.
   *
   * Split from the rotation carry because the viewer holds the picture until `device:postures`
   * says the device arrived, and that report used to wait for the carry's settling read as well.
   * Measured on a Pixel 9 Pro Fold: the screen's own description was already on the wire at
   * ~740ms while the posture report landed at ~1100ms, so the last ~380ms of every fold was the
   * viewer waiting on a read whose answer it does not consume.
   *
   * The wait is a direct read of the thing that changed — `cmd device_state state` at 20ms a
   * call — rather than an inference from the display settling. A commit that never arrives falls
   * out after `POSTURE_COMMIT_TIMEOUT_MS`, and the report then says what the device really is.
   */
  private async beginPosture(deviceId: string, postureId: string): Promise<{ serial: string; before: 0 | 90 | 180 | 270 | null }> {
    const serial = this.adb.getSerial(deviceId)
    if (!serial) throw new PlatformError(`No device for ${deviceId}`)
    // Checked against the list rather than passed through. The list is what the *guest* says it
    // supports, filtered to what the emulator console can actually reach — so an id outside it is
    // either unknown or a posture tapflow cannot move the device into, and both would read as a
    // change that silently did nothing.
    const postures = await this.listPostures(deviceId)
    if (!postures.some((p) => p.id === postureId)) {
      throw new PlatformError(`Unknown posture "${postureId}" for ${deviceId}`)
    }
    const before = (await this.adb.getDisplayMetrics(serial).catch(() => null))?.rotation ?? null
    await this.adb.setPosture(serial, postureId)
    const started = Date.now()
    // Measured against the clock, not by adding up the sleeps: each pass also costs a read, so
    // counting only the gaps overran the constant this promises by a third.
    while (Date.now() - started < POSTURE_COMMIT_TIMEOUT_MS) {
      const current = await this.adb.deviceState(serial).then(parseCurrentPosture).catch(() => null)
      if (current === postureId) {
        logger.info(`posture ${postureId}: guest committed in ${Date.now() - started}ms`)
        return { serial, before }
      }
      await new Promise((resolve) => setTimeout(resolve, POSTURE_COMMIT_POLL_MS))
    }
    logger.warn(`posture ${postureId}: guest did not commit within ${POSTURE_COMMIT_TIMEOUT_MS}ms`)
    return { serial, before }
  }

  /**
   * Put the panel back into the orientation the tester was already in.
   *
   * **Each panel remembers its own rotation, and a person does not think of it that way.** Folding
   * a device held sideways and unfolding it gives you the inner panel's last rotation, not the one
   * you were just looking at — so a landscape session came back landscape only by coincidence, and
   * a portrait one came back landscape. Carrying the rotation across makes the posture control
   * change one thing at a time, which is what a physical hinge does.
   *
   * The rotation is re-applied rather than pre-set: the panels swap during the change, and a lock
   * written before it is overwritten by whatever the incoming panel had.
   *
   * **Off the critical path, and it still settles.** It needs the rotation the *incoming* panel
   * settled on, which a single reading taken mid-fold gets wrong. That duplicates the settling the
   * frame-driven reconcile is doing at the same moment; sharing one would mean waiting on that
   * reconcile's completion, and the duplicate is now background work that delays nothing a viewer
   * sees. Left deliberately rather than by omission.
   */
  private async finishPosture(state: DeviceState | null, serial: string, before: 0 | 90 | 180 | 270 | null): Promise<void> {
    // Not on gRPC: its viewer draws the body, which a fold does not move, and Android picks the new panel's
    // rotation from the sensor; carrying a lock across is what made apps stop following the body.
    // **On an emulator, only a scrcpy session carries a lock** — the one backend whose viewer toggles. Asked as "is it
    // scrcpy", not "is it gRPC": a gRPC stream that is restarting has no client for a moment, and an emulator with
    // no session streams over gRPC when it next streams; both draw the body, and a lock there is what made apps stop
    // following it. A real device has no body and keeps the carry.
    if (before === null) return
    if (serial.startsWith('emulator-') && !state?.scrcpySession) return
    const after = await this.stableDisplayMetrics(serial)
    if (!after || after.rotation === before) return
    // Asked again after the settling read: a boot can replace scrcpy with gRPC in that second, after its
    // `prepareBody` has freed the lock this would write back.
    if (serial.startsWith('emulator-') && !state?.scrcpySession) return
    const quarter = (before / 90) as 0 | 1 | 2 | 3
    logger.info(`posture: carrying rotation ${before} across`)
    await this.adb.setRotation(serial, quarter)
      .then(() => { if (state) this.lockWritten(state, serial) })
      .catch((e: unknown) => logger.warn(`could not carry the rotation across: ${(e as Error).message}`))
    // **And say so, for the same reason `input:rotate` does.** A rotation changes the correction
    // the viewer applies but not the frame's dimensions — the capture is the skin, which does not
    // move — so nothing in the stream reveals it, and an idle screen sends no frame either. It
    // also leaves `state.rotation` stale, which is what `toDevicePx` maps every tap through. The
    // report had already gone out by now, so without this the picture is shown a quarter turn out
    // until the watcher's next tick, and taps land there too.
    if (!state?.grpcClient) return
    // Owned by this stream: a boot replacing it mid-settle must not get this pass's geometry.
    const client = state.grpcClient
    const changed = await this.reconcileSerial(
      state, serial, state.videoWidth, state.videoHeight, state.skin, () => state.grpcClient === client)
    if (changed && state.booted) this.sendChrome(state)
  }

  /** Tell the viewer which postures exist and which one the device is in. Sent at boot and after a
   *  change, so a viewer that joined late is not left without the control. */
  private async sendPostures(state: DeviceState): Promise<void> {
    const [postures, current] = await Promise.all([
      this.listPostures(state.deviceId),
      this.getPosture(state.deviceId),
    ])
    this.sendMsg({
      type: 'device:postures',
      sessionId: state.sessionId,
      payload: { postures, currentId: current?.id ?? null },
    })
  }

  private sendChrome(state: DeviceState): void {
    this.sendMsg({
      type: 'session:chrome',
      sessionId: state.sessionId,
      payload: {
        buttons: ANDROID_BUTTONS,
        streamType: 'h264',
        screenWidth: state.displayWidth,
        screenHeight: state.displayHeight,
        // A fraction of the width the viewer is about to lay out, computed here rather than
        // stored, so a rotation re-sends the right one without anything having to remember to.
        cornerRadius: state.displayWidth > 0 ? state.cornerRadiusPx / state.displayWidth : 0,
        streamRotation: state.streamRotation,
        // Body mode is the gRPC backend: its frames arrive as the body is held. Never on scrcpy, whose frames are
        // the natural panel and whose viewer toggles.
        ...(state.grpcClient ? { bodyRotation: this.bodyRotationOf(state) } : {}),
      },
    })
  }

  /** The body's clockwise turn: whichever came last of a console reading (boot, a turn) and a frame's skin
   *  inverted (REVERSE_LANDSCAPE is a quarter clockwise — measured; `reconcileScreen` writes it). Upright when
   *  neither has answered — the body is never sent as "not known". */
  private bodyRotationOf(state: DeviceState): 0 | 90 | 180 | 270 {
    return state.body ?? 0
  }

  /**
   * `getDisplayMetrics`, sampled until two consecutive reads agree.
   *
   * **A fold changes the panel before Android rotates onto it.** Measured on a Pixel 9 Pro Fold:
   * 300ms after unfolding, `init` was already the inner panel while `cur` and `mRotation` still
   * described the cover; by 600ms both had caught up. Reading inside that window returns the new
   * size with the old rotation, and since the viewer turns the picture by the difference between
   * the two, the error is a visible quarter turn — and it alternates, because the next fold reads
   * cleanly and the one after does not.
   *
   * Sampling rather than a fixed sleep: the lag is a few hundred milliseconds on this machine and
   * nothing says it is that everywhere. **A run of equal reads, not a pair** — a pair taken inside
   * the lag agrees with itself about the posture being left, which is how one unfold in seven came
   * out a quarter turn wrong. See `METRICS_STABLE_RUN`.
   */
  private async stableDisplayMetrics(serial: string): Promise<DisplayMetrics | null> {
    const same = (a: DisplayMetrics, b: DisplayMetrics) =>
      a.natural.width === b.natural.width && a.natural.height === b.natural.height
      && a.current.width === b.current.width && a.current.height === b.current.height
      && a.rotation === b.rotation
    let previous: DisplayMetrics | null = null
    let run = 1
    // Reported because the cost of this loop is **entirely** the waiting: `dumpsys window
    // displays` measures 20ms on a Pixel 9 Pro Fold, so a settle that takes seconds took them in
    // `metricsGapMs`, once per sample the reading refused to repeat. A fold that feels slow and
    // one that feels instant differ only in this number, and nothing else says what it was.
    const started = Date.now()
    const report = (n: number, why: string) =>
      logger.info(`display settled after ${n} sample${n === 1 ? '' : 's'} in ${Date.now() - started}ms (${why})`)
    for (let attempt = 0; attempt < METRICS_SAMPLES; attempt++) {
      const next = await this.adb.getDisplayMetrics(serial).catch(() => null)
      const repeated = next !== null && previous !== null && same(previous, next)
      // Which field moved, when one did. A panel that keeps changing shape and a panel whose
      // rotation keeps being re-decided are different problems with the same symptom.
      if (previous && next && !repeated) {
        const moved = [
          previous.natural.width !== next.natural.width || previous.natural.height !== next.natural.height ? 'panel' : null,
          previous.current.width !== next.current.width || previous.current.height !== next.current.height ? 'screen' : null,
          previous.rotation !== next.rotation ? `rotation ${previous.rotation}→${next.rotation}` : null,
        ].filter(Boolean).join(', ')
        logger.info(`display still moving at sample ${attempt + 1}: ${moved}`)
      }
      run = repeated ? run + 1 : 1
      if (next && run >= METRICS_STABLE_RUN) { report(attempt + 1, 'stable'); return next }
      previous = next
      await new Promise((resolve) => setTimeout(resolve, this.metricsGapMs))
    }
    report(METRICS_SAMPLES, 'gave up, using the last reading')
    // Ran out of attempts: the last reading is still better than the frame's own dimensions, which
    // are the emulator's orientation rather than Android's.
    return previous
  }

  /**
   * Start every session from the same place: unfolded and upright.
   *
   * **A device remembers.** The posture and the rotation lock survive the session that set them, so
   * a viewer opening a device inherits whatever the last one left — and two people describing "the
   * same" screen can be describing different states. That is not only confusing to use; it made the
   * orientation arithmetic impossible to pin down, because no reading could be attributed to a
   * state either party could name.
   *
   * Best effort: a device with no postures just gets the rotation, and a failure to reach either is
   * logged rather than failing the boot. The session is usable in the state it is in.
   */
  private async normaliseOnBoot(state: DeviceState, serial: string, owns: () => boolean = () => true): Promise<void> {
    // Not run for a restart, and the caller decides that rather than a flag on the state: a restart is
    // not a boot — the tester is mid-test — but a shared flag also read as a restart for a *new* boot
    // arriving while an old restart waited, which then inherited the last session's posture.
    //
    // `owns` between steps: these are writes to the device, and a boot that lost its seq must not fold
    // or rotate the device the newer one is setting up.
    const postures = await this.listPostures(state.deviceId)
    if (!owns()) return
    const open = bootPostureId(postures)
    const folded = open !== null && open !== (await this.getPosture(state.deviceId))?.id
    if (!owns()) return
    if (folded) {
      await this.adb.setPosture(serial, open)
        .catch((e: unknown) => logger.warn(`could not unfold on boot: ${(e as Error).message}`))
      // `setPosture` records why: a lock written while the panels are swapping is overwritten by
      // whatever the incoming panel had. Paid only on the rare boot that inherits a folded device
      // — the settling read is what kept the stream waiting when it ran on every boot.
      await this.stableDisplayMetrics(serial)
    }
    // **No rotation lock any more.** This used to lock a foldable to 0, because a posture change was unreadable
    // from an unknown starting state while the viewer drew Android's display. A gRPC viewer now draws the body,
    // which folding does not move (measured), and Android rotates the display itself; the body was stood up
    // before the stream started (`prepareBody`), and the lock is what kept apps from following it.
  }

  /** Re-read the display on a timer for as long as the session lives, and tell the viewer when it
   *  moved. See `SCREEN_WATCH_INTERVAL_MS` for why this is a poll rather than a one-shot read. */
  private watchScreen(state: DeviceState, serial: string, skin: SkinRotation, owns: () => boolean = () => true): void {
    if (state.screenWatch) clearInterval(state.screenWatch)
    state.screenWatch = setInterval(() => {
      // A reconcile may still be running from a fold; skipping a tick is free, since the next one
      // is two seconds away and the fold's own reconcile is doing the same work.
      // A reconcile already running is the answer this tick would have asked for, and
      // `reconcileSerial` would coalesce onto it anyway; skipping saves the cheap read too.
      if (state.reconciling) return
      void (async () => {
        // **One cheap read first, and settle only if it moved.** `reconcileScreen` samples until
        // three readings agree, which costs ~700ms of waiting — and this poll paid it every two
        // seconds for the life of the session, on a device that had not changed. Measured: the
        // read itself is 20ms, so a steady-state tick is now 3% of what it was, and the sampling
        // it used to do no longer competes with a fold's own.
        const quick = await this.adb.getDisplayMetrics(serial).catch(() => null)
        if (quick
          && quick.natural.width === state.videoWidth && quick.natural.height === state.videoHeight
          && quick.current.width === state.displayWidth && quick.current.height === state.displayHeight
          && quick.rotation === state.rotation) return
        // It moved, or could not be read. Either way the settling pass is the one that answers,
        // because a single reading taken mid-fold describes the posture being left.
        // `owns`: a tick that settles across a boot replacing this stream must not write into it.
        const changed = await this.reconcileSerial(
          state, serial, state.videoWidth, state.videoHeight, state.skin ?? skin, owns)
        if (changed && state.booted) this.sendChrome(state)
      })()
        .catch((e: unknown) => logger.debug(`screen watch: ${(e as Error).message}`))
    }, SCREEN_WATCH_INTERVAL_MS)
    // Never hold the process open for a poll.
    state.screenWatch.unref?.()
  }

  /**
   * One reconcile per device at a time, with at most one waiting behind it.
   *
   * **Four callers read the same display and write the same fields**, and only two of them took
   * the `reconciling` flag: the watcher and the frame's own `onSizeChange`. `input:rotate` and
   * the posture carry did not, so a rotate landing during a watcher tick put two settling passes
   * in flight over one `DeviceState` — and the one that finished last won, which is not the one
   * that read last. The loser's dimensions, rotation and corner radius were committed, and a
   * `session:chrome` went out describing them.
   *
   * **Coalesced rather than queued, because a reconcile is a question and not a command.** Every
   * caller asks "what is the display now"; three asked while one runs are one question with one
   * answer, and running three settling passes back to back would cost seconds reading a value
   * that did not change between them. So the first request while one is running schedules the
   * single pass that follows it, and later ones join that same pass — they get a *fresh* read
   * rather than the running pass's answer, because the change they are asking about may have
   * landed after it sampled.
   *
   * This also retires the dropped-callback problem `skinDirty` existed for: `onSizeChange` no
   * longer loses a change it arrived too early for — it waits for one.
   */
  private reconcileSerial(
    state: DeviceState, serial: string, w: number, h: number, skin: SkinRotation | null,
    owns: () => boolean = () => true,
  ): Promise<boolean> {
    const key = state.deviceId
    const running = this.reconcileRunning.get(key)
    if (!running) return this.startReconcile(state, serial, w, h, skin, key, owns)
    const queued = this.reconcileQueued.get(key)
    if (queued) return queued
    const next = running
      // The trailing pass runs whatever the running one did, including throw.
      .catch(() => false)
      .then(() => {
        this.reconcileQueued.delete(key)
        return this.startReconcile(state, serial, w, h, skin, key, owns)
      })
    this.reconcileQueued.set(key, next)
    return next
  }

  private startReconcile(
    state: DeviceState, serial: string, w: number, h: number, skin: SkinRotation | null, key: string,
    owns: () => boolean,
  ): Promise<boolean> {
    // A token rather than the promise itself: the cleanup runs inside the promise it would have
    // to name, and comparing identity is all it needs — "is the map still pointing at me".
    const token = Symbol('reconcile')
    const running = (async () => {
      state.reconciling = true
      try {
        // **The newest frame, not the asker's.** A pass started by a rotate or the watcher carries the skin last
        // *committed*, and a trailing pass carries whatever its first joiner brought — so a frame's new skin that
        // joined the queue second, or arrived while a rotate's pass was being asked for, was lost, and that pass
        // committed the old skin: the viewer framed a turned body the old way (measured on a Galaxy S23, a
        // landscape frame stretched into a portrait shell). The latest frame is always the right question.
        const latest = state.latestFrame
        return await this.reconcileScreen(state, serial, latest?.w ?? w, latest?.h ?? h, latest ? latest.skin : skin, true, owns)
      } finally {
        state.reconciling = false
        // Only if this is still the current one: a trailing pass may already have replaced it.
        if (this.reconcileToken.get(key) === token) {
          this.reconcileToken.delete(key)
          this.reconcileRunning.delete(key)
        }
      }
    })()
    this.reconcileToken.set(key, token)
    this.reconcileRunning.set(key, running)
    return running
  }

  /** In-flight and trailing reconciles, per device. See `reconcileSerial`. */
  private readonly reconcileRunning = new Map<string, Promise<boolean>>()
  private readonly reconcileQueued = new Map<string, Promise<boolean>>()
  private readonly reconcileToken = new Map<string, symbol>()

  /** Bring the device's coordinate spaces in step with what Android is drawing.
   *
   *  Three facts, read together because no two of them determine the third:
   *  - **natural** (`videoWidth/Height`) is the panel unrotated, and what the emulator's gRPC input
   *    takes.
   *  - **current** (`displayWidth/Height`) is what Android draws, so it is what a viewer frames and
   *    what a person points at.
   *  - **rotation** bridges them at input time.
   *
   *  Folding changes all three — the cover panel is a different display, and Android rotates back to
   *  0 on it — so they are re-read rather than derived from the frame. Returns true when anything
   *  changed. */
  private async reconcileScreen(
    state: DeviceState, serial: string, frameW: number, frameH: number, skin: SkinRotation | null,
    settle = true,
    // **Asked after each read and before each batch of writes.** A reconcile started by a stream that
    // has since been replaced — its first frame, or its boot — would otherwise write its geometry into
    // the session that replaced it, and those fields are exactly what `clearGrpcState` exists to clear.
    owns: () => boolean = () => true,
  ): Promise<boolean> {
    // The frame is the fallback, not the source: it arrives in the emulator's physical orientation,
    // which folded is 90° from what Android is drawing.
    // **Boot does not wait.** Settling can take a few seconds, and boot has a deadline it has to
    // answer inside — spending that budget here left the session with no stream at all, which is a
    // far worse failure than a screen that is briefly a quarter turn out. The watcher corrects it
    // within its interval, which is the whole point of polling.
    const m = settle
      ? await this.stableDisplayMetrics(serial)
      : await this.adb.getDisplayMetrics(serial).catch(() => null)
    if (!owns()) return false
    const natural = m?.natural ?? { width: frameW, height: frameH }
    const current = m?.current ?? { width: frameW, height: frameH }
    const rotation = m?.rotation ?? 0
    // **`skin − rotation`, and the sign has been flipped twice while chasing a moving target.**
    //
    // The corrections that are settled: at rotation 0 the picture needs 270 (folded and unfolded
    // alike — boot lands here, and it is correct). What is not settled is rotation 270, where
    // observations of the same posture have come back both "0 is wrong" and "180 is wrong", which
    // cannot both hold. Those readings were taken from sessions that had been folded and rotated
    // several times over, so the device was not in a state either of us could name.
    //
    // This is the form that matches every reading taken from a *known* state, and the session now
    // starts from one — see `normaliseOnBoot`. The landscape case is tracked separately rather than
    // fitted to readings that contradict each other.
    // `SKIN_DEGREES` is keyed by the emulator's own enum, and an entry it does not carry gives
    // `undefined` — which propagates as `NaN` through the arithmetic below and out to the viewer
    // as a correction nobody can apply, silently. The type says that cannot happen; the value
    // comes off the wire, so it can. An unknown skin means no correction, which is what a
    // device whose capture does not turn already gets.
    const skinDegrees = skin === null ? null : SKIN_DEGREES[skin] ?? null
    if (skin !== null && skinDegrees === null) logger.warn(`unknown skin orientation ${skin}; not correcting`)
    const streamRotation = skinDegrees === null
      ? 0
      : ((((skinDegrees - rotation) % 360) + 360) % 360) as 0 | 90 | 180 | 270
    const same = natural.width === state.videoWidth && natural.height === state.videoHeight
      && current.width === state.displayWidth && current.height === state.displayHeight
      && rotation === state.rotation && streamRotation === state.streamRotation && skin === state.skin
    if (same) return false
    state.videoWidth = natural.width
    state.videoHeight = natural.height
    state.displayWidth = current.width
    state.displayHeight = current.height
    state.rotation = rotation
    // The emulator's capture is the panel in its fixed physical orientation — measured as a
    // constant quarter turn from natural on this backend — so the correction is whatever is left
    // between that and the rotation Android is applying. scrcpy captures natural itself and gets 0,
    // which is also the value a device that never rotates ends up with.
    // The panel changed, so its curve may have too. Read from Android rather than kept from the
    // frame measurement, which cannot survive the capture being a quarter turn from the screen.
    const radius = await this.adb.getCornerRadius(serial, natural.width, natural.height).catch(() => null)
    if (!owns()) return false
    if (radius !== null) state.cornerRadiusPx = radius
    state.streamRotation = streamRotation
    state.skin = skin
    // The frame's skin is the body too, and newer than a console read when it lands — a turn made in the
    // emulator's own controls reaches the agent only this way.
    if (skinDegrees !== null) state.body = ((360 - skinDegrees) % 360) as 0 | 90 | 180 | 270
    logger.info(`screen → touch ${natural.width}×${natural.height}, shown ${current.width}×${current.height}, rot ${rotation}, correct ${state.streamRotation}`)
    return true
  }

  private sendDeviceInfo(state: DeviceState, device: Device): void {
    // `readyState`, not presence: this runs mid-boot, and a socket that closed since the entry guard
    // takes the payload into a buffer nobody flushes while `device:ready` is dropped by `sendMsg`'s own
    // check — leaving the caller with neither the data nor an answer.
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.sendOn(this.ws, {
      type: 'session:deviceInfo',
      sessionId: state.sessionId,
      payload: {
        deviceName: device.name,
        osVersion: device.osVersion ?? '',
      },
    })
  }

  private forceScrcpy(): boolean {
    return process.env.TAPFLOW_ANDROID_BACKEND === 'scrcpy'
  }

  private useGrpc(serial: string): boolean {
    return pickAndroidBackend(serial) === 'grpc'
  }

  // The active low-latency pointer backend (gRPC preferred), or null when only the ADB fallback
  // (AndroidTouchHelper) is available. Coordinates go in state.videoWidth/Height px — the device's
  // natural space, which is what the emulator's gRPC input takes.
  private pointerControl(state: DeviceState): PointerControl | null {
    if (state.grpcClient) return state.grpcClient
    if (state.scrcpySession) return state.scrcpySession.control
    return null
  }

  // Clipboard work parks a sentinel on the device while it waits, so two operations on the same
  // device must not interleave — each would read the other's marker instead of the real
  // clipboard. Keyed by device, not session: several sessions (and MCP) can address one device.
  private readonly clipboardQueue = createKeyedSerialQueue()
  // Device-scoped, not operation-scoped. Several sessions (and MCP) can address one emulator, so
  // an operation that fails before parking anything may still be answering while ANOTHER holds a
  // marker down. The viewer decides from this whether pressing the plain chord is safe, and that
  // chord travels as `input:key` — outside this queue — so the answer has to describe the device
  // rather than the caller. Mirrors the iOS agent.
  private readonly parkedSentinels = new Map<string, number>()

  private markSentinel(deviceId: string, delta: 1 | -1): void {
    const n = (this.parkedSentinels.get(deviceId) ?? 0) + delta
    if (n > 0) this.parkedSentinels.set(deviceId, n)
    else this.parkedSentinels.delete(deviceId)
  }

  private sentinelParked(deviceId: string): boolean {
    return (this.parkedSentinels.get(deviceId) ?? 0) > 0
  }

  // Fire-and-forget a pointer call: gRPC methods are async (swallow rejection), scrcpy sync (no-op).
  private fire(r: void | Promise<void>): void {
    if (r) r.catch(() => {})
  }

  // Port to launch the emulator with (`-grpc <port>`, unsecured localhost). A plain `-grpc` endpoint
  // is unsecured; without it the emulator opens its DEFAULT gRPC port with token auth, which our
  // unauthenticated client can't use. Launches are always AVDs (emulators), so default to gRPC
  // unless explicitly forced to scrcpy. undefined = don't open gRPC.
  // Ports reserved between pick() and the emulator actually binding them — avoids two concurrent
  // boots racing onto the same port before either emulator has claimed it.
  private pendingGrpcPorts = new Set<number>()

  // A FREE gRPC port for a new emulator. Each emulator must get its own port — a shared fixed 8554
  // makes a second emulator collide and every session ends up streaming the first emulator (#stream-bleed).
  private async pickFreeGrpcPort(): Promise<number> {
    const base = Number(process.env.TAPFLOW_ANDROID_GRPC_PORT) || 8554
    for (let p = base; p < base + 200; p += 2) { // emulators conventionally use even ports
      if (this.pendingGrpcPorts.has(p)) continue
      // Reserve before the async probe so two concurrent boots can't both claim the same port.
      this.pendingGrpcPorts.add(p)
      let free = false
      try {
        free = await isTcpPortFree(p)
        if (free) return p
      } finally {
        if (!free) this.pendingGrpcPorts.delete(p)
      }
    }
    throw new PlatformError('No free gRPC port available for the emulator')
  }

  // Audio output is ON by default; opt out with TAPFLOW_AUDIO=off. Gates both emulator launch
  // (`-no-audio` removal) and the gRPC streamAudio pump — both must read the same flag so the audio
  // backend matches the stream. Unlike iOS, the emulator also plays to the host (agent Mac) — it has
  // no host-output-only mute, so use the Mac's own volume; see contributing/simulator-audio.md (#341).
  private audioEnabled(): boolean {
    return process.env.TAPFLOW_AUDIO !== 'off'
  }

  /**
   * Start this device's stream, writing to the shared state **only while `owns()` holds** (#587).
   *
   * `owns` is the caller's seq check — a boot's or a restart's. This runs across awaits, and a newer
   * boot's `cleanupDeviceState` stops only what the state points at when it runs. A handle this start
   * published after that, or never published, was stopped by nobody: a scrcpy server, or a gRPC
   * capture with its interval and host-mute tap, for the life of the agent. Worse, a late write could
   * land over the newer boot's own handle and orphan *that*. So a start that finds it no longer owns
   * the state stops what it created itself, clears a shared field only while it still points at its
   * own handle, and throws `StreamSuperseded`. Every catcher decides on the seq, not on the error.
   */
  private async startVideoStream(
    state: DeviceState, streamWs: WebSocket,
    owns: () => boolean = () => true, opts: { restart: boolean; upright?: boolean } = { restart: false },
  ): Promise<void> {
    const serial = this.adb.getSerial(state.deviceId)
    // Was a silent return, and the boot went on to answer `device:ready` for a stream that never
    // started (#611). The boot checks this before describing the device or declaring it ready; this is the backstop.
    if (!serial) throw new PlatformError(EMULATOR_GONE)
    // Ahead of the backend split, so it covers an emulator that ends up on scrcpy too. Queued with the
    // rotations, so an undo from the viewer this boot replaced lands first. An emulator turns its **body**
    // (console only — no gRPC needed): its rotation lock is freed once per AVD, and the body is stood up
    // only for a boot that brought it up or a run — the orientation is otherwise the device's. A real
    // device keeps #910's stand-up of a locked rotation.
    if (!opts.restart) {
      await this.enqueueRotation(state.deviceId, () => (serial.startsWith('emulator-')
        ? this.prepareBody(state, serial, opts.upright === true)
        : this.uprightOnBoot(serial)))
    }

    // Emulator: capture via gRPC streamScreenshot + Mac VideoToolbox (bypasses the guest SW H.264
    // encoder). On any failure (e.g. an externally-booted emulator without `-grpc`), fall back to
    // scrcpy so streaming still works.
    if (this.useGrpc(serial)) {
      try {
        await this.startGrpcVideoStream(state, streamWs, serial, owns, opts)
        return
      } catch (e) {
        // **On the seq, not on the error.** A newer boot's cleanup stops this capture mid-start, and
        // it rejects as an ordinary error — taken as a gRPC failure, the fallback below tore down
        // what was by then the newer boot's touch channel and started a scrcpy session for a boot
        // that had already lost. `startGrpcVideoStream` has released its own handles by now.
        if (!owns()) throw e instanceof StreamSuperseded ? e : new StreamSuperseded()
        logger.warn(`gRPC backend failed (${(e as Error).message}) — falling back to scrcpy`)
        state.emulatorVideo?.stop(); state.emulatorVideo = null
        this.clearGrpcState(state)
        state.touchHelper?.stop(); state.touchHelper = null
      }
    }

    const created: StreamHandles = {}
    try {
      const touchHelper = new AndroidTouchHelper(this.adb, serial)
      touchHelper.start()
      created.touchHelper = touchHelper
      state.touchHelper = touchHelper

      // **An emulator on scrcpy is not in body mode**: its frames are the natural panel and its viewer toggles,
      // starting upright — so its body is stood up, or a Fold that boots turned a quarter would show sideways.
      if (serial.startsWith('emulator-')) await this.enqueueRotation(state.deviceId, async () => { await this.turnBodyTo(state, serial, 0) })
      if (!owns()) throw new StreamSuperseded()
      const session = new ScrcpySession()
      created.scrcpySession = session
      const info = await session.start(serial)
      if (!owns()) throw new StreamSuperseded()
      state.scrcpySession = session
      // A restart is not a boot: the viewer stays mounted and keeps the orientation it shows.
      if (!opts.restart) state.landscape = false

      state.displayWidth = info.width
      state.displayHeight = info.height
      state.videoWidth = info.width
      state.videoHeight = info.height

      const reader = session.video.start().getReader()

      // Detect video size changes via H.264 SPS so ScrcpyControl.screenSize always matches what
      // scrcpy is encoding (landscape-aware vs portrait-locked). The SPS leads the keyframe AU.
      const onFrame = (value: ScrcpyFrame) => {
        if (state.scrcpySession !== session) return
        const parsed = parseSpsFromNal(value.payload)
        if (parsed && (parsed.width !== state.videoWidth || parsed.height !== state.videoHeight)) {
          state.videoWidth = parsed.width
          state.videoHeight = parsed.height
          state.scrcpySession?.control.updateScreenSize(parsed.width, parsed.height)
          logger.info(`video size → ${parsed.width}×${parsed.height}`)
        }
      }

      void this.pumpVideo(state, streamWs, reader, onFrame, () => session.control.resetVideo()).then(() => {
        if (state.scrcpySession === session && !state.restarting) {
          state.restarting = true
          void this.restartVideoStream(state)
        }
      })
    } catch (e) {
      if (!owns()) {
        this.releaseStream(state, serial, created)
        throw e instanceof StreamSuperseded ? e : new StreamSuperseded()
      }
      throw e
    }
  }

  /** Stop what one stream start created, and clear each shared field only while it is still that
   *  start's — a newer boot may have written its own there already. Everything here is idempotent,
   *  because the newer boot's cleanup may have stopped some of it first. */
  private releaseStream(state: DeviceState, serial: string, h: StreamHandles): void {
    if (h.touchHelper) {
      h.touchHelper.stop()
      if (state.touchHelper === h.touchHelper) state.touchHelper = null
    }
    if (h.scrcpySession) {
      h.scrcpySession.stop(serial)
      if (state.scrcpySession === h.scrcpySession) state.scrcpySession = null
    }
    if (h.emulatorVideo) {
      h.emulatorVideo.stop()
      if (state.emulatorVideo === h.emulatorVideo) state.emulatorVideo = null
    }
    if (h.grpcClient) {
      h.grpcClient.close()
      if (state.grpcClient === h.grpcClient) state.grpcClient = null
    }
  }

  // Shared frame pump for both video backends: reads H.264 access units, wraps each in the TFFE
  // envelope (codec + per-AU keyframe flag, so the relay's keyframe-aware backpressure preserves the
  // reference chain), and sends with backpressure + optional throughput metrics. `onFrame` lets a
  // backend inspect each frame (scrcpy parses SPS for size). Resolves when the source stream ends.
  private async pumpVideo(
    state: DeviceState,
    streamWs: WebSocket,
    reader: ReadableStreamDefaultReader<ScrcpyFrame>,
    onFrame?: (frame: ScrcpyFrame) => void,
    requestIdr?: () => void,
  ): Promise<void> {
    const threshold = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) || DEFAULT_BACKPRESSURE_BYTES
    const warnDrop = createRateLimitedDropWarn(logger, state.deviceId)
    // Keyframe-aware backpressure: when the agent→relay socket fills, drop whole GOPs to the next
    // keyframe (never forward an orphan P-frame whose reference was dropped — that decodes to a
    // sheared/ghosted frame until the next IDR). On a drop with no keyframe, ask the encoder for an
    // IDR (throttled) so the stream resyncs fast instead of waiting for the periodic one.
    const dropper = createKeyframeAwareSender()
    let lastIdrReq = 0
    const onWantKeyframe = requestIdr
      ? () => { const now = Date.now(); if (now - lastIdrReq >= 500) { lastIdrReq = now; requestIdr() } }
      : undefined
    // Opt-in throughput baseline (TAPFLOW_STREAM_METRICS=1): logs fps/KB·s/drop every 5s, so the
    // Android source rate can be compared against the relay→browser drop logs and the iOS agent.
    const metrics = process.env.TAPFLOW_STREAM_METRICS === '1' ? createThroughputSampler() : null
    const metricsTimer = metrics
      ? setInterval(() => {
          const s = metrics.sample()
          logger.info(
            `stream metrics [${state.deviceId}] ${s.fpsSent}fps ${s.kbPerSec}KB/s avg=${s.avgFrameKB}KB drop=${(s.dropRate * 100).toFixed(1)}% (${s.droppedFrames}/${s.producedFrames})`,
          )
        }, 5000)
      : undefined
    metricsTimer?.unref()
    const onDrop = metrics ? () => { metrics.recordDropped(); warnDrop() } : warnDrop

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        onFrame?.(value)
        // Declare reorder=0 on the keyframe SPS so the decoder (WASM/WebCodecs) emits frames
        // immediately instead of buffering the level's max DPB (~hundreds of ms of latency on every
        // frame). The gRPC/VideoToolbox SPS omits bitstream_restriction; scrcpy's is a no-op.
        const payload = value.keyframe ? (rewriteLowLatencySpsInFrame(value.payload) as Buffer) : value.payload
        const frame = writeEnvelopeHeader(payload, Date.now(), { codec: CODEC_H264, keyframe: value.keyframe })
        const sent = dropper.send(streamWs, frame, threshold, value.keyframe, onDrop, onWantKeyframe)
        if (sent) metrics?.recordSent(value.payload.length)
      }
    } catch {
      // stream cancelled or ws closed — expected on disconnect
    }
    if (metricsTimer) clearInterval(metricsTimer)
  }

  // gRPC emulator backend: capture via EmulatorVideo (gRPC streamScreenshot + Mac VT encode) through
  // the shared pump. Input is routed to the gRPC client in handleRelayMessage. No auto-restart —
  // the backend is torn down with the device state.
  private async startGrpcVideoStream(
    state: DeviceState, streamWs: WebSocket, serial: string,
    owns: () => boolean = () => true, opts: { restart: boolean } = { restart: false },
  ): Promise<void> {
    const created: StreamHandles = {}
    try {
      await this.startGrpcVideoStreamOwned(state, streamWs, serial, owns, opts, created)
    } catch (e) {
      // See `startVideoStream`. Released here rather than there so the fallback, which runs only for
      // a start that still owns the state, never has to tell its own handles from a newer boot's.
      if (!owns()) {
        this.releaseStream(state, serial, created)
        throw e instanceof StreamSuperseded ? e : new StreamSuperseded()
      }
      throw e
    }
  }

  private async startGrpcVideoStreamOwned(
    state: DeviceState, streamWs: WebSocket, serial: string,
    owns: () => boolean, opts: { restart: boolean }, created: StreamHandles,
  ): Promise<void> {
    // **Before the stream exists, not after.** Unfolding changes the panel's dimensions, so doing
    // it to a running stream makes the session's first act a resolution change — and this capture
    // is frame-driven, with no frames while the screen is static. A device that finishes unfolding
    // onto a still screen then sends nothing, the decoder never reports a size, and the viewer sits
    // on "Waiting for stream…" until something moves. Measured: it cleared only after a few manual
    // rotations, which is exactly "until a frame arrives".
    // **A restart is not a boot** — see `normaliseOnBoot`.
    if (!opts.restart) await this.normaliseOnBoot(state, serial, owns)
    if (!owns()) throw new StreamSuperseded()
    // Connect to THIS emulator's port: the one we launched it with, else the port it advertises in
    // its discovery .ini (covers externally-booted emulators), else the legacy default.
    const port = state.grpcPort ?? discoverGrpcPort(serial) ?? 8554
    // Downscale box (longest side), server-side resize. Per-session tier from the viewer context
    // (secure→native / LAN-HTTP→1280 / external→1000); TAPFLOW_ANDROID_MAX_SIZE | TAPFLOW_MAX_SIZE
    // is a hard override.
    const maxSize = pickMaxSize({
      secureContext: state.secureContext,
      external: state.external,
      override: process.env.TAPFLOW_ANDROID_MAX_SIZE ?? process.env.TAPFLOW_MAX_SIZE,
    })
    // Default 30fps (iOS parity) — caps source 60fps to halve decode/transport for LAN-HTTP.
    const fps = Number(process.env.TAPFLOW_ANDROID_FPS) || 30

    const touchHelper = new AndroidTouchHelper(this.adb, serial)
    touchHelper.start()
    created.touchHelper = touchHelper
    state.touchHelper = touchHelper

    const client = new EmulatorGrpcClient(`127.0.0.1:${port}`)
    created.grpcClient = client
    const video = new EmulatorVideo(client, {
      fps,
      ...(maxSize ? { maxWidth: maxSize, maxHeight: maxSize } : {}),
      // The screen can change under a live session — a foldable swaps which physical display is
      // on. A change arriving while one is still resolving waits for a fresh pass rather than
      // being dropped: `EmulatorVideo` reports each one once and records it, so a skin-only
      // change dropped here would never be reported again by anything.
      onSizeChange: (w, h, skin) => {
        // Asked again inside the reconcile, before it writes: it settles for most of a second, and
        // the stream can be replaced in that time.
        const mine = () => state.emulatorVideo === video
        if (!mine()) return
        state.latestFrame = { w, h, skin }
        void this.reconcileSerial(state, serial, w, h, skin, mine)
          .then((changed) => { if (changed && state.booted) this.sendChrome(state) })
          .catch((e: unknown) => logger.warn(`screen reconcile failed: ${(e as Error).message}`))
      },
    })
    created.emulatorVideo = video
    // Before the first frame, so no tap can arrive while the divisor is still unknown. Cheap: one
    // unary RPC, and the answer does not change for the life of the emulator.
    const touchRange = await client.getDisplaySize()
    if (!owns()) throw new StreamSuperseded()
    state.touchRange = touchRange
    logger.info(`input scale ${state.touchRange
      ? `${state.touchRange.width}×${state.touchRange.height} (emulator display 0)`
      : 'unknown — falling back to the panel size'}`)
    // Assign before start() so the caller's fallback cleanup can tear these down on failure.
    state.grpcClient = client
    state.emulatorVideo = video
    const info = await video.start()
    if (!owns()) throw new StreamSuperseded()
    // A restart is not a boot: the viewer stays mounted and keeps the orientation it shows.
    if (!opts.restart) state.landscape = false
    // Orientation from the frame, magnitude from `wm size` — see `reconcileScreen` for why neither
    // alone is right. The first frame has already fired `onSizeChange`, but that ran before
    // `state.booted`, so nothing was sent; this settles the values the boot `session:chrome` carries.
    await this.reconcileScreen(state, serial, info.width, info.height, info.rotation, false, owns)
    // The last await: everything below starts synchronously, so nothing it starts can outlive a
    // check that passed.
    if (!owns()) throw new StreamSuperseded()
    // **After the reconcile, and only if it came back empty.** `detectCornerRadius` answers a
    // fraction of the *frame's* width, and the frame is both server-side downscaled and a quarter
    // turn from natural — so the pixels it names are neither device pixels nor the right axis.
    // Converting needs the natural size and the skin, which the reconcile has just established.
    if (state.cornerRadiusPx === 0 && info.cornerRadius > 0) {
      const turned = SKIN_DEGREES[info.rotation] === 90 || SKIN_DEGREES[info.rotation] === 270
      state.cornerRadiusPx = Math.round(info.cornerRadius * (turned ? state.videoHeight : state.videoWidth))
    }
    this.watchScreen(state, serial, info.rotation, () => state.emulatorVideo === video)

    const reader = video.frames().getReader()
    // If the gRPC video ends unexpectedly (emulator crash / disconnect), restart the stream so the
    // session recovers instead of going dead — mirrors the scrcpy pump's auto-restart.
    void this.pumpVideo(state, streamWs, reader, undefined, () => video.requestIdr()).then(() => {
      if (state.emulatorVideo === video && !state.restarting) {
        state.restarting = true
        void this.restartVideoStream(state)
      }
    })

    // Opt-in audio output, on the SAME gRPC client + stream socket as video. Best-effort: if it
    // ends or errors it does NOT trigger a video restart — video owns the session lifecycle.
    if (this.audioEnabled()) {
      const audio = client.streamAudio()
      state.emulatorAudio = audio
      void this.pumpAudio(state, streamWs, audio)
      void this.startHostMute(state) // #341: silence the emulator's host (agent Mac) output — iOS parity
    }
  }

  // #341: the emulator also plays to the agent Mac's speakers (its `-audio` backend has no
  // host-output-only mute). On macOS 14.2+ we hold a mute-only Core Audio process tap on the
  // emulator's qemu pid so its host output is silenced while gRPC keeps capturing for the browser —
  // matching iOS's muteBehavior=.muted. Below 14.2 / non-macOS: no-op (fall back to the Mac's volume).
  private async startHostMute(state: DeviceState): Promise<void> {
    if (!isAudioSupported()) return
    if (state.audioMuteQemuPid != null) return // already muting this session (e.g. a stream restart)
    const avdName = state.deviceId.replace(/^avd:/, '')
    const qemuPid = findEmulatorPid(avdName)
    if (!qemuPid) { logger.debug(`host-mute: no qemu pid for ${avdName}`); return }
    const seq = state.bootSeq
    await this.pendingMuteStops.get(qemuPid)
    // A shutdown, relay loss or newer boot bumps the seq while this waits; its cleanup found nothing to stop,
    // so muting now would leave the Mac silent for a device nobody holds.
    if (state.bootSeq !== seq || state.audioMuteQemuPid != null) return
    try {
      launchMuteOnlyTap(ensureHelperApp(), [qemuPid])
      state.audioMuteQemuPid = qemuPid
      logger.info(`host-mute: silencing emulator host output on the agent Mac (qemu ${qemuPid})`)
    } catch (e) {
      logger.warn(`host-mute: failed to launch mute tap: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Stop muting on teardown so the emulator is audible again if the operator uses it directly. The
  // mute helper also self-exits when qemu dies, so this only matters when the emulator outlives us.
  // Async: this runs on device cleanup and on every relay loss, and a synchronous `pkill` held the event
  // loop each time. A start for the same qemu pid waits for it (`pendingMuteStops`).
  private stopHostMute(state: DeviceState): void {
    const pid = state.audioMuteQemuPid
    if (pid == null) return
    state.audioMuteQemuPid = null
    const stop = new Promise<void>((resolve) => {
      execFile('pkill', ['-f', `audiotap-helper.*--mute-only ${pid}$`], () => resolve()) // non-zero: already gone
    }).finally(() => { if (this.pendingMuteStops.get(pid) === stop) this.pendingMuteStops.delete(pid) })
    this.pendingMuteStops.set(pid, stop)
  }

  // Forward raw-PCM audio frames to the relay on the shared stream socket. Uses the yielding sender,
  // never the keyframe-aware video sender: audio must never inflate the socket buffer enough to make
  // video's backpressure misfire. A dropped audio frame is a brief glitch; a stalled video isn't.
  private async pumpAudio(state: DeviceState, streamWs: WebSocket, audio: AudioStream): Promise<void> {
    const warnDrop = createRateLimitedDropWarn(logger, `${state.deviceId} audio`)
    try {
      for await (const f of audio.frames) {
        if (streamWs.readyState !== WebSocket.OPEN) break
        const frame = writeEnvelopeHeader(f.audio, Date.now(), { codec: CODEC_AUDIO })
        sendAudioYieldingToVideo(streamWs, frame, warnDrop)
      }
    } catch {
      // stream cancelled or ws closed — expected on teardown/restart
    }
  }

  private async restartVideoStream(state: DeviceState): Promise<void> {
    // **A restart is not a boot, and does not bump the seq** — it captures it. Anything that does bump
    // it (a boot, a shutdown, losing the relay) means this restart's stream is no longer wanted.
    const seq = state.bootSeq
    const owns = () => state.bootSeq === seq && this.deviceStates.get(state.sessionId) === state
    const serial = this.adb.getSerial(state.deviceId)
    if (!serial) {
      state.restarting = false
      // Was a silent return: a stream that died because its emulator did, reported by nothing.
      if (owns()) this.sendMsg({ type: 'device:boot-error', sessionId: state.sessionId, message: EMULATOR_GONE_RESTART })
      return
    }

    state.scrcpySession?.stop(serial)
    state.scrcpySession = null
    state.emulatorVideo?.stop()
    state.emulatorVideo = null
    state.emulatorAudio?.cancel()
    state.emulatorAudio = null
    this.clearGrpcState(state)
    state.touchHelper?.stop()
    state.touchHelper = null

    const { streamWs } = state
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) {
      state.restarting = false
      return
    }

    // kill any lingering scrcpy server process on the device before restarting
    await this.adb.pkill(serial, 'scrcpy-server').catch(() => {})
    await new Promise<void>((r) => setTimeout(r, 1500))

    if (!owns()) {
      // Only ours to clear while nothing newer has run: a newer boot's cleanup already cleared it, and
      // that boot's own stream may since have died and set it for a restart of its own.
      return
    }

    try {
      await this.startVideoStream(state, streamWs, owns, { restart: true })
    } catch (err) {
      // Superseded while starting: the newer boot answers for the device, and a dead-stream report
      // from here would put an error on a session that is booting normally.
      if (!owns()) return
      logger.error(`scrcpy restart failed: ${err}`)
      // **No `requestId`, and that is the contract rather than an omission.** This is the unsolicited
      // producer of `device:boot-error`: a stream that died mid-session and failed to come back, with
      // no `device:boot` behind it. It is why the correlator on this message is optional, and why a
      // consumer that gates on the correlator drops the only report a dead stream gets.
      this.sendMsg({
        type: 'device:boot-error',
        sessionId: state.sessionId,
        message: 'scrcpy failed to restart',
      })
    } finally {
      if (owns()) state.restarting = false
    }
  }

  // 원격 릴레이는 PAT 인증을 요구한다 (#271) — control/stream WS 모두 같은 토큰을 쓴다.
  private wsClientOptions(): { headers?: Record<string, string>; rejectUnauthorized?: boolean } {
    const opts: { headers?: Record<string, string>; rejectUnauthorized?: boolean } = {}
    if (this.token) opts.headers = { authorization: `Bearer ${this.token}` }
    // All-in-one (tapflow start): the relay's domain cert won't match wss://localhost, but localhost
    // never leaves the machine so MITM is impossible — accept it. External relays keep verification.
    if (this.relayUrl && isLocalhostWss(this.relayUrl)) opts.rejectUnauthorized = false
    return opts
  }

  private async openStreamWs(state: DeviceState): Promise<WebSocket> {
    const streamWs = new WebSocket(this.relayUrl!, this.wsClientOptions())
    state.streamWs = streamWs
    await registerStreamWs(streamWs, state.sessionId)
    return streamWs
  }

  /** Retire the boot that holds the current seq, recording what retired it, and return the new seq.
   *
   *  **Three callers, and the third is why this is a method.** A new boot supersedes the one in flight, a
   *  shutdown abandons it, and losing the relay invalidates it — that last one lives in the reconnect path
   *  and is easy to miss when reading `handleDeviceBoot` alone. Spreading the reason across three
   *  `state.bootSeq++` lines makes forgetting one silent; here it is a parameter.
   *
   *  Deliberately **not** folded into `cleanupDeviceState` the way iOS's bump once was: this agent calls
   *  that cleanup from inside `handleDeviceBoot`, so a bump there would make every boot supersede itself. */
  private bumpBootSeq(state: DeviceState, reason: BootAbandonReason): number {
    if (state.bootsInFlight.has(state.bootSeq)) state.bootAbandon.set(state.bootSeq, reason)
    return ++state.bootSeq
  }

  /** Answer a boot this agent has stopped running. Called at every point that abandons one.
   *
   *  **Only when a correlator exists**, which is the same rule the input path settled on (#489): a reply
   *  nobody is waiting for is not an answer, and the dashboard reports every *uncorrelated*
   *  `device:boot-error` as a failure — deliberately, since this agent's own dead-stream report
   *  (`restartVideoStream`) has no id it could carry (#426). So sending one for a boot with no correlator
   *  would put an error toast on a tester's screen for a device that is booting normally. */
  private abandonBoot(state: DeviceState, seq: number, sessionId: string, requestId?: string): void {
    const reason = state.bootAbandon.get(seq) ?? 'superseded'
    state.bootAbandon.delete(seq)
    // **A state the agent has stopped holding cannot be answered, and trying is worse than silence.**
    // `relay-lost` retires a boot by dropping the whole map, so by the time the parked `await` resumes this
    // `state` is an object nobody is registered against — and whether the socket is back yet decides
    // between dropping the reply and sending it to a *new* relay naming a session id it has never heard
    // of. Neither is an answer, and which one happens is a race between a poll interval and a backoff.
    if (this.deviceStates.get(sessionId) !== state) {
      logger.warn(`boot for ${sessionId} abandoned (${reason}) after the session was dropped — nothing to answer`)
      return
    }
    if (!requestId) {
      logger.warn(`boot for ${sessionId} abandoned (${reason}) with no requestId — nothing to answer`)
      return
    }
    this.sendMsg({ type: 'device:boot-error', sessionId, requestId, message: bootAbandonMessage(reason) })
  }

  // `requestId` is a parameter, never a field on `state`: `bootSeq` exists because two boots overlap,
  // and a correlator hoisted onto shared state would answer the first request with the second's id.
  // Optional because the relay's idle timer boots nothing — but every *browser* boot carries one.
  /**
   * What `flow run` asks reset before a run. `pm clear` takes the app's files, its runtime permissions and its process
   * together, and an install after it keeps the now-empty data — so both lists get it. The keychain, privacy and
   * location items have no Android counterpart here and are never reported.
   */
  private async resetForRun(state: DeviceState, request: RunResetRequest, isStale: () => boolean): Promise<RunResetReport> {
    const deadline = Date.now() + RUN_RESET_BUDGET_MS
    const stop = () => isStale() || Date.now() >= deadline
    const serial = this.adb.getSerial(state.deviceId)
    const apps = [...new Set([...request.uninstall, ...request.clear])]
    const steps: RunResetStep[] = []
    const ms = this.runResetCmdTimeoutMs
    if (apps.length > 0 && serial) {
      const clear = (id: string) => {
        const work = this.adb.clearAppDataIfInstalled(serial, id)
        this.trackClear(state.deviceId, work)
        return bounded(work, ms, `pm clear ${id}`)
      }
      steps.push({ item: 'app-data', run: () => resetApps(apps, clear, stop) })
    }
    const client = state.grpcClient
    if (client) {
      // Through the clipboard queue: a clipboard read in flight parks a sentinel on this clipboard. Read back, because
      // `setClipboard` resolves when the change is scheduled, not when it is applied — the write path does the same.
      const clearClipboard = async () => {
        await client.setClipboard('')
        const applied = Date.now() + CLIPBOARD_WRITE_DEADLINE_MS
        while ((await client.getClipboard().catch(() => null)) !== '') {
          if (Date.now() >= applied) throw new PlatformError('the device clipboard did not take the clear')
          await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
        }
      }
      // The bound covers the wait for the queue too. A clear that reaches the front after the step gave up does nothing:
      // by then the run may have put something of its own on the clipboard.
      let abandoned = false
      const queued = () => this.clipboardQueue(state.deviceId, async () => {
        if (abandoned || stop()) throw new PlatformError('the clipboard was busy for the whole reset')
        await clearClipboard()
      })
      steps.push({ item: 'pasteboard', run: () => bounded(queued(), ms, 'clipboard clear').catch((e: unknown) => { abandoned = true; throw e }) })
    }
    return runResetSteps(steps, isStale, (item, e) => logger.warn(`run reset: ${item} failed: ${(e as Error).message}`), deadline)
  }

  /**
   * `bounded` releases the wait, not the adb child: a `pm clear` that timed out, or whose boot a newer one replaced, may
   * still land, and wipe an app a run installed after the ready. So every `pm clear` a reset starts is kept here by
   * device until it settles, and every boot of that device waits for them before its ready (`awaitPendingClears`) —
   * a boot that asked for no reset too.
   */
  private readonly pendingClears = new Map<string, Set<Promise<unknown>>>()

  private trackClear(deviceId: string, work: Promise<unknown>): void {
    let pending = this.pendingClears.get(deviceId)
    if (!pending) { pending = new Set(); this.pendingClears.set(deviceId, pending) }
    const settled = work.catch(() => {})
    pending.add(settled)
    void settled.then(() => {
      pending.delete(settled)
      if (pending.size === 0 && this.pendingClears.get(deviceId) === pending) this.pendingClears.delete(deviceId)
    })
  }

  /** One more step's time at most. A clear still running past that fails the boot rather than announcing a device the
   *  run's install could lose its data on: failing the step does not stop the clear, and nothing else orders the two. */
  private async awaitPendingClears(deviceId: string): Promise<void> {
    const pending = this.pendingClears.get(deviceId)
    if (!pending || pending.size === 0) return
    try {
      await bounded(Promise.all(pending), this.runResetCmdTimeoutMs, 'waiting for a late pm clear')
    } catch {
      throw new PlatformError('a pm clear from a run reset is still running on the device, so it is not ready for an install')
    }
  }

  private async handleDeviceBoot(sessionId: string, avdId: string, fullErase = false, tier?: { secureContext: boolean; external: boolean }, requestId?: string, runReset?: RunResetRequest): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    // Split, because the two halves are not the same kind of nothing. No open control channel means the
    // answer itself has nowhere to go, so this is the one abandonment that stays silent — and the caller
    // learns from the relay instead, which declares the agent away and terminates the session. A missing
    // `state` is answerable and now answered (#489's reasoning, on the boot path).
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!state) {
      if (requestId) this.sendMsg({ type: 'device:boot-error', sessionId, requestId, message: BOOT_NO_SESSION_STATE })
      return
    }

    const seq = this.bumpBootSeq(state, 'superseded')
    state.bootsInFlight.add(seq)

    // **The teardown runs inside the try, and that is a fix rather than tidying.** It ran before it, and here it is the
    // heaviest thing in the handler — stopping a scrcpy session, closing a gRPC client, `pkill`ing the
    // host-mute tap. A throw there rejected this handler into the bare `.catch(logger.error)` at its dispatch site: no
    // `device:booting`, no ready, no error — and the seq was already bumped, so the boot this one
    // superseded was gone as well. The caller then waited out the very deadline this change exists to
    // end. `finally` is what stops `bootAbandon` outliving the boot that would have read it.
    try {
      this.cleanupDeviceState(state)
      if (tier) { state.secureContext = tier.secureContext; state.external = tier.external }
      this.sendOn(ws, { type: 'device:booting', sessionId })
      const avdName = avdId.replace(/^avd:/, '')
      const devices = await this.adb.listDevices()
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }

      const target = devices.find((d) => d.id === avdId)
      if (!target) throw new PlatformError(`Device not found: ${avdId}`)

      // `-wipe-data` is a **launch** argument, so an emulator that is already up cannot honour it
      // where it stands — the mirror of `simctl erase` refusing a booted device (#439). A device
      // survives agent restarts and sessions that ended without a clean shutdown, so "this
      // session's first boot, device already running" is reachable; iOS answers it by restarting
      // and so does this, or the toggle would refuse exactly the device a tester just armed it for.
      //
      // **Asked of the process, not of `target.status`.** That status is `Boolean(serial)` — it
      // says adb can *see* the emulator, which an emulator that is still coming up, or one whose
      // adb server restarted, is not. Skipping the stop there would put a second emulator on the
      // same AVD and race its lock file. iOS widened the same condition for the same reason and
      // says so at `IOSAgent.ts` (`!== 'shutdown'`, not `=== 'booted'`); this is that widening,
      // expressed against the only thing Android's two-valued status cannot tell us.
      // `probeEmulator`, not `findEmulatorPid`: the latter reports "could not look" as "not
      // running", and here that difference is a wiped device versus a lie about one. An
      // unconfirmable probe fails the boot before anything destructive happens.
      const emulator = fullErase ? probeEmulator(avdName) : { state: 'gone' as const }
      if (emulator.state === 'unknown') {
        throw new PlatformError(
          `Could not tell whether emulator "${avdName}" was already running (process lookup ` +
          'unavailable), so Full reset was not attempted.',
        )
      }
      if (emulator.state === 'running') {
        const serial = this.adb.getSerial(avdId)
        if (serial) {
          await this.adb.shutdown(serial).catch((e: unknown) => {
            // Best effort, as on the shutdown path: the emulator may already be going down. The
            // wait below is what decides whether we may launch, not this call's success.
            logger.warn('emu kill before wipe failed (already gone?):', (e as Error).message)
          })
          this.adb.clearSerial(avdId)
      this.ownedDevices.delete(avdId)
        } else {
          // Live process, no console to ask. Safe here and only here — the data a hard stop could
          // damage is about to be wiped.
          stopEmulatorProcess(avdName)
        }
        // Throws if it is still up at the deadline, which the outer catch turns into
        // `device:boot-error`. Launching anyway would report a Full reset that never happened.
        await this.launcher.waitForExit(avdName)
        // The stop and the wait are both awaits, so a newer boot may have overtaken us. Without
        // this the superseded boot goes on to wipe a device the tester has since re-picked with the
        // toggle off — the erase-with-no-click #439 exists to prevent, on the platform where it
        // would be silent.
        if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      }

      // `|| fullErase`: the branch above left the device down on purpose, and the reading in
      // `target` predates it.
      // Whether this call started the emulator. Lean mode is applied only then; see `reconcileLean`.
      let launched = false
      if (target.status !== 'booted' || fullErase) {
        // One unique gRPC port per emulator (undefined when forced to scrcpy → no `-grpc`).
        const grpcPort = this.forceScrcpy() ? undefined : await this.pickFreeGrpcPort()
        state.grpcPort = grpcPort ?? null
        // The port probe is an await, and the launch below is destructive now that it can carry
        // `-wipe-data`. A `device:shutdown` landing in that gap used to reach a harmless relaunch;
        // it would now bring the device back *erased* seconds after the tester asked for it to stop.
        if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
        try {
          this.launcher.launch(avdName, grpcPort, { audio: this.audioEnabled(), wipeData: fullErase })
          const serial = await this.launcher.findSerial(avdName)
          if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
          await this.launcher.waitForBoot(serial)
          if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
          this.adb.setSerial(avdId, serial)
          this.ownedDevices.add(avdId)
          launched = true
        } finally {
          // The emulator now holds the port (or boot failed) — drop the reservation either way.
          if (grpcPort !== undefined) this.pendingGrpcPorts.delete(grpcPort)
        }
      }

      const refreshed = await this.adb.listDevices()
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      // **Before the device is described or declared ready** (#611) — `device:booting` has gone out already. `target` was read before this boot waited on anything,
      // and a Full reset another boot began can have stopped the emulator since — adb still listed it
      // as up, so this boot skipped the launch. Without a serial there is no stream to start, and the
      // boot used to answer `device:ready` for one. The emulator is really down, so a retry launches it.
      if (!this.adb.getSerial(avdId)) throw new PlatformError(EMULATOR_GONE)
      const refreshedDevice = refreshed.find((d) => d.id === avdId) ?? target

      this.sendDeviceInfo(state, { ...refreshedDevice, status: 'booted' } as Device)

      const streamWs = await this.openStreamWs(state)
      if (seq !== state.bootSeq) {
        streamWs.close()
        this.abandonBoot(state, seq, sessionId, requestId)
        return
      }

      // A boot that brought the emulator up, or a run (which replays from the same orientation every time), stands
      // its body up; any other joins it where it is held.
      await this.startVideoStream(state, streamWs, () => seq === state.bootSeq, { restart: false, upright: launched || runReset !== undefined })
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      // After the stream, which is what opens the gRPC client the clipboard goes through; before the ready, since the
      // run installs its app after it and the report rides on it.
      const runResetReport = runReset ? await this.resetForRun(state, runReset, () => seq !== state.bootSeq) : undefined
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      await this.awaitPendingClears(state.deviceId)
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      this.sendChrome(state)
      void this.sendPostures(state)
      state.booted = true
      this.sendMsg({ type: 'device:ready', sessionId, requestId, payload: { deviceId: avdId, cold: launched, ...(runResetReport ? { runReset: runResetReport } : {}) } })
      // Clear a network condition the last session left behind, then report (#607).
      //
      // **At boot rather than at teardown**, because airplane mode lives in the AVD's userdata and
      // outlives `emu kill` — and a session that ended in a crash, a closed terminal or `dev:down`
      // never reaches a teardown path at all. Clearing on the way up survives however the last one
      // died; clearing on the way out only works when someone was there to run it.
      //
      // The report that follows is the first of the three unsolicited producers the protocol names.
      // Without it a viewer opening a session has no idea whether this device is on the network.
      void this.resetNetworkForSession(sessionId, state, seq)
      // At boot for the same reason, and after `device:ready` because it is never the boot's job:
      // a device that cannot be reconciled is logged and tried again next boot.
      void this.reconcileLeanForSession(sessionId, state, seq, launched)
    } catch (e) {
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      const message = e instanceof Error ? e.message : String(e)
      logger.error('boot failed:', message)
      this.sendMsg({ type: 'device:boot-error', sessionId, requestId, message })
    } finally {
      state.bootsInFlight.delete(seq)
      // Its own key, in the one case nothing reads it: a newer boot arriving after this boot's last
      // checkpoint but before it returns.
      state.bootAbandon.delete(seq)
    }
  }

  // ── network on/off (#607) ──────────────────────────────────────────────────────────────────
  //
  // Airplane mode, so the **OS** goes offline rather than the app being lied to. That is what makes
  // the app's own `ConnectivityManager` callbacks fire and the status bar follow, with nothing
  // faked — measured on API 34: `dumpsys connectivity` reports "Active default network: none" and
  // a ping from the guest fails. iOS has to hook three layers to reach the same place.

  /** The serial for a session's device, or undefined when nothing is booted. */
  /**
   * The AVDs **this agent launched**, which is not the same as the ones `adb` can see.
   *
   * `AdbWrapper.serialMap` is synced from `adb devices` on every `listDevices()`, so it holds a
   * developer's own emulator as readily as tapflow's. Written here at the two places tapflow starts
   * one and cleared at the three where it stops one — the same shape and the same purpose as
   * `IOSAgent.ownedDevices`, which exists because that platform hit this first: its
   * `soleDeviceState` comment records a version that counted every booted simulator and "made all
   * the callers above refuse with '2 booted devices' on the common two-simulator desk".
   */
  private readonly ownedDevices = new Set<string>()

  private serialFor(sessionId: string): string | undefined {
    const state = this.deviceStates.get(sessionId)
    return state ? this.adb.getSerial(state.deviceId) : undefined
  }

  /**
   * Turn a `setAirplaneMode` result into what the viewer is told.
   *
   * **Both unconfirmed shapes are `{ confirmed: false, offline: boolean }` and only the value tells
   * them apart** — the discriminator that used to live nowhere (#618). `AdbWrapper` returns the
   * value it *read* when the read-back succeeded, and the value that was *requested* when the
   * read-back failed, so:
   *
   * - `offline !== requested` — the read-back succeeded and the device had not moved. The write was
   *   accepted and did nothing: `unsupported-device`. **Not "an image that does not support this"** —
   *   that image throws from the write and lands in the branch below, which `AdbWrapper` now records
   *   at the return it describes. What reaches this branch is unmeasured, so the member names the
   *   observation and a consumer keeps offering the retry.
   * - `offline === requested` — nothing was observed. `state-unconfirmed`, which a retry may fix.
   *
   * Shared by the WS path and the capability path on purpose: they answer the same question, and the
   * doc on `setNetworkOffline` records that they had already disagreed once.
   */
  private classifyWrite(result: { confirmed: boolean; offline: boolean }, requested: boolean): NetworkStatePayload {
    if (result.confirmed) return { offline: result.offline, available: true }
    return {
      offline: result.offline,
      available: false,
      reason: result.offline === requested ? 'state-unconfirmed' : 'unsupported-device',
    }
  }

  /**
   * Read the device's current network state.
   *
   * **Reads the device, never a flag this agent kept.** A remembered value cannot see a device left
   * offline by a previous session, one changed outside tapflow, or one that survived an agent
   * restart — and every one of those ends with the viewer showing the opposite of what is true.
   *
   * `lastKnownOffline` is the fallback for a read that fails, **not** `false`: a device that is
   * offline and can no longer be read is still offline, and reporting it as online renders the
   * control in the position that hides the problem. **With no fallback there is no position at all**
   * — the device has never been read — and the answer says so rather than defaulting one (#667).
   */
  private async readNetworkState(serial: string, lastKnownOffline: boolean | undefined): Promise<NetworkStatePayload> {
    try {
      return { offline: await this.adb.airplaneMode(serial), available: true }
    } catch (e) {
      logger.warn('airplane mode read failed:', (e as Error).message)
      if (lastKnownOffline === undefined) return { available: false, reason: 'state-unconfirmed' }
      return { offline: lastKnownOffline, available: false, reason: 'state-unconfirmed' }
    }
  }

  private async reconcileLeanForSession(sessionId: string, state: DeviceState, seq: number, launched: boolean): Promise<void> {
    const serial = this.serialFor(sessionId)
    if (!serial) return
    const adb = this.adb
    // Every write rechecks the boot: a shutdown or a newer boot arriving mid-way stops it here, and
    // the next boot finishes the job from the marker.
    const live = () => { if (seq !== state.bootSeq) throw new Error('the boot was superseded') }
    const device: LeanDevice = {
      packages: () => adb.packageStates(serial),
      setEnabled: async (pkg, enabled) => { live(); await adb.setPackageEnabled(serial, pkg, enabled) },
      readMarker: () => adb.readDeviceFile(serial, LEAN_MARKER_PATH),
      writeMarker: async (content) => { live(); await adb.writeDeviceFile(serial, LEAN_MARKER_PATH, content) },
      deleteMarker: async () => { live(); await adb.removeDeviceFile(serial, LEAN_MARKER_PATH) },
    }
    try {
      if (seq !== state.bootSeq) return
      logger.info(await reconcileLean(device, { lean: this.lean, launched }))
    } catch (e) {
      logger.warn('Lean mode: not reconciled this boot, will try again at the next:', (e as Error).message)
    }
  }

  /**
   * Put a device back on the network if the last session left it off, then report where it is.
   *
   * **Guarded by `bootSeq` like every other await in the boot path**, and for the reason the wipe
   * block states two hundred lines up: this **writes to the device**, and a boot that has been
   * superseded must not. The window is a real one rather than a race — the read below is an adb
   * round trip, and a tester whose device just went ready can arm the network toggle inside it.
   * Without the check, this wakes up and puts them back online with nobody having asked.
   */
  private async resetNetworkForSession(sessionId: string, state: DeviceState, seq: number): Promise<void> {
    const serial = this.serialFor(sessionId)
    if (!serial) return
    // **`undefined` until read, not `false`.** This started at `false`, so a boot whose read failed
    // reported "online" for a device nobody had read — on the first `network:state` any viewer gets.
    let known: boolean | undefined
    try {
      // Conditional: an already-online device is left alone, so an ordinary boot issues no command
      // at all. Unconditional would work too and is worse — it makes every boot a write to a
      // setting nobody asked about, on a path where a failure is not the tester's problem to solve.
      known = await this.adb.airplaneMode(serial)
      if (seq !== state.bootSeq) return
      if (known) {
        const r = await this.adb.setAirplaneMode(serial, false)
        known = r.offline
      }
    } catch (e) {
      // An image that cannot do this has nothing to clear. The report below says so.
      logger.warn('could not clear airplane mode on boot:', (e as Error).message)
    }
    if (seq !== state.bootSeq) return
    await this.reportNetworkState(sessionId, 'device-ready', known)
  }

  /**
   * Send the current state with no correlator — this is a report, not an answer.
   *
   * `lastKnownOffline` defaults to what this device was last *observed* doing rather than to `false`,
   * because the re-join report (#614) has no freshly measured value to pass: the boot path and
   * `network:set` both hand over something they just read, and a viewer coming back has nothing
   * behind it. `false` there would answer "online" for a device that is offline and momentarily
   * unreadable, which `NetworkNotSteerable.offline` forbids.
   *
   * Silent with no device, deliberately: nobody asked, so there is no requester to answer and
   * `network:error` would be addressed to no one.
   *
   * **`trigger` decides what a device never read gets, and the two differ on purpose.** `device:ready`
   * is a report the protocol promises, so it goes — as `NetworkUnobserved`. A re-join stays silent:
   * the viewer reaches `unknown` through its own deadline, and on a released dashboard, which reads a
   * missing `offline` as online, that silence is the honest path (see `NetworkUnobserved`).
   */
  private async reportNetworkState(sessionId: string, trigger: 'device-ready' | 're-join', lastKnownOffline?: boolean): Promise<void> {
    const serial = this.serialFor(sessionId)
    if (!serial) return
    const state = this.deviceStates.get(sessionId)
    const known = lastKnownOffline ?? state?.lastNetworkOffline
    const payload = await this.readNetworkState(serial, known)
    if (trigger === 're-join' && payload.offline === undefined) return
    // Only an observed value enters the memory — a failed read has nothing to record, since what it
    // returns *is* the memory (or a value the caller just read off the device).
    //
    // **No test distinguishes this from storing unconditionally, and that is stated rather than
    // implied:** for every caller today the two are the same write. It guards a future caller that
    // passes a `lastKnownOffline` it did not measure, which would otherwise become the remembered
    // truth for every later read failure.
    if (state && payload.available) state.lastNetworkOffline = payload.offline
    this.sendMsg({ type: 'network:state', sessionId, payload })
  }

  private async handleNetworkSet(sessionId: string, offline: boolean, requestId: string): Promise<void> {
    const serial = this.serialFor(sessionId)
    if (!serial) {
      this.sendMsg({
        type: 'network:error', sessionId, requestId,
        message: 'No booted device — boot one before changing its network.',
      })
      return
    }

    // What the device says now. Only used when the **write** fails, where the device is unchanged
    // and this is still true — every other path reports what the wrapper observed after writing.
    //
    // **The last confirmed value is the fallback, not `false`.** Two failures in a row — this read and
    // then the write — used to answer `offline: false` for a device the agent had already confirmed
    // offline, which draws an online control over a device whose app can reach nothing. The report
    // path has always passed this; the two write paths did not, so the one moment a device is least
    // readable was the one where the memory was dropped.
    const beforeState = this.deviceStates.get(sessionId)
    const before = await this.readNetworkState(serial, beforeState?.lastNetworkOffline)
    // A read that succeeded is an observation, and it was being thrown away. Someone flipping airplane
    // mode in the emulator's own UI between the boot read and this toggle is seen here and nowhere
    // else, so without this a later unreadable device falls back past it to the older value.
    if (beforeState && before.available) beforeState.lastNetworkOffline = before.offline

    let result: { confirmed: boolean; offline: boolean }
    try {
      result = await this.adb.setAirplaneMode(serial, offline)
    } catch (e) {
      // The write itself failed: nothing reached the device. An image whose `cmd connectivity`
      // predates the subcommand lands here — **and so does a device mid-reboot and a dropped adb
      // connection**, which is why this is `state-unconfirmed` rather than a verdict about the
      // device. Nothing in the failure separates them, and calling it permanent tells a tester to
      // give up on a device that is twenty seconds from working. `unsupported-device` is reserved for
      // the one shape that does say so on its own — see `classifyWrite`.
      //
      // **An answer, not a failure.** The viewer needs to say this and stay usable; `network:error`
      // is for a request that could not be dispatched at all, which is the no-device case above and a
      // different fix for the tester.
      logger.warn('airplane mode write failed:', (e as Error).message)
      this.sendMsg({ type: 'network:state', sessionId, requestId, payload: writeFailed(before) })
      return
    }

    // `result.offline` is what the wrapper saw where it could see anything, and the requested value
    // where the read-back failed — never the value this agent held before the write. The write
    // happens before the confirmation, so a state it could not confirm is still more likely to be the
    // requested one than the old one. Reporting the old value here is how an offline device gets
    // rendered as online, which is the failure this whole feature exists to avoid. **Which of those
    // two an unconfirmed result is, is the whole discriminator** — see `classifyWrite`.
    // Remember it for the same reason the boot path hands its read to the report: a later re-join
    // whose own read fails falls back to this, and the write path is the freshest truth there is.
    // Only a **confirmed** result counts — an unconfirmed one is already a guess, and standing one
    // guess on another is how a stale value outlives the thing it described.
    const state = this.deviceStates.get(sessionId)
    if (state && result.confirmed) state.lastNetworkOffline = result.offline

    this.sendMsg({
      type: 'network:state', sessionId, requestId,
      payload: this.classifyWrite(result, offline),
    })
  }

  /**
   * **Answers rather than throwing when the device cannot do it**, which is what
   * `NetworkControlCapability` declares — the return type can express `available: false`, and a
   * device that does not support this is not a caller error. The WS path answers the same way; the
   * two must not disagree about the same question, and this one drifted first.
   *
   * A device that is not booted still throws: there is no state to describe.
   */
  async setNetworkOffline(offline: boolean): Promise<NetworkStatePayload> {
    // **The write #617 was filed about.** This took the first-registered session, so on an agent
    // holding several it took *someone else's* device off the network while they were testing on it.
    const { state, serial } = this.soleLive()
    // Same fallback as the WS path, for the reason recorded there.
    const before = await this.readNetworkState(serial, state.lastNetworkOffline)
    if (before.available) state.lastNetworkOffline = before.offline
    try {
      const result = await this.adb.setAirplaneMode(serial, offline)
      // **And it remembers, which this path did not.** The WS path has always stored the confirmed
      // value, so a caller that toggled through MCP and then lost the device read `false` from a
      // memory nothing had written — the fallback above had nothing to fall back to. Only a confirmed
      // result counts, for the reason the WS path gives: an unconfirmed one is already a guess.
      if (result.confirmed) state.lastNetworkOffline = result.offline
      return this.classifyWrite(result, offline)
    } catch {
      return writeFailed(before)
    }
  }

  async networkState(): Promise<NetworkStatePayload> {
    const live = this.soleLive()
    // A device never observed whose read now fails answers `NetworkUnobserved`, where this used to
    // throw because the payload had no way to say "not known" (#667). The capability promises an
    // answer for a device that is there; an absent device still throws, from `soleLive`.
    const state = await this.readNetworkState(live.serial, live.state.lastNetworkOffline)
    // An observation, so it is remembered like the other paths' reads — otherwise a position this
    // read had just seen would come back as "nobody knows" on the next failure.
    if (state.available) live.state.lastNetworkOffline = state.offline
    return state
  }

  private async handleDeviceShutdown(sessionId: string, avdId: string, requestId?: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state) {
      // Answered only when someone asked: nothing was attempted, and the idle timer's id-less shutdown has no
      // waiter to tell. A failure below is answered either way — `requestId` is optional on `device:shutdown`,
      // so an id-less sender that is waiting can only learn of the failure this way (protocol/AGENTS.md,
      // 「The sender must hold the session」).
      if (requestId) this.sendMsg({ type: 'device:shutdown-error', sessionId, requestId, message: SHUTDOWN_NO_SESSION_STATE })
      return
    }

    const seq = this.bumpBootSeq(state, 'shut-down')
    this.cleanupDeviceState(state)

    // **A failed kill is judged by the process table, not assumed benign** (#455). It used to be logged as
    // "already gone?" and answered done — often right, and exactly why the case where it was wrong stayed
    // invisible: a caller told the device was off while the emulator kept running. No serial at all used to
    // skip the kill and answer done the same way; an adb server restart or an emulator still coming up
    // reaches it. Nothing is signalled here — a hard stop is Full reset's, where the data is about to go.
    const serial = this.adb.getSerial(avdId)
    let killFailure: string | null = serial ? null : 'adb has no console for it'
    if (serial) {
      await this.adb.shutdown(serial).catch((e: unknown) => {
        killFailure = (e as Error).message
      })
    }
    if (killFailure !== null) {
      const probe = await this.settledProbe(avdId.replace(/^avd:/, ''))
      // **A boot may have started during the probe** — a tester pressing Back mid-boot and re-picking the
      // device inside the window. Its emulator is not ours to report on, and a late done would tell the
      // relay the device is down in the middle of that boot. The asker still gets an answer; nothing else.
      if (state.bootSeq !== seq || this.deviceStates.get(sessionId) !== state) {
        if (requestId) {
          this.sendMsg({ type: 'device:shutdown-error', sessionId, requestId, message: 'A boot started before the shutdown could be confirmed, so it was not completed.' })
        }
        return
      }
      if (probe !== 'gone') {
        logger.warn(`emu kill failed and the emulator is ${probe === 'running' ? 'still running' : 'unaccounted for'}:`, killFailure)
        // The stream is already torn down above, so the device may be up with nothing coming from it — and
        // it is still ours, which is why the serial and ownership are kept.
        this.sendMsg({
          type: 'device:shutdown-error',
          sessionId,
          requestId,
          message: probe === 'running'
            ? `The emulator did not shut down, and its stream has been stopped: ${killFailure}`
            : `Could not confirm the emulator shut down (process lookup unavailable), and its stream has been stopped: ${killFailure}`,
        })
        return
      }
    }
    if (serial) this.adb.clearSerial(avdId)
    this.ownedDevices.delete(avdId)
    this.sendMsg({
      type: 'device:shutdown-done',
      sessionId,
      requestId,
      payload: { deviceId: avdId },
    })
  }

  /** `probeEmulator`, asked until it says `gone` or `shutdownSettleMs` passes. **Asked more than once
   *  because the usual reason `emu kill` fails is benign**: adb has already let go of an emulator qemu is
   *  still tearing down, so one look straight after the failure reads it as running. Not `waitForExit`,
   *  whose deadline is sized for a boot. */
  private async settledProbe(avdName: string): Promise<'running' | 'gone' | 'unknown'> {
    const deadline = Date.now() + this.shutdownSettleMs
    for (;;) {
      const { state } = probeEmulator(avdName)
      // Only `running` can change in the window; `unknown` is a missing or failing pgrep, and stays so.
      if (state !== 'running' || Date.now() >= deadline) return state
      await new Promise((r) => setTimeout(r, Math.min(250, this.shutdownSettleMs)))
    }
  }

  // Ack a terminal input. `input:done` = the input reached a live channel on a booted device (not a
  // landing guarantee — `adb shell input` and HID are both fire-and-forget once accepted).
  // Everything else is `input:error` with the reason, because collapsing the reasons would report a
  // dead channel for an input we simply do not implement. See inputOutcome.ts.
  // `seq` is the boot generation observed when the message arrived — captured by the caller, before
  // it awaited the dispatch. Reading it here would be too late: a reboot that started under that
  // await would already have been counted, and caching `booted` across it poisons every later input
  // on the session, since they all skip the verify.
  /** The correlator on an input an ack answers, or `null` if the frame cannot be attributed.
   *
   *  A local capture rather than a guard at the top of the dispatcher: a guard there would not narrow
   *  `msg.requestId` inside the case, so the shortest way to satisfy the reply's required field would be
   *  `msg.requestId!` — the assertion removed from `open-url` and then from clipboard. Inbound is
   *  unvalidated (#444) and `mcp-server`'s tool schemas are bare `z.string()`, so `''` is reachable. */
  private correlatorOf(msg: { type: string; requestId?: string }): string | null {
    if (typeof msg.requestId === 'string' && msg.requestId !== '') return msg.requestId
    logger.warn(`${msg.type} without a usable requestId — dropped, its ack could not be attributed`)
    return null
  }

  // `requestId` joins `seq` as a caller-captured parameter, for the same reason stated above it: state
  // moves under the awaited dispatch, and a correlator read from shared state would answer one input with
  // another's id — #499 rebuilt inside the agent.
  private async ackInput(state: DeviceState, outcome: InputOutcome, seq: number, requestId: string): Promise<void> {
    // Only worth verifying the device when we believe we dispatched: every other outcome already
    // knows why it failed, and asking adb would add a round trip to say the same thing.
    const resolved: InputOutcome = outcome !== 'delivered'
      ? outcome
      : (state.booted || (await this.isBooted(state.deviceId))) ? 'delivered' : 'not-booted'
    if (resolved === 'delivered' && seq === state.bootSeq) state.booted = true // cache the verify
    this.sendMsg(
      resolved === 'delivered'
        ? { type: 'input:done', sessionId: state.sessionId, requestId }
        : { type: 'input:error', sessionId: state.sessionId, requestId, message: outcomeMessage(resolved), reason: wireReason(resolved) })
  }

  // A terminal input naming a session this agent holds no state for. `deviceStates` is never
  // deleted, so this is an unregistered sessionId rather than an evicted one — and the relay only
  // answers on an agent's behalf when the agent is *offline*, so nothing else would answer at all
  // and the caller would wait out its own timeout.
  private ackNoSession(sessionId: string, requestId: string): void {
    // The `if (!sessionId) return` this used to open with is gone: the dispatcher now declares
    // `sessionId: string`, so there is no undefined to guard against and the guard would have been a
    // silent drop with nothing left that could reach it.
    this.sendMsg({
      type: 'input:error', sessionId, requestId, message: outcomeMessage('no-session'), reason: wireReason('no-session'),
    })
  }

  // Await a pointer-channel write and turn it into an outcome. scrcpy's methods are synchronous and
  // return void, so `await` is a no-op there and `isReady()` is the whole signal; gRPC rejects, with a
  // deadline on input RPCs.
  //
  // The deadline is **not** a licence to retry, and this comment used to say it was. It cancels our
  // call, not a request the emulator already applied — and since an unreachable emulator rejects on its
  // own in 4ms, the case the deadline actually fires in is a connected-but-unresponsive emulator, where
  // whether the input landed is unknowable and a retry can double it. AGENTS.md carries the full
  // reasoning under "What the deadline does and does not buy".
  /**
   * Open a gesture on the backend that serves it now, and remember which one (#487).
   *
   * **Chosen once, when it opens.** The opening and closing frames used to pick their backend by
   * different conditions — the opening ones also asked for `videoWidth` — and a stream restart puts
   * the adb helper up before the pointer channel, so a gesture could open on the helper and close on
   * the channel: a touch-up with no touch-down, answered `delivered`, and a helper left mid-gesture
   * that tapped the abandoned position on the next end it received. iOS records the process that took
   * the opening frame for the same reason (`TouchHelper.gestureProc`); this is that, by identity.
   *
   * One slot, and the last opener wins. A pinch left open under a new touch would keep its second
   * pointer down on the channel, but no sender reaches that: the viewer always sends `pinch:end` on
   * leaving pinch mode, and neither MCP nor the flow runner pinches.
   */
  private openGesture(state: DeviceState, kind: 'touch' | 'pinch'): GestureBackend | null {
    const pc = this.pointerControl(state)
    const backend: GestureBackend | null = pc && state.videoWidth > 0 ? { via: 'channel', owner: pc }
      : state.touchHelper ? { via: 'helper', owner: state.touchHelper }
      : null
    state.gesture = backend ? { kind, ...backend } : null
    return backend
  }

  /** The open gesture's backend, if it is of `kind` and that backend is still the one serving the
   *  session — compared by identity, so a channel a restart replaced is not mistaken for its successor. */
  private gestureOwner(state: DeviceState, kind: 'touch' | 'pinch'): GestureBackend | null {
    const g = state.gesture
    if (!g || g.kind !== kind) return null
    const current = g.via === 'channel' ? g.owner === this.pointerControl(state) : g.owner === state.touchHelper
    return current ? g : null
  }

  /**
   * Close the open gesture and say what to do with its end. **The record is released here, before any
   * dispatch awaits** — the helper's end takes hundreds of ms, the viewer does not wait for acks between
   * taps, and clearing it afterwards would erase the next tap's record.
   *
   * **Ownership before readiness**, as on iOS. A gesture whose backend a restart dropped is `no-gesture`
   * even while nothing is up yet: its touch-down did land, and the stream heals by itself, so
   * `channel-down` would toast "not reaching this device" and tell MCP to reconnect for nothing. Only
   * with no gesture at all and no backend either is the channel what there is to report.
   */
  private closeGesture(state: DeviceState, kind: 'touch' | 'pinch'): GestureBackend | { via: 'none'; outcome: InputOutcome } {
    // An end of the other kind closes nothing: a stray touch end must not take an open pinch's record
    // with it, or the pinch's own end would find nothing and leave its second pointer down.
    if (state.gesture && state.gesture.kind !== kind) return { via: 'none', outcome: 'no-gesture' }
    const opened = state.gesture
    const backend = this.gestureOwner(state, kind)
    state.gesture = null
    if (backend) return backend
    // **Released anyway, and still answered `no-gesture`.** A gRPC client is stateless: whether a
    // pointer is down is the emulator's state, and it outlives the client a restart replaced — left
    // alone, the next tap's press arrives on a pointer already down and reads as a drag from here.
    // Best effort, on whatever channel serves now; on scrcpy an unmatched release is harmless. With no
    // channel up yet there is nothing to send it on. It goes on the new client's queue, which cannot order it
    // after a press still in flight on the replaced one — a restart in mid-tap is the window.
    const pc = this.pointerControl(state)
    if (opened?.via === 'channel' && pc) {
      this.fire(kind === 'touch' ? pc.touchUp(0, state.lastTouchPx.x, state.lastTouchPx.y) : pc.pinchEnd())
    }
    if (!opened && !pc && !state.touchHelper) return { via: 'none', outcome: 'channel-down' }
    return { via: 'none', outcome: 'no-gesture' }
  }

  private async dispatchTo(pc: PointerControl, write: () => void | Promise<void>): Promise<InputOutcome> {
    if (!pc.isReady()) return 'channel-down'
    try {
      await write()
      return 'delivered'
    } catch (e) {
      logger.error(`pointer dispatch failed: ${e instanceof Error ? e.message : String(e)}`)
      return 'failed'
    }
  }

  private async isBooted(deviceId: string): Promise<boolean> {
    try {
      const devices = await this.adb.listDevices()
      return devices.find((d) => d.id === deviceId)?.status === 'booted'
    } catch { return false }
  }

  /** Run `step` after every rotation already queued for this device. A failing step is logged and does
   *  not stop the ones behind it.
   *
   *  **No timeout, unlike iOS.** A hung `adb` would hold this device's queue and the boot waiting on it.
   *  The boot already awaits other `adb` calls with none (`normaliseOnBoot`), and bounding them means a
   *  timeout on `AdbRunner.exec` for every caller — a change to make once a hang has been seen. */
  private enqueueRotation(deviceId: string, step: () => Promise<void>): Promise<void> {
    const next = (this.rotations.get(deviceId) ?? Promise.resolve())
      .then(step)
      .catch((e: unknown) => { logger.warn(`rotate failed: ${(e as Error).message}`) })
    this.rotations.set(deviceId, next)
    void next.then(() => { if (this.rotations.get(deviceId) === next) this.rotations.delete(deviceId) })
    return next
  }

  /**
   * Stand a device up for a new session (#910): a fresh viewer always starts portrait, so a device
   * left turned by an earlier session — or by one whose undo never arrived, as on a reload — would
   * otherwise stream sideways under an upright frame. Only a device that is already **locked** to a
   * turn is touched: `wm user-rotation lock` is persistent device state, and writing one onto an
   * auto-rotating AVD would take auto-rotate away from it outside tapflow too (see `normaliseOnBoot`).
   * Replacing one lock with another takes nothing away. An unreadable lock is left alone.
   */
  /**
   * An emulator's boot: free the rotation lock the first time tapflow sees the AVD (earlier versions wrote one;
   * a person's later lock is theirs — `RotationLockMemory`), stand the body up when `upright`, and read where it
   * is held so the first chrome can say so. Best-effort: a failed step leaves the device as it was.
   */
  private async prepareBody(state: DeviceState, serial: string, upright: boolean): Promise<void> {
    const avd = state.deviceId.replace(/^avd:/, '')
    if (!this.rotationLock.freed(avd)) {
      const freed = await this.adb.freeRotation(serial).then(() => true, (e: unknown) => {
        logger.warn(`could not free the rotation lock on ${avd}: ${(e as Error).message}`)
        return false
      })
      // Apart from the free: a marker that cannot be written is not a lock that stayed, and saying so would send
      // someone after the wrong problem. The cost is freeing it again next time, a person's later lock with it.
      if (freed) {
        logger.info(`rotation: freed the rotation lock on ${avd} (once per AVD)`)
        try { this.rotationLock.markFreed(avd) } catch (e) {
          logger.warn(`freed the rotation lock on ${avd}, but could not remember it beside the AVD: ${(e as Error).message}`)
        }
      }
    }
    if (upright) await this.turnBodyTo(state, serial, 0)
    else state.body = await this.adb.readBodyRotation(serial).catch(() => null)
  }

  /**
   * Turn an emulator's body to `want`, a quarter clockwise at a time (`emu rotate` is relative), **from a fresh
   * reading** and confirming each step — a remembered start is what #910 was, and a lost step is put right by
   * the next turn's read. Returns where the body ended up, also kept in `state.body`.
   */
  private async turnBodyTo(state: DeviceState, serial: string, want: 0 | 90 | 180 | 270): Promise<0 | 90 | 180 | 270 | null> {
    let held = await this.adb.readBodyRotation(serial).catch(() => null)
    if (held === null) { logger.warn(`rotate ${serial}: could not read where the body is, not turning`); return null }
    for (let steps = ((want - held + 360) % 360) / 90; steps > 0; steps--) {
      const next = ((held + 90) % 360) as 0 | 90 | 180 | 270
      await this.adb.rotateBodyClockwise(serial)
      const deadline = Date.now() + BODY_TURN_SETTLE_MS
      let read: 0 | 90 | 180 | 270 | null = held
      while (read !== next && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, BODY_TURN_POLL_MS))
        read = await this.adb.readBodyRotation(serial).catch(() => null)
      }
      if (read !== next) { logger.warn(`rotate ${serial}: asked for ${next}, body reads ${read ?? 'unreadable'}`); held = read ?? held; break }
      held = next
    }
    state.body = held
    return held
  }

  /** tapflow just wrote a rotation lock. On an emulator that makes the lock tapflow's again, so the AVD is
   *  forgotten and the next gRPC session frees it (`RotationLockMemory`). A real device has no AVD to remember. */
  private lockWritten(state: DeviceState, serial: string): void {
    if (!serial.startsWith('emulator-')) return
    try { this.rotationLock.forget(state.deviceId.replace(/^avd:/, '')) } catch (e) {
      logger.warn(`could not forget freeing ${state.deviceId}'s rotation lock: ${(e as Error).message}`)
    }
  }

  private async uprightOnBoot(serial: string): Promise<void> {
    const lock = await this.adb.getUserRotation(serial)
    if (lock.mode !== 'lock' || lock.rotation === 0) return
    logger.info(`rotation: standing the device up from lock ${lock.rotation}`)
    await this.adb.setRotation(serial, 0)
  }

  private handleRelayMessage(msg: { type: string; sessionId: string; requestId?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'device:boot': {
        const { deviceId, resetMode, secureContext, external, runReset } = msg.payload as { deviceId: string; resetMode?: 'app-only' | 'full-erase'; secureContext?: boolean; external?: boolean; runReset?: RunResetRequest }
        this.handleDeviceBoot(msg.sessionId, deviceId, resetMode === 'full-erase', { secureContext: !!secureContext, external: !!external }, msg.requestId, runReset)
          .catch((e) => logger.error('handleDeviceBoot failed:', e))
        break
      }
      case 'device:shutdown': {
        const { deviceId } = msg.payload as { deviceId: string }
        this.handleDeviceShutdown(msg.sessionId, deviceId, msg.requestId)
          .catch((e) => logger.error('handleDeviceShutdown failed:', e))
        break
      }
      case 'app:install': {
        const { filePath, bundleId, buildTicket, buildName, buildBytes } = msg.payload as {
          filePath: string; bundleId?: string
          buildTicket?: string; buildName?: string; buildBytes?: number
        }
        const sessionId = msg.sessionId
        const { requestId } = msg
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] app:install without a requestId — dropped, cannot correlate a reply')
          break
        }
        // `...body` first — see the iOS handler and `open-url`.
        const respond = (body: AppInstallReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!state || !serial) {
          respond({ type: 'app:install-error', message: 'No booted device' })
          break
        }
        // **Judged on the name the relay reports, not on a path we may be about to invent.** A
        // downloaded build lands under a temp directory, so checking the local path would stop this
        // guard firing and send an iOS archive to `adb install`, which fails in the parser instead
        // of saying the one useful sentence.
        const declaredName = buildName ?? filePath
        if (declaredName.endsWith('.app.zip') || declaredName.endsWith('.app')) {
          respond({
            type: 'app:install-error',
            message: '.app.zip is an iOS simulator build — upload a .apk file for Android.',
          })
          break
        }
        const doInstall = async () => {
          // Not past a run reset's `pm clear` still running: it would land on the app installed here. A client that
          // joined without booting (MCP's `connect_device`) reaches this without the boot's own wait.
          await this.awaitPendingClears(state.deviceId)
          // The relay's own path only opens where the relay's disk is. A ticket means it can hand
          // us the bytes instead; without one, this is a relay that predates downloading and the
          // old behaviour is all there is.
          if (!buildTicket || !this.relayUrl) {
            if (bundleId) await this.adb.clearAppData(serial, bundleId).catch(() => {})
            await this.installReclaimingStorage(state, serial, filePath)
            return
          }
          // **This `finally` is new.** Android had no temp directory and so no cleanup; iOS has had
          // one all along. Without it every remote install would leave a copy of the build behind.
          const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'tapflow-install-'))
          try {
            const dest = path.join(tmpDir, path.basename(declaredName))
            await downloadBuild({
              relayUrl: this.relayUrl,
              ticket: buildTicket,
              destPath: dest,
              expectedBytes: buildBytes ?? 0,
            })
            if (bundleId) await this.adb.clearAppData(serial, bundleId).catch(() => {})
            await this.installReclaimingStorage(state, serial, dest)
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true })
          }
        }
        doInstall()
          .then(() => respond({ type: 'app:install-done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'app:install-error', message })
          })
        break
      }
      case 'app:launch': {
        const { bundleId, arguments: args, env, defaultsOnly } = msg.payload as AppLaunchToAgent['payload']
        const sessionId = msg.sessionId
        const { requestId } = msg
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] app:launch without a requestId — dropped, cannot correlate a reply')
          break
        }
        // `...body` first — see the iOS handler and `open-url`.
        const respond = (body: AppLaunchReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          respond({ type: 'app:launch-error', message: 'No booted device' })
          break
        }
        // The relay checks with the same function; this is the last door before an `adb shell` line, and a relay of
        // another version may check less. See the iOS handler.
        const problem = launchOptionsProblem({ arguments: args, env })
        if (problem) {
          respond({ type: 'app:launch-error', message: problem })
          break
        }
        const options = compactLaunchOptions({ arguments: args, env })
        // Same reason as `app:install`: a launched app writes data a late `pm clear` would take.
        this.awaitPendingClears(state!.deviceId)
          .then(() => this.adb.launchApp(serial, bundleId, options, defaultsOnly === true))
          // What was delivered, which for the relay's defaults can be less than what was sent, down to nothing.
          .then((applied) => respond(options ? { type: 'app:launch-done', applied: appliedKeys(applied ?? {}) } : { type: 'app:launch-done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            // The toast gets the reason alone; the full adb output (the cause) stays in this log.
            console.warn('[tapflow] app:launch failed:', e instanceof Error && e.cause !== undefined ? e.cause : e)
            respond({ type: 'app:launch-error', message })
          })
        break
      }
      case 'input:touch:start': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const p = msg.payload as InputTouchStart['payload']
        const { x, y } = this.fromFrame(state, p.x, p.y, p.space)
        const g = this.openGesture(state, 'touch')
        if (g?.via === 'helper') {
          g.owner.touchStart(x, y)
        } else if (g?.via === 'channel') {
          const { px, py } = this.toDevicePx(state, x, y)
          state.lastTouchPx = { x: px, y: py }
          this.fire(g.owner.touchDown(0, px, py))
        }
        break
      }
      case 'input:touch:move': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const p = msg.payload as InputTouchStart['payload']
        const { x, y } = this.fromFrame(state, p.x, p.y, p.space)
        // A move with no gesture behind it — or one whose backend has since been replaced — is not the
        // gesture the tester made. Dropped, as iOS drops it.
        const g = this.gestureOwner(state, 'touch')
        if (g?.via === 'helper') {
          g.owner.touchMove(x, y)
        } else if (g?.via === 'channel') {
          const { px, py } = this.toDevicePx(state, x, y)
          state.lastTouchPx = { x: px, y: py }
          this.fire(g.owner.touchMove(0, px, py))
        }
        break
      }
      case 'input:touch:end': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        const closed = this.closeGesture(state, 'touch')
        const seq = state.bootSeq
        const { x: upX, y: upY } = state.lastTouchPx
        // terminal of a tap/swipe → ack the gesture, on what the dispatch actually reported
        void (async () => this.ackInput(state,
          closed.via === 'none' ? closed.outcome
            : closed.via === 'helper' ? await closed.owner.touchEnd()
            : await this.dispatchTo(closed.owner, () => closed.owner.touchUp(0, upX, upY)),
          seq, requestId,
        ))().catch((e) => logger.error('input:touch:end ack failed:', e))
        break
      }
      case 'input:pinch:start': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const p = msg.payload as InputPinchStart['payload']
        const f0 = this.fromFrame(state, p.f0.x, p.f0.y, p.space)
        const f1 = this.fromFrame(state, p.f1.x, p.f1.y, p.space)
        const g = this.openGesture(state, 'pinch')
        if (g?.via === 'helper') {
          g.owner.pinchStart(f0.x, f0.y, f1.x, f1.y)
        } else if (g?.via === 'channel') {
          const { px: px1, py: py1 } = this.toDevicePx(state, f0.x, f0.y)
          const { px: px2, py: py2 } = this.toDevicePx(state, f1.x, f1.y)
          this.fire(g.owner.pinchStart(px1, py1, px2, py2))
        }
        break
      }
      case 'input:pinch:move': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const p = msg.payload as InputPinchStart['payload']
        const f0 = this.fromFrame(state, p.f0.x, p.f0.y, p.space)
        const f1 = this.fromFrame(state, p.f1.x, p.f1.y, p.space)
        const g = this.gestureOwner(state, 'pinch')
        if (g?.via === 'helper') {
          g.owner.pinchMove(f0.x, f0.y, f1.x, f1.y)
        } else if (g?.via === 'channel') {
          const { px: px1, py: py1 } = this.toDevicePx(state, f0.x, f0.y)
          const { px: px2, py: py2 } = this.toDevicePx(state, f1.x, f1.y)
          this.fire(g.owner.pinchMove(px1, py1, px2, py2))
        }
        break
      }
      case 'input:pinch:end': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        const closed = this.closeGesture(state, 'pinch')
        const seq = state.bootSeq
        void (async () => this.ackInput(state,
          closed.via === 'none' ? closed.outcome
            : closed.via === 'helper' ? closed.owner.pinchEnd()   // 'unsupported' — the adb path has no pinch at all
            : await this.dispatchTo(closed.owner, () => closed.owner.pinchEnd()),
          seq, requestId,
        ))().catch((e) => logger.error('input:pinch:end ack failed:', e))
        break
      }
      case 'input:rotate': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const serial = this.adb.getSerial(state.deviceId)
        if (!serial) break
        // The viewer owns rotation intent locally (CSS); here we only ask the device to
        // rotate so rotation-capable apps re-layout. user_rotation=3 = canonical landscape
        // (home-left/punch-right). Portrait-locked apps ignore it — the viewer's CSS handles
        // their cosmetic rotation.
        //
        // **A target when the viewer sends one, a toggle when it does not** (#910) — an older
        // dashboard's. `landscape` is read when the step runs, not when it was queued, and written
        // only once the device took it: a step queued behind another toggles from what that one
        // applied, and a failed one leaves the memory where the device still is.
        const sessionId = msg.sessionId
        const payload = msg.payload as { orientation?: 'portrait' | 'landscape'; direction?: 'clockwise' | 'counterclockwise' } | undefined
        const target = payload?.orientation
        void this.enqueueRotation(state.deviceId, async () => {
          const live = this.deviceStates.get(sessionId) ?? state
          // **Body mode (gRPC): turn the emulator's body**, a quarter at a time from where it is read to be held —
          // a `direction`, or an older viewer's target, met by either landscape since that viewer stands the picture
          // up by `streamRotation` whichever it is. No lock: the app follows the body if it supports the turn.
          //
          // **A `direction` is a body turn even with no gRPC client** — the gap while a stream restarts, or a step
          // that ran after its session was cleaned up. Only a viewer drawing the body sends one, and the toggle below
          // would answer it with `wm user-rotation lock`, the state this model exists to remove. The console needs
          // no gRPC. A device with no body has nothing to turn.
          const bodyTurn = !!live.grpcClient || (payload?.direction !== undefined && serial.startsWith('emulator-'))
          if (!bodyTurn && payload?.direction !== undefined) {
            logger.warn(`rotate ${serial}: a ${payload.direction} turn for a device with no body to turn, ignoring`)
            return
          }
          if (bodyTurn) {
            const held = await this.adb.readBodyRotation(serial).catch(() => null) ?? live.body
            if (held === null) { logger.warn(`rotate ${serial}: could not read where the body is, not turning`); return }
            const landscape = held === 90 || held === 270
            const want = payload?.direction === 'clockwise' ? (held + 90) % 360
              : payload?.direction === 'counterclockwise' ? (held + 270) % 360
              : target === 'portrait' ? (held === 0 ? null : 0)
              : target === 'landscape' ? (landscape ? null : 90)
              : (landscape ? 0 : 90)
            if (want !== null) await this.turnBodyTo(live, serial, want as 0 | 90 | 180 | 270)
          } else {
            const next = target ? target === 'landscape' : !live.landscape
            await this.adb.setRotation(serial, next ? 3 : 0)
            live.landscape = next
            this.lockWritten(live, serial)
          }
          // **Report it, rather than leaving it to the watcher's next tick.** The viewer releases its turn
          // when a chrome says the body got there (`bodyRotation`), and the display's rotation follows the
          // body a few hundred milliseconds later; this pass reports both without waiting for the watcher.
          // **gRPC only, and the guard is the point.** scrcpy captures with
          // `capture_orientation=@0`, so its frame never changes shape and the viewer's CSS
          // quarter is the only thing that rotates it. Reconciling here would report the
          // rotated `cur=` as the screen: the viewer would then see landscape content, switch
          // that CSS quarter *off*, and find the frame no longer matches the screen it was told
          // about — a blank bezel with no way back but pressing rotate again. It would also set
          // `state.rotation` on a backend whose frames are already natural, which `toDevicePx`
          // says must never happen.
          if (!live.grpcClient) return
          const client = live.grpcClient
          // **Outside the queue.** Settling samples the display until it holds still — 0.6s at best,
          // 3.6s at worst — and the next rotation, or a boot waiting to stand the device up, must not
          // wait on that. `reconcileSerial` coalesces per device, so a later pass still runs.
          void this.reconcileSerial(
            live, serial, live.videoWidth, live.videoHeight, live.skin, () => live.grpcClient === client)
            .then((changed) => { if (changed && live.booted) this.sendChrome(live) })
            .catch((e: unknown) => { logger.warn(`rotate: could not re-read the screen: ${(e as Error).message}`) })
        })
        break
      }
      case 'input:posture': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const { postureId } = msg.payload as { postureId: string }
        // No ack by declaration (same as `input:rotate`), so a failure is reported by the posture
        // list that follows saying the device did not move, rather than by an error nobody awaits.
        // **Reported the moment the guest commits, not when the whole change finishes.** The
        // viewer's control is held until `device:postures` says the device arrived; the rotation
        // carry that follows needs a settling read the viewer never consumes, and waiting for it
        // added ~380ms to every fold. Nothing on this side records the posture — `sendPostures`
        // reads the device, which is also what makes a fold performed outside tapflow show up.
        // **One at a time.** The report now goes out before the carry finishes, which is what
        // puts the control back within reach while the first change is still settling — so the
        // second press would read its `before` from a panel mid-swap and the two carries would
        // land in arbitrary order. Dropped rather than queued: a second request during a fold is
        // a double-press, and the posture it asks for is the one already arriving.
        if (state.posturing) {
          logger.info(`posture ${postureId}: a change is already in flight, ignoring`)
          break
        }
        state.posturing = true
        void (async () => {
          let carry: { serial: string; before: 0 | 90 | 180 | 270 | null } | null = null
          try {
            carry = await this.beginPosture(state.deviceId, postureId)
          } catch (e: unknown) {
            logger.warn(`setPosture(${postureId}): ${(e as Error).message}`)
          }
          // Sent on the failure path too, so a change that could not happen reports what the
          // device really is rather than leaving the control with nothing to go on.
          await this.sendPostures(state)
          if (carry) await this.finishPosture(state, carry.serial, carry.before)
        })()
          .catch((e: unknown) => logger.warn(`posture ${postureId}: ${(e as Error).message}`))
          .finally(() => { state.posturing = false })
        break
      }
      case 'input:button': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        // Buttons go through the adb helper on BOTH backends — this is the path that actually runs
        // a command in production, so its outcome is the one that matters most here.
        // Destructuring inside the async body: doing it out here would throw synchronously on a
        // malformed payload, and the ws dispatch swallows that, leaving the caller with no ack.
        const seq = state.bootSeq
        void (async () => {
          const { name } = (msg.payload ?? {}) as { name?: string }
          const helper = state.touchHelper
          if (name === undefined) return this.ackInput(state, 'malformed', seq, requestId)
          if (!helper) return this.ackInput(state, 'channel-down', seq, requestId)
          return this.ackInput(state, await helper.pressButton(name), seq, requestId)
        })().catch((e) => logger.error('input:button ack failed:', e))
        break
      }
      case 'stream:request-idr': {
        // Relay drop-to-keyframe / join recovery: reset the encoder so it re-emits SPS/PPS + IDR,
        // resyncing fast instead of waiting for the periodic IDR. Throttled by the relay.
        const st = this.deviceStates.get(msg.sessionId)
        st?.scrcpySession?.control.resetVideo()
        st?.emulatorVideo?.requestIdr()
        break
      }
      case 'open-url': {
        const { url } = msg.payload as { url: string }
        const sessionId = msg.sessionId
        const { requestId } = msg
        // No fallback by design (see the note above `OpenUrl`), so an uncorrelatable request cannot be
        // answered correlatably either — and inventing an id would make this agent's reply look like a
        // response to a request nobody made. Every in-repo sender supplies one, and the `fixed` version
        // group means there is no in-repo skew window; validating third-party frames at the relay's door
        // is #444, which will take this over. Until then a drop with a log beats a reply that lies.
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] open-url without a requestId — dropped, cannot correlate a reply')
          break
        }
        // See the iOS handler for what this does and does not enforce. `...body` first is load-bearing:
        // with the ids last a body variable carrying a `requestId` overrides the real one, and excess
        // property checking does not fire on variables.
        const respond = (body: OpenUrlReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          respond({ type: 'open-url:error', message: 'No booted device' })
          break
        }
        // Same reason as `app:install`: the URL can start the app.
        this.awaitPendingClears(state!.deviceId)
          .then(() => this.adb.openUrl(serial, url))
          .then(() => respond({ type: 'open-url:done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'open-url:error', message })
          })
        break
      }
      case 'input:keyboard:toggle': {
        // client-side key forwarding toggle only — no ADB side effect needed
        break
      }
      case 'input:type': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        const { text } = (msg.payload ?? {}) as { text?: string }
        if (!serial) {
          this.sendMsg({ type: 'input:type-error', sessionId, requestId, message: 'No booted device' })
          break
        }
        // Empty text is a successful no-op, not a failure: the caller asked for nothing and nothing
        // was needed, so there is no claim to be false about. iOS answers the same way, and both the
        // flow schema and the MCP `type_text` tool accept `""`. (The lie this change removes is
        // "dispatched nothing while claiming otherwise" — not "dispatched nothing".)
        // Ack on completion so a following input step (e.g. pressKey Enter) is
        // only sent after the text has actually landed.
        Promise.resolve(text ? this.adb.inputText(serial, text) : undefined)
          .then(() => this.sendMsg({ type: 'input:type-done', sessionId, requestId }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            logger.error('input:type failed:', e)
            this.sendMsg({ type: 'input:type-error', sessionId, requestId, message })
          })
        break
      }
      case 'input:key': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        const seq = state.bootSeq
        void (async () => {
          const serial = this.adb.getSerial(state.deviceId)
          if (!serial) return this.ackInput(state, 'channel-down', seq, requestId)
          // `modifiers` is optional in the contract and iOS already defaults it; match that here so
          // both agents read the same message the same way.
          const { code, modifiers } = (msg.payload ?? {}) as { code?: string; modifiers?: number }
          if (code === undefined) return this.ackInput(state, 'malformed', seq, requestId)
          return this.ackInput(state, await this.handleKeyInput(serial, code, modifiers ?? 0), seq, requestId)
        })().catch((e) => logger.error('input:key ack failed:', e))
        break
      }
      case 'screenshot:request': {
        // `format` is deliberately destructured and unused — it is on the wire and this platform
        // cannot honour it, which is the whole of #508. Reading it here and answering with it is
        // exactly the bug.
        const raw = msg as unknown as { requestId: string; format?: 'png' | 'jpeg'; sessionId?: string }
        const { requestId } = raw
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.sendMsg({ type: 'screenshot:error', sessionId, requestId, message: 'No booted device' })
          break
        }
        this.adb.screenshot(serial)
          .then((buf) => this.sendMsg({
            type: 'screenshot:done',
            sessionId,
            requestId,
            // `'png'`, never the requested format. `screencap -p` produces PNG and takes no format
            // argument, and this field means what was produced — the request's is a preference (see
            // `ScreenshotRequest` in protocol). Echoing it sent PNG bytes out under `image/jpeg`
            // (#508), which the relay then wrote into the HTTP Content-Type.
            format: 'png',
            data: buf.toString('base64'),
          }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.sendMsg({ type: 'screenshot:error', sessionId, requestId, message })
          })
        break
      }
      case 'app:clear-state': {
        const { bundleId } = (msg.payload ?? {}) as { bundleId?: string }
        const sessionId = msg.sessionId
        const { requestId } = msg
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] app:clear-state without a requestId — dropped, cannot correlate a reply')
          break
        }
        const respond = (body: AppClearStateReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial || !bundleId) {
          respond({ type: 'app:clear-state-error', message: !serial ? 'No booted device' : 'bundleId missing' })
          break
        }
        this.adb.clearAppData(serial, bundleId)
          .then(() => respond({ type: 'app:clear-state-done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'app:clear-state-error', message })
          })
        break
      }
      case 'network:set': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        // `?? {}` and a re-check of a field the relay's schema already requires: this case owes a
        // reply, and the ws dispatch swallows a synchronous throw (see `input:button`), so a cast
        // that dereferences a missing payload answers nothing at all — the one failure the
        // requester cannot tell from a hung device. A malformed frame gets a `network:error`
        // because it could not be dispatched, which is the same reason the no-device case does.
        const { offline } = (msg.payload ?? {}) as { offline?: boolean }
        if (typeof offline !== 'boolean') {
          this.sendMsg({
            type: 'network:error', sessionId: msg.sessionId, requestId,
            message: 'network:set payload must carry a boolean `offline`.',
          })
          break
        }
        void this.handleNetworkSet(msg.sessionId, offline, requestId)
        break
      }
      // The relay asks on a viewer's re-join (#614). Uncorrelated both ways: the reply is a report,
      // and nothing here is waiting on it — a session with no booted device answers nothing at all,
      // because `network:error` would be addressed to a requester that does not exist.
      case 'network:request-state':
        void this.reportNetworkState(msg.sessionId, 're-join')
        break
      // Clipboard bridge. Emulator-only: it rides the gRPC EmulatorController, since the
      // AVD images have no `adb shell cmd clipboard`. The chord is pressed HERE, not by the
      // viewer — the browser cannot know when the key lands, and reading too early returns
      // the PREVIOUS clipboard, a stale value the user would never notice.
      case 'clipboard:read':
      case 'clipboard:write': {
        // `requestId: string`, matching the screenshot and ui:tree casts a few cases below — clipboard was
        // the only one reading it as optional, for the same wire guarantee. `ClipboardRequest.requestId` is
        // required and the only requester goes through a typed `send()`, so nothing in-repo omits it.
        //
        // It is still an assertion about unvalidated JSON, as those other two are: a third-party client
        // could omit it, and then the reply would carry `undefined` and be uncorrelatable. That is inbound
        // validation (#444), not producer typing, and making it optional here instead would just move the
        // same hole into every reply this case sends.
        const { requestId } = msg as unknown as { requestId: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        // Every caller of `fail` gave up before parking anything itself, but another operation
        // on the same device may still hold a marker — and the chord the viewer would press in
        // response does not go through the queue. So report the device, not the caller.
        const fail = (message: string, unsupported = false) =>
          this.sendMsg({
            type: 'clipboard:error', sessionId, requestId, message,
            payload: {
              unsupported,
              sentinelParked: state ? this.sentinelParked(state.deviceId) : false,
            } satisfies ClipboardErrorPayload,
          })
        // Distinguish the three ways this can be unavailable — they need different fixes.
        if (!state || !serial) { fail('No booted device'); break }
        if (!state.grpcClient) {
          // `unsupported` means this backend has no clipboard channel at all, so it can never
          // park a sentinel — which makes it the one error where the viewer may safely press
          // the plain chord. Without that the shortcut would silently do nothing here, which
          // is worse than the behaviour that predates this feature.
          fail('Clipboard needs the emulator gRPC backend — this device pastes on-device only', true)
          break
        }
        const client = state.grpcClient
        const onError = (e: unknown) => fail(e instanceof Error ? e.message : String(e))

        if (msg.type === 'clipboard:read') {
          const { press } = (msg.payload ?? {}) as { press?: 'copy' | 'cut' }
          // Answering is separate from cleaning up: the restore is a `finally`, which runs after
          // the `catch` that replies, so the viewer hears back as soon as the outcome is known.
          // The queue is still held until the restore lands — that is what stops the next
          // operation seeing a sentinel. Mirrors the iOS read path.
          const respond = (body: ClipboardReplyBody) =>
            this.sendMsg({ sessionId, requestId, ...body })
          // The ceiling applies to whatever leaves the device, not just the sentinel path —
          // iOS gets this from getPasteboard's maxBuffer, so Android is the only side that
          // could put a multi-MB guest clipboard on the socket the video shares.
          const capped = (text: string): string => {
            if (clipboardByteLength(text) > MAX_CLIPBOARD_BYTES) {
              throw new PlatformError(`The device clipboard is too large to send (max ${Math.floor(MAX_CLIPBOARD_BYTES / 1024)} KB)`)
            }
            return text
          }
          const read = async (): Promise<void> => {
            if (!press) {
              respond({ type: 'clipboard:data', payload: { text: capped(await client.getClipboard()) } })
              return
            }
            // Overwrite with a value only we could have written, press the chord, then wait for
            // it to change. A fixed delay can only guess whether the app has copied yet, and
            // guessing wrong hands back the PREVIOUS clipboard with no error. The sentinel also
            // covers re-copying identical text, where a plain value-change watch never fires.
            // Read the original first. If we cannot, do NOT continue: parking a sentinel we are
            // unable to undo would destroy whatever the user had on the device clipboard.
            const raw = await client.getClipboard()
            const before = isSentinel(raw) ? '' : raw
            const sentinel = `${SENTINEL_PREFIX}${randomUUID()}`
            let copied: string | null = null
            // Counted before the call: setClipboard only schedules, so a rejection can still
            // leave the marker applied — everything from here to the restore counts as parked.
            this.markSentinel(state.deviceId, 1)
            try {
              // Inside the try: setClipboard only schedules the change, so a rejection can
              // still leave it applied — the restore below has to run either way.
              await client.setClipboard(sentinel)
              // ...and a resolved setClipboard means *scheduled*, not applied (see the proto).
              // Pressing before it lands would let the first poll read the pre-sentinel value
              // and return it as "what the app copied" — the exact staleness this guards.
              const applied = Date.now() + CLIPBOARD_WRITE_DEADLINE_MS
              while ((await client.getClipboard()) !== sentinel) {
                if (Date.now() >= applied) throw new PlatformError('The device clipboard did not respond')
                await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
              }
              await bounded(
                this.adb.sendKeyEvent(serial, press === 'cut' ? 'KEYCODE_CUT' : 'KEYCODE_COPY'),
                ADB_KEYEVENT_TIMEOUT_MS, 'copy keyevent')
              const deadline = Date.now() + CLIPBOARD_COPY_DEADLINE_MS
              do {
                const now = await client.getClipboard()
                // A sentinel is never a copy result: ours means "not yet", another one means a
                // concurrent operation slipped in and must not be handed to the user.
                if (!isSentinel(now)) {
                  copied = now
                  respond({ type: 'clipboard:data', payload: { text: capped(now) } })
                  return
                }
                await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
              } while (Date.now() < deadline)
              throw new PlatformError('The device did not copy anything — is something selected?')
            } catch (e) {
              // Reply here rather than letting this propagate: a rejection would surface only
              // after `finally` had restored, putting that window inside the round trip.
              respond({
                type: 'clipboard:error', message: e instanceof Error ? e.message : String(e),
                // setClipboard only schedules, so a rejection can still leave the marker applied.
                payload: {
                  unsupported: false, sentinelParked: this.sentinelParked(state.deviceId),
                } satisfies ClipboardErrorPayload,
              })
            } finally {
              // Restore only if nothing was copied; otherwise this would clobber the capture.
              // And wait for it to APPLY, not just schedule: releasing the queue early lets the
              // next operation read the sentinel as the original — which then becomes '' and
              // wipes the user's device clipboard.
              if (copied === null) {
                await client.setClipboard(before).catch(() => {})
                const restored = Date.now() + CLIPBOARD_RESTORE_DEADLINE_MS
                while ((await client.getClipboard().catch(() => before)) !== before) {
                  if (Date.now() >= restored) break   // best effort; the error is already going out
                  await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
                }
              }
              this.markSentinel(state.deviceId, -1)
            }
          }
          // `read` answers for itself; this only catches what the press-less branch can throw.
          this.clipboardQueue(state.deviceId, read).catch(onError)
        } else {
          const { text, pasteAfter } = (msg.payload ?? {}) as { text?: string; pasteAfter?: boolean }
          if (clipboardByteLength(text ?? '') > MAX_CLIPBOARD_BYTES) {
            fail(`Clipboard is too large (max ${Math.floor(MAX_CLIPBOARD_BYTES / 1024)} KB)`)
            break
          }
          const write = async (): Promise<void> => {
            const wanted = text ?? ''
            await client.setClipboard(wanted)
            if (!pasteAfter) return
            // setClipboard is explicitly asynchronous in the proto ("executed on the emulator's
            // main looper ... returns OK upon successful asynchronous scheduling"), so a resolved
            // promise means scheduled, not applied. Pasting now would paste the old clipboard.
            const deadline = Date.now() + CLIPBOARD_WRITE_DEADLINE_MS
            while ((await client.getClipboard().catch(() => null)) !== wanted) {
              if (Date.now() >= deadline) throw new PlatformError('The device clipboard did not accept the text')
              await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
            }
            await bounded(this.adb.sendKeyEvent(serial, 'KEYCODE_PASTE'),
              ADB_KEYEVENT_TIMEOUT_MS, 'paste keyevent')
          }
          // Ack only once the write (and the paste, when asked for) actually landed.
          this.clipboardQueue(state.deviceId, write)
            .then(() => this.sendMsg({ type: 'clipboard:write-done', sessionId, requestId }))
            .catch(onError)
        }
        break
      }
      case 'ui:tree:request': {
        const raw = msg as unknown as { requestId: string; sessionId?: string }
        const { requestId } = raw
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.sendMsg({ type: 'ui:tree:error', sessionId, requestId, message: 'No booted device' })
          break
        }
        this.adb.dumpUiHierarchy(serial)
          .then((xml) => this.sendMsg({
            type: 'ui:tree:response',
            sessionId,
            requestId,
            elements: parseUiAutomatorDump(xml),
          }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.sendMsg({ type: 'ui:tree:error', sessionId, requestId, message })
          })
        break
      }
    }
  }

  private async handleKeyInput(serial: string, code: string, modifiers: number): Promise<InputOutcome> {
    const SPECIAL: Record<string, string> = {
      Backspace: '67', Enter: '66', Tab: '61', Space: '62', Escape: '111',
      ArrowLeft: '21', ArrowRight: '22', ArrowUp: '19', ArrowDown: '20',
      Delete: '112', Home: '122', End: '123', PageUp: '92', PageDown: '93',
      F1: '131', F2: '132', F3: '133', F4: '134', F5: '135',
      F6: '136', F7: '137', F8: '138', F9: '139', F10: '140', F11: '141', F12: '142',
    }
    // Every exit below reports whether it dispatched, not merely whether it threw. Two of them
    // deliberately send nothing, and answering `delivered` for those would be the same lie this
    // vocabulary exists to remove.
    // `Object.hasOwn`, not truthiness: `code` comes off the wire, and `'constructor'` would
    // otherwise resolve up the prototype chain to a function and be dispatched as a keycode.
    if (Object.hasOwn(SPECIAL, code)) {
      // Only on a caret key does a modifier change what the key means (#416): Shift+Arrow selects,
      // where the bare arrow moves. Shift+Space or Shift+Enter is still a space or a newline.
      const moves = /^(Arrow|Home$|End$|Page)/.test(code)
      // The bitmap's HID bits → the left-hand Android modifier. On a caret key Meta is held as Ctrl,
      // as for the clipboard chords below: Android gives Meta+Arrow no editing meaning (measured, API
      // 36), and on a Mac viewer Cmd is the only way to reach word-wise movement — macOS takes
      // Ctrl+Arrow for Spaces, and the viewer keeps Option for pinch. Elsewhere Meta is dropped, as it
      // always was, so Cmd+Enter stays the bare Enter that submits a field.
      const HELD: Array<[number, string]> = [[moves ? 0x01 | 0x08 : 0x01, '113'], [0x02, '59'], [0x04, '57']]
      const held = HELD.filter(([bits]) => modifiers & bits).map(([, key]) => key)
      const bare = () => this.dispatchKey(() => this.adb.sendKeyEvent(serial, SPECIAL[code]))
      if (held.length === 0) return bare()
      let pressed = false
      const outcome = await this.dispatchKey(async () => {
        pressed = await this.adb.sendKeyCombination(serial, [...held, SPECIAL[code]])
      })
      if (outcome !== 'delivered' || pressed) return outcome
      // The device cannot hold a modifier (Android below 13). A caret key gets no fallback: the bare
      // arrow would move the caret when the tester asked to select, so `unsupported` is the honest
      // answer. Any other key is pressed bare, which is what it always did here.
      return moves ? 'unsupported' : bare()
    }
    // A Ctrl/Cmd chord is a command, not text. `input text` can't do chords, so map the
    // clipboard shortcuts to dedicated keycodes (a Mac viewer sends Cmd = meta 0x08; treat
    // meta and ctrl alike). Any other chord+letter (e.g. Cmd+A) must NOT type the raw letter.
    if (modifiers & (0x01 | 0x08)) {
      const CLIP: Record<string, string> = { KeyC: 'KEYCODE_COPY', KeyV: 'KEYCODE_PASTE', KeyX: 'KEYCODE_CUT' }
      // Anything else — Cmd+A, Ctrl+S — is intentionally not sent. The channel is fine; we do not
      // implement it.
      if (!Object.hasOwn(CLIP, code)) return 'unsupported'
      return this.dispatchKey(() => this.adb.sendKeyEvent(serial, CLIP[code]))
    }
    const shift = Boolean(modifiers & 0x02)
    let char: string | null = null
    if (code.startsWith('Key')) {
      const letter = code.slice(3)
      char = shift ? letter.toUpperCase() : letter.toLowerCase()
    } else if (code.startsWith('Digit')) {
      const digit = code.slice(5)
      const shiftDigits: Record<string, string> = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
      }
      char = shift ? (shiftDigits[digit] ?? digit) : digit
    } else {
      const PUNCT: Record<string, [string, string]> = {
        Minus: ['-', '_'], Equal: ['=', '+'],
        BracketLeft: ['[', '{'], BracketRight: [']', '}'],
        Backslash: ['\\', '|'], Semicolon: [';', ':'],
        Quote: ["'", '"'], Comma: [',', '<'],
        Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'],
      }
      if (Object.hasOwn(PUNCT, code)) char = shift ? PUNCT[code][1] : PUNCT[code][0]
    }
    // CapsLock, F13+, IntlBackslash, Numpad… — no character mapping, so nothing goes out.
    if (!char) return 'unsupported'
    const text = char
    return this.dispatchKey(() => this.adb.sendInput(serial, 'text', text))
  }

  private async dispatchKey(send: () => Promise<void>): Promise<InputOutcome> {
    try {
      await send()
      return 'delivered'
    } catch (e) {
      logger.error(`key dispatch failed: ${e instanceof Error ? e.message : String(e)}`)
      return 'failed'
    }
  }

  listDevices(): Promise<Device[]> { return this.adb.listDevices() }

  async boot(avdId: string): Promise<void> {
    const avdName = avdId.replace(/^avd:/, '')
    this.launcher.launch(avdName)
    const serial = await this.launcher.findSerial(avdName)
    await this.launcher.waitForBoot(serial)
    this.adb.setSerial(avdId, serial)
    this.ownedDevices.add(avdId)
  }

  async shutdown(avdId: string): Promise<void> {
    const serial = this.adb.getSerial(avdId)
    if (serial) {
      await this.adb.shutdown(serial)
      this.adb.clearSerial(avdId)
      this.ownedDevices.delete(avdId)
    }
  }

  /**
   * The one live device, or a refusal — **the resolver every session-less entry point shares.**
   *
   * `IOSAgent.soleOf` has done this since #607 and says why: *"Refusing beats guessing: this interface
   * has no way to say which device is meant, and picking one silently is the whole defect being fixed
   * here."* Same defect, same interface, and this class never got it — eleven entry points each took
   * `deviceStates.values().next().value`, the entry the relay happened to register first. For a read
   * that answers about the wrong device; for `setNetworkOffline` it takes a device off the network
   * while somebody else is testing on it (#617).
   *
   * **Liveness is `adb` reporting the emulator attached — not tapflow having launched it.**
   * `IOSAgent.soleDeviceState`'s comment says this map is "only populated on launch" and that is
   * **wrong**: `AdbWrapper.listDevices` syncs it from `adb devices` on every call, taking every
   * `emulator-*` in state `device` whoever started it, and dropping the ones that went away. The
   * claim was inherited from that comment and checked afterwards; it is recorded here so the next
   * reader does not inherit it again.
   *
   * So a developer with their own emulator open, plus one a tester booted, is two live devices — and
   * refusing there would be the feature removed by its own fix. `ownedDevices` is what separates
   * them, and it is why that set exists rather than the serial map being enough on its own. **iOS
   * narrows the same way for the same desk** (`soleLiveDeviceState`), after a version that did not.
   *
   * **What ownership does not cover**: an emulator tapflow launched and someone else killed keeps
   * its serial *and* its ownership until the next `listDevices()` syncs the map (`AdbWrapper` calls
   * that removal "stale serials"). A ghost can still make a live device ambiguous for that window.
   * Refusing is the safe direction there, and the window closes on the next device listing.
   *
   * **Absence is not an error here**, because the touch entry points have always no-opped without a
   * device and making them throw would change more than the ambiguity this fixes. `soleLive` is the
   * variant that demands one.
   *
   * **Ambiguity is an error even for input, and there this class diverges from iOS on purpose.**
   * `IOSAgent.liveDeviceState` returns `undefined` when it cannot choose, so a tap on a
   * two-simulator desk silently does nothing. Silence is the failure mode this repo keeps removing:
   * a tester taps, nothing moves, and no channel says why. `touchStart` returns `void` so a throw is
   * the only signal available to it, and `touchMove`/`touchEnd` reject.
   */
  private soleLiveOrNone(): { state: DeviceState; serial: string } | undefined {
    const live: Array<{ state: DeviceState; serial: string }> = []
    for (const state of this.deviceStates.values()) {
      const serial = this.adb.getSerial(state.deviceId)
      if (serial) live.push({ state, serial })
    }
    if (live.length === 0) return undefined
    // **Ownership narrows liveness, and only when it can** — `IOSAgent.soleLiveDeviceState`'s line
    // for the same desk. A developer's own emulator plus tapflow's is two live devices and one
    // obvious answer; when ownership says nothing (nothing launched through tapflow yet, or an agent
    // that reconnected before it booted anything) there is no narrowing to apply and refusing is the
    // honest reply.
    const mine = live.filter((l) => this.ownedDevices.has(l.state.deviceId))
    const pool = mine.length > 0 ? mine : live
    if (pool.length > 1) {
      throw new ValidationError(`${pool.length} booted devices — this entry point cannot choose between them`)
    }
    return pool[0]
  }

  /** `soleLiveOrNone`, for the callers that have nothing to do without a device. */
  private soleLive(): { state: DeviceState; serial: string } {
    const live = this.soleLiveOrNone()
    if (!live) throw new ValidationError('no booted device — call connect() first')
    return live
  }

  async installApp(apkPath: string): Promise<void> {
    const { state, serial } = this.soleLive()
    await this.installReclaimingStorage(state, serial, apkPath)
  }

  /**
   * `adb install`, reclaiming space and retrying when the device is full — see `StorageReclaim`.
   * Only on an emulator this agent launched, and each rollback rechecks the boot, so a shutdown or a
   * newer boot arriving mid-way stops it the way it stops Lean mode.
   */
  private async installReclaimingStorage(state: DeviceState, serial: string, apkPath: string): Promise<void> {
    const adb = this.adb
    const seq = state.bootSeq
    const device: ReclaimDevice = {
      installedPackages: async () => {
        const { enabled, disabled } = await adb.packageStates(serial)
        return new Set([...enabled, ...disabled])
      },
      hasUpdates: (pkg) => adb.hasSystemUpdates(serial, pkg),
      uninstallUpdates: async (pkg) => {
        if (seq !== state.bootSeq) throw new BootSupersededError()
        await adb.uninstallSystemUpdates(serial, pkg)
      },
    }
    await installReclaimingStorage({
      install: () => adb.installApp(serial, apkPath),
      device,
      owned: this.ownedDevices.has(state.deviceId),
    })
  }

  async launchApp(packageName: string, options?: LaunchOptions): Promise<void> {
    const problem = launchOptionsProblem(options ?? {})
    if (problem) throw new ValidationError(problem)
    await this.adb.launchApp(this.soleLive().serial, packageName, compactLaunchOptions(options))
  }

  async screenshot(): Promise<Buffer> {
    return this.adb.screenshot(this.soleLive().serial)
  }

  async queryUITree(): Promise<UIElement[]> {
    return parseUiAutomatorDump(await this.adb.dumpUiHierarchy(this.soleLive().serial))
  }

  stream(): ReadableStream<Buffer> {
    // **Resolved by `soleLiveOrNone`, then checked for frames separately.** Liveness here is a video
    // source rather than a serial, and the two are not the same: a device can be launched and have no
    // stream yet. Routing the *choice* through the shared resolver fixes the ambiguity without
    // swallowing this method's own message.
    const state = this.soleLiveOrNone()?.state
    // Works on either video backend (scrcpy for real devices, gRPC host-encode for emulators).
    const frames = state?.scrcpySession?.video.start() ?? state?.emulatorVideo?.frames()
    if (!frames) throw new ValidationError('no active video stream — call connect() first')
    // DeviceAgent.stream() is the platform-neutral Buffer contract; unwrap ScrcpyFrame payloads.
    return frames.pipeThrough(new TransformStream<ScrcpyFrame, Buffer>({
      transform(frame, controller) { controller.enqueue(frame.payload) },
    }))
  }

  touchStart(x: number, y: number): void {
    this.soleLiveOrNone()?.state.touchHelper?.touchStart(x, y)
  }

  // `async`, so the refusal arrives as a rejection rather than escaping at the call site. It declared
  // `Promise<void>` and could not throw before this change; a caller that wrote `.catch()` on the
  // strength of that signature would have been broken by exactly the path this change added.
  async touchMove(x: number, y: number): Promise<void> {
    this.soleLiveOrNone()?.state.touchHelper?.touchMove(x, y)
  }

  // The platform-neutral DeviceAgent contract has no ack channel, so the outcome is dropped on
  // purpose — but it must be consumed rather than left floating: the helper now returns a promise,
  // and an adb failure escaping here would be an unhandled rejection.
  async touchEnd(): Promise<void> {
    await this.soleLiveOrNone()?.state.touchHelper?.touchEnd()
  }

  async openUrl(url: string): Promise<void> {
    await this.adb.openUrl(this.soleLive().serial, url)
  }
}

/**
 * The answer to a write that threw: nothing reached the device, so it is where `before` found it —
 * which is now unconfirmed. `before` passes through when it is already a failed read, so a device
 * never observed keeps **no** `offline` key rather than gaining one set to `undefined`, which would
 * disagree with the same frame after serialisation under `'offline' in p`.
 */
function writeFailed(before: NetworkStatePayload): NetworkStatePayload {
  return before.available ? { offline: before.offline, available: false, reason: 'state-unconfirmed' } : before
}
