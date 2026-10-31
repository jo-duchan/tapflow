import os from 'os'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { WebSocket } from 'ws'
import type { BootAbandonReason, ClipboardErrorPayload, Device, DeviceAgent, DevicePosture, NetworkControlCapability, NetworkStatePayload, PosturableAgent, UIElement } from '@tapflowio/agent-core'
import type { RunResetStep } from '@tapflowio/agent-core/utils'
import { createLogger, PlatformError, ValidationError, bootAbandonMessage, BOOT_NO_SESSION_STATE, SHUTDOWN_NO_SESSION_STATE, downloadBuild } from '@tapflowio/agent-core'
import type {
  AgentControlOutbound, AgentDevicesApplied, DeviceReport, InputErrorReason, ClipboardReplyBody, OpenUrlReplyBody,
  AppInstallReplyBody, AppLaunchReplyBody, AppLaunchToAgent, LaunchOptions, AppClearStateReplyBody, FormFactor, ServiceTier, RunResetReport, RunResetRequest,
} from '@tapflowio/protocol'
import { appliedKeys, compactLaunchOptions, launchOptionsProblem } from '@tapflowio/protocol/launch'

const logger = createLogger('ios-agent')

/** The run reset's pasteboard step, the wait for the clipboard queue included; one step's bound like the others. */
const RUN_RESET_PASTEBOARD_TIMEOUT_MS = 10_000

// Typed so a typo cannot ship silently — the viewer gates the whole clipboard bridge on this.
// `full-reset` is honoured in `handleDeviceBoot`, which shuts a running device down before
// `simctl erase` (which refuses anything but a shut-down device) and boots it again.
// `network-control` claims what the other two claim: this agent has the code. Whether the injection
// actually took is per device and per app, and `network:state.available` carries that — the split the
// protocol documents. Added last, after the handler and the boot-time arming, because the string on
// its own is what puts a control on screen.
const AGENT_CAPABILITIES: AgentCapability[] = ['clipboard', 'full-reset', 'network-control', 'build-download', 'launch-options', 'launch-env']

// Human prose for each reason. Not in `@tapflowio/protocol`: that package's main entry must stay
// runtime-free so it erases under `import type` and never reaches the dashboard bundle — a lookup
// table is a runtime value. The `reason` on the wire is the machine-readable half; this is only what
// a human reads, and each agent owns its own wording.
const INPUT_ERROR_MESSAGES: Record<InputErrorReason, string> = {
  'not-booted': 'device not booted',
  'channel-unavailable': 'input channel not ready',
  'channel-starting': 'the input channel is still starting — retry in a moment',
  'dispatch-failed': 'the device rejected the input',
  unsupported: 'this input is not supported on the active connection to the device',
  malformed: 'this input does not fit what the device is doing',
  'no-gesture': 'no gesture is in progress to complete — start a new one',
  // The relay is the only producer of this one — an agent has no way to know which socket asked. Present
  // because the map is exhaustive, which is what makes a new reason a decision rather than an omission.
  'not-session-owner': 'this input was addressed to a session the sender does not hold',
}

// Cross-platform button name → iOS device-chrome button name. Chrome uses
// hyphens and "power" (not "lock"); MCP's vocabulary uses underscores. Names
// not listed here (incl. the raw chrome names the dashboard sends) pass through.
export const IOS_BUTTON_ALIASES: Record<string, string> = {
  lock: 'power',
  volume_up: 'volume-up',
  volume_down: 'volume-down',
}
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
  sameServiceTier,
  resetApps,
  runResetSteps,
  RUN_RESET_BUDGET_MS,
  isLocalhostWss,
  DEFAULT_BACKPRESSURE_BYTES,
  writeEnvelopeHeader,
  rewriteLowLatencySpsInFrame,
  CODEC_JPEG,
  CODEC_H264,
  CODEC_AUDIO,
  sendAudioYieldingToVideo,
  DeviceListWatcher,
} from '@tapflowio/agent-core/utils'
import type { AudioFrame } from '@tapflowio/agent-core'
import { SimctlWrapper, isDeviceMissingError, ClipboardTooLargeError, firstLine, launchFailureReason } from './SimctlWrapper.js'
import { SimulatorNetwork } from './SimulatorNetwork.js'
import { LeanStore } from './LeanStore.js'
import { MANAGED_LABELS, labelsFor } from './serviceTiers.js'
import {
  MAX_CLIPBOARD_BYTES, clipboardByteLength,
  CLIPBOARD_SENTINEL_PREFIX as SENTINEL_PREFIX, isClipboardSentinel as isSentinel,
  CLIPBOARD_COPY_DEADLINE_MS, CLIPBOARD_WRITE_DEADLINE_MS, CLIPBOARD_RESTORE_DEADLINE_MS, CLIPBOARD_POLL_MS,
  createKeyedSerialQueue,
  type AgentCapability,
} from '@tapflowio/agent-core'
import { ScreenCaptureStreamer, type StreamFrame } from './ScreenCaptureStreamer.js'
import { AudioCaptureStreamer, readSimVolume, applyGain } from './AudioCaptureStreamer.js'
import { ensureHelperApp, launchAudioHelper, isAudioSupported } from '@tapflowio/audiotap-helper'
import { enumerateSimPids } from './SimProcessTree.js'
import { MjpegStreamer } from './MjpegStreamer.js'
import { TouchHelper } from './TouchHelper.js'
import type { InputChannel } from './InputChannel.js'
import { FoldableInput } from './FoldableInput.js'
import { GuestHelper, defaultGuestHelperNative, type GuestHelperNative } from './GuestHelper.js'
import { PanelState, FOLD_SETTLE_MS, type PanelReading, type Rotation } from './PanelState.js'
import { PhysicalOrientation, ORIENTATION_DEGREES, turned, type DeviceOrientation } from './PhysicalOrientation.js'
import type { GuestOrientation } from './GuestHelper.js'
import type { IntegratedScreen } from './panels.js'
import { XCUITreeReader } from './XCUITreeReader.js'
import { DeviceChromeLoader, type ChromeData, type ChromePanel } from './DeviceChromeLoader.js'
import { TypePanels, panelFrame } from './TypePanels.js'
import { KEY_CODE_MAP, MODIFIER_BITS } from './KeyCodeMap.js'

// whole-sim audio: how often to re-enumerate the simulator's process tree for new audio-producing
// processes (launched apps, WebKit WebContent). Short enough that a tab's audio starts promptly,
// long enough to keep `ps` overhead negligible.
const AUDIO_POLL_MS = 1500

/** Bound on `simctl list` during a reconnect attempt only; see `connectOnce`. */
const RECONNECT_LIST_TIMEOUT_MS = 10_000

/** Lean mode needs an iOS runtime of 18.5 or later, where launchd honours the host-side overrides
 *  across reboots. tvOS, watchOS and visionOS devices come through the same list and are left alone. */
export function leanSupported(osVersion: string | undefined): boolean {
  const m = osVersion?.match(/^iOS (\d+)\.(\d+)/)
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 18 || (major === 18 && minor >= 5)
}

export interface IOSAgentOptions {
  /** How often the device list is re-read for a relay that takes updates. Injectable for tests. */
  deviceRereadMs?: number
  fps?: number
  intervalMs?: number
  reconnectDelays?: number[]
  /** Injectable for tests; defaults to a real macOS power assertion (no-op under vitest). */
  sleepBlocker?: SleepBlocker
  /** Restrict the devices registered with the relay to this name or id (exposure filter). */
  deviceFilter?: string
  /** Credential for remote relays — sent as `Authorization: Bearer` on every relay WS (#271). */
  token?: string
  /** Handshake(연결~agent:registered) 타임아웃 ms. 기본 10초, 테스트용 주입 가능. */
  handshakeTimeoutMs?: number
  /** The three-layer network control (#607). Injectable so a test can point it somewhere harmless;
   *  defaults to one wired to this agent's simctl (and, under vitest, to nothing real). */
  network?: SimulatorNetwork
  /** Lean mode (`agent.lean`): disable background services on each device this agent boots, and put
   *  them back when it shuts the device down. */
  lean?: boolean
  /** Where the launchd overrides are written. Injectable for the same reason as `network`. */
  leanStore?: LeanStore
  /** Device frame loading. Under vitest the default points at directories that do not exist, so a suite never
   *  reads the developer's Xcode chrome or spends seconds rendering it. */
  chromeLoader?: DeviceChromeLoader
  /** Which panel a multi-panel device shows (devicectl). Injectable so a suite never runs devicectl. */
  panelState?: PanelState
  /** Which way a multi-panel device is held (devicectl). Injectable for the same reason. */
  physicalOrientation?: PhysicalOrientation
  /** How a multi-panel device's in-simulator helper is spawned and found. Injectable for the same reason. */
  guestHelperNative?: GuestHelperNative
  /** How long a fold may take to light its panel before it counts as failed. Injectable so a suite does not
   *  wait the real 10 s on the path where it never does. */
  foldSettleMs?: number
  /** How often a multi-panel device's lit panel is read while a session is on it, to follow a fold made
   *  outside tapflow (DeviceHub). Injectable for the same reason. */
  panelPollMs?: number
  /** The same, once nothing has moved for `panelQuietMs`. Injectable for the same reason. */
  panelIdlePollMs?: number
  panelQuietMs?: number
  /** How long a boot waits for a multi-panel device's helper to be ready. Injectable for the same reason. */
  helperBootReadyMs?: number
}

// The postures of a multi-panel device (iPhone Duo), most closed first as the protocol requires. Two, not
// DeviceHub's three: its `flat` (180°) lights the same panel as `open`, and a step between them would read
// as a press that did nothing — the reason Android's list leaves out HALF_OPENED's twin. Labels match Android's.
const FOLDABLE_POSTURES: DevicePosture[] = [{ id: 'closed', label: 'Folded' }, { id: 'open', label: 'Unfolded' }]
// The angles DeviceHub's pose picker sweeps to (closed reads ≈3° after it). Unfolded is its flat pose, 180°, not
// its half-open 130°: both light the same panel, and unfolded means opened all the way — 130 left DeviceHub
// showing the device half open after tapflow unfolded it.
const POSTURE_DEGREES: Record<string, number> = { closed: 0, open: 180 }
// devicectl costs ~0.23 s a read, so this is a fold made outside tapflow showing up within a few seconds,
// not a frame-rate watch. And only while something is moving: each read also costs ~0.2 s of CPU, so a 2 s
// poll held ~18% of a core for as long as a session was open (measured, 8 GB Mac mini). Once nothing has
// changed for PANEL_QUIET_MS it reads every PANEL_IDLE_POLL_MS — a fold in DeviceHub on a device left alone
// shows within 6 s rather than 2 — and the first change it sees, or a fold or turn sent from tapflow, brings
// it back.
const PANEL_POLL_MS = 2_000
const PANEL_IDLE_POLL_MS = 6_000
const PANEL_QUIET_MS = 30_000
// How long a boot waits for a multi-panel device's helper. A helper that dies without saying `fatal` is
// relaunched on a rolling budget for ever, which is right for a session already on the device and wrong for a
// boot, which would otherwise never answer. Four of the helper's own 15 s start-up deadlines.
const HELPER_BOOT_READY_MS = 60_000
// How long a turn sent through the helper has to show up in `devicectl device orientation get`. M1 read each
// one back 2.5 s after sending and every one had landed; the wait ends as soon as it does.
const ROTATE_SETTLE_MS = 3_000
// `rotation-helper` takes UIInterfaceOrientation's names, whose landscapes are the device's the other way round:
// what it calls `landscapeRight` devicectl reads back as `landscapeLeft` (measured, Xcode 27 host, iOS 26.5).
const PURPLE_ARGS: Record<DeviceOrientation, 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown'> = {
  portrait: 'portrait', landscapeRight: 'landscapeLeft', portraitUpsideDown: 'portraitUpsideDown', landscapeLeft: 'landscapeRight',
}
// The helper's labels are the physical orientations' own names, on both of the Duo's panels (measured).
const ORIENT_LABELS: Record<DeviceOrientation, GuestOrientation> = {
  portrait: 'portrait', landscapeRight: 'landscape-right', portraitUpsideDown: 'pud', landscapeLeft: 'landscape-left',
}


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
  /** The device's input channel — `TouchHelper` or `FoldableInput`, chosen in `createInputChannel` only. */
  touchHelper: InputChannel | null
  // Device-booted flag for truthful input acks — set on device:boot, cleared on shutdown; false after a reconnect until the ack path re-verifies once via simctl.
  booted: boolean
  streamWs: WebSocket | null
  streamReader: ReadableStreamDefaultReader<StreamFrame> | null
  // Current capture streamer (ScreenCaptureStreamer path only) — lets the relay
  // request an on-demand IDR for drop-to-keyframe recovery. null on the MjpegStreamer path.
  captureStreamer: ScreenCaptureStreamer | null
  bootSeq: number
  loadedChrome: ChromeData | null
  /** The boot's first frame load has finished, whatever it returned — `resendChrome`'s gate. Not `loadedChrome`:
   *  a model frame that failed to load left it null, and the lit panel's frame was then never sent. */
  chromeSettled: boolean
  /** The `streamRotation` the last `session:chrome` carried — a turn within one panel re-sends the same frame. */
  sentRotation: ChromeData['streamRotation']
  /** The `scaleBasis` the last `session:chrome` carried. */
  sentBasis: number | undefined
  // tracks whether the software keyboard is currently visible so we can send ⌘K
  // in the correct direction. reset to false on any hardware key event because
  // iOS auto-hides the software keyboard whenever a hardware key is pressed.
  softKeyboardVisible: boolean
  // Browser-reported H.264 decode capability from device:boot. false (default) =
  // stream JPEG. Persisted so a stream reconnect re-picks the same codec.
  acceptH264: boolean
  // Viewer context from device:boot → downscale tier (native / 1280 / 1000).
  secureContext: boolean
  external: boolean
  // Audio output (opt-in). The loopback server the audiotap-helper streams PCM to, and its port —
  // the helper (launched at boot for the whole simulator) connects here. null/0 when audio is off.
  audioStreamer: AudioCaptureStreamer | null
  audioPort: number
  // whole-sim tap: the poll timer that re-enumerates the sim's process tree, and the last pid set we
  // pushed to the helper (so we only rebuild the tap when a NEW process appears).
  audioPoll: ReturnType<typeof setInterval> | null
  audioPids: Set<number> | null
  // Per-device capture gain (0–1) from the sim's sim_volume. The tap captures pre-volume audio, so we
  // multiply it back in. Per-session field → each simulator's volume is applied independently.
  audioVolume: number
}

export class IOSAgent implements DeviceAgent, NetworkControlCapability, PosturableAgent {
  private readonly simctl: SimctlWrapper
  private readonly network: SimulatorNetwork
  private readonly fps: number
  private readonly intervalMs: number | undefined
  private readonly reconnectDelays: number[]
  private readonly chromeLoader: DeviceChromeLoader
  private readonly deviceFilter?: string
  private readonly token?: string
  private readonly handshakeTimeoutMs: number
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
   * One queue of rotations per device (#910). Each is its own helper process, so two sent back to back
   * can land in either order, and a held ⌘⇧O or the boot reset racing the first press would leave the
   * simulator on the earlier target. Keyed here rather than on `DeviceState` because a re-register
   * replaces the states while a rotation already in flight keeps running — the boot reset that follows
   * has to queue behind it, not start fresh beside it.
   */
  private readonly rotations = new Map<string, Promise<void>>()
  /**
   * Devices **this agent booted**, by device id.
   *
   * Separate from `DeviceState.booted` because the two answer different questions and have different
   * lifetimes. `booted` is liveness and is a cache: `initDeviceStates` rebuilds the whole map on
   * every `agent:registered`, so it does not survive a reconnect. This does — the agent process is
   * the same one across a reconnect — and it is what says *which* device is tapflow's when a
   * developer has a second simulator of their own open.
   *
   * Without it, a reconnect on a two-simulator desk left the capability entry points asking simctl,
   * getting two live devices, and refusing both. Written only where a boot succeeds; never by
   * `ackInput`, which verifies liveness and proves nothing about ownership.
   *
   * **The `DeviceAgent.boot`/`shutdown` delegates do not touch this**, and that is deliberate: they
   * hand a device id straight to simctl without opening a session, so a device they start is not one
   * this agent is driving. The only caller is `playground/ios-agent.ts`, which boots a device outside
   * any session — so wiring ownership (or Lean mode) through them would serve a caller that has no
   * session to own it. A caller that wants either should go through the boot handler rather than
   * around it.
   */
  private readonly ownedDevices = new Set<string>()
  // Last app launched per device (deviceId → bundleId). The XCUITest tree backend
  // queries by bundleId; kept outside DeviceState so it survives a relay reconnect
  // (which clears deviceStates) while the app keeps running in the simulator.
  private lastBundleIds = new Map<string, string>()
  // **A multi-panel device (iPhone Duo) is known per device id, from the connect, not from a boot.** A
  // reconnect re-seeds sessions with no `device:boot`, and `ensureTouchHelper` then builds the channel with
  // nothing else to go on — so the answer must already be here, or an agent restart would hand the Duo an
  // Indigo channel that answers success and lands nowhere.
  private multiPanelDevices = new Set<string>()
  // Each device's type, from the connect: re-sending a panel's frame after a fold has no boot to read it from.
  private deviceTypeIds = new Map<string, string>()
  // The guest helper and the panels' display UUIDs are keyed by device and live outside `DeviceState`:
  // every relay reconnect rebuilds that map, and stopping the helper there would hide the fold control
  // (no helper, no postures) until something respawned it. They are stopped by the device's own teardown
  // — `stopGuest` — and nowhere else.
  private readonly guests = new Map<string, GuestHelper>()
  private readonly guestScreens = new Map<string, Map<number, IntegratedScreen>>()
  private readonly panelState: PanelState
  private readonly physical: PhysicalOrientation
  // A multi-panel device type's panels: each one's native turn, and the scale every panel is drawn at.
  private readonly typePanels: TypePanels
  private readonly guestHelperNative: GuestHelperNative
  private readonly foldSettleMs: number
  private readonly panelPollMs: number
  private readonly panelIdlePollMs: number
  private readonly panelQuietMs: number
  private readonly helperBootReadyMs: number
  private readonly panelPolls = new Map<string, ReturnType<typeof setTimeout>>()
  // When each device's panel or orientation last moved, or tapflow last moved it: the poll is fast after that.
  private readonly panelActivity = new Map<string, number>()
  private readonly panelRechecks = new Map<string, ReturnType<typeof setTimeout>>()
  // A posture change in flight per device: a second press during a fold is a double-press, dropped like Android's.
  private readonly posturing = new Set<string>()
  // The posture last reported per device, so the poll reports only a change.
  private readonly reportedPosture = new Map<string, string | null>()
  private readonly uiTreeReader = new XCUITreeReader()
  // Holds a macOS power assertion while connected so the host doesn't idle-throttle the
  // simulator capture/encode when the Mac is unattended. No-op off macOS.
  private readonly sleepBlocker: SleepBlocker
  /** What the next "relay disconnected" line reports: when the relay last pinged, and the socket's last error. */
  private lastPingAt: number | null = null
  private lastSocketError: string | undefined
  private releaseStallWatch: (() => void) | null = null
  private relayUrl: string | null = null
  /** The last device-type lookup that answered. A udid's type never changes, so on a reconnect whose
   *  lookup fails this is still right — and the relay overwrites device fields on every register, so
   *  falling back to nothing would blank a form factor it already had until the next reconnect. */
  private formFactors = new Map<string, FormFactor>()
  /** Device type → integrated panels, from every lookup that answered. See `offerDevices` for why it only grows. */
  private panelCounts = new Map<string, number>()
  /** Multi-panel devices already reported as not offered, so a re-read does not say it again every 30 s. */
  private unofferedSaid = new Set<string>()
  /** Re-reads the device list for a relay that takes `agent:devices` (#1085). */
  private readonly deviceWatcher: DeviceListWatcher
  private resourcesTimer: ReturnType<typeof setInterval> | null = null
  private resourcesInFlight: WebSocket | null = null
  private readonly resources = createResourceSampler()
  private _stopping = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _reconnectAttempt = 0
  private readonly lean: boolean
  private readonly leanStore: LeanStore

  constructor(options: IOSAgentOptions = {}, simctl?: SimctlWrapper) {
    // IOSAgent는 직접 export되므로 AgentRegistry.canRun() 가드를 우회해 인스턴스화될 수 있다.
    // 비-macOS에서는 simctl/캡처가 불명확한 에러로 늦게 실패하므로 여기서 일찍 막는다.
    // simctl 주입은 테스트 경로이므로(모킹) 가드를 건너뛴다.
    if (!simctl && process.platform !== 'darwin') {
      throw new PlatformError('IOSAgent requires macOS (xcrun simctl is macOS-only)')
    }
    this.simctl = simctl ?? new SimctlWrapper()
    // **Never the real filter under vitest.** Layer 1 is a system extension installed on the
    // developer's Mac, and `arm()` runs on every boot — so a suite that booted a mock device was
    // launching the notarized container app and rewriting the host's live filter configuration, once
    // per boot test, on any machine where tapflow's own filter is installed. Nothing in the suite
    // said so, because the class reports a missing container app rather than failing.
    //
    // Pointed at a path that does not exist rather than stubbed out: that is the same state a machine
    // without the app is in, so the tests exercise the real class along its real reporting path
    // (`filter-unavailable`) instead of a double that could drift from it. Same shape, and the same
    // reason, as `sleepBlocker` below.
    this.lean = options.lean ?? false
    // Never the host's real store under vitest, for the reason given for `network` just below.
    this.panelState = options.panelState ?? new PanelState()
    // Never the host's devicectl under vitest: every single-panel boot reads the orientation, and on an Xcode 27
    // host a real call would read whatever simulator the developer has under that udid. A suite gets the
    // Xcode 26 answer — unreadable, so tapflow remembers — unless it injects one.
    this.physical = options.physicalOrientation ?? new PhysicalOrientation(process.env.VITEST
      ? { readOrientation: () => Promise.reject(new Error('no devicectl under vitest')) } : undefined)
    this.guestHelperNative = options.guestHelperNative ?? defaultGuestHelperNative
    this.foldSettleMs = options.foldSettleMs ?? FOLD_SETTLE_MS
    this.panelPollMs = options.panelPollMs ?? PANEL_POLL_MS
    this.panelIdlePollMs = options.panelIdlePollMs ?? PANEL_IDLE_POLL_MS
    this.panelQuietMs = options.panelQuietMs ?? PANEL_QUIET_MS
    this.helperBootReadyMs = options.helperBootReadyMs ?? HELPER_BOOT_READY_MS
    this.leanStore = options.leanStore ?? new LeanStore(process.env.VITEST ? path.join(tmpdir(), 'tapflow-no-lean-store') : undefined, MANAGED_LABELS)
    this.network = options.network ?? new SimulatorNetwork(
      this.simctl,
      process.env.VITEST ? { filterHostBinary: path.join(tmpdir(), 'tapflow-no-filter-host') } : {},
    )
    // **Wired here rather than in the constructor call above, and the difference is coverage.** An
    // injected `SimulatorNetwork` — which is what every test uses — would otherwise never carry the
    // handler, so the only path that tells a tester enforcement was lost was reachable in production
    // and in nothing else.
    this.network.setEnforcementLostHandler((deviceId) => { this.reportEnforcementLost(deviceId) })
    this.fps = options.fps ?? 30
    this.intervalMs = options.intervalMs
    this.reconnectDelays = options.reconnectDelays ?? [1000, 2000, 4000, 8000, 16000, 30000]
    this.chromeLoader = options.chromeLoader ?? new DeviceChromeLoader(process.env.VITEST
      ? { run: () => Promise.reject(new Error('no chrome under vitest')) }
      : {})
    this.typePanels = new TypePanels(this.simctl, this.chromeLoader)
    this.deviceFilter = options.deviceFilter
    this.token = options.token
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
    this.deviceWatcher = new DeviceListWatcher({
      read: async () => this.offerDevices(await this.simctl.listDevices(RECONNECT_LIST_TIMEOUT_MS), false),
      send: (devices) => { if (this.ws) this.sendOn(this.ws, { type: 'agent:devices', devices }) },
      onReadError: (e) => logger.debug(`device list re-read failed, trying again later: ${e instanceof Error ? e.message : String(e)}`),
      intervalMs: options.deviceRereadMs,
    })
    // No-op under vitest so the suite never spawns real `caffeinate` processes.
    this.sleepBlocker = options.sleepBlocker ?? (process.env.VITEST ? { acquire() {}, release() {} } : createSleepBlocker())
  }

  get sessionId(): string | null {
    const first = this.deviceStates.values().next().value
    return first?.sessionId ?? null
  }

  async connect(relayUrl: string): Promise<void> {
    return this.connectOnce(relayUrl)
  }

  /**
   * `listTimeoutMs` is set only by the reconnect loop. `simctl list` is left unbounded elsewhere on purpose
   * (see `SimctlWrapper.listDevices`), but here a hang has a worse outcome than a failure: the attempt never
   * settles, `_scheduleReconnect` is never reached, and the agent stays offline with nothing in its output
   * even after CoreSimulator recovers. A bounded attempt fails and the loop tries again.
   */
  private async connectOnce(relayUrl: string, listTimeoutMs?: number): Promise<void> {
    this._stopping = false
    // Paired with the `dispose()` in `disconnect()`. This method is public and reuses the network, so
    // without it a reconnect leaves the liveness watcher off for good — see `SimulatorNetwork.resume`.
    this.network.resume()
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this.relayUrl = relayUrl
    const allDevices = await this.simctl.listDevices(listTimeoutMs)
    this.revertLeftoverLean(allDevices)
    // A `disconnect()` during this await or the one above does not cancel the connect. Every caller
    // today exits the process on the next line (the CLI's SIGINT handlers); one that keeps running
    // needs a generation check here before the socket is built.
    const offered = await this.offerDevices(allDevices, true)

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
          platform: 'ios',
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
          // Only a relay that said it takes `agent:devices`: an older one would drop each with a log line, and
          // the sessions it never made would leave nothing for the list to be about.
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
   * What this agent offers the relay out of `allDevices`: the `--device` filter, each device's form factor, and
   * multi-panel devices left out where this Mac cannot drive them. Shared by the register and the periodic re-read
   * (#1085), so the two cannot offer different lists.
   *
   * `refresh` re-reads every device type and panel count, which a connect does. A re-read asks only about types it has
   * not seen, and only ever adds to what it knows: a type's panels do not change, and `integratedPanelCounts` reads a
   * plist it cannot open as one panel, so asking again could drop a Duo that is in use onto the Indigo path, where
   * input answers success and lands nowhere.
   */
  private async offerDevices(allDevices: Device[], refresh: boolean): Promise<DeviceReport[]> {
    const devices = this.deviceFilter
      ? allDevices.filter((d) => d.name === this.deviceFilter || d.id === this.deviceFilter)
      : allDevices
    // An answer the lookup cannot give costs the field, not the register: a viewer draws a device with
    // no form factor as a phone, which is what it did before there was one. A reconnect falls back to
    // the last answer rather than to none (see `formFactors`).
    if (refresh || allDevices.some((d) => d.typeId && !this.formFactors.has(d.typeId))) {
      await this.simctl.formFactorsByType().then(
        (map) => { this.formFactors = map },
        (e: unknown) => {
          logger.warn(`device types unavailable, registering with the last known form factors: ${e instanceof Error ? e.message : String(e)}`)
        },
      )
    }
    // Whether each device has more than one integrated panel. A failed lookup keeps the last answer, like the
    // form factors above; with no answer at all every device stays on the Indigo path, which is how a
    // multi-panel device behaved before this existed. Wrapped so a simctl without the method cannot throw here.
    const types = [...new Set(allDevices.flatMap((d) => (d.typeId ? [d.typeId] : [])))]
    const ask = refresh ? types : types.filter((t) => !this.panelCounts.has(t))
    if (ask.length > 0) {
      await Promise.resolve()
        .then(() => this.simctl.integratedPanelCounts(ask))
        .then(
          (counts) => { for (const [type, n] of counts) this.panelCounts.set(type, n) },
          (e: unknown) => logger.warn(`could not read the devices' panels, keeping the last answer: ${e instanceof Error ? e.message : String(e)}`),
        )
    }
    const multiPanel = allDevices.filter((d) => d.typeId && (this.panelCounts.get(d.typeId) ?? 1) > 1).map((d) => d.id)
    const typeIds = allDevices.flatMap((d) => (d.typeId ? [[d.id, d.typeId] as const] : []))
    if (refresh) {
      this.multiPanelDevices = new Set(multiPanel)
      this.deviceTypeIds = new Map(typeIds)
    } else {
      for (const id of multiPanel) this.multiPanelDevices.add(id)
      for (const [id, type] of typeIds) this.deviceTypeIds.set(id, type)
    }
    // **A multi-panel device this Mac cannot drive is not offered.** Its input has no other path, so listing it
    // would let a tester — or an MCP agent's `list_devices` — pick a device that boots and then refuses.
    let offered = devices
    if (devices.some((d) => this.multiPanelDevices.has(d.id))) {
      const reason = await this.guestHelperNative.unavailableReason().catch((e: unknown) => String(e))
      if (reason) {
        const left = devices.filter((d) => this.multiPanelDevices.has(d.id))
        // Said once per device, not on every re-read.
        const unsaid = left.filter((d) => !this.unofferedSaid.has(d.id))
        if (unsaid.length > 0) logger.warn(`not offering ${unsaid.map((d) => d.name).join(', ')}: ${reason}`)
        for (const d of left) this.unofferedSaid.add(d.id)
        offered = devices.filter((d) => !this.multiPanelDevices.has(d.id))
      }
    }
    return offered.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      status: d.status,
      osVersion: d.osVersion,
      // A device with more than one panel folds, whatever its product family says (the Duo is an iPhone).
      formFactor: this.multiPanelDevices.has(d.id) ? 'foldable' : d.typeId ? this.formFactors.get(d.typeId) : undefined,
      serviceTier: this.reportedTier(d),
    }))
  }

  /** The relay made sessions for devices that appeared and removed the ones for devices that left (#1085). A removed
   *  session had nobody on it, so there is nothing to tell anyone: its state is retired as a reconnect retires it. */
  private applyDevices(added: Array<{ deviceId: string; sessionId: string }>, removed: Array<{ deviceId: string; sessionId: string }>): void {
    for (const { sessionId } of removed) {
      const state = this.deviceStates.get(sessionId)
      if (!state) continue
      this.bumpBootSeq(state, 'shut-down')
      this.cleanupDeviceState(state)
      this.deviceStates.delete(sessionId)
      if (![...this.deviceStates.values()].some((s) => s.deviceId === state.deviceId)) this.stopGuest(state.deviceId)
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
        streamReader: null,
        captureStreamer: null,
        bootSeq: 0,
        bootAbandon: new Map(),
        bootsInFlight: new Set(),
        loadedChrome: null,
        chromeSettled: false,
        sentRotation: undefined,
        sentBasis: undefined,
        softKeyboardVisible: false,
        acceptH264: false,
        secureContext: false,
        external: false,
        audioStreamer: null,
        audioPort: 0,
        audioPoll: null,
        audioPids: null,
        audioVolume: 1,
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
    for (const deviceId of [...this.guests.keys()]) this.stopGuest(deviceId)
    this.uiTreeReader.stop()
    // The liveness watcher outlives every device it was started for, so it is stopped here with the
    // other things that tick. It is `unref`'d, which is why nobody noticed it had no caller.
    this.network.dispose()
    this.sleepBlocker.release()
    this.releaseStallWatch?.()
    this.releaseStallWatch = null
    this.ws?.close()
    this.ws = null
    this.relayUrl = null
    this.simctl.stopKeyboardDaemon()
  }

  /** `loss` is absent when a reconnect attempt failed: there is no close to describe, only a retry. */
  private _scheduleReconnect(loss?: RelayLoss): void {
    if (this._stopping) return
    if (this.resourcesTimer) { clearInterval(this.resourcesTimer); this.resourcesTimer = null }
    this.deviceWatcher.stop()
    for (const state of this.deviceStates.values()) {
      // Invalidate any boot still in flight against this state. The map is dropped just below, but a
      // `handleDeviceBoot` awaiting simctl holds its own reference and its seq would still match, so it
      // would go on to build a TouchHelper on a state nobody owns. That used to leak one child process;
      // a self-reviving helper would respawn for the life of the agent with no reference left to stop it.
      // Bumped here rather than inside `cleanupDeviceState` so that all three retirements name a reason —
      // and so Android, whose boot path calls its own cleanup mid-boot, can hold the same shape.
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
      this.connectOnce(this.relayUrl, RECONNECT_LIST_TIMEOUT_MS).then(() => {
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
      const bootedCount = Array.from(this.deviceStates.values()).filter((s) => s.streamReader !== null).length
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
    // Drop this device out of the filter rule. The rule lives on the host and is keyed only by udid,
    // so a simulator that goes away while offline would otherwise keep its udid named there for the
    // rest of the Mac's uptime — and the next boot of that same device would come up offline with
    // nothing on screen saying why.
    void this.network.forget(state.deviceId).catch((e: unknown) => {
      logger.warn('could not clear the network rule for a retired device:', (e as Error).message)
    })
    state.streamReader?.cancel().catch(() => { /* an errored stream rejects cancel(); unhandled, it ends the CLI */ })
    state.streamReader = null
    state.captureStreamer = null // reader.cancel() kills the helper proc; drop the ref so a stale requestKeyframe() no-ops
    this.stopAudioCapture(state)
    state.touchHelper?.stop()
    state.touchHelper = null
    state.booted = false
    state.streamWs?.close()
    state.streamWs = null
  }

  private stopAudioCapture(state: DeviceState): void {
    if (state.audioPoll) { clearInterval(state.audioPoll); state.audioPoll = null }
    state.audioStreamer?.stop() // closes the loopback server → the helper sees EOF and exits
    state.audioStreamer = null
    state.audioPort = 0
    state.audioPids = null
  }

  /** Resolves `false` when a newer boot or a relay loss retired this one during the chrome load, in which case
   *  nothing was stored and the caller abandons the boot. A closed socket alone continues as it always did —
   *  the relay loss that follows bumps the seq. */
  private async sendChromeData(state: DeviceState, device: Device, seq: number): Promise<boolean> {
    // `readyState`, not presence: this runs mid-boot, and a socket that closed since the entry guard
    // takes the payload into a buffer nobody flushes while `device:ready` is dropped by `sendMsg`'s own
    // check — leaving the caller with neither the data nor an answer.
    if (this.ws?.readyState !== WebSocket.OPEN) return true
    // Stop the outgoing helper before dropping the reference. This used to leak a child process;
    // now that a helper revives itself on death, an orphan would also keep respawning with
    // nobody left holding a reference to stop it.
    state.touchHelper?.stop()
    state.touchHelper = this.createInputChannel(device.id)
    state.touchHelper.start()
    this.sendOn(this.ws, {
      type: 'session:deviceInfo',
      sessionId: state.sessionId,
      payload: {
        deviceName: device.name,
        osVersion: device.osVersion ?? '',
      },
    })
    // Awaited where it used to block: a cold load is seconds of swift renders. A newer boot or a shutdown can
    // land meanwhile, so the result is stored only after the seq is checked — otherwise a slow stale load
    // would overwrite the chrome a faster newer boot already set, and the button path reads it.
    // A multi-panel device shows its lit panel's frame; until the panels are known it gets the model's, and
    // `applyLitPanel` replaces it once they are.
    // A multi-panel device's scale comes with its first frame, from its type, so a viewer sizes it once.
    const multiPanel = this.multiPanelDevices.has(device.id) && device.typeId
    const [chrome, basis] = await Promise.all([
      this.chromeLoader.load(device.typeId ?? device.name, this.chromePanel(device.id)),
      multiPanel ? this.typePanels.scaleBasis(multiPanel) : undefined,
    ])
    if (seq !== state.bootSeq) return false
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) return true
    state.loadedChrome = chrome
    state.chromeSettled = true
    if (!chrome) {
      // The model's frame did not load; the lit panel's has its own and may.
      if (this.multiPanelDevices.has(device.id)) void this.resendChrome(device.id)
      return true
    }
    state.sentRotation = this.chromeRotation(device.id)
    state.sentBasis = basis
    this.sendOn(ws, {
      type: 'session:chrome',
      sessionId: state.sessionId,
      payload: this.forViewer(chrome, state.sentRotation, state.sentBasis),
    })
    // A multi-panel device's panels can become known while the load above was running — the helper reads them
    // in parallel with the boot — and the frame just sent may be the model's. Settled here, from whichever
    // side finishes last: `resendChrome` replaces it only if the lit panel's frame differs.
    if (this.multiPanelDevices.has(device.id)) void this.resendChrome(device.id)
    return true
  }

  /** `failures` counts the frameless runs before this one; only the restart in `pump` passes it, so a new
   *  boot starts from zero without any state to reset. */
  private startBinaryStream(state: DeviceState, streamWs: WebSocket, failures = 0): void {
    // H.264 is the default; opt out per-agent with TAPFLOW_IOS_CODEC=jpeg. It also needs
    // a browser that reported it can decode it (device:boot acceptH264) — otherwise JPEG.
    // Only on the ScreenCaptureStreamer path — the MjpegStreamer fallback is always JPEG, and now
    // genuinely produces it rather than only being stamped that way.
    const envAllowsH264 = process.env.TAPFLOW_IOS_CODEC !== 'jpeg'
    const useH264 = this.intervalMs === undefined && envAllowsH264 && state.acceptH264
    const codec = useH264 ? CODEC_H264 : CODEC_JPEG
    let stream: ReadableStream<StreamFrame>
    if (this.intervalMs !== undefined) {
      state.captureStreamer = null
      stream = new MjpegStreamer(this.simctl, state.deviceId, this.intervalMs).start()
    } else {
      const maxSize = pickMaxSize({
        secureContext: state.secureContext,
        external: state.external,
        override: process.env.TAPFLOW_IOS_MAX_SIZE ?? process.env.TAPFLOW_MAX_SIZE,
      })
      // A multi-panel device is captured at its lit panel; a restart re-applies it here, since a stdin switch
      // lives only as long as the helper it was written to.
      const panel = this.multiPanelDevices.has(state.deviceId) ? this.litPanel(state.deviceId) : null
      const capture = new ScreenCaptureStreamer(state.deviceId, this.fps, useH264 ? 'h264' : 'jpeg', maxSize,
        panel ? { width: panel.width, height: panel.height } : null)
      state.captureStreamer = capture
      stream = capture.start()
    }

    const reader = stream.getReader()
    state.streamReader = reader

    const threshold = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) || DEFAULT_BACKPRESSURE_BYTES
    const warnDrop = createRateLimitedDropWarn(logger, state.deviceId)

    // Opt-in JPEG baseline measurement (TAPFLOW_STREAM_METRICS=1): logs throughput
    // every 5s so the iOS JPEG bandwidth/drop baseline can be compared against H.264.
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
    // Keyframe-aware backpressure: drop whole GOPs to the next keyframe (never an orphan P-frame,
    // which decodes to a sheared frame on WASM) and force an IDR on a drop (throttled). JPEG frames
    // are self-contained, so each counts as a keyframe.
    const dropper = createKeyframeAwareSender()
    let lastIdrReq = 0
    const onWantKeyframe = () => { const now = Date.now(); if (now - lastIdrReq >= 500) { lastIdrReq = now; state.captureStreamer?.requestKeyframe() } }

    const pump = async () => {
      let delivered = false
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          delivered = true
          // Declare reorder=0 on the keyframe SPS so every decoder (WebCodecs, MSE,
          // WASM) emits frames immediately instead of buffering the level's max DPB
          // (~8 frames ≈ 250ms). Keyframe-only (SPS lives there); no-op otherwise.
          const payload = codec === CODEC_H264 && value.keyframe
            ? rewriteLowLatencySpsInFrame(value.payload)
            : value.payload
          const frame = writeEnvelopeHeader(payload as Buffer, Date.now(), { codec, keyframe: value.keyframe })
          const sent = dropper.send(streamWs, frame, threshold, codec === CODEC_JPEG || value.keyframe, onDrop, onWantKeyframe)
          if (sent) metrics?.recordSent(value.payload.length)
        }
      } catch {
        // stream cancelled or ws closed — expected on disconnect
      }
      if (metricsTimer) clearInterval(metricsTimer)
      if (state.streamReader === reader && streamWs.readyState === WebSocket.OPEN) {
        const next = streamRestartPlan(failures, delivered)
        if (next.failures === 2) {
          logger.warn(`screen stream for ${state.deviceId} keeps ending before its first frame — backing off restarts`)
        }
        // Re-checked after the delay: a new boot, a shutdown, a relay loss or disconnect() all swap or clear
        // the reader, or close the socket, in the meantime.
        const restart = (): void => {
          if (this._stopping || state.streamReader !== reader || streamWs.readyState !== WebSocket.OPEN) return
          try {
            this.startBinaryStream(state, streamWs, next.failures)
          } catch (e) {
            logger.error(`screen stream for ${state.deviceId} could not restart: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (next.delayMs === 0) restart()
        else setTimeout(restart, next.delayMs).unref()
      }
    }

    void pump()
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
   *  (`cleanupDeviceState`'s callers) and is easy to miss when reading `handleDeviceBoot` alone. Spreading
   *  the reason across three `state.bootSeq++` lines makes forgetting one silent; here it is a parameter. */
  private bumpBootSeq(state: DeviceState, reason: BootAbandonReason): number {
    if (state.bootsInFlight.has(state.bootSeq)) state.bootAbandon.set(state.bootSeq, reason)
    return ++state.bootSeq
  }

  /** Answer a boot this agent has stopped running. Called at every point that abandons one.
   *
   *  **Only when a correlator exists**, which is the same rule the input path settled on (#489): a reply
   *  nobody is waiting for is not an answer, and the dashboard reports every *uncorrelated*
   *  `device:boot-error` as a failure — deliberately, since Android's dead-stream report has no id it could
   *  carry (#426). So sending one for a boot with no correlator would put an error toast on a tester's
   *  screen for a device that is booting normally. */
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
  private async handleDeviceBoot(sessionId: string, deviceId: string, fullErase = false, acceptH264 = false, tier?: { secureContext: boolean; external: boolean }, requestId?: string, automation = false, serviceTier?: ServiceTier, runReset?: RunResetRequest): Promise<void> {
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

    state.acceptH264 = acceptH264
    if (tier) { state.secureContext = tier.secureContext; state.external = tier.external }
    const seq = this.bumpBootSeq(state, 'superseded')
    state.bootsInFlight.add(seq)

    // **The teardown runs inside the try, and that is a fix rather than tidying.** It ran before it, so a
    // throw there rejected this handler into the bare `.catch(logger.error)` at its dispatch site: no
    // `device:booting`, no ready, no error — and the seq was already bumped, so the boot this one
    // superseded was gone as well. The caller then waited out the very deadline this change exists to
    // end. `finally` is what stops `bootAbandon` outliving the boot that would have read it.
    try {
      state.streamReader?.cancel().catch(() => { /* an errored stream rejects cancel(); unhandled, it ends the CLI */ })
      state.streamReader = null
      state.captureStreamer = null // reader.cancel() kills the helper proc; drop the ref so a stale requestKeyframe() no-ops
      // A boot of a device that is already running starts its own capture below. Without stopping the
      // last one here, every re-boot orphaned an audiotap-helper and left its poll running.
      this.stopAudioCapture(state)
      state.touchHelper?.stop()
      state.touchHelper = null
      state.booted = false
      state.streamWs?.close()
      state.streamWs = null

      this.sendOn(ws, { type: 'device:booting', sessionId })
      const devices = await this.simctl.listDevices()
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }

      const target = devices.find((d) => d.id === deviceId)
      if (!target) throw new PlatformError(`Device not found: ${deviceId}`)
      // A running device on another tier than the run asked for is restarted onto it: the services have to be off
      // from launch, and replaying on whatever the last boot left is what the tier exists to stop.
      const retier = !fullErase && target.status === 'booted' && serviceTier !== undefined && leanSupported(target.osVersion)
        && !sameServiceTier(this.leanStore.currentTier(deviceId), serviceTier)
      // Read before anything below changes it: a Full reset shuts the device down itself, and `unknown`
      // (booting, shutting down) is a device paying a boot's cost now.
      const cold = fullErase || retier || target.status !== 'booted'
      // A device this boot brings up gets a new helper and fresh readings. One left from before was serving a
      // simulator that is gone — shut down outside tapflow (DeviceHub quitting takes every one), or about to be
      // — and kept, the boot waited out its respawn cooldown and started from the panel lit before.
      if (cold) this.stopGuest(deviceId)

      if (fullErase) {
        // `simctl erase` only accepts a shut-down device, and a device is often already running —
        // it survives agent restarts and sessions that ended without a clean shutdown. Without this
        // the boot fails outright (#439).
        //
        // Anything that is not `shutdown` gets the shutdown, not just `booted`: `toDeviceStatus`
        // collapses `Booting` / `Shutting Down` / `Creating` into `unknown`, and `erase` refuses
        // every one of them. Re-picking a device while its `device:shutdown` is still draining
        // lands exactly there. `SimctlWrapper.shutdown` already tolerates an off device, so
        // widening the condition costs nothing.
        //
        // This makes an unwanted reset *succeed* rather than fail, so it is only safe alongside the
        // dashboard change that consumes the toggle after one use. The erase failing is what used
        // to stand between a stale toggle and a wiped device.
        // A runner still starting for this device would boot it back up mid-erase (`test-without-building` boots its
        // destination), and one already serving would outlive the simulator it reads.
        this.uiTreeReader.stopIfDevice(deviceId)
        if (target.status !== 'shutdown') await this.simctl.shutdown(deviceId)
        // The shutdown is an await, so a newer boot for this device may have overtaken us while it
        // ran. Without this check the superseded boot goes on to erase a device the tester has
        // since re-picked with the toggle off — the exact wipe-with-no-click this issue is about.
        if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
        try {
          await this.simctl.erase(deviceId)
        } catch (err) {
          // We powered the device off to make the erase possible. If the erase then fails, leaving
          // it off strands the tester with a dead device on top of the error message, so put it
          // back the way we found it and report the original failure.
          //
          // `=== 'booted'`, deliberately narrower than the `!== 'shutdown'` above: that one asks
          // "does this need shutting down", this one asks "did we take it down". `unknown` covers
          // `Shutting Down` (someone else was already stopping it) and `Creating` (never ran) —
          // booting either would not be putting it back.
          //
          // The seq check matters as much: erase takes seconds, and a shutdown arriving mid-flight
          // bumps bootSeq. Recovering then would power a device back up right after the tester
          // asked for it to stop — and the throw below is swallowed by the outer catch on the same
          // seq mismatch, so nothing would say why.
          if (seq === state.bootSeq && target.status === 'booted') {
            await this.simctl.boot(deviceId).catch(() => { /* the original error is what matters */ })
          }
          throw err
        }
        // After the erase, not before: a failed erase boots the device back as it was found, and the tier is part of
        // that. The overrides live on the host, so the erase does not touch them either way.
        this.prepareTier(target, serviceTier)
        await this.simctl.boot(deviceId)
      } else {
        // Unconditionally, including when the list above said `booted`. That reading is already
        // stale by the time we act on it — a tester can ⌘Q the simulator, or run `simctl shutdown`,
        // in the width of one `xcrun` round trip — and skipping the boot on it is the only way to
        // reach the wait below with *nothing bringing the device up*, which then costs the full
        // deadline to discover. `SimctlWrapper.boot` swallows `Unable to boot device in current
        // state: Booted`, so re-issuing it for a device that really is up costs one no-op
        // subprocess and makes "the wait only ever runs after a boot was accepted" true.
        if (retier) {
          logger.info(`Service tier: restarting ${target.name} onto ${serviceTier!.name}`)
          // As for a Full reset: a runner starting for this device would boot it back up mid-change.
          this.uiTreeReader.stopIfDevice(deviceId)
          await this.simctl.shutdown(deviceId)
          if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
          this.prepareTier(target, serviceTier)
        } else if (target.status === 'shutdown') {
          this.prepareTier(target, serviceTier)
        } else if (leanSupported(target.osVersion) && !sameServiceTier(this.leanStore.currentTier(deviceId), this.defaultTier())) {
          logger.info(`Service tier: ${target.name} is already running, so ${this.defaultTier().name} applies from its next boot`)
        }
        await this.bootWithZombieRecovery(deviceId)
      }

      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }

      // `simctl boot` returns on initiation, so everything below used to run while the device was
      // still coming up — measured 7.6s early (#486). The status sent with the chrome data was
      // hardcoded `'booted'` over a value that had just been fetched and discarded, and
      // `device:ready` went out a few lines later. A human is slower than the gap and rarely
      // notices; `mcp-server` installs and taps the moment it sees ready, which is what #440's
      // "No devices are booted" was.
      // `isStale` rather than a check on the far side alone: this handler is fire-and-forget, so a
      // shutdown arriving mid-wait bumps `bootSeq` and leaves the poll spawning `xcrun simctl list`
      // twice a second against a device that is now deliberately off — for the rest of the deadline,
      // with nothing left that wants the answer.
      const bootedDevice = await this.simctl.waitUntilBooted(deviceId, { isStale: () => seq !== state.bootSeq })
      // Before anything runs on the device: the network arm below starts nothing, and the run installs its app after the
      // ready. Clearing an app now and installing it after leaves a clean container.
      const runResetReport = runReset ? await this.resetForRun(deviceId, runReset, () => seq !== state.bootSeq) : undefined
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      // Arm the network injection while nothing is running on the device yet — dyld reads the
      // environment at process start, so anything launched before this is unhooked for its whole life.
      // Best-effort: the network toggle is opt-in and a device that cannot be armed says so through
      // `network:state.available`, which is a better answer than a boot that fails for it.
      await this.network.arm(deviceId).catch((e: unknown) => {
        logger.warn('could not arm the network injection:', (e as Error).message)
      })
      // **Where it is held, before the first frame says so** (#910). The orientation is the device's, shared with
      // DeviceHub and every viewer, so it is read and reported as it is, and a reload or a second viewer joins it
      // there rather than turning it under the first. It is stood up only when there is nothing to report — no
      // reading and nothing remembered — and **for a run**: a flow replays from the same orientation every time,
      // whatever a person left the device in (`runReset` is a run's boot; review finding). Queued with the
      // rotations, so one still in flight lands first. A multi-panel device reads its own through its helper.
      if (!this.multiPanelDevices.has(deviceId)) {
        await this.enqueueRotation(deviceId, async () => {
          if (runReset || !(await this.heldSingle(deviceId))) await this.standUp(deviceId)
        })
      }
      // Another await — a multi-second one — and `sendChromeData` below starts a helper process. A
      // shutdown or a newer boot arriving in this gap would otherwise get a helper installed for the
      // device it is taking down — and one that revives itself, so the stale reference outlives the
      // boot that returns just below.
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      if (!(await this.sendChromeData(state, bootedDevice, seq))) { this.abandonBoot(state, seq, sessionId, requestId); return }
      // **A session with no frame cannot be told the turn**: no `session:chrome` goes out, and its viewer draws
      // the device upright, as one always started. So that device is stood up, the old guarantee for the one
      // viewer that still relies on it (review finding).
      if (!this.multiPanelDevices.has(deviceId) && !state.loadedChrome && this.physical.last(deviceId) !== 'portrait') {
        await this.enqueueRotation(deviceId, async () => { await this.standUp(deviceId) })
      }
      // **A multi-panel device is usable only through its helper**, so the boot is not ready until the helper
      // is, and a runtime that refuses it fails the boot with the reason. The device is shut down only if this
      // boot brought it up: one that was already running (DeviceHub, another session) is left as it was found.
      //
      // No helper at all is a socket that closed before `sendChromeData` built the channel: the boot carries on
      // as a single-panel one does, and the relay loss that follows retires it — not a refusal to shut down for.
      const guest = this.multiPanelDevices.has(deviceId) ? this.guests.get(deviceId) : undefined
      if (guest) {
        let limit: ReturnType<typeof setTimeout> | undefined
        const ready = await Promise.race([
          guest.whenReady(),
          new Promise<boolean>((resolve) => { limit = setTimeout(() => resolve(false), this.helperBootReadyMs) }),
        ]).finally(() => clearTimeout(limit))
        if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
        if (!ready) {
          const reason = guest.unavailableReason() ?? `the input helper was not ready within ${this.helperBootReadyMs / 1000}s`
          this.stopGuest(deviceId)
          if (cold) await this.simctl.shutdown(deviceId).catch(() => { /* reported below either way */ })
          throw new PlatformError(`${bootedDevice.name} cannot be used on this Mac: ${reason}`)
        }
        // A run replays from the same orientation, as a single-panel device's does (the stand-up above); the Duo
        // turns through its helper, so only once the helper is up.
        // Re-described afterwards, as `input:rotate` does: the chrome sent while the helper came up carried the old
        // turn. The panel poll the turn re-arms would correct it too, but up to its interval later.
        // A newer boot can arrive while the turn waits in the queue: it neither turns for a boot already superseded
        // nor goes on to open a stream over the newer one's.
        if (runReset) {
          await this.enqueueRotation(deviceId, async () => {
            if (seq === state.bootSeq) await this.turnHeld(deviceId, undefined, 'portrait', () => seq !== state.bootSeq)
          })
          if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
          this.applyLitPanel(deviceId)
        }
      }

      const streamWs = await this.openStreamWs(state)
      if (seq !== state.bootSeq) {
        streamWs.close()
        this.abandonBoot(state, seq, sessionId, requestId)
        return
      }

      this.startBinaryStream(state, streamWs)
      // Opt-in audio output: stand up the loopback server and start the whole-sim tap now. Best-effort
      // — never blocks/affects the video path.
      if (this.audioEnabled()) this.startAudioCapture(state, streamWs, deviceId)
      state.booted = true
      // **"Driving", not "transitioned from off to on".** A tester who picks a simulator that was
      // already running is choosing the device tapflow should act on, and `simctl boot` is issued on
      // every path precisely so that case reaches here. Requiring an off→on transition would leave
      // that device unowned and put the resolvers back to refusing between two live simulators.
      this.ownedDevices.add(deviceId)
      this.sendMsg({ type: 'device:ready', sessionId, requestId, payload: { deviceId, cold, serviceTier: this.reportedTier(target), ...(runResetReport ? { runReset: runResetReport } : {}) } })
      // The unsolicited report the protocol names on `device:ready`. It follows the ready rather than
      // riding inside it: a tester whose device just came up can arm the toggle in the same breath, and
      // a boot that armed nothing still has to say so rather than leaving the control blank.
      void this.reportNetworkState(sessionId)
      if (this.multiPanelDevices.has(deviceId)) void this.sendPostures(state)
      // An automation client's first selector step would otherwise spend the runner's cold start inside its timeout.
      if (automation) this.uiTreeReader.warm(deviceId)

      // Sync AppleKeyboards after ready — fire-and-forget so streaming isn't delayed.
      // hw=Automatic lets the hardware layout follow the active input source on LANG1/CapsLock.
      // By the time the user navigates to a text field the sync has already completed.
      this.simctl.syncKeyboardsFromLanguages(deviceId).catch((e) => {
        logger.error('syncKeyboardsFromLanguages failed:', e)
      })

    } catch (e) {
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      // `firstLine`, not `e.message`: this reaches a toast, and node's first line is
      // `Command failed: xcrun simctl boot <UDID>`, which says nothing and echoes the udid. That
      // matters more now that the boot is issued unconditionally — a device caught mid `Shutting
      // Down` refuses the boot, and refusing is correct (swallowing it would put us back to waiting
      // on a device nobody is bringing up), so the refusal is what the tester reads.
      this.sendMsg({ type: 'device:boot-error', sessionId, requestId, message: firstLine(e) })
    } finally {
      state.bootsInFlight.delete(seq)
      // Its own key, in the one case nothing reads it: a newer boot arriving after this boot's last
      // checkpoint but before it returns.
      state.bootAbandon.delete(seq)
    }
  }

  // Boot a device, auto-recovering from a vanished data dir. simctl lists the device
  // as available but `boot` fails; erase regenerates the data and we retry once. Guarded
  // by isDeviceMissingError so an unrelated boot failure never erases a healthy device.
  private async bootWithZombieRecovery(deviceId: string): Promise<void> {
    try {
      await this.simctl.boot(deviceId)
    } catch (e) {
      if (!isDeviceMissingError(e)) throw e
      logger.warn(`iOS device ${deviceId} data missing on disk — erasing to recover, retrying boot once`)
      await this.simctl.erase(deviceId)
      await this.simctl.boot(deviceId)
    }
  }

  // ── Lean mode ──────────────────────────────────────────────────────────────

  /** The tier a boot gets when it does not ask for one: Lean mode's setting. A person's boot is always this. */
  private defaultTier(): ServiceTier {
    return { name: this.lean ? 'lean' : 'stock', keep: [] }
  }

  /** What the device boots with now, for the relay: the marker's tier, or `unsupported` on a runtime that cannot take one. */
  private reportedTier(device: Device): ServiceTier | 'unsupported' {
    return leanSupported(device.osVersion) ? this.leanStore.currentTier(device.id) : 'unsupported'
  }

  /**
   * Called only when the device is known to be shut down: `launchd_sim` reads the store when it
   * starts, and a write while it runs is not known to survive. So a device that was already up when
   * asked for is booted as it is, and takes the default tier from its next boot through tapflow —
   * unless a run asked for a tier, which restarts it (`retier` in `handleDeviceBoot`).
   *
   * **Every boot sets an exact tier**, the asked-for one or the default. Adding to whatever the last boot left
   * is how a device a run left slim reached a person still slim (L2 review R4-S1).
   *
   * **A failure here never stops the boot.** A tier is an optimisation and booting is the job.
   */
  private prepareTier(device: Device, requested: ServiceTier | undefined): void {
    const tier = requested ?? this.defaultTier()
    try {
      if (!leanSupported(device.osVersion)) {
        if (tier.name !== 'stock') logger.info(`Service tier: ${tier.name} not applied to ${device.name} (${device.osVersion ?? 'unknown runtime'}) — iOS 18.5 or later only`)
        return
      }
      this.leanStore.setTier(device.id, tier, labelsFor(tier))
    } catch (e) {
      logger.warn(`Service tier: could not set ${device.name} to ${tier.name}, booting it as it is:`, (e as Error).message)
    }
  }

  /** Put back what Lean mode disabled on a device that is now shut down. A no-op for devices it never touched. */
  private revertLean(deviceId: string): void {
    try {
      this.leanStore.revert(deviceId)
    } catch (e) {
      logger.warn(`Lean mode: could not restore ${deviceId}:`, (e as Error).message)
    }
  }

  /**
   * A device left lean by a run that ended without shutting it down — a crash, a lost relay, a
   * tester quitting the simulator — is put back here if it is off, whatever `lean` says now: if Lean
   * mode is on, the next boot through tapflow applies it again. One still running is left alone,
   * and a udid that no longer exists (the host directory outlives `simctl delete`) is not ours to count.
   */
  private revertLeftoverLean(devices: Device[]): void {
    let marked: string[]
    try { marked = this.leanStore.applied() } catch { return }
    if (marked.length === 0) return
    const off = new Set(devices.filter((d) => d.status === 'shutdown').map((d) => d.id))
    for (const udid of marked) if (off.has(udid)) this.revertLean(udid)
  }

  private async handleDeviceShutdown(sessionId: string, deviceId: string, requestId?: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state) {
      // Answered only when someone asked: nothing was attempted, and the idle timer's id-less shutdown has no
      // waiter to tell. A failure below is answered either way — `requestId` is optional on `device:shutdown`,
      // so an id-less sender that is waiting can only learn of the failure this way (protocol/AGENTS.md,
      // 「The sender must hold the session」).
      if (requestId) this.sendMsg({ type: 'device:shutdown-error', sessionId, requestId, message: SHUTDOWN_NO_SESSION_STATE })
      return
    }

    this.bumpBootSeq(state, 'shut-down')
    // **Said here as well as in `cleanupDeviceState`, because this path does not go through it.**
    // The teardown below is a copy of that method's, and the copy is older than the network rule —
    // so a device shut down from the dashboard while offline kept its udid in the host filter for
    // the rest of the Mac's uptime, and its next boot came up with traffic dead and nothing on
    // screen saying why. The two bodies have already diverged in another respect (this one does not
    // stop the audio tap), which is why this is a call rather than a merge: unifying them changes
    // audio teardown on a path nobody asked about.
    void this.network.forget(deviceId).catch((e: unknown) => {
      logger.warn('could not clear the network rule for a shut-down device:', (e as Error).message)
    })
    state.streamReader?.cancel().catch(() => { /* an errored stream rejects cancel(); unhandled, it ends the CLI */ })
    state.streamReader = null
    state.captureStreamer = null // reader.cancel() kills the helper proc; drop the ref so a stale requestKeyframe() no-ops
    state.touchHelper?.stop()
    state.touchHelper = null
    this.stopGuest(deviceId)
    state.booted = false
    state.streamWs?.close()
    state.streamWs = null
    this.lastBundleIds.delete(deviceId)
    // Each device has its own tree runner; stop this one's, never another device's.
    this.uiTreeReader.stopIfDevice(deviceId)

    try {
      await this.simctl.shutdown(deviceId)
      this.revertLean(deviceId)
      // **After the shutdown lands, not with the teardown above.** Everything before this point is
      // the session's state, which is correct to drop the moment a shutdown is asked for. Ownership
      // is about the *device*, and a shutdown that throws leaves it running — forgetting it was ours
      // there would hand an ambiguous choice back to the resolvers for a simulator tapflow is still
      // driving. `cleanupDeviceState` deliberately does not clear it at all: that path is a relay
      // disconnect, where the device outlives the session and ownership is the thing worth keeping.
      this.ownedDevices.delete(deviceId)
      this.sendMsg({
        type: 'device:shutdown-done',
        sessionId,
        requestId,
        payload: { deviceId },
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger.error('shutdown failed:', message)
      // "Already shut down" never reaches here — `SimctlWrapper.shutdown` absorbs it — so this is a device
      // that is still running, with its stream already torn down above. Said, because silence left the
      // caller waiting out its deadline (#455).
      this.sendMsg({
        type: 'device:shutdown-error',
        sessionId,
        requestId,
        message: `The simulator did not shut down, and its stream has been stopped: ${message}`,
      })
    }
  }

  /**
   * What `flow run` asks reset before a run, carried out on a booted device. Only the agent's report says it happened.
   * It waits for the system services first: `Booted` shows before tccd and securityd serve, and not only on a boot this
   * agent started — a device someone else just booted reads `booted` too. On a settled device the wait returns at once.
   * The wait does not watch `isStale`; a shutdown meanwhile holds this boot's abandonment until its deadline.
   */
  private async resetForRun(deviceId: string, request: RunResetRequest, isStale: () => boolean): Promise<RunResetReport> {
    // One budget for the wait and the steps: a device whose services never come up spends it waiting, and the steps
    // that would have failed against it are reported failed instead of each running out its own timeout.
    const deadline = Date.now() + RUN_RESET_BUDGET_MS
    const stop = () => isStale() || Date.now() >= deadline
    await this.simctl.waitForBootStatus(deviceId).catch((e: unknown) => logger.warn(`run reset: boot status unknown: ${firstLine(e)}`))
    const steps: RunResetStep[] = []
    if (request.uninstall.length > 0) {
      steps.push({ item: 'app-uninstall', run: () => resetApps(request.uninstall, (id) => this.simctl.uninstallAppForReset(deviceId, id), stop) })
    }
    if (request.clear.length > 0) {
      steps.push({ item: 'app-files', run: () => resetApps(request.clear, (id) => this.simctl.clearAppDataIfInstalled(deviceId, id), stop) })
    }
    steps.push(
      { item: 'keychain', run: () => this.simctl.resetKeychain(deviceId) },
      { item: 'privacy-services', run: () => this.simctl.resetPrivacy(deviceId) },
      // Through the clipboard queue: a clipboard read in flight parks a sentinel on this pasteboard.
      { item: 'pasteboard', run: () => this.clearPasteboardQueued(deviceId, stop) },
      { item: 'location', run: () => this.simctl.clearLocation(deviceId) },
    )
    return runResetSteps(steps, isStale, (item, e) => logger.warn(`run reset: ${item} failed: ${firstLine(e)}`), deadline)
  }

  /**
   * The pasteboard step of a run reset. The queue can be held by a clipboard operation already running, so the wait for
   * it is bounded too; a clear that reaches the front after the step gave up does nothing, because by then the run may
   * have put something of its own there.
   */
  private clearPasteboardQueued(deviceId: string, stop: () => boolean): Promise<void> {
    let abandoned = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const queued = this.clipboardQueue(deviceId, async () => {
      if (abandoned || stop()) throw new PlatformError('the clipboard was busy for the whole reset')
      await this.simctl.setPasteboard(deviceId, '')
    })
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abandoned = true; reject(new PlatformError('pasteboard clear timed out')) }, RUN_RESET_PASTEBOARD_TIMEOUT_MS)
    })
    queued.catch(() => {})
    return Promise.race([queued, late]).finally(() => clearTimeout(timer))
  }

  // Lazily set up the touch channel: a reconnect re-issues the session with touchHelper=null while the sim stays booted, so input self-heals without a fresh device:boot. Sync so a tap's start+end stay paired (async would drop touchEnd → stuck finger).
  private ensureTouchHelper(state: DeviceState): void {
    if (state.touchHelper) return
    state.touchHelper = this.createInputChannel(state.deviceId)
    state.touchHelper.start()
  }

  /**
   * **The one place a device's input path is chosen** (see `InputChannel`). A device with more than one
   * integrated panel gets `FoldableInput` over its in-simulator helper; every other device gets the Indigo
   * `TouchHelper` it always had. A multi-panel device is never given a `TouchHelper`: its writes would
   * answer success and land on a dark panel or nowhere.
   */
  private createInputChannel(deviceId: string): InputChannel {
    if (!this.multiPanelDevices.has(deviceId)) return new TouchHelper(deviceId)
    this.ensureGuest(deviceId)
    return new FoldableInput({
      guest: () => this.guests.get(deviceId) ?? null,
      litScreen: () => this.litScreen(deviceId),
    })
  }

  private ensureGuest(deviceId: string): void {
    if (this.guests.has(deviceId)) return
    const guest = new GuestHelper(
      deviceId,
      async () => {
        const screens = await this.simctl.integratedScreens(deviceId)
        this.guestScreens.set(deviceId, new Map(screens.map((s) => [s.screenId, s])))
        const typeId = this.deviceTypeIds.get(deviceId)
        if (typeId) await this.typePanels.load(typeId)
        return screens.map((s) => s.uuid)
      },
      this.guestHelperNative,
      {
        onUnavailable: (reason) => {
          logger.error(`input for ${deviceId} is unavailable: ${reason}`)
          // Hide the fold control everywhere, and in the relay's replay cache: a control left up would do nothing.
          for (const state of this.deviceStates.values()) if (state.deviceId === deviceId) void this.sendPostures(state)
        },
        // Back after an outage (the respawn window cleared): show it again, from the device's real posture.
        onAvailable: () => {
          for (const state of this.deviceStates.values()) if (state.deviceId === deviceId) void this.sendPostures(state)
        },
      },
    )
    this.guests.set(deviceId, guest)
    void guest.start()
    this.startPanelPoll(deviceId)
    // Which panel is lit decides where every touch goes and which panel is captured; until a reading arrives
    // the channel says `starting`. The panels are known once the helper has read them (`whenReady`), and a
    // stream that started before that captured the largest panel — dark while folded — so it is corrected here.
    // The way it is held is read alongside, so the first frame a viewer gets after the helper is up is
    // already turned rather than corrected a poll later.
    void this.panelState.read(deviceId)
    void this.physical.read(deviceId)
    void guest.whenReady()
      .then((ready) => (ready ? Promise.all([this.panelState.read(deviceId), this.physical.read(deviceId)]) : null))
      .then(() => this.applyLitPanel(deviceId))
  }

  /** The lit panel of a multi-panel device, from the last devicectl reading and this boot's panels. */
  private litPanel(deviceId: string): IntegratedScreen | null {
    const lit = this.panelState.last(deviceId)?.lit
    return lit ? this.guestScreens.get(deviceId)?.get(lit.displayId) ?? null : null
  }

  /**
   * How far the viewer turns a multi-panel device (`ChromeData.streamRotation`): the way it is held, plus the
   * lit panel's own native turn — the Duo's unfolded panel is drawn turned 270, so a device held upright
   * shows it turned 90 (measured: portrait → rot90 … landscapeLeft → rot0). Undefined for a single-panel
   * device, and until both the orientation and the lit panel have been read.
   */
  private chromeRotation(deviceId: string): ChromeData['streamRotation'] {
    if (!this.multiPanelDevices.has(deviceId)) {
      const single = this.physical.last(deviceId)
      return single ? ORIENTATION_DEGREES[single] : undefined
    }
    const held = this.physical.last(deviceId)
    const panel = this.litPanel(deviceId)
    if (!held || !panel) return undefined
    const typeId = this.deviceTypeIds.get(deviceId)
    const native = typeId ? this.typePanels.nativeOrientation(typeId, panel.deviceName) : 0
    return ((ORIENTATION_DEGREES[held] + 360 - native) % 360) as Rotation
  }

  /** The cached frame with this send's turn and scale — never written into the loader's shared object. */
  private forViewer(chrome: ChromeData, streamRotation: ChromeData['streamRotation'], scaleBasis?: number): ChromeData {
    if (streamRotation === undefined && scaleBasis === undefined) return chrome
    return {
      ...chrome,
      ...(streamRotation === undefined ? {} : { streamRotation }),
      ...(scaleBasis === undefined ? {} : { scaleBasis }),
    }
  }

  /** The lit panel's frame for `DeviceChromeLoader`, or undefined for a single-panel device or an unknown panel. */
  private chromePanel(deviceId: string): ChromePanel | undefined {
    if (!this.multiPanelDevices.has(deviceId)) return undefined
    const panel = this.litPanel(deviceId)
    return panel ? panelFrame(panel) : undefined
  }

  /** Point every stream of this device at its lit panel, and give its viewers that panel's frame. */
  private applyLitPanel(deviceId: string): void {
    const panel = this.litPanel(deviceId)
    if (!panel) return
    for (const state of this.deviceStates.values()) {
      if (state.deviceId === deviceId) state.captureStreamer?.selectPanel({ width: panel.width, height: panel.height })
    }
    void this.resendChrome(deviceId)
  }

  /**
   * Load the lit panel's frame and send it as `session:chrome` to every session on this device whose frame
   * it is not already. `session:chrome` is re-sendable by contract (protocol `InputPosture`), and the relay
   * caches the last one for a re-joining viewer.
   */
  private async resendChrome(deviceId: string): Promise<void> {
    const typeId = this.deviceTypeIds.get(deviceId)
    const panel = this.chromePanel(deviceId)
    if (!typeId || !panel) return
    const [chrome, basis] = await Promise.all([this.chromeLoader.load(typeId, panel), this.typePanels.scaleBasis(typeId)])
    const ws = this.ws
    if (!chrome || ws?.readyState !== WebSocket.OPEN) return
    for (const state of this.deviceStates.values()) {
      // Only a session whose boot has finished loading its first frame: one still loading gets the lit panel's
      // frame from the tail of `sendChromeData`, and sending it here first would be overwritten by the model's.
      const rotation = this.chromeRotation(deviceId)
      if (state.deviceId !== deviceId || !state.chromeSettled) continue
      if (state.loadedChrome === chrome && state.sentRotation === rotation && state.sentBasis === basis) continue
      state.loadedChrome = chrome
      state.sentRotation = rotation
      state.sentBasis = basis
      this.sendOn(ws, { type: 'session:chrome', sessionId: state.sessionId, payload: this.forViewer(chrome, rotation, basis) })
    }
  }

  /** The display UUID of the panel a multi-panel device is showing, or null if not known yet. */
  private litScreen(deviceId: string): string | null {
    return this.litPanel(deviceId)?.uuid ?? null
  }

  /**
   * Follow a fold made outside tapflow (DeviceHub's picker) while a session is on the device: read the lit
   * panel, re-point the capture and the frame, and report the posture if it moved. Skipped while tapflow's own
   * fold is in flight, which reports for itself.
   */
  private startPanelPoll(deviceId: string): void {
    if (this.panelPolls.has(deviceId)) return
    this.panelActivity.set(deviceId, Date.now())
    this.schedulePanelPoll(deviceId)
  }

  private schedulePanelPoll(deviceId: string): void {
    const quiet = Date.now() - (this.panelActivity.get(deviceId) ?? 0) >= this.panelQuietMs
    const timer = setTimeout(() => {
      this.followPanel(deviceId)
      // Stopped while it ran (`stopGuest`) is stopped for good.
      if (this.panelPolls.get(deviceId) === timer) this.schedulePanelPoll(deviceId)
    }, quiet ? this.panelIdlePollMs : this.panelPollMs)
    timer.unref?.()
    this.panelPolls.set(deviceId, timer)
  }

  /** The device's panel or orientation is moving, or about to: the poll goes back to its fast rate now, not
   *  after the slow wait already scheduled. */
  private panelMoved(deviceId: string): void {
    if (!this.panelPolls.has(deviceId)) return
    this.panelActivity.set(deviceId, Date.now())
    clearTimeout(this.panelPolls.get(deviceId))
    this.schedulePanelPoll(deviceId)
  }

  private followPanel(deviceId: string): void {
    if (this.posturing.has(deviceId) || this.guests.get(deviceId)?.inputState() !== 'ready') return
    if (![...this.deviceStates.values()].some((s) => s.deviceId === deviceId && s.booted)) return
    const pose = () => `${this.panelState.last(deviceId)?.lit?.displayId}:${this.physical.last(deviceId)}`
    const before = pose()
    void Promise.all([this.panelState.read(deviceId), this.physical.read(deviceId)]).then(() => {
      if (pose() !== before) this.panelMoved(deviceId)
      // The panel it has settled on, not the one just read: one lit only for a moment is not followed.
      const settled = this.panelState.last(deviceId)
      if (!settled?.lit || this.posturing.has(deviceId)) return
      // A new panel is read again once it has had time to hold, rather than at the next poll or two.
      if (this.panelState.changing(deviceId) && !this.panelRechecks.has(deviceId)) {
        const recheck = setTimeout(() => { this.panelRechecks.delete(deviceId); this.followPanel(deviceId) }, this.panelState.holdMs)
        recheck.unref?.()
        this.panelRechecks.set(deviceId, recheck)
      }
      this.applyLitPanel(deviceId)
      const posture = this.postureOf(deviceId, settled)
      if (posture !== this.reportedPosture.get(deviceId)) {
        for (const state of this.deviceStates.values()) if (state.deviceId === deviceId) void this.sendPostures(state)
      }
    })
  }

  /** The device's teardown: shut down, erased, or the agent leaving. Not a relay reconnect — see `guests`. */
  private stopGuest(deviceId: string): void {
    clearTimeout(this.panelPolls.get(deviceId))
    this.panelPolls.delete(deviceId)
    this.panelActivity.delete(deviceId)
    clearTimeout(this.panelRechecks.get(deviceId))
    this.panelRechecks.delete(deviceId)
    this.reportedPosture.delete(deviceId)
    this.guests.get(deviceId)?.stop()
    this.guests.delete(deviceId)
    this.guestScreens.delete(deviceId)
    this.panelState.forget(deviceId)
    this.physical.forget(deviceId)
  }

  // ── PosturableAgent ────────────────────────────────────────────────────────
  // A multi-panel device (iPhone Duo) folds through its in-simulator helper's hinge, and which panel is lit
  // is read back from devicectl — never inferred from the angle sent.

  async listPostures(deviceId: string): Promise<DevicePosture[]> {
    // The list's length is the capability's real gate: a device that cannot fold, or whose helper is not up
    // to fold it, answers none, and the viewer shows no control.
    return this.multiPanelDevices.has(deviceId) && this.guests.get(deviceId)?.inputState() === 'ready' ? FOLDABLE_POSTURES : []
  }

  async getPosture(deviceId: string): Promise<DevicePosture | null> {
    if ((await this.listPostures(deviceId)).length === 0) return null
    const reading = (await this.panelState.read(deviceId)) ?? this.panelState.last(deviceId)
    const id = reading ? this.postureOf(deviceId, reading) : null
    return FOLDABLE_POSTURES.find((p) => p.id === id) ?? null
  }

  async setPosture(deviceId: string, postureId: string): Promise<void> {
    if (!(await this.listPostures(deviceId)).some((p) => p.id === postureId)) {
      throw new PlatformError(`Unknown posture "${postureId}" for ${deviceId}`)
    }
    const guest = this.guests.get(deviceId)!
    this.panelMoved(deviceId)
    const target = [...(this.guestScreens.get(deviceId)?.values() ?? [])]
      .find((s) => s.deviceName === (postureId === 'closed' ? 'primary' : 'primary-1'))
    if (!target) throw new PlatformError(`${deviceId} has no ${postureId === 'closed' ? 'cover' : 'unfolded'} panel`)
    const from = POSTURE_DEGREES[(await this.getPosture(deviceId))?.id ?? (postureId === 'closed' ? 'open' : 'closed')]
    // **The panel is the answer, not the helper's.** The sweep ending is not the panel changing — measured, the
    // new panel lights 4–6 s after the command — and on a loaded Mac the helper's answer came after the panel
    // had lit. So both are watched at once, and a lit panel is success however late the answer.
    const swept = guest.hinge(from, POSTURE_DEGREES[postureId], 800)
    const settled = await this.panelState.awaitLit(deviceId, (r) => r.lit?.displayId === target.screenId, this.foldSettleMs)
    if (!settled) {
      if (!(await swept)) throw new PlatformError('the hinge did not move')
      throw new PlatformError(`the ${postureId === 'closed' ? 'cover' : 'unfolded panel'} did not light within ${this.foldSettleMs}ms`)
    }
    // Nothing is turned: a fold does not change the way the device is held (measured), so only the frame and
    // the lit panel's native turn change — which is what DeviceHub shows.
    this.applyLitPanel(deviceId)
  }

  /**
   * Turn a multi-panel device the way it is held, through the helper (Purple and `devicectl orientation set`
   * do nothing on the Duo — measured). From the orientation read back now, never one remembered: a quarter
   * turn `direction`, or an older viewer's `target` — where either landscape meets landscape, so asking for
   * it never flips one into the other, and portrait means upright. Then waits for devicectl to say so, which
   * is what the re-sent chrome reports; a turn that does not land is logged and the chrome says where the
   * device really is.
   */
  private async turnHeld(deviceId: string, direction?: 'clockwise' | 'counterclockwise', target?: 'portrait' | 'landscape', isStale?: () => boolean): Promise<void> {
    const guest = this.guests.get(deviceId)
    this.panelMoved(deviceId)
    const held = (await this.physical.read(deviceId)) ?? this.physical.last(deviceId)
    // The read takes a moment, and a caller whose boot was superseded in it must not turn the shared device.
    if (isStale?.()) return
    if (!guest || !held) { logger.warn(`rotate ${deviceId}: ${guest ? 'its orientation could not be read' : 'no helper'}, not turning`); return }
    const landscape = held === 'landscapeLeft' || held === 'landscapeRight'
    const want: DeviceOrientation | null = direction ? turned(held, direction)
      : target === 'portrait' ? (held === 'portrait' ? null : 'portrait')
      : target === 'landscape' ? (landscape ? null : 'landscapeRight')
      : (landscape ? 'portrait' : 'landscapeRight')
    if (!want) return
    if (!(await guest.orient(ORIENT_LABELS[want]))) { logger.warn(`rotate ${deviceId}: the helper did not take ${want}`); return }
    if (!(await this.physical.await(deviceId, (o) => o === want, ROTATE_SETTLE_MS))) {
      logger.warn(`rotate ${deviceId}: asked for ${want}, still ${this.physical.last(deviceId) ?? 'unread'} after ${ROTATE_SETTLE_MS}ms`)
    }
  }

  /**
   * Where a single-panel device is held: read (devicectl on Xcode 27, the guest helper before — see
   * `defaultPhysicalOrientationNative`), else the last known — the last reading, or what tapflow last set on a
   * host where neither source answers. Read every time, never marked unreadable: one failure right after a
   * boot would otherwise have left the device on memory for the life of the agent (review finding).
   */
  private async heldSingle(deviceId: string): Promise<DeviceOrientation | null> {
    return (await this.physical.read(deviceId)) ?? this.physical.last(deviceId)
  }

  /** Turn a device nobody can say the orientation of upright, so there is one to turn from. */
  private async standUp(deviceId: string): Promise<DeviceOrientation> {
    await this.simctl.rotate(deviceId, PURPLE_ARGS.portrait)
    this.physical.note(deviceId, 'portrait')
    return 'portrait'
  }

  /**
   * Turn a single-panel device, through Purple: a quarter turn `direction` from where it is held, or an older
   * viewer's `target`. **That viewer draws landscape as 270**, so `landscape` means exactly `landscapeLeft` —
   * the other landscape would show it upside down — and is met only there; `portrait` means upright. A device
   * whose orientation cannot be read or remembered (an agent restarted under it) is stood up first.
   */
  private async turnSingle(deviceId: string, direction?: 'clockwise' | 'counterclockwise', target?: 'portrait' | 'landscape'): Promise<void> {
    const held = (await this.heldSingle(deviceId)) ?? (await this.standUp(deviceId))
    const want: DeviceOrientation | null = direction ? turned(held, direction)
      : target === 'portrait' ? (held === 'portrait' ? null : 'portrait')
      : target === 'landscape' ? (held === 'landscapeLeft' ? null : 'landscapeLeft')
      : (held === 'portrait' ? 'landscapeLeft' : 'portrait')
    if (!want) return
    await this.simctl.rotate(deviceId, PURPLE_ARGS[want])
    // Read back once; a host that cannot read at all remembers what it set instead of waiting out the settle.
    const back = await this.physical.read(deviceId)
    if (!back) { this.physical.note(deviceId, want); return }
    if (back !== want && !(await this.physical.await(deviceId, (o) => o === want, ROTATE_SETTLE_MS))) {
      logger.warn(`rotate ${deviceId}: asked for ${want}, still ${this.physical.last(deviceId) ?? 'unread'} after ${ROTATE_SETTLE_MS}ms`)
    }
  }

  /** Re-send the frame each session on this device already has, with the turn it is held at now. */
  private resendTurn(deviceId: string): void {
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) return
    const rotation = this.chromeRotation(deviceId)
    for (const state of this.deviceStates.values()) {
      // Not to a session whose boot is still running: its frame is the last boot's, and that boot sends its own.
      if (state.deviceId !== deviceId || !state.loadedChrome || state.bootsInFlight.size > 0 || state.sentRotation === rotation) continue
      state.sentRotation = rotation
      this.sendOn(ws, { type: 'session:chrome', sessionId: state.sessionId, payload: this.forViewer(state.loadedChrome, rotation, state.sentBasis) })
    }
  }

  /** `closed` while the cover is lit, `open` while the unfolded panel is. */
  private postureOf(deviceId: string, reading: PanelReading): string | null {
    const lit = reading.lit && this.guestScreens.get(deviceId)?.get(reading.lit.displayId)
    if (!lit) return null
    return lit.deviceName === 'primary' ? 'closed' : 'open'
  }

  /** Tell the viewer which postures exist and which one the device is in — read from the device, so a fold
   *  made outside tapflow shows too. Sent at boot, after a change (failed or not), and on the helper dying. */
  private async sendPostures(state: DeviceState): Promise<void> {
    const [postures, current] = await Promise.all([this.listPostures(state.deviceId), this.getPosture(state.deviceId)])
    this.reportedPosture.set(state.deviceId, current?.id ?? null)
    this.sendMsg({ type: 'device:postures', sessionId: state.sessionId, payload: { postures, currentId: current?.id ?? null } })
  }

  // Clipboard work parks a sentinel on the device while it waits, so two operations on the same
  // device must not interleave — each would read the other's marker instead of the real
  // clipboard. Keyed by device, not session: several sessions (and MCP) can address one device.
  private readonly clipboardQueue = createKeyedSerialQueue()
  // Device-scoped, not operation-scoped. Several sessions (and MCP) can address one simulator,
  // so an operation that fails before parking anything may still be answering while ANOTHER
  // holds a marker down. The viewer decides from this whether pressing the plain chord is safe,
  // and that chord travels as `input:key` — outside this queue — so the answer has to describe
  // the device rather than the caller.
  private readonly parkedSentinels = new Map<string, number>()

  private markSentinel(deviceId: string, delta: 1 | -1): void {
    const n = (this.parkedSentinels.get(deviceId) ?? 0) + delta
    if (n > 0) this.parkedSentinels.set(deviceId, n)
    else this.parkedSentinels.delete(deviceId)
  }

  private sentinelParked(deviceId: string): boolean {
    return (this.parkedSentinels.get(deviceId) ?? 0) > 0
  }

  // A terminal input naming a session this agent holds no state for. Reachable in a way that is
  // genuinely disputed: `sessionRebind.test.ts` records that a restarted agent is re-seeded from
  // `agent:registered`, so `!state` should never fire — but `registeredSessions` carries one entry
  // per *device* (`RelayServer.ts`, `byDeviceId`), and the relay's own comment there notes that one
  // device can now sit behind two sessions, which leaves the second unseeded. Answering costs four
  // lines; staying silent costs a terminal input swallowed and the caller's own fallback reporting
  // success. Android already answers, and `channel-unavailable` is what it maps this to.
  /** The correlator on an input an ack answers, or `null` if the frame cannot be attributed.
   *
   *  A local capture rather than a guard at the top of the dispatcher, and that is the point: a guard there
   *  would not narrow `msg.requestId` inside the case, so the shortest way to satisfy the reply's required
   *  field would be `msg.requestId!` — the assertion removed from `open-url` and then from clipboard. This
   *  hands back a `string` the case can close over.
   *
   *  It is unvalidated JSON, so the check is real work rather than ceremony: the declaration is required and
   *  every in-repo sender is typed against it, and #444 made the relay refuse an empty one — but this agent may
   *  be talking to a relay older than that, and `mcp-server`'s tool
   *  schemas are bare `z.string()` so a model can produce `''`. */
  private correlatorOf(msg: { type: string; requestId?: string }): string | null {
    if (typeof msg.requestId === 'string' && msg.requestId !== '') return msg.requestId
    logger.warn(`${msg.type} without a usable requestId — dropped, its ack could not be attributed`)
    return null
  }

  private ackNoSession(sessionId: string, requestId: string): void {
    // The `if (!sessionId) return` this used to open with is gone: the dispatcher now declares
    // `sessionId: string`, so there is no undefined to guard against and the guard would have been a
    // silent drop with nothing left that could reach it.
    this.sendMsg({
      type: 'input:error', sessionId, requestId,
      message: INPUT_ERROR_MESSAGES['channel-unavailable'],
      reason: 'channel-unavailable' satisfies InputErrorReason,
    })
  }

  /**
   * Why a write was refused. The helper's boolean says only "no".
   *
   * `kind` matters because the two questions were decided at different times. Readiness is about now;
   * a continuation frame's fate was decided when the gesture opened. A gesture whose opening frame
   * was refused inside the start-up window owns nothing, so its terminal frame can never land no
   * matter how ready the helper has since become — and reading readiness first answered `malformed`
   * ("never retry") for precisely the case `channel-starting` exists to serve. Ownership is therefore
   * checked first for continuations, which is also the right answer when the helper died mid-gesture
   * and its replacement is still starting: waiting would not help either.
   *
   * Safe to read at the ack site rather than inside the write, because iOS writes are synchronous —
   * but only for the question readiness answers. That is why ownership is asked separately.
   */
  private refusalReason(helper: InputChannel | null, kind: 'continuation' | 'standalone'): InputErrorReason {
    const state = helper?.inputState() ?? 'unavailable'
    // No channel at all dominates: the caller must reconnect, and telling it to re-open a gesture
    // would send it round a loop that cannot succeed.
    if (state === 'unavailable') return 'channel-unavailable'
    // Then ownership, and only for a continuation. A gesture whose opening frame never landed owns
    // nothing, so its terminal frame can never be delivered however ready the helper has become —
    // which is why readiness must not be consulted first here.
    //
    // A consequence worth stating: `channel-starting` is unreachable for a continuation. Owning a
    // gesture requires an opening frame to have landed, which requires the helper to have been ready,
    // so a continuation is never refused *merely* because the channel is still coming up. Standalone
    // inputs — a key, a button — are the ones that get that answer.
    if (kind === 'continuation' && !helper?.ownsGesture()) return 'no-gesture'
    return state === 'starting' ? 'channel-starting' : 'no-gesture'
  }

  // Ack a terminal input. `input:done` = dispatched to a booted device (not a landing guarantee —
  // HID is fire-and-forget). Otherwise `input:error` carries a machine-readable `reason` so a caller
  // can tell "retry in a moment" from "reconnect" from "never retry"; `message` stays human prose.
  // Off the sync inject path, so start/end pairing is unaffected.
  //
  // `requestId` is a parameter, never read from shared state: a gesture is dozens of frames and two can
  // overlap, so a correlator hoisted out of per-request scope would answer one input with another's id —
  // which is #499 rebuilt inside the agent. Same reason `seq` is passed in on the Android side.
  private async ackInput(state: DeviceState, outcome: 'delivered' | InputErrorReason, requestId: string): Promise<void> {
    const reason: InputErrorReason | null = outcome !== 'delivered'
      ? outcome
      : (state.booted || (await this.isBooted(state.deviceId))) ? null : 'not-booted'
    if (reason === null) state.booted = true // cache the post-reconnect verify so later inputs skip simctl
    this.sendMsg(
      reason === null
        ? { type: 'input:done', sessionId: state.sessionId, requestId }
        : { type: 'input:error', sessionId: state.sessionId, requestId, message: INPUT_ERROR_MESSAGES[reason], reason })
  }

  private async isBooted(deviceId: string): Promise<boolean> {
    try {
      const devices = await this.simctl.listDevices()
      return devices.find((d) => d.id === deviceId)?.status === 'booted'
    } catch { return false }
  }

  /** Run `step` after every rotation already queued for this device. A failing step is logged and does
   *  not stop the ones behind it. */
  private enqueueRotation(deviceId: string, step: () => Promise<void>): Promise<void> {
    const next = (this.rotations.get(deviceId) ?? Promise.resolve())
      .then(step)
      .catch((e: unknown) => { logger.error('rotate failed:', e) })
    this.rotations.set(deviceId, next)
    void next.then(() => { if (this.rotations.get(deviceId) === next) this.rotations.delete(deviceId) })
    return next
  }

  private handleRelayMessage(msg: { type: string; sessionId: string; requestId?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'device:boot': {
        // `external` and `automation` are added by the relay, never by the browser (see `DeviceBoot`).
        const { deviceId, resetMode, acceptH264, secureContext, external, automation, serviceTier, runReset } = msg.payload as { deviceId: string; resetMode?: string; acceptH264?: boolean; secureContext?: boolean; external?: boolean; automation?: boolean; serviceTier?: ServiceTier; runReset?: RunResetRequest }
        const sessionId = msg.sessionId
        this.handleDeviceBoot(sessionId, deviceId, resetMode === 'full-erase', acceptH264 === true, { secureContext: !!secureContext, external: !!external }, msg.requestId, automation === true, serviceTier, runReset)
          .catch((e) => logger.error('handleDeviceBoot failed:', e))
        break
      }
      case 'device:shutdown': {
        const { deviceId } = msg.payload as { deviceId: string }
        const sessionId = msg.sessionId
        this.handleDeviceShutdown(sessionId, deviceId, msg.requestId)
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
        // `...body` first: with the ids last, a body *variable* carrying one would override the real
        // correlator, because excess-property checking does not fire on variables. See `open-url`.
        const respond = (body: AppInstallReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const installState = this.deviceStates.get(sessionId!)
        if (!installState) {
          respond({ type: 'app:install-error', message: 'No booted device' })
          break
        }
        this.installBuild(installState.deviceId, filePath, bundleId, { buildTicket, buildName, buildBytes })
          .then(() => respond({ type: 'app:install-done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'app:install-error', message })
          })
        break
      }
      case 'app:launch': {
        const { bundleId, arguments: args, env } = msg.payload as AppLaunchToAgent['payload']
        const sessionId = msg.sessionId
        const { requestId } = msg
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] app:launch without a requestId — dropped, cannot correlate a reply')
          break
        }
        // `...body` first: with the ids last, a body *variable* carrying one would override the real
        // correlator, because excess-property checking does not fire on variables. See `open-url`.
        const respond = (body: AppLaunchReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const launchState = this.deviceStates.get(sessionId!)
        if (!launchState) {
          respond({ type: 'app:launch-error', message: 'No booted device' })
          break
        }
        // Checked again here rather than trusted: the relay checks with the same function, but an agent is the last
        // door before a command line, and a relay of another version may check less.
        const problem = launchOptionsProblem({ arguments: args, env })
        if (problem) {
          respond({ type: 'app:launch-error', message: problem })
          break
        }
        const options = compactLaunchOptions({ arguments: args, env })
        // The target is named BEFORE the launch, and the order is the whole point: dyld reads the
        // environment when the process starts, so naming it afterwards arms the next launch and leaves
        // this one unhooked while `available` would still say true.
        this.network.target(launchState.deviceId, bundleId)
          .catch((e: unknown) => logger.warn('could not name the network target:', (e as Error).message))
          .then(() => this.simctl.launchApp(launchState.deviceId, bundleId, options))
          .then((pid) => {
            // **After the launch, with the pid it returned.** The network control measures how long a
            // started process has gone without reporting its hooks; opening that window before
            // `simctl launch` had run put the launch itself inside the budget, and left it open when
            // the launch failed. A null or unchanged pid means no new process, so nothing is owed.
            this.network.markLaunched(launchState.deviceId, pid)
            // Track the foreground app so ui:tree:request can query it via XCUITest.
            this.lastBundleIds.set(launchState.deviceId, bundleId)
            // Audio: the whole-sim tap's poll picks up the launched app process within one interval;
            // no per-launch helper needed.
            respond(options ? { type: 'app:launch-done', applied: appliedKeys(options) } : { type: 'app:launch-done' })
          })
          .catch((e: unknown) => {
            // The toast gets the reason alone; the full simctl output stays in this log.
            console.warn('[tapflow] app:launch failed:', e)
            respond({ type: 'app:launch-error', message: launchFailureReason(e) })
          })
        break
      }
      case 'input:touch:start': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        this.ensureTouchHelper(state)
        const { x, y } = msg.payload as { x: number; y: number }
        state.touchHelper?.touchStart(x, y)
        break
      }
      case 'input:touch:move': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state?.touchHelper) break
        const { x, y } = msg.payload as { x: number; y: number }
        state.touchHelper.touchMove(x, y)
        break
      }
      case 'input:touch:end': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        // The helper's answer, not its existence: a helper whose process has died reports every
        // write as dropped, and that is what the caller needs to hear (#482).
        const helper = state.touchHelper
        // terminal of a tap/swipe → ack the gesture, once the up is written (it may wait for the
        // touch's minimum contact). The refusal is read then too, from the helper the state holds *then*:
        // one replaced during the wait (a chrome reload, a reboot) is up and owns nothing, which is
        // `no-gesture`, where the stopped one it replaced would say the channel is gone.
        void (helper ? helper.touchEndAfterMinContact() : Promise.resolve(false))
          .then((sent) => this.ackInput(state, sent ? 'delivered' : this.refusalReason(state.touchHelper, 'continuation'), requestId))
        break
      }
      case 'input:pinch:start': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        this.ensureTouchHelper(state)
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        state.touchHelper?.pinchStart(f0.x, f0.y, f1.x, f1.y)
        break
      }
      case 'input:pinch:move': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state?.touchHelper) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        state.touchHelper.pinchMove(f0.x, f0.y, f1.x, f1.y)
        break
      }
      case 'input:pinch:end': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        const pinchHelper = state.touchHelper
        void this.ackInput(state, pinchHelper?.pinchEnd() ? 'delivered' : this.refusalReason(pinchHelper, 'continuation'), requestId)
        break
      }
      case 'input:rotate': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        // **A target when the viewer sends one, a toggle when it does not** (#910) — an older
        // dashboard's. The memory is read when the step runs, not when it was queued, and written only
        // once the simulator took it: a step queued behind another toggles from what that one applied.
        const sessionId = msg.sessionId
        const payload = msg.payload as { orientation?: 'portrait' | 'landscape'; direction?: 'clockwise' | 'counterclockwise' } | undefined
        const target = payload?.orientation
        void this.enqueueRotation(state.deviceId, async () => {
          const live = this.deviceStates.get(sessionId) ?? state
          if (this.multiPanelDevices.has(live.deviceId)) {
            await this.turnHeld(live.deviceId, payload?.direction, target)
            this.applyLitPanel(live.deviceId)
            return
          }
          await this.turnSingle(live.deviceId, payload?.direction, target)
          this.resendTurn(live.deviceId)
        })
        break
      }
      case 'input:posture': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const { postureId } = msg.payload as { postureId: string }
        // No ack by declaration (like `input:rotate`): a fold that fails is reported by the posture list that
        // follows saying where the device really is. One at a time per device, like Android's.
        if (this.posturing.has(state.deviceId)) {
          logger.info(`posture ${postureId}: a change is already in flight, ignoring`)
          break
        }
        this.posturing.add(state.deviceId)
        void this.setPosture(state.deviceId, postureId)
          .catch((e: unknown) => logger.warn(`setPosture(${postureId}): ${(e as Error).message}`))
          .then(() => this.sendPostures(state))
          .finally(() => this.posturing.delete(state.deviceId))
        break
      }
      case 'stream:request-idr': {
        // Relay drop-to-keyframe recovery: force an IDR so the stream resyncs fast.
        this.deviceStates.get(msg.sessionId)?.captureStreamer?.requestKeyframe()
        break
      }
      case 'input:keyboard:toggle': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const showing = !state.softKeyboardVisible
        const op = showing
          ? this.simctl.showSoftwareKeyboard(state.deviceId)
          : this.simctl.hideSoftwareKeyboard(state.deviceId)
        op.then(() => {
          state.softKeyboardVisible = showing
          this.sendMsg({
            type: 'keyboard:toggled',
            sessionId: state.sessionId,
            payload: { visible: showing },
          })
        }).catch((e: unknown) => {
          logger.error('keyboard toggle failed:', e)
        })
        break
      }
      case 'input:type': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        if (state) this.ensureTouchHelper(state)
        const { text } = (msg.payload ?? {}) as { text?: string }
        if (!state?.touchHelper) {
          this.sendMsg({ type: 'input:type-error', sessionId, requestId, message: 'No booted device' })
          break
        }
        // simctl pbcopy → Cmd+V paste. Works for arbitrary Unicode (unlike a
        // per-character HID path, which is limited to keys on the layout) and
        // needs a focused text field, same as real typing. Cmd+V goes through
        // the same HID keyboard path as input:key, so hide the software
        // keyboard first when it's up — otherwise iOS desyncs the hardware
        // keyboard context and the chord is dropped (same guard as input:key).
        const doType = async (): Promise<void> => {
          if (!text) return
          await this.simctl.setPasteboard(state.deviceId, text)
          if (state.softKeyboardVisible) {
            state.softKeyboardVisible = false
            await this.simctl.hideSoftwareKeyboard(state.deviceId).catch(() => {})
          }
          // Throwing routes into the input:type-error below. Without it a dropped chord still
          // answers input:type-done: the text sits on the device pasteboard, nothing was pasted
          // into the app, and the caller moves on. Unlike the copy path in clipboard:read there
          // is no pasteboard deadline here to fail loudly in its place.
          if (!state.touchHelper?.sendKey(KEY_CODE_MAP['KeyV'], MODIFIER_BITS['MetaLeft'])) {
            throw new PlatformError('Cannot paste the text — no input channel to the device')
          }
        }
        // Ack on completion so a following input step (e.g. pressKey Enter) is
        // only sent after the paste has actually landed.
        // Shares the clipboard queue: this writes the pasteboard, so running it alongside a
        // clipboard:read would overwrite that read's sentinel and be returned as "copied".
        this.clipboardQueue(state.deviceId, doType)
          .then(() => this.sendMsg({ type: 'input:type-done', sessionId, requestId }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            logger.error('input:type (pbcopy+paste) failed:', e)
            this.sendMsg({ type: 'input:type-error', sessionId, requestId, message })
          })
        break
      }
      case 'input:key': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        this.ensureTouchHelper(state)
        const { code, modifiers } = msg.payload as { code: string; modifiers?: number }
        const usage = KEY_CODE_MAP[code]
        if (usage === undefined) {
          // Prose preserved (it names the code), reason added: `unsupported` tells a caller never to
          // retry, which the message alone could not.
          this.sendMsg({
            type: 'input:error', sessionId: msg.sessionId, requestId,
            message: `unknown key code: ${code}`, reason: 'unsupported' satisfies InputErrorReason,
          })
          break
        }
        if (state.softKeyboardVisible) {
          // Hide the SW keyboard first so iOS re-initialises the HW keyboard
          // context. Skipping this causes input-source desync (qks / ㅂㅏㄴ symptoms).
          state.softKeyboardVisible = false
          // The ack belongs after the deferred chord, not beside it. Acking out here ran before
          // the key was ever written, so the answer could only be a guess — and the guess was
          // "delivered". The hide failing is not fatal (the key still goes out), so the catch
          // resolves and the send happens exactly once either way.
          void this.simctl.hideSoftwareKeyboard(state.deviceId)
            .catch((e: unknown) => { logger.error('hideSoftwareKeyboard (on key) failed:', e) })
            .then(() => {
              const h = state.touchHelper
              return this.ackInput(state, h?.sendKey(usage, modifiers ?? 0) ? 'delivered' : this.refusalReason(h, 'standalone'), requestId)
            })
        } else {
          const h = state.touchHelper
          void this.ackInput(state, h?.sendKey(usage, modifiers ?? 0) ? 'delivered' : this.refusalReason(h, 'standalone'), requestId)
        }
        break
      }
      case 'input:button': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        this.ensureTouchHelper(state)
        const { name, phase } = msg.payload as { name: string; phase?: 'down' | 'up' }
        // Map the cross-platform button vocabulary (used by MCP) onto this
        // device's actual chrome button names. Dashboard already sends the raw
        // chrome names (e.g. "volume-up"), which pass through unchanged.
        const chromeName = IOS_BUTTON_ALIASES[name] ?? name
        // Two branches below deliberately write nothing — a home press-down, and a button this
        // device's chrome has no HID mapping for. Neither is a dropped input, so they answer
        // with the channel's health instead of a write result; reporting an error there would
        // trade this issue's false success for a false failure.
        const btnHelper = state.touchHelper
        const wrote = (ok: boolean): 'delivered' | InputErrorReason =>
          ok ? 'delivered' : this.refusalReason(btnHelper, 'standalone')
        // The two branches that write nothing answer from the channel's state, which is `delivered`
        // when it is ready. A button this device's chrome lacks stays a *success* — the device
        // genuinely has no such button, so an error would be a false failure (#484). That is a
        // decision, and it is why iOS never sends `unsupported` for a button while Android does.
        let outcome: 'delivered' | InputErrorReason = btnHelper?.inputState() === 'ready'
          ? 'delivered'
          : this.refusalReason(btnHelper, 'standalone')
        if (chromeName === 'home') {
          // Home has no HID down/up split — always a single legacy press. Send once on release
          // (or on a phase-less legacy message) so a down+up pair doesn't fire it twice.
          if (phase !== 'down') outcome = wrote(btnHelper?.pressLegacyButton(0) ?? false)
        } else {
          const btn = state.loadedChrome?.buttons.find((b) => b.name === chromeName)
          if (btn && btn.usagePage > 0 && btn.usage > 0) {
            if (phase === 'down') outcome = wrote(btnHelper?.pressButtonDown(btn.usagePage, btn.usage) ?? false)
            else if (phase === 'up') outcome = wrote(btnHelper?.pressButtonUp(btn.usagePage, btn.usage) ?? false)
            else outcome = wrote(btnHelper?.pressButton(btn.usagePage, btn.usage) ?? false)
          }
        }
        void this.ackInput(state, outcome, requestId)
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
        // Every exit merges the correlation ids here. What that buys, precisely — review measured 13
        // attacks and the type caught 3:
        //
        //  - **Omitting the correlator is a compile error.** That comes from `requestId: string` being
        //    required on `OpenUrlDone`/`OpenUrlError`, reached through `sendMsg`'s `AgentControlOutbound`
        //    — not from `OpenUrlReplyBody`, whose one contribution is rejecting a fresh id written as a
        //    literal at the `respond(...)` call.
        //  - **`...body` goes first on purpose.** With the ids last, a body *variable* carrying a
        //    `requestId` cannot override them — excess-property checking does not fire on variables, so
        //    the earlier `{ sessionId, requestId, ...body }` let a wrong id win.
        //
        // What it does **not** buy: `sendMsg` accepts any `string` here, so a site that bypasses
        // `respond` type-checks. The echo tests in both agents' suites are what catch that, and each
        // remaining correlation pair needs its own — this helper does not remove that work.
        const respond = (body: OpenUrlReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        if (!state) {
          respond({ type: 'open-url:error', message: 'no booted device' })
          break
        }
        this.simctl.openUrl(state.deviceId, url)
          .then(() => respond({ type: 'open-url:done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'open-url:error', message })
          })
        break
      }
      case 'screenshot:request': {
        const raw = msg as unknown as { requestId: string; format?: 'png' | 'jpeg'; sessionId?: string }
        const { requestId, format } = raw
        const sessionId = msg.sessionId
        const shotState = this.deviceStates.get(sessionId!)
        if (!shotState) {
          this.sendMsg({ type: 'screenshot:error', sessionId, requestId, message: 'No booted device' })
          break
        }
        // Note for anyone widening this signature again: before the udid parameter existed this
        // read `screenshot(format ?? 'png')`, and adding a leading `udid: string` did NOT make it a
        // type error — the format string simply became the device id. The compiler cannot help
        // here; the test that scans exec arguments is what does.
        this.simctl.screenshot(shotState.deviceId, format ?? 'png')
          .then((buf) => this.sendMsg({
            type: 'screenshot:done',
            sessionId,
            requestId,
            format: format ?? 'png',
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
        if (!state || !bundleId) {
          respond({ type: 'app:clear-state-error', message: !state ? 'No booted device' : 'bundleId missing' })
          break
        }
        this.simctl.clearAppData(state.deviceId, bundleId)
          .then(() => respond({ type: 'app:clear-state-done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'app:clear-state-error', message })
          })
        break
      }
      // Clipboard bridge. The chord is pressed HERE rather than by the viewer: the browser
      // cannot know when the key actually lands (a visible software keyboard makes this path
      // await hideSoftwareKeyboard first), and reading too early returns the PREVIOUS
      // pasteboard — a stale value the user would never notice.
      case 'network:set': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        // `?? {}` and a re-check of a field the relay's schema already requires: this case owes a
        // reply, and a cast that dereferences a missing payload throws into a dispatch that swallows
        // it — answering nothing at all, the one failure a requester cannot tell from a hung device.
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
      // The relay asks on a viewer's re-join (#614). Uncorrelated both ways: the reply is a report and
      // nothing is waiting on it, so a session with no booted device answers nothing at all.
      case 'network:request-state':
        void this.reportNetworkState(msg.sessionId)
        break
      case 'clipboard:read': {
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
        if (!state) {
          this.sendMsg({
            type: 'clipboard:error', sessionId, requestId, message: 'No booted device',
            payload: { sentinelParked: false } satisfies ClipboardErrorPayload,
          })
          break
        }
        const { press } = (msg.payload ?? {}) as { press?: 'copy' | 'cut' }
        // Answering is separate from cleaning up. The restore below runs in a `finally`, which
        // executes AFTER this — so the viewer hears back as soon as the outcome is known and
        // does not wait out the restore window. The queue is still held until the restore
        // finishes, which is what actually matters: the next operation must not see a sentinel.
        const respond = (body: ClipboardReplyBody) =>
          this.sendMsg({ sessionId, requestId, ...body })
        const read = async (): Promise<void> => {
          if (!press) {
            respond({ type: 'clipboard:data', payload: { text: await this.simctl.getPasteboard(state.deviceId) } })
            return
          }

          this.ensureTouchHelper(state)
          if (!state.touchHelper) throw new PlatformError('Cannot press copy — no input channel to the device')
          if (state.softKeyboardVisible) {
            state.softKeyboardVisible = false
            await this.simctl.hideSoftwareKeyboard(state.deviceId).catch(() => {})
          }

          // Overwrite the pasteboard with a value only we could have written, then press the
          // chord and wait for it to change. Without this there is no way to tell "the app
          // copied" from "the app has not copied yet" — a fixed delay guesses, and guessing
          // wrong hands the PREVIOUS clipboard to the user with no error. The sentinel also
          // covers re-copying the identical text, where a plain value-change watch never fires.
          // Read the original first. If we cannot (a hung simctl, or a pasteboard past
          // maxBuffer), do NOT continue: parking a sentinel we are unable to undo would
          // destroy whatever the user had on the device clipboard.
          const raw = await this.simctl.getPasteboard(state.deviceId)
          // Never restore someone else's marker as if it were the user's text.
          const before = isSentinel(raw) ? '' : raw
          const sentinel = `${SENTINEL_PREFIX}${randomUUID()}`
          let copied: string | null = null
          // Counted before the call: setPasteboard can reject after the device took the value,
          // so anything from here until the restore has to be treated as parked.
          this.markSentinel(state.deviceId, 1)
          try {
            // Inside the try: if this rejects *after* the device applied it, the restore below
            // still runs. Outside, a leaked sentinel would sit on the device permanently.
            await this.simctl.setPasteboard(state.deviceId, sentinel)
            // `pbcopy` exiting means the write was accepted, not that the pasteboard shows it
            // yet. Pressing before it does lets the first poll read the PRE-sentinel value,
            // decide it is not a sentinel, and return it as "what the app copied" — the exact
            // staleness this whole mechanism exists to prevent. Mirrors the Android read path.
            const applied = Date.now() + CLIPBOARD_WRITE_DEADLINE_MS
            while ((await this.simctl.getPasteboard(state.deviceId)) !== sentinel) {
              if (Date.now() >= applied) throw new PlatformError('The device clipboard did not respond')
              await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
            }
            state.touchHelper.sendKey(KEY_CODE_MAP[press === 'cut' ? 'KeyX' : 'KeyC'], MODIFIER_BITS['MetaLeft'])
            const deadline = Date.now() + CLIPBOARD_COPY_DEADLINE_MS
            do {
              let now: string
              try {
                now = await this.simctl.getPasteboard(state.deviceId)
              } catch (e) {
                // ONLY the size ceiling means the app copied — we just cannot carry it — so the
                // restore below must be skipped or it would overwrite the very text the user
                // copied. Every other failure here (a hung or timed-out pbpaste) says nothing
                // about the device, and skipping the restore for those left the sentinel parked
                // for good: the user's clipboard destroyed, and a zero-width marker pasted into
                // the app under test. Android reaches the same two states, by assigning `copied`
                // before it throws for the over-sized case and not otherwise.
                if (e instanceof ClipboardTooLargeError) copied = ''
                throw e
              }
              // A sentinel is never a copy result — ours means "not yet", any other means a
              // concurrent operation slipped in and its marker must not be handed to the user.
              if (!isSentinel(now)) {
                copied = now
                respond({ type: 'clipboard:data', payload: { text: now } })
                return
              }
              await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
            } while (Date.now() < deadline)
            throw new PlatformError('The device did not copy anything — is something selected?')
          } catch (e: unknown) {
            // Reply here rather than letting this propagate: a rejection would surface only
            // after `finally` had finished restoring, putting that window inside the round trip.
            respond({
              type: 'clipboard:error', message: e instanceof Error ? e.message : String(e),
              // A sentinel may be on the device: setPasteboard can reject after the device took
              // it. The viewer must not press the chord — the restore would overwrite the copy.
              payload: { sentinelParked: this.sentinelParked(state.deviceId) } satisfies ClipboardErrorPayload,
            })
          } finally {
            // Only restore when the copy never happened; otherwise this would overwrite the
            // value we just captured. A leaked sentinel would be worse than the original bug.
            // Wait for the restore to be visible, not merely accepted: releasing the queue early
            // lets the next operation read the sentinel as "the original", which then becomes ''
            // and wipes the user's device clipboard. Mirrors the Android read path.
            if (copied === null) {
              await this.simctl.setPasteboard(state.deviceId, before).catch(() => {})
              const restored = Date.now() + CLIPBOARD_RESTORE_DEADLINE_MS
              while ((await this.simctl.getPasteboard(state.deviceId).catch(() => before)) !== before) {
                if (Date.now() >= restored) break   // best effort; the error is already going out
                await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
              }
            }
            this.markSentinel(state.deviceId, -1)
          }
        }
        // `read` answers for itself once the sentinel is in play. This catches only what can
        // throw BEFORE that — the press-less branch, a missing input channel, and the failed
        // read of the original — so nothing is parked and the viewer's chord fallback is safe.
        this.clipboardQueue(state.deviceId, read).catch((e: unknown) => {
          respond({
            type: 'clipboard:error', message: e instanceof Error ? e.message : String(e),
            payload: { sentinelParked: this.sentinelParked(state.deviceId) } satisfies ClipboardErrorPayload,
          })
        })
        break
      }
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
        if (!state) {
          this.sendMsg({
            type: 'clipboard:error', sessionId, requestId, message: 'No booted device',
            payload: { sentinelParked: false } satisfies ClipboardErrorPayload,
          })
          break
        }
        const { text, pasteAfter } = (msg.payload ?? {}) as { text?: string; pasteAfter?: boolean }
        if (clipboardByteLength(text ?? '') > MAX_CLIPBOARD_BYTES) {
          this.sendMsg({
            type: 'clipboard:error', sessionId, requestId,
            message: `Clipboard is too large (max ${Math.floor(MAX_CLIPBOARD_BYTES / 1024)} KB)`,
            payload: { sentinelParked: this.sentinelParked(state.deviceId) } satisfies ClipboardErrorPayload,
          })
          break
        }
        const write = async (): Promise<void> => {
          const wanted = text ?? ''
          await this.simctl.setPasteboard(state.deviceId, wanted)
          if (!pasteAfter) return
          this.ensureTouchHelper(state)
          if (!state.touchHelper) throw new PlatformError('Cannot press paste — no input channel to the device')
          // Confirm the pasteboard really holds it before pressing paste; otherwise the device
          // could paste whatever was there before. (On Android the same call is documented as
          // asynchronous, so this is not iOS paranoia — it is the same failure on both sides.)
          const deadline = Date.now() + CLIPBOARD_WRITE_DEADLINE_MS
          while ((await this.simctl.getPasteboard(state.deviceId).catch(() => null)) !== wanted) {
            if (Date.now() >= deadline) throw new PlatformError('The device clipboard did not accept the text')
            await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
          }
          // Same guard as input:key — skipping it desyncs the hardware keyboard context.
          if (state.softKeyboardVisible) {
            state.softKeyboardVisible = false
            await this.simctl.hideSoftwareKeyboard(state.deviceId).catch(() => {})
          }
          // Same reason as input:type: the deadline above proves the pasteboard took the text,
          // not that the chord reached the device, so a dead channel here would answer
          // clipboard:write-done having pasted nothing.
          if (!state.touchHelper?.sendKey(KEY_CODE_MAP['KeyV'], MODIFIER_BITS['MetaLeft'])) {
            throw new PlatformError('Cannot press paste — no input channel to the device')
          }
        }
        // Ack only once the write (and the paste, when asked for) actually landed.
        this.clipboardQueue(state.deviceId, write)
          .then(() => this.sendMsg({ type: 'clipboard:write-done', sessionId, requestId }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.sendMsg({
              type: 'clipboard:error', sessionId, requestId, message,
              payload: { sentinelParked: this.sentinelParked(state.deviceId) } satisfies ClipboardErrorPayload,
            })
          })
        break
      }
      case 'ui:tree:request': {
        const raw = msg as unknown as { requestId: string; sessionId?: string }
        const { requestId } = raw
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        if (!state) {
          this.sendMsg({ type: 'ui:tree:error', sessionId, requestId, message: 'No booted device' })
          break
        }
        this.readUITree(state)
          .then((elements) => this.sendMsg({ type: 'ui:tree:response', sessionId, requestId, elements }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.sendMsg({ type: 'ui:tree:error', sessionId, requestId, message })
          })
        break
      }
    }
  }

  // The XCUITest backend queries a specific app by bundleId (the last one launched
  // via app:launch), reading its tree from inside the simulator — no Simulator.app
  // window required.
  private async readUITree(state: DeviceState): Promise<UIElement[]> {
    const bundleId = this.lastBundleIds.get(state.deviceId)
    if (!bundleId) {
      throw new PlatformError('no app launched — launch an app before querying the UI tree')
    }
    return this.uiTreeReader.read(state.deviceId, bundleId)
  }

  /**
   * .app.zip / .tar.gz(.tgz) 이면 임시 디렉토리에 풀어 .app 경로로 설치, 그 외(.apk 등)는
   * 직접 설치. tar 추출은 실행 비트·심볼릭 링크를 보존하고(재압축이 아니라 네이티브 보관),
   * macOS tar(libarchive)가 path traversal·symlink 탈출을 기본 차단한다. 완료 후 임시 정리.
   */
  private async installBuild(
    udid: string,
    filePath: string,
    bundleId?: string,
    remote?: { buildTicket?: string; buildName?: string; buildBytes?: number },
  ): Promise<void> {
    const tmpDir = path.join(tmpdir(), `tapflow-install-${randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    try {
      // **The relay's `filePath` is only usable when we share its filesystem**, which is false for a
      // relay in a container or on another host — and that is exactly what it looks like when it
      // fails: `unzip` answers `cannot find or open`, which this used to report as a bad archive.
      // A ticket means the relay can hand us the bytes instead, so take that whenever it is offered
      // and fall back only for a relay that predates it.
      //
      // The download keeps the upload's filename, because **the extension decides the branch
      // below** — a random temp name would send a zip straight to `simctl` unopened.
      let source = filePath
      if (remote?.buildTicket && this.relayUrl) {
        source = path.join(tmpDir, path.basename(remote.buildName ?? path.basename(filePath)))
        await downloadBuild({
          relayUrl: this.relayUrl,
          ticket: remote.buildTicket,
          destPath: source,
          expectedBytes: remote.buildBytes ?? 0,
        })
      }
      // **The uninstall waits until there is a build to put back.** It used to run first, which was
      // survivable while the only thing between it and the install was a local extract — this change
      // put a *network transfer* in that gap. An expired ticket, a dropped link, a timeout or a
      // short transfer would then leave the simulator with the old app gone and no new one: a tester
      // loses the build they were using, to an install that never had a chance of finishing.
      if (bundleId) {
        await this.simctl.uninstallApp(udid, bundleId).catch(() => { /* 미설치 상태면 무시 */ })
      }
      return await this.installFrom(udid, source, tmpDir)
    } finally {
      // Async for the same reason as the extraction: a large .app is a lot of files to unlink.
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    }
  }

  /** Extraction + `simctl install`, given a file this machine can actually open. */
  private async installFrom(udid: string, filePath: string, tmpDir: string): Promise<void> {
    const lower = filePath.toLowerCase()
    const isTar = lower.endsWith('.tar.gz') || lower.endsWith('.tgz')
    const isZip = lower.endsWith('.zip')
    if (!isTar && !isZip) {
      return this.simctl.installApp(udid, filePath)
    }

    // A subdirectory of the caller's, which owns the cleanup: a downloaded archive already sits in
    // `tmpDir`, and extracting beside it would put the two in one listing.
    const outDir = path.join(tmpDir, 'x')
    fs.mkdirSync(outDir, { recursive: true })
    // **Not `spawnSync`.** It held the event loop for as long as the extraction ran, which on a large build
    // or a busy Mac was long enough for the relay's heartbeat to end this agent's connection — and every
    // other session on the Mac froze with it.
    const result = isTar
      ? await runExtractor('tar', ['-xzf', filePath, '-C', outDir])
      : await runExtractor('unzip', ['-q', '-o', filePath, '-d', outDir])
    // 실행 자체 실패(tar/unzip 부재=ENOENT 등)는 아카이브 무효와 구분한다.
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code ?? result.error.message
      throw new Error(`아카이브 추출 실행 실패 (${isTar ? 'tar' : 'unzip'}: ${code})`)
    }
    if (result.status !== 0) {
      // **The tool's own words go in the message.** This used to name a likely cause and throw the
      // evidence away, so a build that was fine read as corrupt — `unzip` had said
      // `cannot find or open`, which names a missing file rather than a bad archive, and nobody
      // could see it. Trimmed because the whole thing reaches a browser toast.
      const detail = result.stderr.trim().split('\n')[0]?.slice(0, 300)
      throw new ValidationError(
        (isTar
          ? 'tar.gz 압축 해제 실패 — 시뮬레이터용 .tar.gz(경로 탈출/심볼릭 링크 없는)인지 확인하세요.'
          : 'zip 압축 해제 실패 — 시뮬레이터용 .app.zip 파일인지 확인하세요.')
        + (detail ? ` (${isTar ? 'tar' : 'unzip'}: ${detail})` : ''),
      )
    }

    const entries = fs.readdirSync(outDir)
    const appDir = entries.find(e => e.endsWith('.app') && fs.statSync(path.join(outDir, e)).isDirectory())
    if (!appDir) {
      throw new ValidationError('.app 디렉토리를 찾을 수 없습니다. iphonesimulator 로 빌드한 .app 을 .app.zip 또는 .tar.gz 로 업로드하세요.')
    }

    await this.simctl.installApp(udid, path.join(outDir, appDir))
  }

  // DeviceAgent interface — delegate to SimctlWrapper
  listDevices(): Promise<Device[]> { return this.simctl.listDevices() }
  boot(deviceId: string): Promise<void> { return this.simctl.boot(deviceId) }
  shutdown(deviceId: string): Promise<void> { return this.simctl.shutdown(deviceId) }
  /** The `DeviceAgent` interface has no device parameter — it predates multi-session agents and is
   *  shared with Android, so widening it would be a breaking change for every implementation and
   *  caller. `AndroidAgent` resolves the single live session internally instead
   *  (`AndroidAgent.ts:1429`); these do the same. Throwing beats falling back to simctl's `booted`
   *  alias, which would quietly act on whichever simulator happened to be up. */
  async installApp(appPath: string): Promise<void> {
    await this.simctl.installApp(await this.soleLiveDeviceId(), appPath)
  }
  // ── network control (#607) ─────────────────────────────────────────────────
  //
  // iOS has no airplane mode to ask for, so "offline" is three mechanisms applied together — see
  // `SimulatorNetwork`, which owns the ordering. What lives here is the wire: which device a request
  // means, and what the session is told afterwards.

  /** The device a session is driving, or undefined when nothing is booted. */
  /**
   * The session's device, **only while it is up**.
   *
   * `deviceStates` holds one entry per *registered* simulator, not per running one, so this used to
   * answer for a device that was shut down — or never booted. The network path is where that costs
   * something: a toggle after a shutdown writes the kernel rule for a dead udid, and `arm()` is the
   * only thing that clears it, which now happens on the *next* boot of that device. Until then the
   * host is dropping flows for nothing, and a simulator that reuses the udid comes up offline.
   *
   * **`booted` alone is not the check, and reading it as one is a regression this shipped once.**
   * The flag is a cache, not the truth: `initDeviceStates` runs on `agent:registered`, which is every
   * *reconnect* and not only the first connection, so it is `false` for a simulator that has been up
   * the whole time. Gated on the flag alone, a relay restart left the toggle answering
   * `No booted device` for a running device and left `network:request-state` — the message a viewer's
   * re-join sends, which exists precisely for this moment — silently unanswered, so the control never
   * left `waiting`.
   *
   * So it falls back to asking simctl and caches the answer, which is what `ackInput` already does
   * with the same flag and for the same reason. That is also why this is async.
   */
  private async deviceFor(sessionId: string): Promise<string | undefined> {
    const state = this.deviceStates.get(sessionId)
    if (!state) return undefined
    if (state.booted) return state.deviceId
    if (!(await this.isBooted(state.deviceId))) return undefined
    state.booted = true
    return state.deviceId
  }

  /**
   * Send the current state to a session.
   *
   * Uncorrelated on purpose: this answers `device:ready` and a viewer's re-join, neither of which is a
   * request anyone is waiting on. Silent with no device, for the same reason `network:error` would be
   * addressed to nobody.
   */
  private async reportNetworkState(sessionId: string): Promise<void> {
    const deviceId = await this.deviceFor(sessionId)
    if (!deviceId) return
    this.sendMsg({ type: 'network:state', sessionId, payload: this.network.state(deviceId) })
  }

  /**
   * A device that was offline stopped being enforced — tell whoever is watching it.
   *
   * **Uncorrelated, and it has to be**: nobody asked. `network:error` is the wrong carrier for the
   * same reason — that type is *"a `network:set` that could not be dispatched"*, and this is not a
   * request failing. `network:state` already supports an unsolicited frame; the viewer re-join path
   * has been sending one since #614.
   *
   * **Every session holding the device, not one.** A device can sit behind two sessions, and the one
   * that happened to make the last request is not necessarily the one whose tester is looking at it.
   *
   * Synchronous on purpose: `deviceFor` asks simctl before believing a device is up, and this runs
   * from a timer while something has just gone wrong with that device. The state being reported is
   * about the filter, not about whether the simulator is still booted.
   */
  private reportEnforcementLost(deviceId: string): void {
    for (const [sessionId, state] of this.deviceStates) {
      if (state.deviceId !== deviceId) continue
      this.sendMsg({ type: 'network:state', sessionId, payload: this.network.state(deviceId) })
    }
  }

  private async handleNetworkSet(sessionId: string, offline: boolean, requestId: string): Promise<void> {
    const deviceId = await this.deviceFor(sessionId)
    if (!deviceId) {
      this.sendMsg({
        type: 'network:error', sessionId, requestId,
        message: 'No booted device — boot one before changing its network.',
      })
      return
    }
    try {
      const payload = await this.network.setOffline(deviceId, offline)
      this.sendMsg({ type: 'network:state', sessionId, requestId, payload })
    } catch (e: unknown) {
      this.sendMsg({
        type: 'network:error', sessionId, requestId,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /**
   * The two capability entry points, which resolve their device the way every other one on this class
   * does — **`soleDeviceState`, not the first key in the map.**
   *
   * `deviceStates` holds one entry per *registered* simulator and this Mac reports dozens, so
   * `keys().next()` is whichever simctl listed first, almost always a shut-down one. That was wrong
   * before the liveness check and became a hard failure after it: `deviceFor` answers `undefined` for
   * a shut-down device, so both of these threw `No booted device` while a booted device sat right
   * there. `soleDeviceState` filters on `booted` and refuses to guess between two, which is the
   * policy this class already settled and wrote down — these were simply not using it.
   *
   * `deviceFor` stays for the wire path, where the caller names a session and the only open question
   * is whether that device is up.
   */
  async setNetworkOffline(offline: boolean): Promise<NetworkStatePayload> {
    return this.network.setOffline(await this.soleLiveDeviceId(), offline)
  }

  async networkState(): Promise<NetworkStatePayload> {
    return this.network.state(await this.soleLiveDeviceId())
  }

  async launchApp(bundleId: string, options?: LaunchOptions): Promise<void> {
    const problem = launchOptionsProblem(options ?? {})
    if (problem) throw new ValidationError(problem)
    await this.simctl.launchApp(await this.soleLiveDeviceId(), bundleId, compactLaunchOptions(options))
  }

  /** The one booted session, or undefined when there is no unambiguous answer. Callers that can
   *  reasonably do nothing (input) use this; callers that owe the user a result use
   *  `soleDeviceState`, which throws instead. */
  private liveDeviceState(): DeviceState | undefined {
    const live = [...this.deviceStates.values()].filter((s) => s.booted)
    return live.length === 1 ? live[0] : undefined
  }

  /** The one device out of `live`, or the refusal. Factored so the async resolver below answers
   *  ambiguity with the same words rather than its own. */
  private soleOf(live: DeviceState[]): DeviceState {
    if (live.length === 0) throw new ValidationError('no booted device — call connect() first')
    // Refusing beats guessing: this interface has no way to say which device is meant, and picking
    // one silently is the whole defect being fixed here.
    if (live.length > 1) {
      throw new ValidationError(`${live.length} booted devices — this entry point cannot choose between them`)
    }
    return live[0]!
  }

  /**
   * **The synchronous resolver, and `stream()` is the only caller left.**
   *
   * Everything else that resolves a device for a capability call awaits `soleLiveDeviceState`,
   * which asks simctl rather than trusting `booted` — a flag `initDeviceStates` clears on every
   * reconnect. `stream()` returns a `ReadableStream` and is part of `DeviceAgent`, so it cannot
   * await without changing that interface across both agents.
   *
   * **It is deliberately left with the stale flag, and nothing was added to paper over that.** A
   * refresh that marked every simulator simctl reports as booted was written and removed: it also
   * marked the ones a developer had open in Simulator.app, which destroys the very thing `booted`
   * disambiguates by — *the device this agent booted* — and made all the callers above refuse with
   * "2 booted devices" on the common two-simulator desk. Fire-and-forget, it could also resurrect a
   * flag a `device:shutdown` had just cleared, with no path back.
   *
   * That was a mechanism for a method **nothing in this repo calls**. A future caller needs the
   * interface decision, not a guess: make `stream()` async across `DeviceAgent`, or give it an
   * explicit device argument.
   */
  private soleDeviceState(): DeviceState {
    // `deviceStates` holds one entry per *registered* simulator, not per running one — the relay
    // opens a session for every device in `agent:register` and this Mac reports dozens. Taking the
    // first entry would pick whichever simulator simctl listed first, almost always a shut-down
    // one, which is worse than the `booted` alias it replaced: the alias at least found the device
    // that was actually up. `booted` is set by handleDeviceBoot, so filtering on it is the liveness
    // check `AndroidAgent` gets for free from `getSerial` (its serial map is only populated on
    // launch).
    return this.soleOf([...this.deviceStates.values()].filter((s) => s.booted))
  }

  /**
   * `soleDeviceState`, but **it asks simctl before believing that nothing is booted**.
   *
   * `booted` is a cache and `initDeviceStates` clears it on `agent:registered` — every reconnect,
   * not only the first connection. So after a relay restart every flag reads false while the
   * simulators are still running, and a resolver that trusts the cache refuses a live device until
   * something else happens to refresh it. On the wire path that is `deviceFor`; these two entry
   * points have no session id to work from, so without this they stay broken.
   *
   * Only the empty case pays for the `listDevices` call: a cache that already names a booted device
   * is not wrong, just possibly incomplete, and the ambiguity refusal is stricter for having fewer
   * candidates rather than looser.
   *
   * **Every entry point that can await now comes through here** — the network pair, `installApp`,
   * `launchApp`, `queryUITree`, `screenshot`, `openUrl`. `stream()` cannot, and `soleDeviceState`
   * above says what that costs and why nothing was bolted on to hide it.
   */
  private async soleLiveDeviceState(): Promise<DeviceState> {
    const cached = [...this.deviceStates.values()].filter((s) => s.booted)
    if (cached.length > 0) return this.soleOf(cached)

    const booted = new Set(
      (await this.simctl.listDevices()).filter((d) => d.status === 'booted').map((d) => d.id),
    )
    const up = [...this.deviceStates.values()].filter((s) => booted.has(s.deviceId))
    // **Ownership narrows liveness, and only when it can.** A developer with their own simulator open
    // makes two devices live, and asking simctl alone would find both and refuse both — the reconnect
    // case this whole path exists for. `ownedDevices` survives the reconnect and says which one is
    // tapflow's. When it says nothing — a fresh agent process, or devices booted entirely outside
    // tapflow — there is no ownership to apply and the refusal is the honest answer.
    const mine = up.filter((s) => this.ownedDevices.has(s.deviceId))
    const live = this.soleOf(mine.length > 0 ? mine : up)
    live.booted = true   // same cache write `ackInput` makes, so the next call skips simctl
    return live
  }

  private async soleLiveDeviceId(): Promise<string> {
    return (await this.soleLiveDeviceState()).deviceId
  }

  async queryUITree(): Promise<UIElement[]> {
    const state = await this.soleLiveDeviceState()
    return this.readUITree(state)
  }

  // ── Audio output (opt-in, macOS 14.2+ Core Audio process taps) ───────────────────────────────
  // Simulator apps are host processes, so a process tap on the launched app's PID captures its audio
  // with no device routing, no injection, and no host-output hijack. The capture runs in a separate
  // signed .app (audiotap-helper) launched via LaunchServices so it holds its own audio-recording TCC
  // grant; it streams PCM back over loopback TCP. See AudioCaptureStreamer.

  // Audio output is ON by default (macOS 14.2+); opt out with TAPFLOW_AUDIO=off. The tap is .muted, so
  // the sim's audio goes only to the browser and the host (agent Mac) stays silent. The grant is
  // primed at `tapflow agent start`; see contributing/simulator-audio.md.
  private audioEnabled(): boolean {
    return process.env.TAPFLOW_AUDIO !== 'off' && isAudioSupported()
  }

  // Stand up the per-session loopback server the audiotap-helper streams to, pump its frames to the
  // relay, and start the whole-sim tap: launch the helper for the simulator's current process tree,
  // then poll for new processes (apps, WebKit WebContent) and push deltas over the same socket.
  private startAudioCapture(state: DeviceState, streamWs: WebSocket, udid: string): void {
    const seq = state.bootSeq
    const streamer = new AudioCaptureStreamer()
    streamer.listen()
      .then(async (port) => {
        // A reboot/shutdown/disconnect may have superseded this boot while listen() was binding —
        // discard so we don't leave an orphan helper/poll/server behind the current lifecycle.
        if (seq !== state.bootSeq || streamWs.readyState !== WebSocket.OPEN) { streamer.stop(); return }
        state.audioStreamer = streamer
        state.audioPort = port
        // Read before launching, so the first frames carry the sim's volume rather than full.
        const [pids, volume] = await Promise.all([enumerateSimPids(udid), readSimVolume(udid)])
        // A stop or reboot while reading retired this capture: `stopAudioCapture` already stopped `streamer`,
        // and launching the helper now would tap a device nobody is streaming.
        if (state.audioStreamer !== streamer) return
        // Only the control socket's close tears audio down; a stream socket that closed while reading would
        // leave a helper and a poll running for nothing until the next reboot.
        if (streamWs.readyState !== WebSocket.OPEN) { this.stopAudioCapture(state); return }
        state.audioVolume = volume
        void this.pumpAudio(streamWs, streamer.frames(), state)
        this.launchWholeSimTap(state, pids)
        // Started after the launch, so the first poll never races the launch's own pid set. One poll at a
        // time: `ps` is bounded by its timeout, and a slow one is not stacked by the next tick.
        let polling = false
        state.audioPoll = setInterval(() => {
          if (polling) return
          polling = true
          void this.refreshAudio(state, udid, streamer).finally(() => { polling = false })
        }, AUDIO_POLL_MS)
      })
      .catch((e) => logger.warn(`audio capture server failed to start: ${e instanceof Error ? e.message : String(e)}`))
  }

  // Launch the tap helper for the simulator's whole process tree. Swallows errors — audio must never
  // break the launch/video path (e.g. helper build fails, or the user hasn't granted the audio
  // permission). The helper holds the socket open; refreshAudio() pushes later updates to it.
  private launchWholeSimTap(state: DeviceState, pids: number[]): void {
    if (!pids.length) { logger.warn('no simulator processes to tap (audio idle until first poll)'); return }
    state.audioPids = new Set(pids)
    try {
      launchAudioHelper(ensureHelperApp(), state.audioPort, pids)
    } catch (e) {
      logger.warn(`audiotap-helper launch failed (audio disabled): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Re-enumerate the sim's process tree and, only when a NEW process appeared (a launched app or a
  // freshly spawned WebKit WebContent), push the updated set so the helper rebuilds its tap. Dead pids
  // need no rebuild — they resolve to no audio object, so the helper just stops mixing them; we still
  // refresh the baseline so a later reappearance is detected. Rebuilding only on additions keeps
  // short-lived daemon churn from causing constant tap teardown (audio glitches). Also tracks live sim-volume
  // changes. Both reads are asynchronous, so the capture may have been retired by the time they land; `streamer`
  // is the capture this poll belongs to.
  private async refreshAudio(state: DeviceState, udid: string, streamer: AudioCaptureStreamer): Promise<void> {
    const [pids, volume] = await Promise.all([enumerateSimPids(udid), readSimVolume(udid)])
    if (state.audioStreamer !== streamer) return
    state.audioVolume = volume
    if (!pids.length) return
    const prev = state.audioPids
    const hasNew = !prev || pids.some((p) => !prev.has(p))
    state.audioPids = new Set(pids)
    if (hasNew) streamer.updatePids(pids)
  }

  // Forward captured PCM to the relay on the shared stream socket via the yielding sender (audio must
  // never inflate the socket buffer enough to trip video's backpressure). Mirrors android-agent.
  private async pumpAudio(streamWs: WebSocket, frames: ReadableStream<AudioFrame>, state: DeviceState): Promise<void> {
    const warnDrop = createRateLimitedDropWarn(logger, 'ios audio')
    const reader = frames.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || streamWs.readyState !== WebSocket.OPEN) break
        if (state.audioVolume < 0.999) applyGain(value.payload, state.audioVolume) // reflect sim volume (tap is pre-volume)
        const frame = writeEnvelopeHeader(value.payload, Date.now(), { codec: CODEC_AUDIO })
        sendAudioYieldingToVideo(streamWs, frame, warnDrop)
      }
    } catch {
      // stream cancelled or ws closed — expected on teardown/restart
    }
  }
  // async, not a bare `return`: `soleDeviceId` throws, and a synchronous throw out of a method
  // typed `Promise<T>` skips every caller's `.catch`.
  async screenshot(): Promise<Buffer> { return this.simctl.screenshot(await this.soleLiveDeviceId()) }
  stream(): ReadableStream<Buffer> {
    const first = this.soleDeviceState()
    // DeviceAgent.stream() is the platform-neutral Buffer contract; unwrap StreamFrame payloads.
    return new ScreenCaptureStreamer(first.deviceId, this.fps).start()
      .pipeThrough(new TransformStream<StreamFrame, Buffer>({
        transform(frame, controller) { controller.enqueue(frame.payload) },
      }))
  }

  touchStart(x: number, y: number): void {
    const first = this.liveDeviceState()
    first?.touchHelper?.touchStart(x, y)
  }
  touchMove(x: number, y: number): Promise<void> {
    const first = this.liveDeviceState()
    first?.touchHelper?.touchMove(x, y)
    return Promise.resolve()
  }
  async touchEnd(): Promise<void> {
    const first = this.liveDeviceState()
    await first?.touchHelper?.touchEndAfterMinContact()
  }

  async openUrl(url: string): Promise<void> {
    return this.simctl.openUrl(await this.soleLiveDeviceId(), url)
  }
}

/**
 * Runs an archive tool without blocking, in the shape `spawnSync` returned: a spawn failure (the tool is
 * missing) in `error`, otherwise the exit `status` and what it wrote to stderr. stdout is discarded — the
 * tools run quiet, and nothing reads it.
 */
function runExtractor(cmd: string, args: string[]): Promise<{ error?: Error; status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    // Decoded by the stream, not per chunk: a chunk boundary inside a multibyte character (a Korean file
    // name in unzip's message) would otherwise turn into replacement characters.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk })
    child.once('error', (error) => resolve({ error, status: null, stderr }))
    child.once('close', (status) => resolve({ status, stderr }))
  })
}

/**
 * When to restart a screen stream that just ended. Only a run that delivered a frame resets the count — not
 * how long it lasted: the helper retries `device.io` and its ports for up to ~10s before it gives up, so a
 * duration rule would call every first-boot failure healthy. A simulator shut down from outside makes the
 * helper exit at once, which without this was a restart loop at full speed.
 */
export function streamRestartPlan(previousFailures: number, deliveredFrame: boolean): { failures: number; delayMs: number } {
  if (deliveredFrame) return { failures: 0, delayMs: 0 }
  const failures = previousFailures + 1
  return { failures, delayMs: failures <= 1 ? 0 : Math.min(250 * 2 ** (failures - 2), 5000) }
}
