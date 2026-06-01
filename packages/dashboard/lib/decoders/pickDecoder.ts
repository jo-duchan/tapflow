import type { Decoder } from './types'
import type { Muxer } from './MSEDecoder'
import { WebCodecsDecoder } from './WebCodecsDecoder'
import { MSEDecoder } from './MSEDecoder'

export interface DecoderCapabilities {
  /** HTTPS or localhost — required by WebCodecs. */
  secureContext: boolean
  /** VideoDecoder API present. */
  webCodecs: boolean
  /** WebGL2 available (WebCodecsDecoder renders via WebGL). */
  webgl2: boolean
  /** MediaSource present and supports baseline H.264. */
  mse: boolean
}

const MSE_H264 = 'video/mp4; codecs="avc1.42E01E"'

export function detectCapabilities(): DecoderCapabilities {
  const hasWindow = typeof window !== 'undefined'

  let webgl2 = false
  try {
    webgl2 = !!document.createElement('canvas').getContext('webgl2')
  } catch {
    webgl2 = false
  }

  const mse = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MSE_H264)

  return {
    secureContext: hasWindow && window.isSecureContext === true,
    webCodecs: hasWindow && 'VideoDecoder' in window,
    webgl2,
    mse,
  }
}

/**
 * Selects the best available H.264 decoder for the current environment:
 * - WebCodecs (lowest latency) — secure context + VideoDecoder + WebGL2
 * - MSE (works over plain HTTP) — otherwise, when MediaSource supports H.264
 * - null — neither available (caller shows guidance)
 *
 * `createMuxer` is injected (createJMuxer in the browser) so this module stays
 * free of the MediaSource-touching jmuxer import.
 */
export function pickDecoder(
  createMuxer: (video: HTMLVideoElement) => Muxer,
  caps: DecoderCapabilities = detectCapabilities(),
): Decoder | null {
  if (caps.secureContext && caps.webCodecs && caps.webgl2) return new WebCodecsDecoder()
  if (caps.mse) return new MSEDecoder(createMuxer)
  return null
}
