// tapflow wire protocol — the WebSocket message contract shared by browser, relay and agents.
//
// Scope: JSON messages only. The binary frame envelope (TFFE) is not here — see
// contributing/frame-envelope.md. Runtime validators, if they ever exist, belong in this package
// next to the types they validate.
//
// Types only, deliberately. Consumers use `import type`, so nothing from this package reaches a
// runtime bundle. Do not add `enum` or const objects: they compile to runtime values, which would
// put JavaScript into the dashboard bundle the moment someone referenced one as a value.

// ── Domain shapes carried by messages ────────────────────────────────────────

/** Agent resource sample, reported on `agent:resources` and echoed in a session listing. */
export interface AgentResources {
  cpuPercent: number
  memUsedMB: number
  memTotalMB: number
  slotsAvailable: number
  slotsTotal: number
  /** Date.now() */
  reportedAt: number
  /** The kernel's own memory pressure on the agent's Mac. Absent where the agent cannot read it (not macOS) and
   *  from agents that predate it. */
  memoryPressure?: MemoryPressure
}

/**
 * macOS `kern.memorystatus_vm_pressure_level` (1, 2, 4). An 8 GB Mac idles at `warn` with no simulator running,
 * so only `critical` means anything to admission: the relay refuses automated cold boots on it
 * (`host-memory-critical`).
 */
export type MemoryPressure = 'normal' | 'warn' | 'critical'

/** What kind of device it is, for what the viewer draws around it. A string literal union, not a
 *  runtime list, so it erases under `import type`; the one runtime copy is the register schema in
 *  `./validate`, held to this by its tier assertion. */
export type FormFactor = 'phone' | 'tablet' | 'foldable'

/** What an agent reports about a device in `agent:register`. No `sessionId`/`busy` — the relay
 *  owns those. */
export interface DeviceReport {
  id: string
  name: string
  platform: string
  status: string
  osVersion?: string
  /** Absent from an agent that predates it, and from one that cannot tell. A relay drops a value it
   *  does not know rather than refusing the register, so a newer agent's new form factor reaches an
   *  older viewer as absent — which every consumer reads as "draw it as a phone". */
  formFactor?: FormFactor
  /** The service tier the device boots with now — what its agent last wrote for it. `'unsupported'` for a
   *  device whose runtime cannot take one (iOS before 18.5, every Android device). Absent from an agent that
   *  predates tiers. See `ServiceTier`. */
  serviceTier?: ServiceTier | 'unsupported'
}

/**
 * How many of a simulator's background services are switched off when it boots (iOS only). A boot's cost to
 * the other sessions on its Mac falls with the list: measured on 8 GB, the full list cut the boot's CPU
 * saturation from 20–49 s to 7–14 s, while `lean` was indistinguishable from `stock`
 * (`contributing/simulator-boot-contention.md`).
 *
 * - `stock`: nothing off.
 * - `lean`: what the agent's Lean mode turns off — services apps rarely need. A person's default when Lean mode is on.
 * - `slim`: almost everything, including widgets, Spotlight, push, StoreKit, photos and contacts. Only for an
 *   automated run that asked for it, with `keep` naming what its app needs back.
 *
 * Asked for by a run (`device:boot.payload.serviceTier`), never chosen from who is booting, so the same flow
 * replays on the same services every time. A boot without one gets the agent's own setting.
 */
export type ServiceTierName = 'stock' | 'lean' | 'slim'

/** Features a run can keep on under a tier, each backed by the services it needs (simslim's feature map). */
export type ServiceFeature =
  | 'push' | 'storekit' | 'app-store' | 'universal-links' | 'spotlight' | 'siri' | 'icloud' | 'keychain-sync'
  | 'contacts' | 'calendar' | 'reminders' | 'mail' | 'photos' | 'health' | 'homekit' | 'imessage' | 'widgets'
  | 'wallet' | 'maps' | 'weather' | 'news' | 'game-center' | 'find-my' | 'screen-time'

/** One value, so a relay that does not know the field drops the tier and its exceptions together — never the
 *  exceptions alone, which would boot slim with services the app needs switched off. */
export interface ServiceTier {
  name: ServiceTierName
  keep: ServiceFeature[]
}

/**
 * What `tapflow flow run` asks the agent to reset before a run, so one run does not inherit what the last left on the
 * device. A device that stays up between runs keeps it, and so does one shut down and booted again: app data, the
 * keychain and privacy grants live on disk.
 *
 * - `uninstall`: apps the run is about to install. Removing them first drops their data container, App Group
 *   containers, notification settings and privacy grants in one step, which clearing files cannot (cached defaults).
 * - `clear`: apps the run uses but does not install. Their files are cleared and they keep running as installed.
 *
 * Absent from every other boot: a person's session and an AI agent's exploration keep their state.
 */
export interface RunResetRequest {
  uninstall: string[]
  clear: string[]
}

/**
 * One thing an agent reset, named for what it covers rather than what was hoped for.
 *
 * - `app-uninstall` / `app-files`: the two `RunResetRequest` lists (iOS). `app-data`: `pm clear` (Android), which
 *   covers files, permissions and the running process.
 * - `keychain`: iOS `simctl keychain reset`. Roots added with `add-root-cert` stay trusted.
 * - `privacy-services`: iOS `simctl privacy reset all` — only the services simctl names; notifications are not one.
 * - `pasteboard`: set to an empty string, which is not the same as nothing ever copied.
 * - `location`: iOS simulated location cleared.
 *
 * Device-wide except the app items. An item a platform does not do is never reported, so absence means not reset.
 */
export type RunResetItem = 'app-uninstall' | 'app-files' | 'app-data' | 'keychain' | 'privacy-services' | 'pasteboard' | 'location'

/** What the agent actually reset. The only evidence a reset happened: a relay or agent that predates it drops the
 *  request without a word. */
export interface RunResetReport {
  done: RunResetItem[]
  failed: RunResetItem[]
}

/** A device as the relay lists it, after adding what only the relay knows. Named `DeviceSummary`
 *  rather than `DeviceInfo` because both packages already used that name for different shapes:
 *  the relay for this, and `DeviceDetails` is the `session:deviceInfo` payload. */
export interface DeviceSummary extends DeviceReport {
  sessionId: string
  busy: boolean
  /** Who is driving the device, when it is an AI client (`mcp-server`, `flow-runner`) holding a live
   *  session. Absent for an unheld device and for a person's session — a manual session is not
   *  watchable, so naming its holder would only say who to look over the shoulder of.
   *
   *  **What a viewer offers Watch on** — it says the session is watchable — and a version gate for a
   *  viewer that can meet an older relay (a third-party one, or a downgrade under an open tab): an older
   *  relay drops `watch:start` without a reply, and one that sends this field understands it.
   *
   *  **Never the owner key or the client id.** The owner key is `<userId>:<clientId>` and the client half
   *  comes off the handshake query: a local socket that learned it could claim it and drive the device. */
  holder?: SessionHolder
  /**
   * The device is waiting for a person whose connection dropped, and will shut down if they do not come back (#1087).
   * Sent to everyone, so a teammate picking it knows it is someone's before taking it: this is the one place a
   * person's session is named to others, because what it protects is that person's app state, which taking the
   * device wipes. A connected person's session still is not named (`holder` above).
   */
  waiting?: DeviceWaiting
  /** Present when the person the device is waiting for is the one asking — from any browser, since it is the
   *  signed-in user that matches, not the tab. Absent while an AI client is borrowing the device. */
  resumable?: true
  /** How long ago the device started waiting, with `resumable`. A tab that finds its own session held by another of
   *  its user's tabs waits this long before retrying, so the tab that dropped gets back first. */
  releasedAgoMs?: number
  /** A person is holding it from another tab of the asker's own account, live. Absent for an AI client of the same
   *  account: nothing about that holder is going away, so waiting for it would wait forever. */
  heldBySelf?: true
  /** Someone else took or shut down the device while it was waiting for the asker. Sent only to that person, on every
   *  listing until it expires — never cleared by being read, since every open tab polls. */
  endedBy?: DeviceEndedBy
  /** The name an Admin gave the device on the relay (#1085). For people only: `name` stays the device's own, which
   *  is what an MCP client or a flow picks a device by. */
  displayName?: string
  /** An Admin hid the device from the dashboard's device list. The device is still listed, and still offered to
   *  automation: hiding is for people picking a device by eye. */
  hidden?: true
  /** The asker starred the device. Per person. */
  favourite?: true
}

export interface DeviceWaiting {
  /** A label for people (an email, or `local`), as `SessionHolder.user`. Shown on hover, under `name`. */
  user: string
  /** What to call them: their display name, or the part of the email before `@` (the rule `/auth/me` uses). */
  name: string
  /** Until the device shuts down. Absent while an AI client holds it: its countdown is stopped and starts again in
   *  full when the client leaves. */
  remainingMs?: number
  aiHolding?: true
  /** The asker is the person waited for. Unlike `resumable` it holds while an AI client borrows the device, so a
   *  viewer can tell its own borrowed session from someone else's. */
  yours?: true
  /** The build last installed on the device, with `yours`: what a link back into the session opens. Absent when the
   *  relay has no record of one. */
  buildId?: number
}

export interface DeviceEndedBy {
  /** The email of whoever took it, or `local`. */
  by: string
  /** What to call them, as `DeviceWaiting.name`. */
  name: string
  /** The relay's clock. Only for telling one notice from the next; never compared with the viewer's clock. */
  at: number
}

/** A holder as the device list shows it. `user` is a label for people, not an identity to act on. */
export interface SessionHolder {
  kind: AiClientKind
  /** The signed-in user behind the client's credential (their email), or `local` for an
   *  unauthenticated loopback client — the MCP server on the relay's own Mac, typically. */
  user: string
}

/** The clients that drive a device for an agent rather than a person. */
export type AiClientKind = 'mcp' | 'flow-runner'

/** What a client declares itself to be on `session:start`. **A self-exposure, not a credential:** an AI
 *  kind makes the declarer's own session watchable by teammates and grants nothing else, so declaring it
 *  falsely can only expose oneself. Who may *watch* is decided by authentication, never by this. */
export type ClientKind = 'dashboard' | AiClientKind

/** The `session:deviceInfo` payload.
 *
 *  **Nothing displays it.** Both agents send it and the relay caches and replays it on join; the flow runner
 *  copies it into a run's video beside the chrome (A4), and nothing reads it back yet — the dashboard shows
 *  device name and OS from `agents:listed` (`DeviceSummary`) instead. This comment used to claim "what the viewer shows in its info card", which
 *  was the kind of false statement about a consumer that this package exists to remove; L6 found it while
 *  classifying every browser-inbound message. Kept on the wire because third-party agents send it. */
export interface DeviceDetails {
  deviceName: string
  osVersion: string
}

/** Closed role vocabulary shared by all platforms. An unmappable native role becomes `'other'` and the
 *  platform-native string is preserved in `rawRole`, so a consumer can still branch on it without the
 *  vocabulary having to grow for every platform. */
export type UIElementRole =
  | 'button'
  | 'text'
  | 'input'
  | 'image'
  | 'checkbox'
  | 'switch'
  | 'slider'
  | 'list'
  | 'cell'
  | 'tab'
  | 'other'

/** Normalized to 0–1 in the same coordinate space the touch input path consumes, so a frame centre can
 *  be fed straight into a tap without conversion. */
export interface UIElementFrame {
  x: number
  y: number
  width: number
  height: number
}

/** One node of `ui:tree:response`. Lived in `agent-core` until L4a needed it to type that message —
 *  protocol is a leaf and cannot import agent-core, and the alternative was a copy. There was already
 *  one: `mcp-server` carried a hand-written mirror, which is the drift this package exists to remove. */
export interface UIElement {
  role: UIElementRole
  label: string
  identifier?: string
  /** A text field's placeholder (iOS `placeholderValue`, Android `hint`), apart from `label` on purpose: a
   *  placeholder is not a name, and folding it into one hides the app's missing label. Absent when there is
   *  none — and from an agent that predates the field, which reads the same as none. */
  placeholder?: string
  frame: UIElementFrame
  enabled: boolean
  rawRole?: string
}

/** `agents:listed` groups devices by agent machine. */
export interface SessionInfo {
  agentName?: string
  /** The Mac's key for settings kept on the relay (device prefs, favourites): its machine id, else its name — the
   *  identity the relay already dedups agents by. Sent back verbatim as `agent` in those requests. */
  agentKey?: string
  platform?: string
  resources?: AgentResources
  /** What this agent implements, mirroring `AgentRegister.capabilities`.
   *
   *  It rides the listing as well as `session:joined` because the viewer has to gate controls
   *  **while picking a device**, which happens before any session exists to join — Full reset
   *  (#447) is armed on the picker, not inside the session.
   *
   *  **Required, like every other producer field.** There is one producer (`SessionManager.list()`)
   *  and it always emits an array, so no relay can send the listing without it — and none ever
   *  will, because the dashboard ships inside the relay package (`files: [public]`) and cannot skew
   *  from it. An agent that predates the capability is expressed by `[]`, not by the key being
   *  absent; the door already defaults it that way (`validate/index.ts`). Optional here would
   *  describe a frame nobody sends and hand every consumer a `?.` to carry for good. */
  capabilities: string[]
  /** What the relay would do with this Mac now, so the picker shows the relay's judgement instead of
   *  recomputing a threshold of its own. The same value on every agent of one Mac. Required: one
   *  producer (`SessionManager.list()`), and the dashboard ships inside the relay package. */
  admission: MacAdmission
  devices: DeviceSummary[]
}

export interface MacAdmission {
  /** A cold boot holds this Mac's boot slot (`relay/src/admission/`). Another boot waits or is refused. */
  booting: boolean
  /** No person's `session:start` on this Mac would be let in now (`agent-resources-exhausted`): CPU is over the
   *  line, or memory is and the relay has no device up here to rejoin. */
  overloaded: boolean
  /** Devices of this agent a person's join would be refused for memory now: memory is over the line and the
   *  relay has not brought these up (`readySent`), so joining would start them. Empty when memory is fine. Per
   *  device rather than a flag, because "running" by the device list's `status` is not the relay's rule — a
   *  simulator booted before its agent registered reads `booted` and is still refused. */
  memoryRefuses: string[]
}

export interface ChromeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ChromeButton {
  name: string
  accessibilityTitle: string
  anchor: string
  /** true = button is above the device frame (e.g. home button) */
  onTop: boolean
  /** button center in the **expanded composite** space at 2× px (retracted/default) */
  normalOffset: { x: number; y: number }
  /** button center at the rollover (extended/hover) position, same space */
  rolloverOffset: { x: number; y: number }
  /** button width in 2× composite px */
  buttonW: number
  /** button height in 2× composite px */
  buttonH: number
  /** HID usage page for SimulatorKit injection (0 = unknown) */
  usagePage: number
  /** HID usage code (0 = unknown) */
  usage: number
  /** base64 PNG of the button at 2× (for the CSS-animated overlay) */
  buttonPng?: string
  /** base64 PNG of the pressed state (imageDown asset) */
  pressedPng?: string
  /** position + size in the **expanded composite** space at 2× px */
  pressedRect?: ChromeRect
}

export interface AndroidButton {
  name: string
  accessibilityTitle: string
  keyCode: number
}

/** Payload on every `clipboard:error` from a read. `sentinelParked` answers the one question the
 *  viewer needs to decide its fallback: is a marker still sitting on the device clipboard?
 *
 *  If it is, the agent's restore is about to overwrite whatever the device copies next, so
 *  pressing the plain chord as a fallback would hand the user a stale value — the exact bug the
 *  sentinel exists to prevent. If it is not, the chord is safe and is the only way the copy
 *  happens at all. Absent means "assume parked": an agent from before this field cannot tell us,
 *  and the silent-stale-paste failure is worse than a copy that did not happen.
 *
 *  `unsupported` is narrower — this backend has no clipboard channel whatsoever — and drives the
 *  paste fallback and the wording of the toast. */
export interface ClipboardErrorPayload {
  unsupported?: boolean
  sentinelParked?: boolean
}

/**
 * iOS device chrome — the bezel artwork and hit regions the viewer composites around the screen.
 *
 * **Two coordinate spaces exist here and the field names do not distinguish them.** The composite
 * PDF is the device frame; the *expanded* composite is that canvas grown by the button margins, and
 * it is the space the viewer lays out against. `compositeWidth`/`Height`, `screenRect` and every
 * `ChromeButton` offset are in the **expanded** space; `padding` is the device's own padding inside
 * the un-expanded one. Getting this wrong puts buttons at an offset that looks almost right.
 *
 * These descriptions come from the producer (`ios-agent`'s `DeviceChromeLoader`, which computes
 * `expandedW = pdfSize.width + buttonMargins`). They were previously accurate only in that file —
 * this declaration said `compositeWidth` was "full PDF width including devicePadding", a different
 * quantity — so they moved here with the type rather than being lost with it.
 */
export interface ChromeData {
  /** composite with buttons baked in, at 2× — screen hole transparent */
  framePng: string
  /** composite minus devicePadding, at 2× px */
  bezelWidth: number
  bezelHeight: number
  /** **expanded** canvas width — composite + button margins — at 2× px */
  compositeWidth: number
  /** **expanded** canvas height, at 2× px */
  compositeHeight: number
  /** devicePadding at 2× px, inside the un-expanded composite */
  padding: { left: number; right: number; top: number; bottom: number }
  /** screen position in the **expanded** composite space, at 2× px */
  screenRect: ChromeRect
  /** screen corner radius in 2× px (0 if the device has no rounded corners) */
  screenCornerRadius: number
  /**
   * Each corner's radius in 2× px, in the same space as `screenRect` — present only when the device type
   * states them per corner and they differ from what one number can carry. The iPhone Duo's cover is
   * rounded on its outer side and nearly square at the hinge (59 pt against 8, from its `capabilities.plist`).
   * A viewer that reads only `screenCornerRadius` gets the largest of the four.
   */
  screenCornerRadii?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }
  /** screen width in iOS logical pixels (pt) */
  logicalWidth: number
  /** screen height in iOS logical pixels (pt) */
  logicalHeight: number
  buttons: ChromeButton[]
  /**
   * Quarter turns **clockwise** to turn the device on screen — frame and video together — which is the
   * device's **physical** orientation, the way DeviceHub draws it: the glass turns with the body, and
   * whether the picture on it stands up is the app's business. An app that does not support the
   * orientation shows sideways, as it would in a hand. Sent for every iOS simulator by an agent that knows
   * where it is held: `devicectl device orientation get` on an Xcode 27 host, and inside the simulator on an
   * older one, whose devicectl does not see simulators. Where neither answers, what the agent last set.
   *
   * **Not the same meaning as `AndroidChrome.streamRotation`**, which corrects a capture to stand the
   * picture up. The two share a name and a unit only.
   *
   * It includes the lit panel's native orientation: the Duo's unfolded panel is drawn turned (its
   * `nativeOrientation` is 270), so holding the device upright turns that panel's frame 90.
   *
   * **Absent means no information, not 0.** An older agent never sends it, and a device whose orientation
   * is not known yet has none; a viewer that read absence as upright would stand a landscape device up
   * every time a chrome was re-sent.
   */
  streamRotation?: 0 | 90 | 180 | 270
  /**
   * The length, in 2× px, that a viewer sizes this device by in place of `compositeHeight` — the longest
   * side of the largest panel's expanded composite. Present only for a device with more than one panel (the
   * iPhone Duo), so that every panel is drawn at one scale: the cover is half the unfolded device in the
   * hand, as DeviceHub draws it. Sized by its own frame, each panel filled the same height.
   */
  scaleBasis?: number
}

/** Android chrome — no bezel artwork; the emulator frame carries it. */
export interface AndroidChrome {
  buttons: AndroidButton[]
  streamType: 'h264'
  /** What Android is drawing — the size the viewer frames, and the space a person points at. */
  screenWidth?: number
  screenHeight?: number
  cornerRadius?: number
  /**
   * Quarter turns **clockwise** to apply to the video before it matches `screenWidth/Height`.
   *
   * The capture does not always arrive in the orientation Android is drawing. The emulator's gRPC
   * backend captures the panel the way the device's body is held, so the correction is the body's turn
   * less the display's: folding rotates Android's screen back to 0 while the body stays put, and a
   * portrait-locked app keeps the screen at 0 while the body is turned. Measured on a Pixel 9 Pro Fold:
   * unfolded the two agree, folded the frame is 2424x1080 against a 1080x2424 screen.
   *
   * **The agent computes it** rather than the viewer deriving it from the two sizes. Only the agent
   * sees the display's rotation, and a viewer comparing aspect ratios would have to wait for the
   * decoder and this message to agree — which they do not during a fold, so the picture flipped
   * while they disagreed. Absent or 0 means the frame is already upright.
   *
   * Still the map from the frame to the screen Android draws when the viewer draws the body (`bodyRotation`) —
   * the space MCP's screenshot, the UI tree and every touch without a `space` are in. A viewer drawing the body
   * sends its own touches in the frame's space instead (`PointSpace`), turned by the agent.
   */
  streamRotation?: 0 | 90 | 180 | 270
  /**
   * Quarter turns **clockwise** the device's body is turned — the same meaning as `ChromeData.streamRotation`
   * on iOS, and **not** this type's `streamRotation` (a capture correction), the display's rotation, or a
   * rotation lock. Derived from the emulator's skin orientation, inverted: `REVERSE_LANDSCAPE` is the body a
   * quarter clockwise (measured — the frame then arrives as the device is held).
   *
   * **Present means the viewer draws the body**: the frame unturned, a portrait-locked app on its side as in
   * a hand, and `input:rotate { direction }` to turn it. Sent by an emulator streaming over gRPC, from its
   * first chrome. **Absent means this agent or backend does not report it** — an older agent, or scrcpy (a
   * real device, or the fallback) — and the viewer toggles portrait/landscape as before. Never "not known yet".
   */
  bodyRotation?: 0 | 90 | 180 | 270
}

/** The `session:chrome` payload. The relay never reads it — it stores and forwards — but the
 *  contract still states the shape, because the viewer parses it. A new platform adds its variant
 *  here; relay and dashboard code stay unchanged, which is what the OCP rule asks for. */
export type ChromePayload = ChromeData | AndroidChrome

// ── relay → agent ────────────────────────────────────────────────────────────

export interface AgentRegistered {
  type: 'agent:registered'
  registeredSessions: Array<{ deviceId: string; sessionId: string }>
  /** What this relay accepts from an agent beyond the messages every relay does. Optional: an older relay omits
   *  it, and an agent reads the absence as "send only what every relay understands". The relay → agent half of
   *  the skew markers (protocol AGENTS.md, #662); `capabilities` is agent → relay, `AgentsListed.features` is
   *  relay → browser. */
  features?: RelayAgentFeature[]
}

/** Values of `AgentRegistered.features`. An agent meeting one it does not know ignores it.
 *  `'device-updates'`: the relay takes `agent:devices` and answers `agent:devices-applied`. */
export type RelayAgentFeature = 'device-updates'

/** The relay's answer to `agent:devices`: the sessions it made for devices that appeared, and the ones it removed
 *  for devices that left. Not correlated: the agent sends at most one list at a time per socket, and a list lost
 *  with its socket is replaced by the next `agent:register`. A device still in use when it left is kept until its
 *  session ends, so it is in neither array. */
export interface AgentDevicesApplied {
  type: 'agent:devices-applied'
  added: Array<{ deviceId: string; sessionId: string }>
  removed: Array<{ deviceId: string; sessionId: string }>
}

export interface StreamRequestIdr {
  type: 'stream:request-idr'
  sessionId: string
}

/**
 * Ask the agent to re-read the device's network condition and report it (#614).
 *
 * Shaped after `stream:request-idr` above, and sent from the same place — the relay's re-join replay
 * block. A viewer that reconnects has no other way to learn whether the device is offline:
 * `NetworkState` is agent-produced, and the relay cannot cache it the way it caches `chromeData` and
 * `deviceInfo`. Those become false only on a reboot or an agent death, both of which the relay
 * observes; airplane mode changes when someone types `adb` in a terminal, and on iOS the state is
 * "is the injected dylib armed", which is not a thing the relay can observe at all. **The relay caches
 * only what it can invalidate**, so this asks rather than remembers.
 *
 * Uncorrelated, like its neighbour: the answer is a `network:state` with no `requestId`, which is the
 * fourth unsolicited producer that message declares. An agent that predates this ignores the frame.
 *
 * **That silence is not self-healing, unlike an ignored IDR request.** A dropped keyframe request is
 * repaired by the next periodic one; nothing re-produces a network state. The read path also has no
 * error message, because there is no requester to address one to — so a viewer will have to arm its
 * own deadline after joining and say it could not read. **No viewer does yet**: the control is not on
 * screen, and this describes the obligation the one that lands takes on, not behaviour that exists.
 *
 * The relay sends this only to an agent whose `capabilities` include `network-control`, so the
 * silence never means "this agent does not implement it" — that is already known before the ask.
 */
export interface NetworkRequestState {
  type: 'network:request-state'
  sessionId: string
}

// Optional, unlike every other correlated request, because **the relay originates this one** — the
// idle timer at `RelayServer.ts` shuts a device down with no browser behind it. This is one interface
// serving both `BrowserToRelay` and `RelayToAgent`, so required here would be unsatisfiable there.
// See 「Lifecycle correlation」 in AGENTS.md.
export interface DeviceShutdown {
  type: 'device:shutdown'
  sessionId: string
  requestId?: string
  payload: { deviceId: string }
}

export interface AppInstallToAgent {
  type: 'app:install'
  sessionId: string
  requestId: string
  payload: {
    /**
     * The relay's **own** path to the build. Only usable by an agent that shares the relay's
     * filesystem, which is why the three fields below exist — a relay in a container or on another
     * host sends a path that means nothing where the agent runs, and `unzip` answers
     * `cannot find or open`, which the agent used to report as a bad archive.
     *
     * Kept for agents that predate `build-download`: they read this and nothing else, so removing
     * it would break every local install at once.
     */
    filePath: string
    bundleId: string | null
    /**
     * Single-use, short-lived credential for `GET /api/v1/build-download`. Absent from a relay that
     * predates this, which is the only reason an up-to-date agent falls back to `filePath`.
     *
     * **Not bound to an agent**, and deliberately not described as if it were: the relay cannot tell
     * which agent is making an HTTP request — it does not keep the agent socket's address. What is
     * enforced is all of what is claimed: 32 bytes of entropy, one use, one build, one TTL.
     */
    buildTicket?: string
    /**
     * The upload's stored filename. **The extension decides how both agents install** — `.tar.gz`
     * takes tar, `.zip` takes unzip, and Android refuses an `.app.zip` by name — so a download
     * written to a random temp name would silently take the wrong branch.
     */
    buildName?: string
    /**
     * Size in bytes, from `statSync` on the relay. The agent compares what it received against
     * **this**, not against `Content-Length`: that header is hop-by-hop, so a proxy re-chunking the
     * response drops it, and a check that reads an absent header passes without looking at anything.
     */
    buildBytes?: number
  }
}

export interface AppLaunchToAgent {
  type: 'app:launch'
  sessionId: string
  requestId: string
  payload: { bundleId: string } & LaunchOptions & {
    /** Everything in the options came from the relay's per-app defaults, none from the caller. An agent that cannot
     *  deliver them all may launch without them and report an empty `applied`, where it would refuse a caller's: a
     *  default written for automation must not break the plain Launch button on an app it does not fit. */
    defaultsOnly?: boolean
  }
}

/**
 * One launch argument's value. A map of these is passed to the app on both platforms: on iOS as `-key value` pairs
 * after the bundle id (read through `UserDefaults` and `ProcessInfo.arguments`), on Android as intent extras typed by
 * the value (read through `getIntent().getExtras()`). No fractional numbers: Android's double extra (`--ed`) is
 * missing on older images and its float one loses precision, so a decimal travels as a string. The limits and the
 * rules every producer applies are in `@tapflowio/protocol/launch`.
 */
export type LaunchArgumentValue = string | number | boolean | string[]

/** What a launch can carry besides the bundle id (#1047). `env` reaches the app's process environment on iOS only;
 *  Android has no such channel, and an agent there refuses it rather than launching without it. */
export interface LaunchOptions {
  arguments?: Record<string, LaunchArgumentValue>
  env?: Record<string, string>
}

/** The names of the launch options an agent applied: never the values. */
export interface LaunchApplied {
  arguments: string[]
  env: string[]
}

export interface ScreenshotRequest {
  type: 'screenshot:request'
  sessionId: string
  requestId: string
  /**
   * A **preference, not a requirement.** An agent may produce something else, and says what it
   * produced in `ScreenshotDone.format`.
   *
   * That asymmetry is not slack, it is the platform contract: `DeviceAgent.screenshot()` takes no
   * format argument at all, so no agent has ever been asked to honour this — iOS happens to
   * (`simctl io … --type`), Android cannot (`screencap -p` produces PNG and takes no format), and a
   * third-party platform registered through `AgentRegistry.register()` is free to produce whatever
   * it can. Required here only because every in-repo sender supplies one; absence would have to mean
   * "no preference", which is what `'png'` already means.
   *
   * A consumer that needs to know what it is holding reads the **bytes**, not this field and not the
   * reply's echo of it — #508 was this field being read as an outcome.
   */
  format: 'png' | 'jpeg'
}

export interface UiTreeRequest {
  type: 'ui:tree:request'
  sessionId: string
  requestId: string
}

export type RelayToAgent =
  | AgentRegistered
  | AgentDevicesApplied
  | StreamRequestIdr
  | NetworkRequestState
  | DeviceShutdown
  | AppInstallToAgent
  | AppLaunchToAgent
  | ScreenshotRequest
  | UiTreeRequest

export type SessionTerminatedReason = 'agent-disconnected'

/**
 * Why a terminal input was not delivered — the machine-readable half of `input:error`.
 *
 * The set is derived from **what a consumer has to do differently**, not from how many internal
 * states an agent has. Those differ per platform (one HID helper on iOS; a scrcpy socket, an
 * emulator gRPC channel and `adb shell input` on Android) and each agent maps its own states onto
 * these. A closed set that is smaller than either agent's internals is the point.
 *
 * | reason | consumer should |
 * |---|---|
 * | `not-booted` | boot the device |
 * | `channel-unavailable` | reconnect or rebind; do not blindly retry |
 * | `channel-starting` | **retry shortly** — the channel exists and is coming up |
 * | `dispatch-failed` | may retry once |
 * | `unsupported` | never retry; this agent does not implement it |
 * | `malformed` | fix the call; never retry |
 * | `no-gesture` | **open a new gesture** — retrying this frame can never land |
 *
 * `channel-starting` is the one that had no name. On iOS the input helper needs a measured
 * 186–247ms after spawn before an injected frame reaches the device, and `device:ready` can arrive
 * inside that window — so a caller that taps as soon as a boot returns was being told the channel
 * was gone when it was merely coming up.
 *
 * **A consumer that meets a reason it does not know must treat it as `channel-unavailable`** — the
 * conservative reading. The field is optional precisely so an older agent can omit it, so absence
 * means "unknown", never "fine".
 *
 * A string literal union rather than an enum, per this package's HOW NOT: it must erase under
 * `import type` so it never lands in the dashboard's bundle.
 */
export type InputErrorReason =
  | 'not-booted'
  | 'channel-unavailable'
  | 'channel-starting'
  | 'dispatch-failed'
  | 'unsupported'
  | 'malformed'
  /**
   * A frame that only means something as part of a gesture arrived with no gesture behind it — the
   * opening frame never landed, or the process serving it was replaced. Distinct from `malformed`
   * because the advice differs: the message was well-formed and the channel may be perfectly
   * healthy, but *this* frame can never be delivered, so the caller re-opens the gesture rather than
   * giving up. Distinct from `channel-starting` for the same reason — waiting does not help.
   */
  | 'no-gesture'
  /**
   * The sender does not hold the session it addressed. The relay forwards a browser-role input after
   * resolving the session and, until this existed, without checking that the socket asking is the one the
   * session is bound to — so any authenticated client could drive a device another tester was looking at,
   * and the agent's ack went to the session holder rather than to whoever asked.
   *
   * **Not folded into `channel-unavailable`**, on that set's own rule — a reason exists per thing a consumer
   * must do differently. `channel-unavailable` means reconnect or re-join *this* session; this means the
   * caller never held it, so the move is to join first, and it may find someone else holding it.
   *
   * And it is the **only** reason that guarantees nothing reached the device. Every other one leaves partial
   * delivery open — `no-gesture` most sharply, which is why nothing retries on it (#491). Here the frame was
   * refused at the relay's door, so a retry after joining is safe, and that makes this the first member
   * whose advice can say so.
   */
  | 'not-session-owner'

// ── relay → browser ──────────────────────────────────────────────────────────
//
// `stream:registered` goes to a stream socket rather than a viewer. It is grouped here because the
// relay treats "everything that is not an agent" alike on the way out; splitting the outbound union
// by socket role is a later refinement, and the roles are already distinguished at runtime
// (`wsRoles`, and `directionOf` from this package's `validate` entry).

/** Browser-inbound messages with **two** producers: an agent sends it and the relay also originates
 *  its own copy — replaying session state to a re-joining viewer, or failing fast when it cannot
 *  reach the agent at all.
 *
 *  Declared once here and referenced by both directions rather than written into each, because two
 *  copies of one message drift. That is not hypothetical: the dashboard kept a hand-copy of this
 *  whole surface and four members had diverged from it, with nothing reporting the difference. */
// These three were `sessionId?` because the two producers disagreed, and the honest thing one
// declaration could say about a disagreement is "optional". Both agents stamp it on every copy
// (`IOSAgent.ts:428,438,633`, `AndroidAgent.ts:489,895,906`); the relay's own replay to a re-joining
// viewer did not, and it is the same declaration.
//
// **The disagreement was the defect, not the declaration.** Two alternatives were weighed when this
// surface was consolidated — declaring the three twice, or mapping the shared union through
// `Omit<T,'sessionId'> & { sessionId: string }` — and both were rejected. The third option was not
// considered: **fix the producer.** The relay stamps the two above now, so one declaration says
// `required` about both.
//
// **`device:ready` is the exception, and it is a deferral rather than an oversight.** Its `sessionId?`
// is doing correlation work by accident: `mcp-server` and `flow-runner` gate a pending `device:boot`
// on `msg.sessionId === sessionId` with no truthiness escape, so the unstamped replay is invisible to
// them. Stamping it makes a *replayed* ready satisfy an in-flight boot — measured: `boot_device`
// answers `{booted: true}` with the agent having sent nothing. The replay is cached state addressed to
// a **join**, not an answer to a **boot**, and `readySent` is cleared by nothing while an agent is
// wedged-but-connected, which is exactly when a boot hangs. So the value is stalest when it would be
// consumed.
//
// The real defect underneath is that leaving a session does not clear its waiters — a *real* ready
// after a re-join already satisfies the stale one. That is filed separately. The mechanism that makes
// this message tightenable is a request correlator, not another field.
//
// **That correlator landed and `device:ready` is still `sessionId?` — deliberately.** The correlator
// is `requestId?` below, and it is optional, so it cannot *replace* the sessionId comparison; it can
// only run ahead of it. Which means the unstamped replay is still what the two boot waiters discriminate
// on, and stamping it now would delete the working discriminator rather than make a tightened one
// redundant. Tightening this field and having the relay stamp its replay is therefore one later slice
// of its own — and it must carry a test pinning the **value** stamped, because there is none: with the
// stamp mutated to `session.deviceId`, a plausible slip on a line whose `payload` reads
// `{ deviceId: session.deviceId }`, every relay test, every dashboard test and the whole static suite
// still passed — measured on `1bf47c8`, before the tests in this pair existed. Deliberately no totals:
// they move every slice, and a stale number here reads as a reason to doubt the measurement.
// `deviceReadyReplay.test.ts` scopes itself out of that value in writing, and states the cost: a
// wrong-but-present id is dropped by the dashboard's gate, and the symptom is #440 — the very defect the
// replay exists to prevent, so nothing else would report it.
export interface SessionChrome {
  type: 'session:chrome'
  sessionId: string
  payload: ChromePayload
}

export interface SessionDeviceInfo {
  type: 'session:deviceInfo'
  sessionId: string
  payload: DeviceDetails
}

export interface DeviceReady {
  type: 'device:ready'
  sessionId?: string
  /** Absent = this is not the answer to a `device:boot`. See 「Lifecycle correlation」 in AGENTS.md. */
  requestId?: string
  payload: {
    deviceId: string
    /**
     * Whether this boot brought the device up, as opposed to finding it already running. Only the agent
     * can say: it reads the device list after `device:booting` has gone out, and the relay's own
     * `deviceStatus` is a snapshot from registration. A boot that brings a device up is what costs the
     * host 30–90 s of memory pressure (`contributing/simulator-boot-contention.md`), so this is the fact
     * a per-host boot gate needs.
     *
     * Judged from the agent's device-list read at the start of this boot, so a device stopped after
     * that read and booted again reports `false` — an undercharge the gate accepts. A device found
     * mid-transition counts as cold where the agent can see that state (iOS `unknown`); Android's adb
     * cannot, and reports `false` for an emulator it can already see.
     *
     * Absent = unknown: an agent that predates the field, or the relay's own replay of a ready it
     * already forwarded. A reader must not treat absent as `false`.
     */
    cold?: boolean
    /** The tier this boot came up with. The relay records it as the device's current tier, since the device
     *  list it registered with is a snapshot. Absent from an agent that predates tiers. */
    serviceTier?: ServiceTier | 'unsupported'
    /** Present only when the boot carried `runReset` and the agent knows it. */
    runReset?: RunResetReport
  }
}

/**
 * `sessionId` is what makes a failure findable. An MCP caller waits for the reply that carries its own
 * sessionId, and without one it waits out the deadline instead (#445).
 *
 * **This is now a description of the wire, and for two releases it was a specification the relay did not
 * meet.** Nothing validated inbound messages, so a client sending `{"type":"input:touch:end"}` with no
 * sessionId reached `sessions.get(undefined)`, missed, and was answered through `msg.sessionId!` —
 * `JSON.stringify` then dropped the key, shipping a frame whose required field this declaration claimed
 * was there. `sessionId: ''` was the sharper half: it type-checks, and `mcp-server`'s tool schemas are
 * bare `z.string()`, so an LLM could produce one.
 *
 * #444 closed it at the door. `@tapflowio/protocol/validate` parses an inbound frame against these
 * declarations before the relay routes it, with `.min(1)` on this field so the empty string is refused
 * too — and **`RelayServer.ts` now contains no `msg.sessionId!` at all**, where it once held eleven.
 * There is no count left to keep current here, which is the point: the assertion is gone rather than
 * enumerated, and a stale number in this paragraph is what taught that lesson.
 *
 * One member still declares `sessionId?` — `DeviceReady`, and its own note says why. That is a reasoned
 * deferral about a correlator, not a gap in this one.
 *
 * Optional would have described the old wire accurately and still been the wrong contract: an MCP caller
 * that receives an uncorrelatable `input:error` has nothing it can do with it and waits out the deadline
 * either way. An earlier version of this note said the producer should "send `error` instead", pointing at
 * `GenericError` below as an escape hatch for a failure with no session. **That escape is gone**:
 * `GenericError` requires `sessionId` since L5d, and a request naming no session is refused at the door
 * rather than answered, because a reply carrying no `requestId` cannot be attributed and costs the caller
 * the same deadline silence would.
 */
export interface SessionScoped {
  sessionId: string
}

export interface AppInstallError extends SessionScoped {
  type: 'app:install-error'
  message: string
  requestId: string
}

export interface AppLaunchError extends SessionScoped {
  type: 'app:launch-error'
  message: string
  requestId: string
  /** Set when the launch was refused because the device's agent predates launch options. A version mismatch, not
   *  the app failing, so a flow runner counts it as an environment failure. Absent on every other refusal. */
  reason?: 'agent-outdated'
}

// The only error on this surface whose correlator is optional, and it is not for compatibility.
// `AndroidAgent.restartVideoStream` sends this message with **no `device:boot` behind it** — a stream
// that died mid-session and failed to come back, reported through the one field the dashboard renders.
// So an unsolicited producer is not a possibility here, it is in the repo with a test on it, and a
// consumer that correlates this message drops the only report of a dead stream. See AGENTS.md.
export interface DeviceBootError extends SessionScoped {
  type: 'device:boot-error'
  message: string
  requestId?: string
  /**
   * Set only when the relay's per-host boot gate refused the boot, so a client can tell "wait and try
   * again" from a boot that failed. An agent's own boot failures carry no reason. See `BootRefusalReason`.
   */
  reason?: BootRefusalReason
}

/**
 * Why the relay refused a boot before it reached an agent. Only automated clients are refused; a person's
 * boot is held instead (`packages/relay/src/admission/`).
 *
 * - `host-booting`: another boot on the same Mac has not settled yet. One boot at a time is the rule,
 *   because a boot is what slows the other sessions on that Mac (`contributing/simulator-boot-contention.md`).
 * - `host-memory-critical`: the Mac's kernel reports critical memory pressure (`AgentResources.memoryPressure`).
 *   Another device started now would push the running ones into swap, so automated boots wait it out.
 * - `host-at-capacity`: the Mac already runs as many automation-started devices as it is allowed, and every one
 *   of them is in use. The relay shuts an idle one down to make room when it can, so this means none was idle.
 */
export type BootRefusalReason = 'host-booting' | 'host-memory-critical' | 'host-at-capacity'

/**
 * Every refusal a client may meet on its way to a booted device that means "the Mac is busy, not broken" —
 * all of them worth waiting out. A join refused for resources and a boot refused by the gate call for the same
 * response, so they are one type even though they arrive on different messages (`error.reason`,
 * `device:boot-error.reason`). Types only, like the rest of this entry; a client that needs the members at
 * runtime mirrors them in a `Record<AdmissionRefusal, true>`, as `SESSION_START_FAILURES` does.
 */
export type AdmissionRefusal = BootRefusalReason | Extract<SessionStartFailure, 'agent-resources-exhausted'>

export interface OpenUrlError extends SessionScoped {
  type: 'open-url:error'
  message: string
  requestId: string
}

export interface AppClearStateError extends SessionScoped {
  type: 'app:clear-state-error'
  message: string
  requestId: string
}

/**
 * **The guaranteed half is now the half that is a contract** (#491).
 *
 * `message` used to be required and `reason` optional, which is the inversion this message could least
 * afford: `packages/protocol/AGENTS.md` states the split on purpose — `message` is free prose each agent
 * owns, `reason` is the closed union consumers branch on — so the field a consumer was guaranteed to
 * receive was the one it must not depend on, and the one it should depend on could be absent.
 *
 * That was the correct way to *ship* it (#490): an agent predating the field omitted it and nothing broke.
 * It is not a correct end state, because every consumer carries an unknown-reason branch for as long as it
 * holds, and "absence means unknown" has to be re-derived by each new one.
 *
 * **Measured before flipping it: all six in-repo producers already send a reason**, two of them with
 * `satisfies InputErrorReason` on the literal — `IOSAgent.ts` (three sites), `AndroidAgent.ts` (two) and
 * `RelayServer.refuseInput`. The prerequisite was the relay, which used to send prose alone (#492, closed).
 * So this costs no in-repo change; what it buys is that an agent outside this repo cannot omit it, and that
 * a consumer written tomorrow cannot be handed an unanswerable failure.
 *
 * **`message` is optional rather than removed.** It still carries parameterised detail a closed union
 * cannot — `unknown key code: KeyFoo` — which is a debug and forward-compatibility field, and a debug field
 * should not be required. Display copy belongs to the presentation layer: agent-authored English cannot be
 * localised, and this product's audience is PO, PM, designers and QA. A structured `params` field is the
 * honest way to keep `KeyFoo` once prose is demoted, and it is deliberately **not** added here — #485 is
 * what will say whether a rendered UI misses the variable, and adding it now means guessing a schema from
 * no requirement.
 *
 * `InputTypeError` keeps `reason?` and that asymmetry is deliberate, not an oversight: its agent-side
 * producers answer with prose from a rejected `adb` or pasteboard write and have no reason to give. Only
 * the relay sets one. The field's own doc there records it.
 */
export interface InputError extends SessionScoped {
  type: 'input:error'
  /** Required — see `InputDone`. The relay produces this message too, so omission is a compile error there
   *  rather than something only a test could hold. */
  requestId: string
  reason: InputErrorReason
  message?: string
}

// `requestId` is required on the same terms, and with a narrower guarantee behind it: the forward
// gate resolves `sessionId` only, and both agents read the id as optional
// (`IOSAgent.ts:1078`, `AndroidAgent.ts:1262`) and pass it straight through. What holds today is
// that `ClipboardRequest.requestId` is required and the only requester — the dashboard's bridge —
// is typed with it; `mcp-server` and `flow-runner` send no clipboard message at all. When one of
// them gains a clipboard tool, this required field is what turns a missing id into a compile error
// instead of a reply the bridge drops on `if (!msg.requestId) return`. Holding the untyped senders
// to it is L4.
export interface ClipboardError extends SessionScoped {
  type: 'clipboard:error'
  message: string
  requestId: string
  payload?: ClipboardErrorPayload
}

/**
 * Why network control is not available on this device right now.
 *
 * A closed set for the same reason `InputErrorReason` is one: **a member exists per thing a
 * consumer must do differently**, not per internal state an agent can be in. Each of these makes a
 * different sentence on screen, which is what a single `available: boolean` could not do — and a
 * machine field nobody branches on is the shape this package forbids by name (#492).
 */
export type NetworkUnavailableReason =
  /**
   * The agent cannot reach inside this app, and knows it rather than suspecting it.
   *
   * Two observables, and they are different enough to name: the hooks were delivered and **proved by
   * trying** that they did not take, or the library that would be injected is **not on the machine
   * at all** — a damaged install, whose remedy is to reinstall rather than to retry. Both are
   * settled facts, which is what separates this member from `state-unconfirmed`.
   *
   * It was written for the first alone, and the second arrived with #653. The distinction that
   * matters to a consumer is unchanged — the control is dead and no button helps — so they stay one
   * member; but "the agent proved this by trying" was the whole doc, and it is false of the second.
   *
   * **A third arrived with #629, and it is not a settled fact — it is a deadline.** An app was
   * launched and wrote no verdict at all within the time one takes to write it, which happens when
   * the library is present and armed and dyld still does not load it: a wrong architecture, a runtime
   * change, a signature. Nothing was observed, and the member is chosen *because* nothing was.
   *
   * That makes it weaker than the two above and it is still this member rather than
   * `state-unconfirmed`, because the consumer's move is the same and `state-unconfirmed` promises that
   * looking again helps. Looking again does not help here; launching a different app might. Anyone
   * treating this member as proof should read this paragraph first.
   */
  | 'hooks-not-installed'
  /** Nothing was delivered for this boot — a re-arm that did not happen, or a device booted outside
   *  tapflow. Distinct from the above because the answer is to reboot the device, not to give up. */
  | 'not-armed'
  /**
   * Delivered, and waiting for an app to run under it.
   *
   * **The member that separates the two above from a device that is simply not being used yet.** On
   * iOS the injection is put in place when the device boots but can only name its target when an app
   * is launched, so between those two moments nothing has been proved either way — and both of the
   * reasons above would say something false about it. `not-armed` prescribes a reboot, which fixes
   * nothing here; `hooks-not-installed` says the agent cannot reach inside the app, which nothing has
   * established while the launch is still in flight.
   *
   * What a consumer must do differently: **say what is missing, and do not draw the control as
   * dead.** Traffic-level control does work in this state — a device taken offline here really does
   * stop reaching the network — so a rendering that reads "tapflow cannot change this" is wrong in
   * the one direction that makes a working control look broken. What it cannot do is make the app
   * *believe* it, which is the half the sentence has to carry.
   */
  | 'awaiting-app'
  /**
   * **The device was asked, answered, and had not moved.** The write was accepted, the read-back
   * *succeeded*, and it still reported the old value — a command that exists, is accepted, and does
   * nothing. That observable is the whole of what this member claims (#618). Every other Android
   * failure — a write that threw, a read that threw, an answer that did not parse — is
   * `state-unconfirmed`.
   *
   * **What it does not claim is a cause, and an earlier draft of this paragraph did.** It said this
   * was an image whose `cmd connectivity` predates the API, which is the obvious reading and is
   * contradicted by the repo's own measurement: such an image *throws from the write*
   * (`AdbWrapper.test.ts`), so it arrives as `state-unconfirmed` and never here. What does land here
   * — a policy restriction, a rule that has not taken effect yet — has not been measured, so nothing
   * is known about whether it lasts.
   *
   * So a consumer must **not** render this as permanent, and should keep offering the retry. The
   * distinction this member buys is that the device answered, which is worth a different sentence
   * from "we could not tell"; it does not buy a verdict about the future.
   */
  | 'unsupported-device'
  /**
   * **A read that could not be confirmed, so what the device is doing is not known.** On Android that
   * is an adb round trip failing: the write threw, or the read threw, or the answer did not parse. On
   * iOS it is the injected library's verdict file arriving in a shape that says nothing — caught
   * mid-write, since the library writes it non-atomically, but equally a file that parses and carries
   * no verdict. What it is *not* is a verdict about the device — the same shape is produced by a
   * device mid-reboot, a dropped adb connection, an image too old to have the command, and a read
   * that landed on a file with nothing in it to read.
   *
   * It said **Android only** while Android was the only producer. That was a note about who emits it,
   * not about what it means, and iOS reaching the same state did not change the meaning.
   *
   * What a consumer must do differently: **keep the position it already had and let the tester
   * retry.** `offline` here is the freshest evidence there is rather than a fresh reading — the last
   * confirmed value when a read failed, and the *requested* value when a write landed and could not be
   * read back, because a write that was accepted is better evidence than the state before it. What it
   * is never is `false` as a stand-in for "unknown": a device that went offline and then became
   * unreadable is still offline. **And when there is no evidence at all** — a device this agent has
   * never managed to read — there is no `offline` to give, and the frame is `NetworkUnobserved`
   * instead (#667). Answering `false` there is the same stand-in by another route.
   *
   * **Where `offline` is present**, it must not be rendered as an unknown *position*. That was tried
   * and reverted: from `unknown` every click asks for offline again, so nothing can bring the device
   * back online through the UI. Say the uncertainty some other way — the position is not the channel
   * for it. Where it is absent, `unknown` is not a rendering choice but the only true one.
   */
  | 'state-unconfirmed'
  /**
   * **iOS only.** This Mac cannot take a device offline: the host-side network filter is not
   * installed, not approved, or not enforcing. Nothing about the device is wrong, and no device is
   * affected — the request was **refused**, so no layer was applied.
   *
   * **`offline` is still the device's real state, and it is not always `false`.** An earlier draft of
   * this paragraph said it was, which would have been a promise the producer does not keep: not being
   * able to *change* the rule is not the same as nothing enforcing it, so a device that was already
   * offline is refused and stays offline. A consumer that drew `false` from this doc would render a
   * device it cannot reach as online — the exact direction the whole member exists to prevent.
   *
   * Refusing is the point. Two of the three layers work without the filter and neither blocks
   * traffic: the app would be told it is offline while its requests keep succeeding, which is
   * precisely the sign-off a tester must never be able to give.
   *
   * What a consumer must do differently: **send the tester to the setup steps**, which happen on the
   * agent Mac and need administrator rights. A retry from a browser cannot fix this and must not be
   * offered.
   */
  | 'filter-unavailable'
  /**
   * **iOS only.** The device *was* offline and enforcement stopped underneath it — the filter died,
   * was disabled, or came back holding a different rule. The layers have been taken down, so
   * `offline` is `false` and the device is back on the network.
   *
   * **This one invalidates work that already happened**, which no other member does. Between the
   * moment enforcement stopped and the moment it was noticed, requests the tester believed were
   * blocked were succeeding. Measured on the reference Mac: a provider killed and restarted by
   * launchd leaves the kernel passing traffic for about 5.8 seconds, and 23–27 requests got through
   * per occurrence.
   *
   * So it is the one reason that has to interrupt rather than re-colour: a tester who has already
   * signed off has to be told that what they saw did not hold. It arrives unsolicited — there is no
   * request it answers.
   */
  | 'enforcement-lost'

/**
 * What the device's network is doing, and whether tapflow can steer it.
 *
 * **Answers `network:set`, and is also sent unsolicited** — on `device:ready`, when a boot re-arms
 * the injection, when a session's condition is cleared, and in reply to `network:request-state` from
 * a viewer's re-join (#614) — **except** that a device never read is answered there with silence (see
 * `NetworkUnobserved`). So `requestId` is optional, and absent
 * means *this frame is not the answer to a request* — never "an old agent" (see
 * 「Lifecycle correlation」 in AGENTS.md for what that optionality costs and who pays it).
 *
 * `available` is separate from the `network-control` capability on purpose. The capability is
 * announced once at `agent:register`, before any device is booted or app launched, so it can only
 * ever mean "this agent has the code". Whether the hooks actually took is per device and per app,
 * and this is where that lives.
 */
/** The device is off the network right now, or is not, and tapflow can still change that. */
export interface NetworkSteerable {
  /**
   * Whether the device is off the network **right now**, as far as the agent can tell.
   *
   * **This describes the device, not the request.** A device taken offline and then left
   * unsteerable is *still offline* — see `NetworkNotSteerable`, which carries the same field for
   * that reason. Reporting `false` as a stand-in for "the request did not land" would render
   * "online" over a device whose app can reach nothing, sending every bug filed after it to the app
   * under test.
   */
  offline: boolean
  available: true
}

/** Whatever the device's network is doing, tapflow cannot steer it — and this is why.
 *
 * **Not "no longer".** That wording assumed the control had been working and stopped, which two
 * members contradict: `filter-unavailable` is a Mac that never could, and `state-unconfirmed` is one
 * adb round trip that failed under a control that is otherwise fine. */
export interface NetworkNotSteerable {
  /** Still the device's real state. See `NetworkSteerable.offline`. */
  offline: boolean
  available: false
  /** **Required here, and absent from the steerable member.** Written as prose first — "set when
   *  `available` is false, and only then" — which a single interface could not enforce: it admitted
   *  both `{ available: false }` with nothing to show a tester and `{ available: true, reason }`.
   *  Each value makes a different sentence on screen, so an unavailable state with no reason is a
   *  control that says it does not work and cannot say why. */
  reason: NetworkUnavailableReason
}

/**
 * **Where the device is, nobody knows** — it could not be read, and it never has been (#667).
 *
 * The one state where `offline` has no honest value. `NetworkNotSteerable` requires one, and its
 * fallback is the last observed position; a device this agent has never read has none, and every
 * value the field could take is a claim. `false` was the one producers reached for, and it is the
 * claim that hides the problem: a device someone took offline in the emulator's own UI, drawn online.
 *
 * **A member of its own rather than `offline?` on `NetworkNotSteerable`**, so the compiler keeps the
 * rule that only this reason can lack a position. `filter-unavailable` and `enforcement-lost` always
 * know where the device is, and an optional field there would let a producer forget to say.
 *
 * **Narrow on `p.offline === undefined`, never on `'offline' in p`.** The key is absent on the wire, but
 * an in-process producer can build the object with the key set to `undefined`, and the two disagree
 * under `in`.
 *
 * **What a released viewer does with it**, since agents and the relay are installed separately: a
 * dashboard from 0.20–0.26 reads `offline` as a truthy test and draws *online* — the same screen the
 * `false` stand-in drew before this member existed, so nothing gets worse for it. That comparison is
 * why the field is absent rather than a third string value: `'unknown'` is truthy, and those viewers
 * would have drawn a device nobody can read as *offline*.
 *
 * **Not sent in reply to `network:request-state`.** A viewer re-joining has its own way to reach
 * `unknown` — its report deadline — and on a released dashboard that silence is the honest path, where
 * this frame would draw online. It is sent on `device:ready` and in answer to `network:set`, which
 * must answer and which used to answer `false`.
 */
export interface NetworkUnobserved {
  available: false
  reason: 'state-unconfirmed'
  offline?: undefined
}

/**
 * What a device's network is doing and whether tapflow can steer it.
 *
 * **Named members rather than one interface with an optional field** — three since #667 — so the invariant is the
 * compiler's rather than a comment's. **And named rather than inline** so `agent-core` can
 * re-export instead of declaring a second copy — the rule `types.ts` already follows for
 * `ClipboardErrorPayload` — and so `scripts/__tests__/protocolPayloadTypes.test.mjs` can see the
 * shapes. That check reads named declarations; an inline payload is invisible to it, and so is a
 * union alias whose members are anonymous.
 */
export type NetworkStatePayload = NetworkSteerable | NetworkNotSteerable | NetworkUnobserved

export interface NetworkState {
  type: 'network:state'
  /** Inline rather than `extends SessionScoped`: that base is the **failure** family — every member
   *  of it carries a `message` and `protocolMessageNames` enforces that. This one reports state, not
   *  a failure, so it names its session the way `clipboard:data` does. */
  sessionId: string
  requestId?: string
  payload: NetworkStatePayload
}

/** A `network:set` that could not be dispatched or that the device refused. Relay-or-agent, because
 *  the relay answers one it cannot deliver rather than letting the viewer's control sit armed. */
export interface NetworkError extends SessionScoped {
  type: 'network:error'
  message: string
  requestId: string
}

export type RelayOrAgentToBrowser =
  | SessionChrome
  | SessionDeviceInfo
  // The agent produces it; the relay replays the cached copy to a re-joining viewer, exactly as it
  // does for `session:chrome` above.
  | DevicePostures
  | DeviceReady
  | AppInstallError
  | AppLaunchError
  | DeviceBootError
  | OpenUrlError
  | AppClearStateError
  | InputError
  // Moved out of `AgentToBrowser` in L5c: the relay originates this one now. An `input:type` whose session
  // the sender does not hold is refused here, and it has to be refused in *this* shape — the waiters in
  // `mcp-server` and `flow-runner` key on the `input:type-*` pair and ignore an `input:error` entirely,
  // which is why widening `TERMINAL_INPUT_TYPES` was never the fix for it.
  | InputTypeError
  | NetworkError
  | ClipboardError
  | DeviceShutdownError
  // Moved out of `AgentToBrowser` for the same reason as `input:type-error`: the relay answers an install with
  // `keepIfInstalled` itself when the build is already on the device, and it answers in the shape the install's
  // waiter reads.
  | AppInstallDone

export interface AgentsListed {
  type: 'agents:listed'
  sessions: SessionInfo[]
  /**
   * What this relay understands beyond the messages every relay does: `'device-lease'` (`device:lease`). A client
   * reads it before sending one, because an older relay drops an unknown message without a word and the client
   * would otherwise learn that only from its own deadline. Optional, unlike the rest of the listing: the
   * dashboard cannot skew from the relay it ships in, but a flow runner can, and an older relay omits the key.
   */
  features?: RelayFeature[]
}

/** Values of `AgentsListed.features`. A client meeting one it does not know ignores it.
 *  `'launch-options'`: `app:launch` carries `arguments` and `env` through. An older relay's validator strips both and
 *  still answers `app:launch-done`, so a client checks this before sending either. */
export type RelayFeature = 'device-lease' | 'launch-options'

export interface SessionJoined {
  type: 'session:joined'
  sessionId: string
  capabilities: string[]
  /** The dashboard page where teammates can watch this session, for a holder that declared an AI
   *  `clientKind` — **only when the relay knows an address teammates can open** (a tunnel, `relay.url`),
   *  the rule its invite links follow. Absent otherwise, and from an older relay: the client then builds
   *  the link from the address it dialled, which the person running it can open. Never sent for a
   *  person's session. */
  watchUrl?: string
}

export interface SessionTerminated {
  type: 'session:terminated'
  sessionId: string
  reason: SessionTerminatedReason
}

// The socket carrying this session's agent went away and the relay is holding the session open
// in case the agent comes back. Nothing is streaming. Sent so the viewer can say what is going on
// instead of showing a frame that stopped updating — the symptom #426 opened with.
//
// While the same browser socket stays attached, at most one of `session:rebound` (it came back)
// or `session:terminated` (it did not) follows. Both are addressed to `browserSocket`, so a
// viewer that disconnects in between gets neither, and re-joining re-sends this one.
export interface SessionAgentAway {
  type: 'session:agent-away'
  sessionId: string
}

// The agent behind this session restarted and the relay re-pointed the session at its new socket
// — same sessionId, nothing streaming. The viewer has to ask for the device again, because the
// codec negotiation and tier live in its own `device:boot` payload and nowhere the relay can see.
// `capabilities` rides along because `session:joined` is sent once and a restarted agent may
// advertise a different set (an upgrade is the usual reason to restart one).
export interface SessionRebound {
  type: 'session:rebound'
  sessionId: string
  capabilities: string[]
}

/**
 * Why a `session:start` could not be honoured. The same split as `InputErrorReason`: `message` stays
 * free prose the producer owns, and the machine field is closed.
 *
 * It exists because the dashboard was branching on the prose. Three wordings were sent and two were
 * handled, so `Session busy` — the reply a second tester gets when someone else already holds the
 * device — reached the viewer and did nothing at all, leaving the tab waiting on a `session:joined`
 * that cannot arrive. Nothing reported it, because from the outside the type *was* handled.
 *
 * **Required, unlike `InputErrorReason`.** That one is permanently optional because its producer set is
 * open by design — a third-party platform registers through `AgentRegistry.register()` and may predate
 * the field. This one has a single producer: the relay, at three sites in `handleSessionStart`. So the
 * compiler can insist, and it does — `sendTo` takes `RelayOutbound`.
 */
export type SessionStartFailure =
  /** No such session. Nothing else is ever coming for it. */
  | 'session-not-found'
  /** The session exists and another browser socket holds it. It is alive; this viewer cannot have it. */
  | 'session-busy'
  /** The Mac is over its resource ceiling and refused to take another session. */
  | 'agent-resources-exhausted'

/**
 * The answer to a `session:start` the relay refused. **Not a general escape hatch**, which is what this
 * comment used to claim — and the claim could not coexist with `SessionStartFailure`'s, one screen up, that
 * the reason has a single producer inside `handleSessionStart`. Both were in HEAD at once for two months.
 *
 * L5c settled it by removing the general role rather than the specific one: a request that names no session
 * is now **dropped at the relay's door** — by the inbound schema since #444 — because answering it would ship a frame whose own
 * required `sessionId` `JSON.stringify` erases, and `error` has no `requestId` either — so a caller could not
 * attribute the answer and would wait out the same deadline silence costs. With nothing left needing an
 * unaddressed failure, every producer of this message answers one specific join.
 *
 * **So it extends `SessionScoped`**, and that is the honest form rather than a field bolted on: the base's
 * own definition — a failure a *session* is waiting on — is now exactly what this is.
 * `protocolMessageNames.test.mjs` enforces that membership, and its note saying `error` "cannot be a
 * `SessionError`" described a nature that argument replaced. The base was called `SessionError` and carried
 * `message` until #491 demoted prose on `input:error`; `message` now sits on each member that requires it,
 * and what the base states is the one thing all nine share — the failure is addressed to a session.
 *
 * What the address buys: the join waiters in `mcp-server` and `flow-runner` matched
 * `sessionId === undefined || sessionId === mine`, and with no such key the left half was **always true**, so
 * any `error` resolved any pending join. Two concurrent `connect_device` calls and the first refusal woke the
 * wrong one — reported as a failure the other session never had, while the one that did fail waited out its
 * deadline. `dispatch` resolves only the first matching waiter, so that is one wrong answer and one timeout.
 *
 * The name stays `GenericError` despite the narrowed role. The derivation rule would give `Error`, which
 * shadows the global, so the exception exists for the literal rather than the role — renaming to
 * `SessionStartError` needs an exception entry just the same, and removing it needs a new wire literal.
 */
export interface GenericError extends SessionScoped {
  type: 'error'
  message: string
  reason: SessionStartFailure
}

/**
 * A `device:shutdown` that did not end with the device off — or may not have.
 *
 * **The pair's error member, added late and by a different producer than its `-done`.** Every other
 * browser-originated command answers when the relay cannot dispatch it; this one resolved its session
 * inline and dropped the frame in silence, so `mcp-server`'s `shutdownDevice` burned a 30s deadline and
 * reported `Request timed out` with no cause (#542). There was no shape to answer *with*, which is why
 * fixing it was a protocol change rather than a relay one.
 *
 * **Two producers and four outcomes**, which is why it sits in `RelayOrAgentToBrowser` beside
 * `DeviceBootError` (#455), and the wire does not say which:
 * - the relay could not dispatch it — nothing reached the device;
 * - the relay dispatched it and the session ended before the agent answered — the outcome is unknown;
 * - an agent attempted it and could not confirm it — both tear the session's stream down *before* they
 *   try, so the device may still be running with nothing streaming from it;
 * - an agent held no state for the session — nothing was attempted.
 *
 * So a consumer that renders it must not claim the device was left untouched, nor that it is still up.
 *
 * `requestId` is optional because **the request's is** — the relay originates `device:shutdown` from its
 * own idle timer, so a reply cannot demand a field the request need not carry. Absent here means the
 * same thing it means on `DeviceShutdownDone`: this frame answers no request.
 */
export interface DeviceShutdownError extends SessionScoped {
  type: 'device:shutdown-error'
  message: string
  requestId?: string
}

/** Why a `watch:start` was refused. One member per thing the viewer says differently. */
export type WatchRefusal =
  /** No such session — it ended, or the id was never valid. */
  | 'session-not-found'
  /** The session exists but is not an AI client's: unheld, held by a person, or by a client that did
   *  not declare its kind. */
  | 'not-watchable'
  /** This connection may not watch: an unauthenticated loopback socket. */
  | 'not-permitted'
  /** The session already has as many watchers as the relay allows. */
  | 'watchers-full'

/** The relay accepted a `watch:start`. The session's cached state follows, as it does for a re-join. */
export interface WatchStarted {
  type: 'watch:started'
  sessionId: string
}

export interface WatchRefused extends SessionScoped {
  type: 'watch:refused'
  reason: WatchRefusal
  message: string
}

/** The holder's socket dropped; the relay is holding the session for it to come back. A holder that leaves
 *  on purpose (`session:leave`) ends the watch instead — `watch:ended` with `session-ended`. The
 *  stream may continue meanwhile. A re-join by the same client keeps the watch; any other client binding
 *  the session ends it with `watch:ended`. */
export interface WatchHolderLeft {
  type: 'watch:holder-left'
  sessionId: string
}

/** Why a watch ended without the watcher asking. */
export type WatchEndReason =
  /** The session is gone, or its holder is done with it — its agent left, its holder ended it, or its
   *  holder left it on purpose (a flow run finishing, an MCP `disconnect_device`). */
  | 'session-ended'
  /** A different client now holds the session. It was not the session this watch was admitted to. */
  | 'holder-changed'

export interface WatchEnded {
  type: 'watch:ended'
  sessionId: string
  reason: WatchEndReason
}

/**
 * What the holder of a watched session just did, for its watchers only (A2). Built by the relay from the input and
 * app commands it passed on to the agent — "passed on", not "applied" — and from the holder's own `session:activity`
 * labels. Never the text typed (`type` carries a count) nor a URL opened. Nothing is stored: a watcher sees what
 * happens after it joins.
 */
export type WatchActionKind =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; from: [number, number]; to: [number, number] }
  | { kind: 'key'; key: string }
  | { kind: 'button'; button: string }
  | { kind: 'type'; chars: number }
  | { kind: 'pinch' }
  | { kind: 'launch' }
  | { kind: 'install' }
  | { kind: 'clear-state' }
  | { kind: 'open-url' }
  | { kind: 'label'; label: string }

export interface WatchAction {
  type: 'watch:action'
  sessionId: string
  /** The relay's clock, ms since the epoch. */
  at: number
  action: WatchActionKind
}

/** Messages the relay originates and no agent sends. */
/**
 * A person's boot the relay is holding until another boot on the same Mac has settled, or until the Mac's critical
 * memory pressure has passed. Sent when the boot is held, and again with the same `until` when what it waits for
 * changes; it then goes ahead by itself and `device:booting` follows. Answers the held boot,
 * so it carries its correlator. An automated boot is refused instead (`BootRefusalReason`) and never
 * receives this.
 */
export interface DeviceBootWaiting {
  type: 'device:boot-waiting'
  sessionId: string
  requestId: string
  /** Epoch ms after which the boot goes ahead even if the other has not settled. */
  until: number
  /** What it waits for. Read absence as `host-booting`, the only wait there was before the field. */
  reason?: BootRefusalReason
}

/**
 * The relay chose a device for a `device:lease`, made this client its holder and sent its boot. The boot's own
 * `device:ready` or `device:boot-error` follows with the lease's `requestId`, as it would for a `device:boot`, after
 * the `session:joined` a join sends. Sent before both, so the client knows which session they are about.
 */
export interface DeviceLeased {
  type: 'device:leased'
  requestId: string
  sessionId: string
  deviceId: string
  deviceName: string
  platform: 'ios' | 'android'
  /** `pool`: already up from an earlier automated boot, so the boot is warm. `boot`: started for this lease. */
  source: 'pool' | 'boot'
}

/**
 * No device could be leased now. Nothing was joined or booted. `retryable` says whether asking again can help:
 * every `AdmissionRefusal` and `all-held` can, the others will answer the same until something is changed.
 */
export interface DeviceLeaseRefused {
  type: 'device:lease-refused'
  requestId: string
  reason: LeaseRefusalReason
  message: string
  retryable: boolean
}

/**
 * - an `AdmissionRefusal`: every Mac with a fitting device refused it — the boot gate, the automation cap, or the
 *   CPU and memory a join is held to; the reason given is the one most worth waiting out.
 * - `all-held`: every fitting device is held by someone, or is a person's.
 * - `no-device`: no agent offers a device of this platform, or every one was excluded.
 * - `bad-request`: no platform could be read: none given, or the build named is not one this relay has.
 */
export type LeaseRefusalReason = AdmissionRefusal | 'all-held' | 'no-device' | 'bad-request'

export type RelayToBrowser =
  | RelayOrAgentToBrowser
  | AgentsListed
  | DeviceBootWaiting
  | DeviceLeased
  | DeviceLeaseRefused
  | SessionJoined
  | SessionTerminated
  | SessionAgentAway
  | SessionRebound
  | GenericError
  | WatchStarted
  | WatchRefused
  | WatchHolderLeft
  | WatchEnded
  | WatchAction

export interface DeviceBooting {
  type: 'device:booting'
  sessionId: string
}

export interface DeviceShutdownDone {
  type: 'device:shutdown-done'
  /** Absent = this shutdown was not requested by a browser — the relay's idle timer ran. */
  requestId?: string
  sessionId: string
  payload: { deviceId: string }
}

export interface AppInstallDone {
  type: 'app:install-done'
  sessionId: string
  requestId: string
}

/** The app was launched. Not that its screen is up: on iOS this follows the process start, on Android the first frame
 *  (`am start -W`, bounded at 10 s) — which can still be a splash. What a client may infer, and how flow-runner's `launchApp` waits, is in agent-core's
 *  `DeviceAgent.launchApp`. */
export interface AppLaunchDone {
  type: 'app:launch-done'
  sessionId: string
  requestId: string
  /** The keys the agent applied, present when the launch carried any. Names only: an env value can be a secret, and
   *  this reaches run records. A launch that sent keys and got no `applied` back lost them somewhere on the way. */
  applied?: LaunchApplied
}

export interface AppClearStateDone {
  type: 'app:clear-state-done'
  sessionId: string
  requestId: string
}

export interface OpenUrlDone {
  type: 'open-url:done'
  sessionId: string
  requestId: string
}

export interface InputDone {
  type: 'input:done'
  sessionId: string
  /**
   * Required, and this is the pair where an absent correlator costs the most. The four already correlated
   * arrive at the speed a person clicks a button; a swipe is dozens of frames, so a late ack landing in the
   * next input's waiter is not a corner case — it is #499.
   *
   * There is no unsolicited producer to make this optional (the discriminator this repo uses): `ackInput`
   * on both agents is the only sender, and it fires on terminal outcomes only. Contrast the lifecycle pair,
   * where an Android stream dying mid-session produces a `device:boot-error` answering nothing.
   */
  requestId: string
}

export interface InputTypeDone {
  type: 'input:type-done'
  sessionId: string
  requestId: string
}

export interface InputTypeError extends SessionScoped {
  type: 'input:type-error'
  message: string
  requestId: string
  /**
   * Optional because the agents' own failures carry none — they answer with prose from a rejected `adb` or
   * pasteboard write. The **relay** sets it, and without this field one of the five requests it can refuse
   * had no machine-readable answer at all: `not-session-owner`'s whole value is the promise that nothing
   * reached the device, and a consumer that can only read `message` cannot act on it. Branching on prose is
   * the thing #492 legislated against.
   */
  reason?: InputErrorReason
}

// iOS only — Android's `input:keyboard:toggle` is a client-side forwarding flag with no device
// side effect, so it has nothing to report back.
export interface KeyboardToggled {
  type: 'keyboard:toggled'
  sessionId: string
  payload: { visible: boolean }
}

export interface ClipboardData {
  type: 'clipboard:data'
  sessionId: string
  requestId: string
  payload: { text: string }
}

export interface ClipboardWriteDone {
  type: 'clipboard:write-done'
  sessionId: string
  requestId: string
}

/** Messages an agent produces. The relay forwards them byte-for-byte (`JSON.stringify(raw)`, the frame
 *  exactly as it arrived, so a field a newer agent adds is not stripped by a relay that does not know it) rather
 *  than re-creating them, so it never constructs one — which is exactly why they were missing from
 *  this file until L3: nothing on the relay's own send path referenced them.
 *
 *  The ones declared below carry `sessionId` as required, on two independent grounds: both agents
 *  include it in every send literal, and the relay's forward gate resolves `sessions.get(msg.sessionId)`
 *  before forwarding, so a message with no sessionId never reaches a browser by this path.
 *
 *  Every member inherited from `RelayOrAgentToBrowser` carries it too except `device:ready` — deliberately no
 *  count, because members move into that union whenever the relay starts producing one. Three of them
 *  (`session:chrome`, `session:deviceInfo`, `device:ready`) were `sessionId?` for as long as the relay's
 *  replay omitted what both agents stamped. Two ways to tighten the *declaration* were weighed and
 *  rejected — declaring the three twice (drift, which is the finding this surface exists to remove), and
 *  mapping the union through `Omit<T,'sessionId'> & { sessionId: string }`.
 *
 *  The recorded reason for rejecting the second one does not survive checking, and it is worth saying so
 *  rather than deleting it: it claimed the mapping breaks `useClipboardBridge`, which reads its replies
 *  through `Extract<>`. It does not — that hook takes the three replies as **named members**
 *  (`ClipboardData | ClipboardWriteDone | ClipboardError`) and says so in its own comment, and its only
 *  `Extract` is over `ClipboardRequest`, an outbound union this mapping would never touch.
 *
 *  It does not change the outcome, because both alternatives are ways to make one declaration describe
 *  two producers that disagree, and the disagreement was the defect. The relay stamps the first two now.
 *  `device:ready` stays optional for a different reason — see the note above the declarations. */
export type AgentToBrowser =
  | RelayOrAgentToBrowser
  | DeviceBooting
  | DeviceShutdownDone
  | AppLaunchDone
  | AppClearStateDone
  | OpenUrlDone
  | InputDone
  | InputTypeDone
  | KeyboardToggled
  | ClipboardData
  | NetworkState
  | ClipboardWriteDone

/** Everything a browser socket can receive, whoever produced it. This is what a viewer's message
 *  handler should be typed with — the two unions above answer "who sends this", which matters to
 *  the relay and not to the consumer. */
export type BrowserInbound = RelayToBrowser | AgentToBrowser

/** The agent's *stream* socket, not a browser. Its own direction because it has its own audience:
 *  the consumer is `agent-core`'s stream registration, and nothing in a browser reads it. */
export interface StreamRegistered {
  type: 'stream:registered'
}

export type RelayToStream =
  | StreamRegistered

/** Everything the relay originates. Messages it merely forwards keep their inbound type — they are
 *  not re-created, so they are not checked against this union. */
export type RelayOutbound = RelayToAgent | RelayToBrowser | RelayToStream

// ── agent → relay ────────────────────────────────────────────────────────────
//
// The last direction to be declared. Until L4a an agent built these literals and handed them to
// `ws.send` with nothing checking the result, which is where #489 (an agent answering nobody) and #490
// (a missing `reason`) came from — and why `scripts/__tests__/inputErrorReason.test.mjs` exists at all:
// the compiler could not see an agent's literal, so a script had to.

/** The agent's opening message on its control socket, sent from inside `onopen`. */
export interface AgentRegister {
  type: 'agent:register'
  /** Open on purpose — **not** `'ios' | 'android'`. A third-party platform registers through
   *  `AgentRegistry.register()` (root AGENTS.md, OCP), and narrowing this would stop it producing a
   *  valid registration. `agent-core`'s own `Platform` is `string` for the same reason. */
  platform: string
  /** What this agent implements, as plain strings on the wire. `agent-core`'s `AgentCapability` is
   *  assignable to it; the wire does not close the set. */
  capabilities: string[]
  /** Stable per-machine id (macOS IOPlatformUUID). **Optional because `getMachineId()` returns
   *  `undefined` off darwin**, and the relay falls back to `agentName` for dedup. */
  agentId?: string
  agentName: string
  devices: DeviceReport[]
}

/** The agent's whole device list, sent when it changed after registration (#1085). Full rather than a delta: the
 *  relay diffs it against its own sessions, so a lost reply cannot leave the two out of step. Sent only to a relay
 *  that announced `'device-updates'`. */
export interface AgentDevices {
  type: 'agent:devices'
  devices: DeviceReport[]
}

/** Periodic load report. The relay gates new sessions on it. */
export interface AgentResourceReport {
  type: 'agent:resources'
  resources: AgentResources
}

export interface ScreenshotDone {
  type: 'screenshot:done'
  sessionId: string
  requestId: string
  /**
   * What the agent produced — the relay turns this into the HTTP `Content-Type`.
   *
   * The **only** field on this pair that describes an outcome; the request's `format` is a
   * preference (see `ScreenshotRequest`). Android echoed the request here while always producing
   * PNG, so a JPEG request came back as PNG bytes labelled `image/jpeg` (#508).
   *
   * Still a claim rather than a guarantee: it is what the agent *says*, and an agent older than the
   * fix says the wrong thing. The relay logs a mismatch against the bytes but does not overwrite
   * this — a consumer whose behaviour depends on the real format sniffs the bytes itself.
   */
  format: 'png' | 'jpeg'
  /** base64. */
  data: string
}

/** A screenshot that failed.
 *
 *  **Does not extend `SessionScoped`**, unlike every other `*-error`, because it is not addressed to a
 *  session: the relay resolves the pending promise by `requestId` alone. The base is for a failure a
 *  *session* is waiting on, and drawing that line is what keeps it meaningful.
 *
 *  `sessionId` is still **required**, because every producer has one. An earlier draft made it optional
 *  on the grounds that the agents pass through an optional id — true when written, and false by the end
 *  of the same change, which required it on both dispatchers. A field weaker than every producer
 *  describes a message nobody sends, and here it would also remove the one field a symmetric ownership
 *  check could read: the clipboard replies beside these verify `session.agentSocket === ws` before
 *  resolving, and these two do not. */
export interface ScreenshotError {
  type: 'screenshot:error'
  sessionId: string
  requestId: string
  message: string
}

export interface UiTreeResponse {
  type: 'ui:tree:response'
  sessionId: string
  requestId: string
  elements: UIElement[]
}

/** Request-scoped, for the same reasons as `ScreenshotError`. */
export interface UiTreeError {
  type: 'ui:tree:error'
  sessionId: string
  requestId: string
  message: string
}

export type AgentToRelay =
  | AgentRegister
  | AgentDevices
  | AgentResourceReport
  | ScreenshotDone
  | ScreenshotError
  | UiTreeResponse
  | UiTreeError

// ── stream socket → relay ────────────────────────────────────────────────────

/** Its own direction, mirroring `RelayToStream`. The relay assigns the role `'stream'` from this
 *  message rather than `'agent'` (`RelayServer.ts:554-557`), so putting it in `AgentToRelay` would make
 *  that union's name disagree with the runtime role — and would let a control socket claim to be a
 *  session's stream socket once L4b narrows inbound by role. */
export interface StreamRegister {
  type: 'stream:register'
  sessionId: string
}

export type StreamToRelay = StreamRegister

/** The three replies a clipboard request can get. Both agents build these through a local `respond`
 *  helper that merges the correlation ids, and that helper took `object` — so the replies were the last
 *  send path in the clipboard code that nothing checked. The consumer side names the same set
 *  (`useClipboardBridge`), so it lives here rather than in either. */
export type ClipboardReply = ClipboardData | ClipboardWriteDone | ClipboardError

/** A `ClipboardReply` minus the ids the sender merges in. Distributive, so each member keeps its own
 *  payload — a plain `Omit` would collapse them into one shape and stop checking which goes with which. */
export type ClipboardReplyBody<T = ClipboardReply> = T extends unknown ? Omit<T, 'sessionId' | 'requestId'> : never

/** The replies an `open-url` request can get. */
export type OpenUrlReply = OpenUrlDone | OpenUrlError

/** An `OpenUrlReply` minus the ids the sender merges in — the `ClipboardReplyBody` shape.
 *
 *  **What it buys, exactly.** A first draft of this comment claimed it made the echo obligation
 *  unstateable-otherwise and therefore removed the need for any check. Review measured that against 13
 *  attacks and it is false: `sendMsg` takes `AgentControlOutbound`, whose `OpenUrlDone`/`OpenUrlError`
 *  members declare `requestId: string`, so any site with any string in scope emits a fully-typed, fully
 *  wrong reply without going through the helper at all. The helper is convention, not a type boundary.
 *
 *  What it does buy is one thing worth having: at a `respond({ … })` call, a **freshly minted id written
 *  as a literal** is an excess property. It does not survive a body *variable* — excess-property checking
 *  does not fire on those — which is why the agents spread `...body` **first** and put the ids last, so a
 *  variable that carries one cannot override the real one.
 *
 *  Omission is caught, but by `requestId: string` being required on the reply interfaces rather than by
 *  this type. The rest is carried by each agent's echo tests, and each remaining correlation pair needs
 *  its own pair of them. A check can see that a field is present; it cannot see that the value came from
 *  the request, which is the actual property — that part of the original reasoning stands, and it is why
 *  the answer is tests at the sites rather than a cleverer checker. */
export type OpenUrlReplyBody<T = OpenUrlReply> = T extends unknown ? Omit<T, 'sessionId' | 'requestId'> : never

/** The app-command pairs, same shape as `OpenUrlReplyBody` and for the same reason — see the note there
 *  for exactly what it buys and what it does not.
 *
 *  There is deliberately **no request-direction counterpart.** One was designed and measured: a branded
 *  correlator is laundered by any cast to the brand, because a brand names a *kind* while provenance is a
 *  property of the *instance* and TypeScript has no value-dependent types; and a generic `Omit`-body
 *  helper does not compile without a cast of its own, which is worse than the literal it replaces since a
 *  literal at least gets its whole shape checked. The reply side is worth the type because there are
 *  ~20 literal sites; the request side has one per pair, on the line below the helper that builds it. So
 *  the relay's "carries the request's id" is held by tests, not by a type. */
export type AppInstallReply = AppInstallDone | AppInstallError
export type AppInstallReplyBody<T = AppInstallReply> = T extends unknown ? Omit<T, 'sessionId' | 'requestId'> : never

export type AppLaunchReply = AppLaunchDone | AppLaunchError
export type AppLaunchReplyBody<T = AppLaunchReply> = T extends unknown ? Omit<T, 'sessionId' | 'requestId'> : never

export type AppClearStateReply = AppClearStateDone | AppClearStateError
export type AppClearStateReplyBody<T = AppClearStateReply> = T extends unknown ? Omit<T, 'sessionId' | 'requestId'> : never


/** What an agent's **control** socket carries. This is what the agents' send helpers take.
 *
 *  `StreamToRelay` is deliberately *not* in it. Splitting `stream:register` into its own direction was
 *  justified above by the hazard of a control socket claiming to be a session's stream socket — and a
 *  union that re-merged them would have handed that hazard straight back, since `case 'stream:register'`
 *  calls `setStreamSocket(session.id, ws)` with no role gate. The stream socket's one message is typed
 *  at its own send site in `agent-core/src/utils/stream.ts`. */
export type AgentControlOutbound = AgentToRelay | AgentToBrowser

/**
 * Every message this protocol declares, reached through the seven directions.
 *
 * Not a fourteenth union for its own sake: it is what lets a consumer assert that its own list of
 * literals is *complete* rather than merely correct so far. `relay/src/types.ts` keeps such a list —
 * hand-maintained, 62 entries, and missing `stream:request-idr` until this change, which is the exact
 * drift this package was created to end (see AGENTS.md).
 *
 * The fact it restates is small and stable — **which directions exist** — not the 63 literals inside
 * them. A message added to a direction flows in here for free; a message added to *no* direction does
 * not, and nothing here can see that. That gap is real and is not this union's to close.
 */
export type AnyWireMessage =
  | BrowserToRelay
  | RelayToBrowser
  | AgentToRelay
  | AgentToBrowser
  | RelayToAgent
  | StreamToRelay
  | RelayToStream

// ── browser → relay ──────────────────────────────────────────────────────────

/** Key input. The payload carries `code` — a `KeyboardEvent.code` name — and `modifiers` as a
 *  **bitmap**, not a list and not `key`.
 *
 *  The dashboard union declared `{ key: string }` while every sender and both agents used
 *  `{ code, modifiers }`; the mismatch survived because `send()` took `object`. The authority is
 *  the consumer: `IOSAgent.ts` reads `{ code: string; modifiers?: number }` and passes the number
 *  straight to `touchHelper.sendKey(usage, modifiers ?? 0)`, where it is the HID modifier bitmap
 *  documented in packages/ios-agent/AGENTS.md (touch-helper type 9). */
export interface InputKey {
  type: 'input:key'
  sessionId: string
  /**
   * Required. A terminal input is the only kind that gets an ack, and #499 is what an unattributed one
   * costs: an ack that arrives after its own deadline is consumed by the **next** input's waiter, which
   * then reports the previous input's outcome — including reporting an unanswered input as landed.
   *
   * Opening and move frames deliberately do **not** carry this. They get no reply
   * (`ios-agent/AGENTS.md`: "Opening frames stay silent: they carry no ack obligation"), so an id there
   * would be minted for a waiter that does not exist. Nor does `input:rotate`, for the same reason.
   */
  requestId: string
  payload: { code: string; modifiers?: number }
}

export interface Point {
  x: number
  y: number
}

/** The two clipboard requests a viewer can make. Kept as its own union because the bridge sends
 *  them through one call that takes the type as an argument. */
export interface ClipboardRead {
  type: 'clipboard:read'
  sessionId: string
  requestId: string
  payload?: { press?: 'copy' | 'cut' }
}

export interface ClipboardWrite {
  type: 'clipboard:write'
  sessionId: string
  requestId: string
  payload: { text: string; pasteAfter?: boolean }
}

export type ClipboardRequest =
  | ClipboardRead
  | ClipboardWrite

/**
 * Take the device under test off the network, or put it back (#607).
 *
 * `requestId` is **required**, like the clipboard pair: every producer is a viewer acting on a
 * control, so an id is always available, and requiring it makes a missing one a compile error
 * rather than a reply the viewer drops.
 */
export interface NetworkSet {
  type: 'network:set'
  sessionId: string
  requestId: string
  payload: { offline: boolean }
}


export interface AgentsList {
  type: 'agents:list'
}

export interface SessionStart {
  type: 'session:start'
  sessionId: string
  /** What the joining client is. Absent from a client that predates the field, which the relay treats as
   *  a session nobody may watch — no inference from the credential, which a new auth method would break.
   *  See `ClientKind`. */
  clientKind?: ClientKind
  /** `false` from a client that never reads the stream (the MCP server; the flow runner when it is not recording
   *  video): the relay sends this holder no stream frames, video or audio. Watchers are unaffected. Absent or `true`
   *  is as before. An older relay drops the key and keeps sending. */
  stream?: boolean
}

/**
 * Watch a session another client holds, read-only. Only a session whose
 * holder declared an AI `clientKind` can be watched, and only by a cookie session or a remote PAT with
 * `view` — never by an unauthenticated loopback socket.
 *
 * A watching socket receives the stream and the session's lifecycle (`WATCHER_MESSAGES` in the relay),
 * and nothing it sends reaches the device: input is refused by the ownership gate, and `session:start`,
 * `device:boot` and `device:shutdown` for the watched session are refused outright.
 */
export interface WatchStart {
  type: 'watch:start'
  sessionId: string
}

/**
 * A human-readable name for what the holder is about to do — a flow step — shown to the session's watchers (A2).
 * Unanswered and optional: an older relay drops the unknown type without a reply, so a client sends it and moves on.
 * At most 200 characters, and never something typed or a URL: watchers are the whole team.
 */
export interface SessionActivity {
  type: 'session:activity'
  sessionId: string
  label: string
}

/** Stop watching. Unanswered: there is no waiter, and closing the socket does the same. */
export interface WatchStop {
  type: 'watch:stop'
  sessionId: string
}

// The relay handles `session:end`, but nothing in this repo sends it — the dashboard and
// mcp-server both use `session:leave`. Kept because the relay's handler is the contract for any
// client that does send it; remove it here only together with that handler.
export interface SessionEnd {
  type: 'session:end'
  sessionId: string
}

export interface SessionLeave {
  type: 'session:leave'
  sessionId: string
}

// `external` and `automation` are added by the relay on the way through — the browser never sets them.
// Undeclared on purpose: the parser strips both from what a browser sends, and the relay sets them after it.
export interface DeviceBoot {
  type: 'device:boot'
  sessionId: string
  /**
   * Required, unlike every reply in this pair. Absence has no legitimate meaning on the request side —
   * nothing originates a boot but a browser, so there is no producer for an id-less one to belong to.
   * This is what puts `device:boot` inside 「No fallback, and one policy at the door」: required is what
   * `correlatedRequestsGated` derives its set from, and what makes the relay's door gate reachable.
   *
   * `device:shutdown` below stays optional for the opposite reason — the relay sends that one itself.
   */
  requestId: string
  payload: { deviceId: string; resetMode?: 'app-only' | 'full-erase'; acceptH264?: boolean; secureContext?: boolean; serviceTier?: ServiceTier; runReset?: RunResetRequest }
}

/**
 * Ask the relay for a device instead of naming one: it picks a free device of the platform — one automation left
 * up first, then one it boots on the Mac with the most room — makes this client its holder and boots it, all in one
 * step, so two clients asking at once never get the same device and every boot still passes the Mac's boot gate.
 * Answered by `device:leased` then the boot's reply, or by `device:lease-refused`. Send only to a relay listing
 * `'device-lease'` in `AgentsListed.features`.
 *
 * No `sessionId`: choosing the session is what this asks for. So a malformed payload has no address to be refused
 * at, and every payload field reads an unusable value as absent instead; the relay then refuses what it cannot
 * serve with `bad-request`.
 */
export interface DeviceLease {
  type: 'device:lease'
  requestId: string
  payload: {
    /** Required unless `buildId` is given; with both, the build's platform wins. */
    platform?: 'ios' | 'android'
    /** The build the run installs. The relay reads its platform, which a client holding only `view` cannot. */
    buildId?: number
    serviceTier?: ServiceTier
    acceptH264?: boolean
    runReset?: RunResetRequest
    /** As on `session:start`. */
    stream?: boolean
    /** Sessions not to lease: ones this run already saw fail. */
    exclude?: string[]
  }
}

export interface AppInstallToRelay {
  type: 'app:install'
  sessionId: string
  requestId: string
  buildId: number
  /**
   * Install only if this build is not already on the device. The relay answers `app:install-done` itself when it
   * last installed this build there, and joins an install of it already in flight. A viewer sends it when coming
   * back to a device it was using, because every install clears the app's data first (iOS uninstalls, Android
   * clears) — so reinstalling on a reconnect would cost the tester the state they came back for.
   *
   * Absent means install as before. A relay that predates the field strips it and reinstalls, which is the
   * behaviour from before it existed.
   */
  keepIfInstalled?: boolean
}

export interface AppLaunchToRelay extends LaunchOptions {
  type: 'app:launch'
  sessionId: string
  requestId: string
  buildId: number
}

/** Wipe an installed app's data.
 *
 *  `bundleId` is **required, twice over** — the field and the payload. It was `payload?: { bundleId?: string }`,
 *  which was looser than every producer *and* every consumer: `mcp-server` and `flow-runner` are its only
 *  senders (the dashboard resets through `device:boot` instead) and both supply a string, and both agents answer
 *  `app:clear-state-error` with `'bundleId missing'` when it is absent. A field weaker than every producer
 *  describes a message nobody sends.
 *
 *  What required buys is a **compile error for a future sender**, no more. The agents keep that branch and
 *  should: `bundleId: ''` type-checks — the door checks the *shape*, and an empty string is a valid one
 *  everywhere but the two correlation fields, which carry `.min(1)`. So this is the same
 *  argument as `sessionId` below, not a stronger one.
 *
 *  Unlike `app:install` / `app:launch`, which carry a `buildId` the relay resolves into a bundle id from the
 *  builds table, this message is passed through untouched. That is an **absence of relay-side resolution, not a
 *  design** — the machinery exists next door. It stays client-supplied because clearing a *different* app is a
 *  documented flow step (`clearState: com.other.app`), so the field has to be expressible either way; adding a
 *  relay-filled form would be a new feature, not a contract alignment. */
export interface AppClearState {
  type: 'app:clear-state'
  sessionId: string
  requestId: string
  payload: { bundleId: string }
}

/** First message of the correlation work (L5). `requestId` is **required on the request and on both
 *  replies**, which is the same shape the three pairs that already work use — `screenshot`, `ui:tree`
 *  and `clipboard` all declare it required on the reply too, including the four an *agent* produces.
 *
 *  The alternative considered was optional-on-the-reply, so that an agent predating the field would not
 *  make the declaration false. It was rejected on measurement rather than taste:
 *
 *  - Required yields **complete, precise** in-repo compile errors — seven, at exactly the seven
 *    production sites for this pair, nothing else. The write side is fully covered because L4a routed
 *    every agent send through a typed helper.
 *  - Optional needs a static check to replace the compiler, and that check **cannot exist.** Presence is
 *    checkable; the property is *provenance* — that the id is the request's. A check built and run
 *    against the clipboard family (100% correlated today) produced seven false positives, because
 *    `respond({ sessionId, requestId, ...body })` puts the `type` literal and the id in different object
 *    literals; and it passed when an echo was replaced with a freshly minted id.
 *  - Absence would carry **two** meanings that want opposite handling: "an old agent" and "not a reply at
 *    all". The relay's `device:ready` replay is a permanent in-repo producer of the second, and treating
 *    it as the first is the `{booted: true}` for a boot that never happened that #516 measured and
 *    refused to ship. Required makes absence mean "not a reply", unambiguously — which is what makes
 *    that message tightenable at all.
 *
 *  There is deliberately **no fallback** to the old `sessionId` + type matching. The `fixed` version
 *  group in `.changeset/config.json` locks protocol, agent-core, both agents and the relay together, so
 *  the in-repo skew window is zero; a third-party agent predating this is a release-note matter. A
 *  permanent fallback would be a fifth correlation strategy in the layer whose goal is to have one. */
export interface OpenUrl {
  type: 'open-url'
  sessionId: string
  requestId: string
  payload: { url: string }
}

/** Which picture a touch's fractions are of. **Absent means the screen the device draws** — the space of MCP's
 *  screenshot, the UI tree and a flow, and what every sender but one uses. `'frame'` means the video frame as it
 *  arrives, which on an Android emulator turned in the hand is that screen turned by the capture's correction.
 *  The dashboard's body mode sends it so the agent turns the point by the frame it holds now: turned by the
 *  chrome's correction instead, a touch had to wait out the 0.6–3.6 s the chrome lags a turn.
 *
 *  An agent that does not know the field reads the point as the screen, a quarter off on a turned body — so a
 *  sender uses it only toward an agent that reported `AndroidChrome.bodyRotation`, which is the marker. */
export type PointSpace = 'frame'

export interface TouchPoint extends Point {
  space?: PointSpace
}

export interface InputTouchStart {
  type: 'input:touch:start'
  sessionId: string
  payload: TouchPoint
}

export interface InputTouchMove {
  type: 'input:touch:move'
  sessionId: string
  payload: TouchPoint
}

// `payload` is accepted but ignored: the agents call `touchEnd()` without reading it. The
// dashboard omits it, mcp-server sends the last point. Optional here because that is what the
// wire actually carries — not because the coordinate means anything on this message.
export interface InputTouchEnd {
  type: 'input:touch:end'
  sessionId: string
  requestId: string
  payload?: Point
}

export interface InputPinchStart {
  type: 'input:pinch:start'
  sessionId: string
  /** `space` as on a touch — see `PointSpace`. */
  payload: { f0: Point; f1: Point; space?: PointSpace }
}

export interface InputPinchMove {
  type: 'input:pinch:move'
  sessionId: string
  /** `space` as on a touch — see `PointSpace`. */
  payload: { f0: Point; f1: Point; space?: PointSpace }
}

export interface InputPinchEnd {
  type: 'input:pinch:end'
  sessionId: string
  requestId: string
}

export interface InputType {
  type: 'input:type'
  sessionId: string
  requestId: string
  payload: { text: string }
}

export interface InputButton {
  type: 'input:button'
  sessionId: string
  requestId: string
  payload: { name: string; phase?: 'down' | 'up' }
}

export interface InputRotate {
  type: 'input:rotate'
  sessionId: string
  /**
   * Where to turn the device, rather than "turn it" (#910). A toggle has a memory on each side, and the
   * agent's resets on every re-register while the device stays put — after which an undo meant
   * "go portrait" turned it landscape and every later press stayed inverted. A target is safe to repeat.
   *
   * **Or a quarter turn from where the device is** (`direction`), for an agent that knows the device's
   * physical orientation — DeviceHub's own rotate button, and the only form whose meaning does not depend
   * on which landscape or which panel the device is on. The agent turns from the orientation it reads just
   * before — never from a per-session memory, which is what #910 was about. Sent only to a device whose
   * chrome reports the body's turn — iOS `ChromeData.streamRotation`, Android `AndroidChrome.bodyRotation`;
   * an agent that predates the member ignores it and toggles.
   *
   * Optional for skew: an agent that predates it ignores the field and toggles, as before. Without it,
   * an agent toggles.
   */
  payload?: { orientation: 'portrait' | 'landscape' } | { direction: 'clockwise' | 'counterclockwise' }
}

/**
 * One physical arrangement of a device's screens — folded, unfolded, and whatever else a platform
 * offers.
 *
 * **`id` is opaque and platform-owned.** Android's are `cmd device_state` names, and a future
 * platform's will be something else; nothing outside the agent that produced it may compare one to
 * a literal. That is the same rule `Platform` follows (a `string`, so a third-party agent can
 * register one) and for the same reason.
 *
 * **No size.** A posture is not identified by its screen: on a Pixel 9 Pro Fold, `CLOSED` and
 * `REAR_DISPLAY_MODE` both present 1080x2424. And a screen's size is a function of posture *and*
 * rotation, so a size carried here would be false the first time the user rotates. The size a
 * viewer needs is in `session:chrome`, which is re-sent when it changes.
 */
export interface DevicePosture {
  id: string
  /** Final, human-readable text. The dashboard renders it as given rather than mapping it — a map
   *  would have to grow a case per platform, which is what `AgentRegistry` exists to avoid. */
  label: string
}

/** Ask the device to take a posture. Answers nothing, like `input:rotate`: the change shows up as a
 *  new `device:postures` and, when the screen changed with it, a new `session:chrome`. */
export interface InputPosture {
  type: 'input:posture'
  sessionId: string
  payload: { postureId: string }
}

/**
 * The postures this device has, and which one it is in.
 *
 * **Ordered most closed → most open.** That ordering is the contract, and it is what lets a viewer
 * render a control without knowing any platform's vocabulary: draw the list in order and the
 * left-hand end is "shut". A device that does not fold sends an empty list, which is how a viewer
 * knows to show nothing.
 */
export interface DevicePostures {
  type: 'device:postures'
  sessionId: string
  payload: PosturesPayload
}

/** The payload of `device:postures`, named because the relay caches it for the re-join replay —
 *  the same reason `ChromePayload` has a name. */
export interface PosturesPayload {
  postures: DevicePosture[]
  currentId: string | null
}

export interface InputKeyboardToggle {
  type: 'input:keyboard:toggle'
  sessionId: string
}

export type BrowserToRelay =
  | AgentsList
  | SessionStart
  | SessionEnd
  | SessionLeave
  | DeviceBoot
  | DeviceLease
  | DeviceShutdown
  | AppInstallToRelay
  | AppLaunchToRelay
  | AppClearState
  | OpenUrl
  | InputTouchStart
  | InputTouchMove
  | InputTouchEnd
  | InputPinchStart
  | InputPinchMove
  | InputPinchEnd
  | InputKey
  | InputType
  | InputButton
  | InputRotate
  | InputPosture
  | InputKeyboardToggle
  | ClipboardRequest
  | NetworkSet
  | WatchStart
  | WatchStop
  | SessionActivity

