import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MutableRefObject } from 'react'
import { useDecoderStream } from '@/hooks/useDecoderStream'
import type { Decoder } from '@/lib/decoders/types'
import type { BinaryFrameHandler } from '@/lib/envelope'
import type { PerfHook } from '@/components/perf/types'
import { composeTurn, framesAgree, showsPicture, surfaceBox } from '@/lib/coordinate-transform'

const MAX_ANDROID_LONG = 720

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
  screenWidth, screenHeight, streamRotation, cornerRadius, userWantsLandscape, rotatePending,
}: UseAndroidScreenOptions) {
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

  // **What Android draws, not what the stream carries.** `session:chrome` reports the display's
  // current size; the emulator's gRPC capture arrives in the device's *physical* orientation, and on
  // a folded foldable those differ — measured: Android draws 1080x2424 while the frame is 2424x1080.
  // Framing the stream's dimensions is what laid the folded screen on its side.
  const shownSize = screenWidth && screenHeight ? { width: screenWidth, height: screenHeight } : null
  const effectiveSize = shownSize ?? videoSize
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
  const needsCSSRotation = userWantsLandscape && !isLandscapeContent
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
  const totalTurn = composeTurn(streamRotation, needsCSSRotation)

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
  const screenRadius = cornerRadius != null ? Math.round(cornerRadius * androidDisplayW) : 22
  // Whether the frame and the agent's description are talking about the same screen; the
  // reasoning, and why the user's quarter is deliberately not part of it, is in `framesAgree`.
  const frameMatchesScreen = framesAgree(videoSize, shownSize, streamRotation)
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
    surfaceHostRef, containerRef, decoderRef, videoSizeRef, needsCSSRotationRef,
    decoderUnsupported, totalTurn,
    containerW, containerH, screenRadius, frameMatchesScreen, pictureVisible, canvasStyle,
  }
}

export type AndroidScreen = ReturnType<typeof useAndroidScreen>
