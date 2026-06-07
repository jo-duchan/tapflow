import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { pickDecoder } from '@/lib/decoders/pickDecoder'
import { WASMDecoder } from '@/lib/decoders/WASMDecoder'
import type { Decoder, DecoderSize } from '@/lib/decoders/types'
import { CODEC_H264, type BinaryFrameHandler, type FrameMeta } from '@/lib/envelope'
import { FrameLatencyTracker } from '@/components/perf/FrameLatencyTracker'
import type { PerfHook } from '@/components/perf/types'

interface UseDecoderStreamOptions {
  /** The viewer's binary-frame handler slot — this hook owns its lifecycle. */
  binaryFrameHandlerRef: { current: BinaryFrameHandler | undefined }
  /** Perf hook (DEV only). Receives onFrameBegin per frame + onFrameEnd per present. */
  perfHookRef?: MutableRefObject<PerfHook>
  /** Bumped per decoded frame for the FPS counter. */
  frameCount: MutableRefObject<number>
  /** Called once when the decoder is created so the viewer can mount its surface. May return
   *  a cleanup fn (e.g. to cancel a mirror-canvas rAF), run on unmount before the decoder closes. */
  onDecoderReady: (decoder: Decoder) => void | (() => void)
  /** Frame size on first frame / rotation. */
  onResize: (size: DecoderSize) => void
  /** No decoder available (no WebGL2/secure context). */
  onUnsupported: () => void
  /** iOS-only: a non-H.264 (JPEG) frame. If omitted, every frame goes to the decoder. */
  onJpegFrame?: (data: ArrayBuffer, meta?: FrameMeta) => void
}

/**
 * Shared decode + perf wiring for the device viewers (iOS / Android), so both plug into
 * one render pipeline: pick the decoder (with the DEV `?decoder=wasm` override), track
 * decode→present latency (FrameLatencyTracker → perfHook), and route binary frames to the
 * decoder (or to a platform JPEG handler). Platform-specific bits — surface mounting,
 * recording, the JPEG canvas path — stay in the viewer via the callbacks.
 */
export function useDecoderStream(opts: UseDecoderStreamOptions): void {
  const { binaryFrameHandlerRef, perfHookRef, frameCount } = opts
  // Keep the latest callbacks without re-running the (mount-once) effect.
  const cbRef = useRef(opts)
  cbRef.current = opts

  useEffect(() => {
    let decoder: Decoder | null = null
    let decoderFailed = false
    // Drop H.264 frames until the first keyframe: a viewer can join mid-GOP (the relay forwards the
    // live stream), and feeding P-frames to the decoder before any IDR renders uninitialized green
    // garbage. The relay's join-IDR request brings a keyframe shortly; until then, skip.
    let seenKeyframe = false
    let lastRecvAt = 0
    let readyCleanup: void | (() => void)
    // Correlates the decoder's async present back to its submit so the H.264 path reports
    // decodeMs / glass-to-glass like the synchronous JPEG path.
    const tracker = new FrameLatencyTracker()
    // glass-to-glass needs agent + browser on one clock — true only on localhost.
    const singleClock = typeof location !== 'undefined'
      && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')

    const ensureDecoder = (): Decoder | null => {
      if (decoder) return decoder
      if (decoderFailed) return null // latch: don't re-pick/re-warn on every frame
      // Dev override: ?decoder=wasm forces the WASM tier on localhost (a secure context, so
      // it would otherwise auto-pick WebCodecs) for measurement.
      const forced = import.meta.env.DEV ? new URLSearchParams(location.search).get('decoder') : null
      const d = forced === 'wasm' ? new WASMDecoder() : pickDecoder()
      if (!d) {
        decoderFailed = true
        cbRef.current.onUnsupported()
        console.warn('[decoder] none available — set up HTTPS or use a supported browser')
        return null
      }
      decoder = d
      if (import.meta.env.DEV) {
        console.log(`[decoder] using ${d instanceof WASMDecoder ? 'WASM' : 'WebCodecs'}${forced ? ` (forced: ${forced})` : ''}`)
        let diagN = 0
        d.onDecodedFrame?.((presentTime, sample) => {
          const timing = tracker.onPresented(
            presentTime,
            singleClock ? performance.timeOrigin + presentTime : undefined,
          )
          if (timing) {
            // Prefer the decoder's exact timestamp-matched decodeMs (drop-immune) over the FIFO estimate.
            if (sample) timing.decodeMs = sample.decodeMs
            perfHookRef?.current?.onFrameEnd(timing)
          }
          if (sample && diagN++ % 30 === 0) {
            console.log(`[wc-diag] decodeMs=${sample.decodeMs.toFixed(1)} queueSize=${sample.queueSize}`)
          }
        })
      }
      d.onResize((size) => cbRef.current.onResize(size))
      readyCleanup = cbRef.current.onDecoderReady(d)
      return d
    }

    binaryFrameHandlerRef.current = (data: ArrayBuffer, meta?: FrameMeta) => {
      const jpeg = cbRef.current.onJpegFrame
      if (jpeg && meta?.codec !== CODEC_H264) { jpeg(data, meta); return }
      const d = ensureDecoder()
      if (!d) return
      if (!seenKeyframe) {
        if (!meta?.keyframe) return // wait for the first IDR before decoding (avoids green garbage)
        seenKeyframe = true
      }
      if (import.meta.env.DEV) {
        const recvAt = performance.now()
        const recvInterval = lastRecvAt ? recvAt - lastRecvAt : 0
        lastRecvAt = recvAt
        perfHookRef?.current?.onFrameBegin()
        // onFrameEnd fires later, from onDecodedFrame, once this frame presents.
        tracker.onSubmit({ submitTime: recvAt, recvAt, recvInterval, capturedAt: meta?.capturedAt, relayedAt: meta?.relayedAt })
      }
      d.decode(data)
      frameCount.current += 1
    }

    return () => {
      binaryFrameHandlerRef.current = undefined
      if (typeof readyCleanup === 'function') readyCleanup()
      decoder?.close()
      decoder?.surface.remove()
      decoder = null
    }
  }, [binaryFrameHandlerRef, perfHookRef, frameCount])
}
