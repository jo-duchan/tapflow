import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MutableRefObject } from 'react'
import { useDecoderStream } from '@/hooks/useDecoderStream'
import type { Decoder } from '@/lib/decoders/types'
import type { BinaryFrameHandler } from '@/lib/envelope'
import type { PerfHook } from '@/components/perf/types'
import { composeTurn, framesAgree, showsPicture, surfaceBox, turnedSize, type Turn } from '@/lib/coordinate-transform'

/** The longest side the device is drawn at, in CSS px. The recording composer scales its cursor
 *  rings by the same number, so the two have to stay one constant. */
export const MAX_ANDROID_LONG = 720

/** How long a turn this viewer asked for may wait for its frame before the device is put back where the frames
 *  say it is. A body turn's frame comes ~53 ms after the turn (measured); this is for one that never comes. */
export const PENDING_TURN_MS = 4_000
/** How long the device takes to spin a quarter — the 300 ms transition, with room for it to land. iOS's, so both
 *  turn alike; a press is sent after it, and input waits it out. */
export const SPIN_MS = 350

interface UseAndroidScreenOptions {
  binaryFrameHandlerRef: { current: BinaryFrameHandler | undefined }
  perfHookRef?: MutableRefObject<PerfHook>
  /** From `useFps`, which the caller owns because the status card reads the same count. */
  frameCount: MutableRefObject<number>
  screenWidth?: number
  screenHeight?: number
  /** Quarter turns clockwise to apply to the video so it matches `screenWidth/Height`. The agent
   *  computes it; see `AndroidChrome.streamRotation`. */
  streamRotation: 0 | 90 | 180 | 270
  /** Rounded-corner radius as a fraction of width — the emulator bakes the device's corners into
   *  the framebuffer as black; we clip them so they don't show inside the screen bezel. 0 = square. */
  cornerRadius?: number
  /** The tester asked for landscape. A viewer that cannot rotate passes `false`. */
  userWantsLandscape: boolean
  /** A rotation is in flight — the picture is held back until it lands. */
  rotatePending: boolean
  /** How far the emulator's body is turned (`AndroidChrome.bodyRotation`). Present means **body mode**: the frame
   *  is drawn as it arrives — already as the body is held — and the shell takes the frame's shape. */
  bodyRotation?: Turn
  /** How many turns this viewer has asked for — a count, so each press is one. A page that cannot turn the device
   *  passes nothing, and draws every turn as the frame brings it. */
  turnsAsked?: number
}

/**
 * **The picture half of the Android viewer** — decoding, the frame's size against the agent's
 * description of the screen, and where the picture sits — with nothing that talks to the device.
 * `AndroidViewer` adds the controls; a page that only watches uses this and `AndroidDeviceScreen`, so
 * both draw the device the same way.
 *
 * Returns the refs and the turn because the controls depend on them: pointer mapping reads the surface
 * host and the CSS quarter, recording and screenshots read the decoder surface, the frame size and the
 * whole turn.
 */
export function useAndroidScreen({
  binaryFrameHandlerRef, perfHookRef, frameCount,
  screenWidth, screenHeight, streamRotation, cornerRadius, userWantsLandscape, rotatePending, bodyRotation, turnsAsked = 0,
}: UseAndroidScreenOptions) {
  const bodyMode = bodyRotation !== undefined
  const surfaceHostRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const decoderRef = useRef<Decoder | null>(null)

  const [canvasReady, setCanvasReady] = useState(false)
  // **Hide the picture while the screen is changing under it.** `session:chrome` arrives before the
  // stream has caught up — a fold changes the bezel's shape, its corner radius and the correction
  // angle in one message, while the decoder is still emitting frames of the previous screen — so for
  // a moment the old picture is drawn into the new frame, stretched and turned. That is the flash.
  // The canvas comes back on the first frame that arrives at the new size, which `onResize` reports.

  const [decoderUnsupported, setDecoderUnsupported] = useState(false)
  const videoSizeRef = useRef<{ width: number; height: number } | null>(null)
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null)
  /** Which of the frame and the agent's description changed most recently. The aspect gate reads
   *  it to tell the flash — which ends on its own — from a description with no frame behind it,
   *  which does not. See `showsPicture`. */
  //
  //  Cleared while rendering once the description moves on, rather than by an effect a commit late —
  //  and for good, until the next frame. Keyed instead ("ahead of *this* description"), a description
  //  that left and came back made the frame ahead again with no new frame behind it: A → B → A hid the
  //  picture until a resize that might never come.
  const [frameIsAhead, setFrameIsAhead] = useState(false)
  const descriptionKey = `${streamRotation}:${screenWidth ?? ''}:${screenHeight ?? ''}`
  const [shownDescription, setShownDescription] = useState(descriptionKey)
  if (shownDescription !== descriptionKey) {
    setShownDescription(descriptionKey)
    setFrameIsAhead(false)
  }

  // ── Decoder init + surface mount (shared render pipeline) ─────────────────
  // useDecoderStream owns decoder selection (+ the DEV ?decoder= override), decode→present
  // perf tracking, and frame routing — same wiring as iOS. This only mounts the surface and
  // reacts to resize. (Android is H.264-only, so no JPEG handler.)
  useDecoderStream({
    binaryFrameHandlerRef,
    perfHookRef,
    frameCount,
    onUnsupported: () => setDecoderUnsupported(true),
    onResize: (size) => {
      setCanvasReady(true)
      const prev = videoSizeRef.current
      if (!prev || prev.width !== size.width || prev.height !== size.height) {
        videoSizeRef.current = size
        setVideoSize(size)
        setFrameIsAhead(true)
      }
    },
    onDecoderReady: (decoder) => {
      decoderRef.current = decoder
      const surface = decoder.surface
      surface.style.display = 'block'
      surface.style.width = '100%'
      surface.style.height = '100%'
      surface.style.objectFit = 'fill'
      surfaceHostRef.current?.appendChild(surface)
    },
  })

  // **A turn this viewer asked for spins the device, and the frame ends the spin** — DeviceHub's order, as on iOS:
  // the device turns, then the screen. Each press owes a quarter, drawn as a CSS turn of the whole device; the
  // turned body's frame pays it, and is the same picture the spin ended on (the body as held), so the swap is
  // seamless. That frame is recognised by its shape flipping: a quarter turn of the body always swaps the frame's
  // sides, while a quality tier only scales them. The description is no use here — it follows 0.6–3.6 s later.
  const frameLandscape = videoSize ? videoSize.width > videoSize.height : null
  const [spin, setSpin] = useState({ asked: turnsAsked, owed: 0, frameLandscape, animate: false })
  if (spin.asked !== turnsAsked || spin.frameLandscape !== frameLandscape) {
    const flipped = spin.frameLandscape !== null && frameLandscape !== null && spin.frameLandscape !== frameLandscape
    const paid = flipped && spin.owed > 0 ? 1 : 0
    const asked = Math.max(0, turnsAsked - spin.asked)
    setSpin({ asked: turnsAsked, owed: spin.owed + asked - paid, frameLandscape, animate: asked > 0 })
  }
  // A turn whose frame never came is undone, turning back as visibly as it went — and the device is still drawn
  // turned while it does, so input stays closed until the way back has finished (`settling`).
  const owed = bodyMode ? spin.owed : 0
  const [settling, setSettling] = useState(false)
  useEffect(() => {
    if (owed === 0) return
    const t = setTimeout(() => { setSpin((s) => ({ ...s, owed: 0, animate: true })); setSettling(true) }, PENDING_TURN_MS)
    return () => clearTimeout(t)
  }, [owed, turnsAsked])
  useEffect(() => {
    if (!settling) return
    const t = setTimeout(() => setSettling(false), SPIN_MS)
    return () => clearTimeout(t)
  }, [settling])

  // **What Android draws, not what the stream carries.** `session:chrome` reports the display's
  // current size; the emulator's gRPC capture arrives in the device's *physical* orientation, and on
  // a folded foldable those differ — measured: Android draws 1080x2424 while the frame is 2424x1080.
  // Framing the stream's dimensions is what laid the folded screen on its side.
  const shownSize = screenWidth && screenHeight ? { width: screenWidth, height: screenHeight } : null
  // **Body mode frames the frame, as it arrives.** The frame already is the body as held, and it turns 53 ms after
  // the body does while the description follows 0.6–3.6 s later (the agent settles the display first). Framed by
  // the description, the picture was hidden behind "Changing posture…" for that long on every turn, and a
  // description that lost a race framed a landscape frame in a portrait shell.
  const effectiveSize = bodyMode
    ? (videoSize ?? (shownSize ? turnedSize(shownSize.width, shownSize.height, streamRotation) : null))
    : (shownSize ?? videoSize)
  const isLandscapeContent = effectiveSize ? effectiveSize.width > effectiveSize.height : false
  // CSS rotation: applied when the user requested landscape but the video content is still
  // portrait (portrait-locked app). Matches native Android emulator — the shell rotates even
  // when app content stays portrait.
  //
  // **Whether a rotation-capable app makes the stream landscape depends on the backend**, and an
  // earlier version of this comment claimed it always does. scrcpy captures with
  // `capture_orientation=@0`, so its frames stay in the device's natural orientation whatever the
  // app does, and this CSS path is the only thing that rotates them. The emulator's gRPC backend
  // captures the display as it actually is — measured on a Pixel 9 Pro Fold: 2152x2076 while
  // `wm size` reported the natural 2076x2152 — so there the frame is already landscape and
  // `isLandscapeContent` turns this off by itself.
  const needsCSSRotation = !bodyMode && userWantsLandscape && !isLandscapeContent
  // **The device frame is never rotated — the video inside it is.** A foldable's frame follows the
  // screen Android draws, and turning the whole shell was what put the bezel on its side. The
  // quarter turn comes from the agent rather than from comparing the two sizes here: they update on
  // different messages, and during a fold they disagree for a few frames, which is long enough to
  // flip the picture and flip it back.
  //
  // **They add up.** The two corrections answer different questions — one turns the video because
  // the capture is not the orientation Android is drawing, the other turns it again because the
  // user asked for landscape and the app refused — and a device can need both at once. Measured on
  // a folded foldable at the lock screen: Android keeps `rotation 0` (the lock screen is portrait
  // only) so the stream still needs its 270, and the rotate button wants a further 90 on top. Two
  // earlier versions each picked one and dropped the other, which is a half turn either way.
  //
  // What differs between them is the *shell*: only the user's request changes the frame's shape,
  // because the device's screen has not actually rotated.
  const totalTurn: Turn = bodyMode ? 0 : composeTurn(streamRotation, needsCSSRotation)
  /** From the shell's space to the screen Android draws, for a pointer: body mode's frame turned by the capture's
   *  correction (`turnPoint`), nothing otherwise. A ref for the reason `needsCSSRotationRef` gives. */
  const screenTurn: Turn = bodyMode ? streamRotation : 0
  const screenTurnRef = useRef<Turn>(0)
  useLayoutEffect(() => { screenTurnRef.current = screenTurn }, [screenTurn])

  // **One ref, and only because a pointer event is not a render.** `toNorm` runs from a pointer
  // handler and wants whatever is true at the moment of the event, not at the render that built
  // it. The turn used to be mirrored the same way for capture, which was the wrong reason for the
  // same shape: the mirror was written *after* the closure was handed to `useClientRecording`, so
  // the value a frame drew with came from a ref the hook already held — a Rules of React violation
  // the React Compiler will not compile past. Capture takes the turn as a dependency now and
  // re-registers; see `setComposeFrame` beside `composeFrame` in `AndroidViewer`.
  const needsCSSRotationRef = useRef(false)
  useLayoutEffect(() => { needsCSSRotationRef.current = needsCSSRotation }, [needsCSSRotation])

  // ── Layout ────────────────────────────────────────────────────────────────
  // Scale by longest side so portrait and landscape stay the same physical size on screen
  const androidScale = effectiveSize
    ? Math.min(1, MAX_ANDROID_LONG / Math.max(effectiveSize.width, effectiveSize.height))
    : 0.3
  const androidDisplayW = effectiveSize ? Math.round(effectiveSize.width * androidScale) : 324
  const androidDisplayH = effectiveSize ? Math.round(effectiveSize.height * androidScale) : 720
  // Container uses landscape dims; canvas inside rotated 90° to show portrait content in landscape shell
  const containerW = needsCSSRotation ? androidDisplayH : androidDisplayW
  const containerH = needsCSSRotation ? androidDisplayW : androidDisplayH
  // Screen-opening radius: when the emulator bakes the device's rounded corners into the frame as
  // black, round the screen container to that radius so overflow:hidden clips the black away (the
  // content rounds at the same radius → no dark corner). Falls back to the design default 22px.
  // `cornerRadius == null` = unknown → design default; an explicit 0 (square screen) must stay 0.
  // **The corner is the panel's, and no turn changes it.** It arrives as a fraction of the width Android draws, which
  // does change with a turn; its product with that width is the radius in device pixels. Body mode scales that by the
  // shell's long side over the device's — not by the stream's scale, which a quality tier shrinks, and not by a side
  // chosen by the description's correction, which lags a turn and made the corners jump on every one.
  const deviceLong = screenWidth && screenHeight ? Math.max(screenWidth, screenHeight) : 0
  const screenRadius = cornerRadius == null ? 22
    : bodyMode && screenWidth && deviceLong
      ? Math.round((cornerRadius * screenWidth * Math.max(androidDisplayW, androidDisplayH)) / deviceLong)
      : Math.round(cornerRadius * androidDisplayW)
  // Whether the frame and the agent's description are talking about the same screen; the
  // reasoning, and why the user's quarter is deliberately not part of it, is in `framesAgree`.
  const descriptionAgrees = framesAgree(videoSize, shownSize, streamRotation)
  // Body mode draws the frame in its own shape, so the picture never disagrees with its shell, and a pointer goes
  // out in the frame's own space — nothing waits on the description there.
  const frameMatchesScreen = bodyMode ? true : descriptionAgrees
  const pictureVisible = showsPicture({
    ready: canvasReady, aspectAgrees: frameMatchesScreen, frameIsAhead, rotating: rotatePending,
  })

  // The canvas carries the whole turn. When that is a quarter, it takes the container's dimensions
  // swapped and is centred, so rotating it lands exactly on the container — which is what keeps the
  // bezel still and the pointer maths honest, since the canvas's bounding box then matches the
  // screen the viewer is showing.
  const box = surfaceBox(totalTurn, containerW, containerH)
  const canvasStyle: CSSProperties = {
    position: 'absolute',
    ...box,
    transform: `rotate(${totalTurn}deg)`,
    transformOrigin: 'center center',
    visibility: pictureVisible ? 'visible' : 'hidden',
    cursor: 'none',
  }

  return {
    surfaceHostRef, containerRef, decoderRef, videoSizeRef, needsCSSRotationRef, screenTurnRef, screenTurn, bodyMode,
    /** The picture is turned a quarter by CSS inside a landscape box (portrait content held landscape, no body mode):
     *  what the overlay needs to put a screen point back in its box. The ref above is for event handlers. */
    needsCSSRotation,
    decoderUnsupported, totalTurn,
    containerW, containerH, screenRadius, frameMatchesScreen, pictureVisible, canvasStyle,
    /** Degrees the whole device is drawn turned by while turns this viewer asked for wait for their frame, and
     *  whether getting there animates: a press and an undo do, a frame paying its quarter does not. */
    spinDeg: owed * 90, spinAnimates: spin.animate,
    /** The device is drawn mid-turn — turned for a press, or on its way back from one — so a pointer means nothing
     *  and the viewer takes none. */
    spinning: owed !== 0 || settling,
  }
}

export type AndroidScreen = ReturnType<typeof useAndroidScreen>
