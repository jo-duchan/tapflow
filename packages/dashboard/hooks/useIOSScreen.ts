import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { useDecoderStream } from '@/hooks/useDecoderStream'
import type { BinaryFrameHandler } from '@/lib/envelope'
import type { PerfHook } from '@/components/perf/types'
import type { ChromeData } from '@/lib/types'

/** How long fps reads 0, over a picture already painted, before the viewer says it is waiting. */
const STALL_MS = 2500

interface UseIOSScreenOptions {
  chrome: ChromeData
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>
  perfHookRef?: MutableRefObject<PerfHook>
  /** From `useFps`, which the caller owns because the status card reads the same count. */
  fps: number
  frameCount: MutableRefObject<number>
  /** Told each time the mirror canvas takes a new size, on either decode path. */
  onCanvasResize?: (size: { width: number; height: number }) => void
}

/**
 * **The picture half of the iOS viewer** — decoding into the mirror canvas and the state of what is on
 * it — with nothing that talks to the device. `IOSViewer` adds the controls on top; a page that only
 * watches uses this and `IOSDeviceScreen` alone, so the two draw the device the same way.
 *
 * The refs are returned rather than kept, because the controls measure the same elements: pointer
 * mapping reads the container and the screen area, recording and screenshots read the canvas.
 */
export function useIOSScreen({ chrome, binaryFrameHandlerRef, perfHookRef, fps, frameCount, onCanvasResize }: UseIOSScreenOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const screenAreaRef = useRef<HTMLDivElement>(null)
  const lastFrameRecvAtRef = useRef<number>(0)
  const deviceSeq = useRef(0)

  const [canvasReady, setCanvasReady] = useState(false)
  // **Over a picture, the wait overlay waits too.** fps is counted in one-second windows, and a still
  // H.264 screen sends a keep-alive about every 1.03s, so an empty window turns up every half minute on a
  // healthy stream (the status card says the same of its own fps). With the screen dimmed behind the
  // text that blink became loud, so once a picture is up the overlay shows only after fps has read 0 for
  // `STALL_MS` — about 3.5 to 4.5s after the last frame, since fps reports a whole window late. Precise
  // timing from the last frame would need a second clock on both decode paths; nothing here needs it. Before the first frame it shows at once, as it always did. The clock
  // starts at the picture, not at mount: a first frame later than `STALL_MS` would otherwise land already
  // "stalled" and be dimmed until the next fps window.
  const [stalled, setStalled] = useState(false)
  if (fps !== 0 && stalled) setStalled(false)
  useEffect(() => {
    if (fps !== 0 || !canvasReady) return
    const t = setTimeout(() => setStalled(true), STALL_MS)
    return () => clearTimeout(t)
  }, [fps, canvasReady])
  const [decoderUnsupported, setDecoderUnsupported] = useState(false)

  // ── Decoder + frame routing (shared render pipeline) ──────────────────────
  // The decoder's surface sits over the canvas, so it takes the canvas's place — when the decoder starts,
  // and again whenever the chrome changes. The second is not hypothetical: a viewer that opened with no
  // chrome from the agent (`framelessChrome`) is handed the real one if it arrives, and the surface would
  // otherwise stay covering the whole canvas, frame included.
  const decoderSurfaceRef = useRef<HTMLElement | null>(null)
  const placeSurface = (surface: HTMLElement) => {
    const c = canvasRef.current
    if (!c) return
    surface.style.left = c.style.left
    surface.style.top = c.style.top
    surface.style.width = c.style.width
    surface.style.height = c.style.height
    surface.style.borderRadius = c.style.borderRadius
    surface.style.maskImage = c.style.maskImage
  }
  useLayoutEffect(() => {
    if (decoderSurfaceRef.current) placeSurface(decoderSurfaceRef.current)
  }, [chrome])

  // useDecoderStream owns decoder selection (+ the DEV ?decoder= override) and decode→present
  // perf tracking — same wiring as Android. iOS-specific bits stay here: the H.264 surface mounts
  // over the device chrome (mirrored to canvasRef for recording/screenshot), and the JPEG path
  // decodes via createImageBitmap onto that canvas.
  useDecoderStream({
    binaryFrameHandlerRef,
    perfHookRef,
    frameCount,
    onUnsupported: () => setDecoderUnsupported(true),
    onResize: (size) => {
      const canvas = canvasRef.current
      if (canvas && (canvas.width !== size.width || canvas.height !== size.height)) {
        canvas.width = size.width; canvas.height = size.height
        onCanvasResize?.({ width: size.width, height: size.height })
      }
      setCanvasReady(true)
    },
    onDecoderReady: (d) => {
      // Display the decoder surface directly over the chrome; the canvas stays behind,
      // mirrored, so the existing recording/screenshot paths (which read canvasRef) keep working.
      const surface = d.surface
      surface.style.position = 'absolute'
      placeSurface(surface)
      decoderSurfaceRef.current = surface
      surface.style.objectFit = 'fill'
      surface.style.zIndex = '3'
      surface.style.pointerEvents = 'none'
      containerRef.current?.appendChild(surface)
      let raf: number | null = null
      const blit = () => {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (canvas && ctx && d.size) {
          try { ctx.drawImage(d.surface, 0, 0, canvas.width, canvas.height) } catch { /* surface not paintable yet */ }
        }
        raf = requestAnimationFrame(blit)
      }
      raf = requestAnimationFrame(blit)
      return () => {
        if (raf !== null) cancelAnimationFrame(raf)
        if (decoderSurfaceRef.current === surface) decoderSurfaceRef.current = null
      }
    },
    onJpegFrame: (data) => {
      const recvAt = performance.now()
      const recvInterval = lastFrameRecvAtRef.current ? recvAt - lastFrameRecvAtRef.current : 0
      lastFrameRecvAtRef.current = recvAt
      if (import.meta.env.DEV) perfHookRef?.current?.onFrameBegin()

      const seq = deviceSeq.current
      createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
        .then((bitmap) => {
          const decodeMs = performance.now() - recvAt
          if (deviceSeq.current !== seq) { bitmap.close(); return }
          const canvas = canvasRef.current
          const ctx = canvas?.getContext('2d')
          if (!canvas || !ctx) { bitmap.close(); return }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width; canvas.height = bitmap.height
            onCanvasResize?.({ width: bitmap.width, height: bitmap.height })
          }
          const paintStart = performance.now()
          ctx.drawImage(bitmap, 0, 0)
          const paintMs = performance.now() - paintStart
          bitmap.close()
          setCanvasReady(true)
          frameCount.current += 1
          if (import.meta.env.DEV) {
            perfHookRef?.current?.onFrameEnd({ recvAt, recvInterval, decodeMs, paintMs })
          }
        })
        .catch(() => {})
    },
  })

  return { canvasRef, containerRef, screenAreaRef, canvasReady, stalled, decoderUnsupported }
}

export type IOSScreen = ReturnType<typeof useIOSScreen>
