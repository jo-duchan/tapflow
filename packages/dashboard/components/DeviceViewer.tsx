'use client';

import type { BrowserToRelay, SessionTerminatedReason } from '@tapflowio/protocol'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRelay } from '@/hooks/useRelay';
import { usePerfMode } from '@/hooks/usePerfMode';
import { IOSViewer } from './device/IOSViewer';
import { AndroidViewer } from './device/AndroidViewer';
import { SimulatorInfoCard } from './device/shared/SimulatorInfoCard';
import type { AndroidChrome, ChromeData, BrowserInbound } from '@/lib/types';
import type { FrameTiming, PerfHook } from './perf/types';
import { parseEnvelopeHeader, HEADER_SIZE, CODEC_H264, CODEC_AUDIO, type BinaryFrameHandler } from '@/lib/envelope';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import type { ClipboardMessageHandler } from '@/hooks/useClipboardBridge';
import type { NetworkMessageHandler } from '@/hooks/useNetworkControl';
import { canDecodeH264 } from '@/lib/decoders/pickDecoder';
import { fitsSideBySide, BEZEL_PADDING_W } from '@/lib/coordinate-transform';
import { resolveInputError } from '@/lib/inputErrorNotice';
import { newRequestId } from '@/lib/requestId';
import { StatsOverlay } from './perf/StatsOverlay';
import { MetricsPanel } from './perf/MetricsPanel';
import { toast } from 'sonner';

interface Props {
  sessionId: string;
  deviceId: string;
  buildId?: number;
  resetMode?: 'app-only' | 'full-erase';
  /** Available width (CSS px) for the whole viewer, measured by the page around it. `0`/absent
   *  means unmeasured — the viewer falls back to its unconstrained desktop sizing. */
  widthBudget?: number;
  onRecordingUploaded?: () => void;
  /** Why this viewer stopped. The viewer cannot recover from any of these on its own — it holds a
   *  socket it can make no further progress on — so it reports upward and the parent decides where to go.
   *
   *  A **superset** of why the *relay* terminated the session. `busy-elsewhere` is the dashboard's own:
   *  the session is alive and another socket holds it, so no protocol reason describes it, and widening
   *  `SessionTerminatedReason` would let `session:terminated` carry a reason it can never mean. */
  onSessionEnded?: (reason: SessionTerminatedReason | 'busy-elsewhere' | 'mac-overloaded') => void;
}

export function DeviceViewer({ sessionId, deviceId, buildId, resetMode, widthBudget, onRecordingUploaded, onSessionEnded }: Props) {
  const sendRef = useRef<(msg: BrowserToRelay) => void>(() => {});
  // One reset per mount; see the boot handler below.
  const resetSentRef = useRef(false);
  // How many rebind re-boots are still waiting for their `device:ready`, and whether the app was
  // actually on the device when the first of them started.
  //
  // A counter, not a flag: a crash-looping agent produces several rebinds, each with its own boot
  // and its own ready. A boolean is cleared by the first ready, and the second then reinstalls —
  // destroying the app state this exists to preserve.
  //
  // `appInstalled` is captured because a rebind can land *during* an install, which is if anything
  // the likelier moment for an agent to die. Then the app is genuinely absent and the re-boot has
  // to install it after all; assuming otherwise leaves a Launch button for an app that is not
  // there. It cannot be read from `installed` at ready-time either — `device:booting` clears that
  // flag and the agent sends it on every boot, so it is always false by then.
  const rebindRef = useRef<{ pending: number; appInstalled: boolean }>({ pending: 0, appInstalled: false });
  const { perfMode, visible: perfVisible } = usePerfMode();

  // statsRef is set by StatsOverlay; perfMetricsPushRef is set by MetricsPanel
  const statsRef = useRef<PerfHook | null>(null);
  const perfMetricsPushRef = useRef<((t: FrameTiming) => void) | null>(null);
  // FIFO queue: one entry pushed per incoming frame, shifted on paint completion.
  // Prevents mis-attribution when multiple frames are in-flight through async decoders.
  const envelopeQueueRef = useRef<Array<{ capturedAt: number; relayedAt: number } | null>>([]);

  // Viewers call these; both are no-ops when overlays are not mounted
  const perfHookRef = useRef<PerfHook>({
    onFrameBegin: () => statsRef.current?.onFrameBegin(),
    onFrameEnd: (t) => {
      const env = envelopeQueueRef.current.shift() ?? null;
      const timing: FrameTiming = env ? { ...t, capturedAt: env.capturedAt, relayedAt: env.relayedAt } : t;
      statsRef.current?.onFrameEnd(timing);
      perfMetricsPushRef.current?.(timing);
    },
  });

  const [joined, setJoined] = useState(false);
  // The relay told us it is holding this session while its agent is gone (#426). Cleared by
  // whichever answer follows — `session:rebound` if it came back, and `session:terminated` takes
  // the viewer away entirely.
  const [agentAway, setAgentAway] = useState(false);
  const [deviceReady, setDeviceReady] = useState(false);
  const [chrome, setChrome] = useState<ChromeData | AndroidChrome | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  // What the agent on the other end implements. Absent ⇒ an agent predating the capability,
  // so the viewer degrades on purpose rather than inferring anything from a timeout.
  const [agentCapabilities, setAgentCapabilities] = useState<string[]>([]);
  // In-flight `device:boot` ids for this mount. A Set, for the same reason `rebindRef.pending` is a
  // counter: a crash-looping agent issues several boots and each gets its own reply. Cleared on
  // `session:joined` and nowhere else — see the `device:booting` branch for why not there.
  const bootIdsRef = useRef<Set<string>>(new Set());
  // The **most recent** boot this mount sent, which is a different question from `bootIdsRef`'s. The set
  // answers "did I ask for this?"; this answers "is this still the one I am waiting for?" — and only the
  // second can suppress the failure of a boot this viewer replaced itself, now that both agents answer a
  // superseded boot instead of going silent (#526). Membership cannot: `session:joined` clears the set on
  // every reconnect, so after a Wi-Fi blip the id of a boot that is still running is no longer in it.
  const latestBootIdRef = useRef<string | null>(null);
  // Deeplinks this viewer asked for. A reply does not go to whoever asked — the relay forwards it to
  // whichever socket holds the session now — so before `open-url` carried a `requestId` this viewer
  // toasted "Deeplink opened" for an `mcp-server` deeplink it knew nothing about.
  const openUrlIdsRef = useRef<Set<string>>(new Set());
  // Same for the app commands. The install id is minted here; the launch id is minted by whichever viewer
  // holds the button, through `launchApp` below — both land in this viewer's records because this viewer
  // is what consumes the replies.
  const appInstallIdsRef = useRef<Set<string>>(new Set());
  const appLaunchIdsRef = useRef<Set<string>>(new Set());
  const [swKeyboardVisible, setSwKeyboardVisible] = useState(false);
  const [swKeyboardPending, setSwKeyboardPending] = useState(false);

  // Active viewer registers its binary frame decoder here.
  // SimulatorViewer routes incoming binary frames to whichever viewer is mounted.
  const binaryFrameHandlerRef = useRef<BinaryFrameHandler | undefined>(undefined);

  // The mounted viewer's clipboard bridge registers here; replies are correlated by
  // requestId on its side, so this only has to hand the message over.
  const clipboardHandlerRef = useRef<ClipboardMessageHandler | undefined>(undefined);
  // Same shape, one message family over: the network control registers here and the routing below
  // hands it `network:state` and `network:error` (#607).
  const networkHandlerRef = useRef<NetworkMessageHandler | undefined>(undefined);

  // Opt-in audio output (Android emulator first). Audio frames are codec-tagged and routed
  // straight to Web Audio — they never enter the video FIFO/decoder path. Always-on playback;
  // muting is delegated to the emulator's own volume keys.
  const { pushFrame: pushAudioFrame } = useAudioPlayback();

  const handleMessage = useCallback((msg: BrowserInbound) => {
    // Anything addressed to another session is not ours to act on. Before #445 an
    // `app:install-error` arrived unattributed and was applied to whichever viewer was mounted.
    //
    // The union now declares `sessionId` on every message that carries one, so this reads as a normal
    // narrowing rather than the widening it used to be — it was `in msg` because the local copy of
    // this union omitted the field on messages the wire always stamped it on.
    //
    // `'sessionId' in msg` stays, and it is a **runtime** check rather than a type formality, so the two
    // levels have to be read separately. In the *union*, as of L5d one member declares no `sessionId`:
    // `agents:listed`, which is about the relay's inventory rather than any session. (`error` used to be the
    // second — "a failure the relay could not attribute" — and is now the answer to a specific
    // `session:start`, so it passes through the comparison instead of around it.) On the *wire* the key can
    // also be absent from a message that declares it: the relay replays cached session state to a re-joining
    // viewer, and `device:ready` is still sent unstamped — the paragraph below on the removed truthiness
    // check is about exactly those frames. So "one member carries none" is a statement about the declaration,
    // and `in msg` is what carries the replay.
    //
    // That makes the gate reject a foreign `error`, which is a no-op rather than a change: every producer
    // sends it with `sendTo(ws, …)` to the socket that asked, and this viewer's only `session:start` names
    // the session it holds for the life of the socket. So there is no `error` the wire can deliver here that
    // this line will drop — defence in depth, measured rather than assumed.
    //
    // **Why this gate is safe at all**: the relay only ever sends a session-scoped message to that
    // session's own `browserSocket`, so a mismatch means a stale socket rather than normal traffic. If
    // that stops holding, a dropped `session:terminated` strands the tab — the defect #426 exists to
    // fix, and there is a test for exactly that in `DeviceViewer.sessionScope.test.tsx`.
    //
    // There used to be a `&& msg.sessionId` truthiness check as well, for messages the relay *replayed*
    // to a re-joining viewer from its own cache without stamping. It sent those with the key absent, so
    // `'sessionId' in msg` already lets them through and the check was never what carried them — it only
    // ever admitted a key that was *present and falsy*. Two of the three are stamped now
    // (`device:ready` is not; see the protocol note), so it is gone.
    //
    // Dropping it means `sessionId: ''` is a mismatch rather than a pass. That is defence in depth, not
    // a live hole: `''` cannot reach a viewer today, because every agent→browser forward resolves
    // `sessions.get(msg.sessionId!)` against a `randomUUID` key and breaks on the miss. It matters for
    // the unvalidated-inbound gap (#444) — `mcp-server`'s tool schemas are bare `z.string()`, so an LLM
    // can put `''` on the wire, and a future producer echoing it back should not be applied to whichever
    // viewer happens to be mounted.
    if ('sessionId' in msg && msg.sessionId !== sessionId) return;

    if (msg.type === 'session:joined') {
      // A join starts a boot cycle of its own (socket blip, re-entry). Any rebind still waiting for
      // a `device:ready` will never get one, and leaving it pending would make this cycle's ready
      // look like a rebind — suppressing installs for the rest of the mount.
      rebindRef.current = { pending: 0, appInstalled: false };
      setJoined(true);
      setAgentAway(false);
      setAgentCapabilities(msg.capabilities ?? []);
      // Tell the agent up front whether this browser can decode H.264 so it picks the
      // codec accordingly; false (old/unsupported browser) → agent streams JPEG.
      // secureContext (localhost/HTTPS) → the agent can stream full res (WebCodecs hw-decodes it);
      // non-secure (LAN-HTTP) → it downscales for the WASM decoder. The relay adds `external`.
      // Only the first boot of this mount carries the reset. `session:joined` arrives again whenever
      // the socket reconnects (useRelay retries after 2s, and the effect below re-sends
      // `session:start` on `connected`), so a Wi-Fi blip or a sleeping laptop would otherwise
      // re-erase the device the user is currently looking at — with no click involved (#439).
      const reset = resetSentRef.current ? 'app-only' : resetMode;
      resetSentRef.current = true;
      // Cleared with `rebindRef` just above and for the same reason: an earlier cycle's boot will
      // never be answered now, and keeping its id would let a straggler release this cycle's rebind.
      bootIdsRef.current.clear();
      const bootId = newRequestId();
      bootIdsRef.current.add(bootId);
      latestBootIdRef.current = bootId;
      sendRef.current({ type: 'device:boot', sessionId, requestId: bootId, payload: { deviceId, resetMode: reset, acceptH264: canDecodeH264(), secureContext: window.isSecureContext } });
    }
    if (msg.type === 'session:agent-away') {
      // Everything on screen describes an agent that is no longer there. Drop the frame so the
      // status card is what the tester sees — a picture that has simply stopped updating is the
      // thing #426 was opened about.
      setAgentAway(true);
      setChrome(null);
      setDeviceReady(false);
      return;
    }
    if (msg.type === 'session:terminated') {
      onSessionEnded?.(msg.reason);
      return;
    }
    if (msg.type === 'session:rebound') {
      // The agent restarted under us. Nothing is streaming, but until the new agent answers, every
      // flag here still describes the old one — and the relay cannot tell a viewer to stop, since
      // its own "agent offline" check sees a live socket (the new agent's). So tear down first,
      // then ask for the device back.
      //
      // `device:booting` clears most of this, but only once the new agent replies; these three it
      // never clears at all, and before rebinding existed a dead agent unmounted the viewer so they
      // could not outlive it. Now they can: a restart during a launch would leave the button
      // spinning on an `app:launch-done` that died with the old agent.
      setDeviceReady(false);
      setChrome(null);
      setInstalling(false);
      setInstallError(null);
      setBootError(null);
      setLaunching(false);
      setSwKeyboardPending(false);
      setSwKeyboardVisible(false);
      envelopeQueueRef.current = [];
      setAgentCapabilities(msg.capabilities);

      const wasAnnounced = agentAway;
      setAgentAway(false);
      rebindRef.current = {
        pending: rebindRef.current.pending + 1,
        appInstalled: rebindRef.current.pending > 0 ? rebindRef.current.appInstalled : installed,
      };
      // Always `app-only`: a restart is not a request to erase the device (#439). Deriving this
      // from `resetSentRef` the way the `session:joined` branch does would happen to agree today,
      // only because a rebind cannot precede a join on the same mount — and would silently become
      // a wipe the day that stops holding.
      resetSentRef.current = true;
      const rebootId = newRequestId();
      bootIdsRef.current.add(rebootId);
      latestBootIdRef.current = rebootId;
      sendRef.current({ type: 'device:boot', sessionId, requestId: rebootId, payload: { deviceId, resetMode: 'app-only', acceptH264: canDecodeH264(), secureContext: window.isSecureContext } });
      // Only when the status card has not been saying it already — otherwise the toast lands at the
      // exact moment that message is replaced by the reconnect, saying the same thing twice.
      if (!wasAnnounced) toast.info('The agent restarted — reconnecting to the device.');
      return;
    }
    if (msg.type === 'device:boot-error') {
      // **Deliberately uncorrelated, and this is the one prohibition in the pair.** Android's
      // `restartVideoStream` sends this message for a stream that died mid-session, with no
      // `device:boot` behind it and so no id it could ever carry. This branch is the only surface that
      // reports it. Gating it on `bootIdsRef` would turn a dead stream back into a picture that has
      // simply stopped updating — the symptom #426 was opened about.
      //
      // **A boot this viewer has already replaced is not a failure to report.** Both agents now answer a
      // superseded boot rather than abandoning it silently, so re-picking a device — or any reconnect that
      // re-boots — produces an error for a request that has been overtaken. Judged against the latest id
      // only, never set membership; and an id from before this mount's first boot (`null`) is somebody
      // else's by the same argument. This sits above the `rebindRef` release deliberately: the boot that
      // replaced this one owns that release, and taking it here would let a straggler free the current
      // cycle's rebind.
      if (msg.requestId !== undefined && msg.requestId !== latestBootIdRef.current) return;
      // Joining a session whose agent is away answers `session:joined`, and the branch above sends
      // `device:boot` on the strength of it — which the relay refuses with `agent offline`. The
      // waiting state already says what is happening, and recording a boot failure on top of it
      // only waits for a status-card reordering to start telling the tester a recovery failed.
      if (agentAway) return;
      // Release the rebind: without this a failed re-boot would suppress every later install for
      // the life of the mount.
      rebindRef.current = { pending: 0, appInstalled: false };
      setBootError(msg.message);
    }
    // An input the device never got. Deliberately no session-level state behind this: the acks are
    // per-input, unordered (a dispatch is awaited before its ack while a refusal is not) and do not
    // say which channel answered — on Android buttons always take the adb path while touch takes the
    // pointer channel on any streaming session. A latch built on them cleared itself on an unrelated
    // success, and no message carries evidence that input is working again, so it had no honest clear
    // edge either. The toast's own lifetime is the state: repeats reuse
    // `id`, which sonner refreshes rather than stacks, so it stays up while inputs keep failing and
    // fades on its own when they stop. See `.work/2026-08-08-dashboard-input-error-plan.md`.
    if (msg.type === 'input:error') {
      // Suppressed while the agent is away, matching what `device:boot-error` does two branches down
      // and for a sharper reason: an absent agent cannot send this, so in that state the *relay*
      // answers every terminal input itself (`RelayServer.ts`, `channel-unavailable`). A
      // tapping tester would refresh this toast indefinitely, and its advice would contradict the
      // status card — which already says the relay is holding the session open and waiting.
      if (agentAway) return;
      const { key, notice } = resolveInputError(msg.reason);
      // A reason this build does not know about is normalised away, and without this line it would
      // vanish with it: the tester correctly sees the conservative copy, but nobody can tell the
      // dashboard is behind its agents. That is the situation the growth of this union guarantees, so
      // it needs a trace. Absence is *not* logged — a pre-#490 agent omits the field on every input,
      // and that case is documented rather than surprising.
      if (msg.reason !== undefined && msg.reason !== key) {
        console.debug(`[tapflow] unrecognised input:error reason "${msg.reason}", treated as ${key}`);
      }
      if (notice) {
        // `sessionId` in the id so a toast still on screen from the session just left cannot be
        // refreshed by a failure in the next one.
        toast.error(notice.title, {
          id: `input:${sessionId}:${key}`,
          // **The parenthetical is dropped when there is no prose**, not filled with a placeholder.
          // `message` became optional in #491 — the closed `reason` is the contract now and prose is
          // the producer's own — so an agent that sends only a reason is legal, and this is the one
          // place its text reaches a person. A template literal accepts `string | undefined` and
          // `restrict-template-expressions` is configured nowhere here, so nothing would have caught
          // "(undefined)" appearing in a toast read by a PO or a designer.
          description: msg.message ? `${notice.action} (${msg.message})` : notice.action,
          // The only "state" this design has. A finite lifetime is what makes the toast disappear
          // when inputs stop failing, with no clear signal — set explicitly and above sonner's
          // 4000ms default, which is short enough to lapse between two unhurried taps.
          duration: 6000,
        });
      } else {
        console.debug(`[tapflow] input refused, shown nowhere: ${key}${msg.message ? ` — ${msg.message}` : ''}`);
      }
    }
    // `input:done` is deliberately not handled. It was only ever needed to release the latch above,
    // and there is no latch.

    if (msg.type === 'device:booting') {
      setDeviceReady(false);
      setInstalling(false);
      setInstalled(false);
      setInstallError(null);
      setBootError(null);
      // A boot cycle invalidates the installs of the previous one, and this handler is where everything
      // else a new cycle invalidates is already cleared. Without it the record outlives the cycle that
      // made it: cycle 1's `app:install-done` can arrive while cycle 2's install is still in flight, and
      // it would set `installed` — showing a Launch control for an app that is not on the device yet.
      //
      // The pre-correlation code had the same hole and a wider one (any install reply set the flag,
      // including another client's), so this is not a regression — but the correlator is what makes the
      // precise fix possible, and adding the record without a lifetime is what left it.
      //
      // Not a generation counter, because the boundary already exists. What this does not cover is two
      // `device:ready` in one cycle — the relay replays that message on a re-join — and there both ids
      // install the same build, so the first reply clearing `installing` is imprecise rather than wrong.
      appInstallIdsRef.current.clear();
      appLaunchIdsRef.current.clear();
      // **`bootIdsRef` is deliberately not cleared here, and it is the one id set that must not be.**
      // The reasoning above is about records outliving their cycle, which invites adding it — but a boot
      // id has to *span* this message: both agents send `device:booting` before the `device:ready` that
      // answers the same boot (`IOSAgent.ts:560` → `:639`, `AndroidAgent.ts:863` → `:916`). Clearing it
      // here rejects every real ready, and the failure is quiet in the worst way: `setDeviceReady(true)`
      // still runs, so the spinner clears and the device looks healthy while the app is never installed.
      // Pinned by the "agent's real boot sequence" case in DeviceViewer.lifecycleCorrelation.test.tsx.
      setChrome(null); // causes active viewer to unmount → cleanup
    }
    if (msg.type === 'device:ready') {
      // **Before the correlator, deliberately.** The relay replays this message from cache to a
      // re-joining viewer and sends it with the key absent, so it answers no boot of this mount — and
      // clearing the spinner is exactly what it is for (#440). Gating this line on the correlator would
      // reinstate the defect the replay exists to prevent.
      setDeviceReady(true);
      // Everything below is a reaction to *our* boot, so it is gated. Absent is accepted, so what this
      // rejects is exactly one thing: a ready **carrying** an id that is not one this mount is waiting
      // for. That is a straggler from an earlier boot cycle, which would otherwise release the current
      // rebind and install on top of an install already in flight.
      //
      // It does **not** cover the case the comment two branches up describes. The relay's replayed ready
      // has no id, so it lands here as before — and it has to, because that is also how an agent
      // predating the echo answers, and the two are indistinguishable while the correlator is optional.
      // Telling them apart needs the replay to be identifiable in its own right, which is the deferred
      // `sessionId` tightening; until then that case is unchanged rather than fixed.
      if (msg.requestId !== undefined && !bootIdsRef.current.delete(msg.requestId)) return;
      if (rebindRef.current.pending > 0) {
        const { appInstalled } = rebindRef.current;
        rebindRef.current = { pending: rebindRef.current.pending - 1, appInstalled };
        if (appInstalled) {
          // Skipping the install means `app:install-done` never arrives, and `installed` gates the
          // Launch control — so restore it here or the tester silently loses that button.
          setInstalled(true);
          return;
        }
        // The install had not finished when the agent went away, so the app really is missing.
        // Fall through and install it.
      }
      if (buildId) {
        setInstalling(true);
        const requestId = newRequestId();
        appInstallIdsRef.current.add(requestId);
        sendRef.current({ type: 'app:install', sessionId, requestId, buildId });
      }
    }
    // Correlated, for the reason `open-url` is: the relay delivers a reply to whichever socket holds the
    // session, not to whoever asked, so an `mcp-server` install on this session would otherwise flip this
    // viewer's install state.
    if (msg.type === 'app:install-done' || msg.type === 'app:install-error') {
      if (!appInstallIdsRef.current.delete(msg.requestId)) return;
      setInstalling(false);
      if (msg.type === 'app:install-done') setInstalled(true);
      else setInstallError(msg.message);
    }
    if (msg.type === 'app:launch-done' || msg.type === 'app:launch-error') {
      if (!appLaunchIdsRef.current.delete(msg.requestId)) return;
      setLaunching(false);
    }
    if (msg.type === 'session:chrome') { setChrome(msg.payload); }
    if (msg.type === 'keyboard:toggled') {
      const { visible } = msg.payload;
      setSwKeyboardVisible(visible);
      setSwKeyboardPending(false);
    }
    if (msg.type === 'network:state' || msg.type === 'network:error') {
      networkHandlerRef.current?.(msg);
      return;
    }

    if (msg.type === 'clipboard:data' || msg.type === 'clipboard:write-done' || msg.type === 'clipboard:error') {
      clipboardHandlerRef.current?.(msg);
    }
    if (msg.type === 'open-url:done' || msg.type === 'open-url:error') {
      // `delete` returns whether it was ours, and removes it in the same step — a reply arrives once.
      if (!openUrlIdsRef.current.delete(msg.requestId)) return;
      if (msg.type === 'open-url:done') toast.success('Deeplink opened');
      else toast.error(msg.message);
    }
    // Branch on `reason`, never on `message`. The prose version handled two of the three wordings the
    // relay sends, so `Session busy` arrived and did nothing — and nothing reported it, because from
    // the outside `error` *was* a handled type. The switch is exhaustive, so a fourth reason is a
    // compile error rather than another silent case.
    if (msg.type === 'error') {
      switch (msg.reason) {
        case 'session-not-found':
          // Nothing else is ever coming for it. Reached when a browser blip outlasts the hold the relay
          // keeps after an agent goes away (#426): the re-join lands after the window closed, and
          // `session:terminated` went to a socket that no longer existed. Without this the tab waits on
          // a message that cannot arrive.
          onSessionEnded?.('agent-disconnected');
          return;
        case 'session-busy':
          // The session is alive and someone else holds it — so this is not `agent-disconnected`, and
          // saying so would send the tester to re-pick a Mac that is working fine.
          onSessionEnded?.('busy-elsewhere');
          return;
        case 'agent-resources-exhausted':
          // Exit, not just a toast. The relay `return`s after sending this, so no `session:joined` and no
          // `session:terminated` follows — a toast alone left the tab sitting on "Starting device…"
          // forever, which is the state this whole layer is about. Making `reason` required stopped a
          // case from being unhandled; it did not make the three handled cases *end* the same way, and
          // this was the one that did not.
          onSessionEnded?.('mac-overloaded');
          return;
      }
    }
  }, [sessionId, deviceId, buildId, onSessionEnded, resetMode, installed, agentAway]);

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const envelope = parseEnvelopeHeader(data);
    // Audio is a separate pipeline: hand the PCM to Web Audio and return before touching the
    // video FIFO/decoder. (It must not enter envelopeQueueRef — that's video-frame correlation.)
    if (envelope && envelope.codec === CODEC_AUDIO) {
      pushAudioFrame(data.slice(HEADER_SIZE));
      return;
    }
    // iOS H.264 presents asynchronously through a decoder surface; its viewer's
    // FrameLatencyTracker owns capturedAt/relayedAt correlation (via meta), so it
    // must not also go through this FIFO — a dropped frame would desync it forever.
    // JPEG (iOS) and Android stay synchronous/FIFO-matched here.
    if (!(envelope && envelope.codec === CODEC_H264)) {
      envelopeQueueRef.current.push(envelope);
    }
    const payload = envelope ? data.slice(HEADER_SIZE) : data;
    const meta = envelope
      ? { codec: envelope.codec, keyframe: envelope.keyframe, capturedAt: envelope.capturedAt, relayedAt: envelope.relayedAt }
      : undefined;
    binaryFrameHandlerRef.current?.(payload, meta);
  }, [pushAudioFrame]);

  const { send, connected } = useRelay(handleMessage, handleBinaryFrame);
  useLayoutEffect(() => { sendRef.current = send; });

  useEffect(() => {
    if (connected) send({ type: 'session:start', sessionId });
  }, [connected, send, sessionId]);

  // Derive platform from chrome payload shape
  const iosChrome = chrome !== null && 'framePng' in chrome ? chrome as ChromeData : null;
  const androidChrome = chrome !== null && !('framePng' in chrome) ? chrome as AndroidChrome : null;

  const onKbdToggle = () => {
    setSwKeyboardPending(true);
    send({ type: 'input:keyboard:toggle', sessionId });
  };

  const openUrl = useCallback((url: string) => {
    const requestId = newRequestId();
    openUrlIdsRef.current.add(requestId);
    sendRef.current({ type: 'open-url', sessionId, requestId, payload: { url } });
  }, [sessionId]);

  const launchApp = useCallback(() => {
    // Guarded rather than asserted. The old send sat inside `installed && buildId ? …`, where the render
    // condition narrowed `buildId` to `number`; hoisting it here lost that, and `buildId!` would have been
    // the same species as the `msg.requestId!` this layer removed from the relay.
    if (buildId === undefined) return;
    const requestId = newRequestId();
    appLaunchIdsRef.current.add(requestId);
    setLaunching(true);
    sendRef.current({ type: 'app:launch', sessionId, requestId, buildId });
  }, [sessionId, buildId]);

  const commonProps = {
    sessionId, buildId, send, openUrl, launchApp, connected, joined,
    deviceReady, installing, installed, installError, bootError,
    launching, widthBudget,
    binaryFrameHandlerRef,
    clipboardHandlerRef,
    clipboardSupported: agentCapabilities.includes('clipboard'),
    networkHandlerRef,
    networkSupported: agentCapabilities.includes('network-control'),
    onRecordingUploaded,
    swKeyboardVisible, swKeyboardPending, onKbdToggle,
  };

  // Before chrome arrives, show a phone skeleton + status card so the layout isn't empty
  if (!iosChrome && !androidChrome) {
    // Same row-fits check the real viewers use (#680) — the toolbar placeholder and info card
    // stack below the skeleton phone instead of beside it when there isn't room for a full row.
    // The skeleton has the same bezel padding as AndroidViewer's real device (padding: '12px').
    const skeletonSideBySide = fitsSideBySide(widthBudget, 324, BEZEL_PADDING_W);
    return (
      <div data-testid="device-skeleton-row" className={skeletonSideBySide ? 'flex items-start justify-center gap-16' : 'flex flex-col items-center gap-4'}>
        {/* toolbar placeholder */}
        <div className="flex flex-col items-center gap-0.5 rounded-2xl border bg-background/90 px-1.5 py-2.5 shrink-0 mt-3 opacity-40">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 w-8 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
        <div className={skeletonSideBySide ? 'flex items-start gap-8' : 'flex flex-col items-center gap-4'}>
          {/* phone body skeleton — width capped via max-width, not widthBudget math: it's a
              placeholder rect, not a real device render, so plain CSS shrink is enough. */}
          <div style={{ background: '#1c1c1e', borderRadius: '34px', padding: '12px', flexShrink: 0, maxWidth: '100%' }}>
            <div className="animate-pulse bg-zinc-700" style={{ width: 324, maxWidth: '100%', aspectRatio: '324 / 720', borderRadius: '22px' }} />
          </div>
          <SimulatorInfoCard
            sideBySide={skeletonSideBySide}
            joined={joined} fps={0} connected={connected}
            deviceReady={deviceReady} bootError={bootError}
            installing={installing} installError={installError}
            keyboardActive={false} agentAway={agentAway}
          />
        </div>
      </div>
    );
  }

  const devPerfHookRef = import.meta.env.DEV ? perfHookRef : undefined;

  return (
    <>
      {iosChrome && <IOSViewer {...commonProps} chrome={iosChrome} perfHookRef={devPerfHookRef} />}
      {androidChrome && <AndroidViewer {...commonProps} androidButtons={androidChrome.buttons} screenWidth={androidChrome.screenWidth} screenHeight={androidChrome.screenHeight} cornerRadius={androidChrome.cornerRadius} perfHookRef={devPerfHookRef} />}
      {import.meta.env.DEV && perfMode && perfVisible && (
        <>
          <StatsOverlay perfHookRef={statsRef} />
          <MetricsPanel pushRef={perfMetricsPushRef} />
        </>
      )}
    </>
  );
}
