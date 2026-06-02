import type { Decoder } from './types'
import { WebCodecsDecoder } from './WebCodecsDecoder'
import { WASMDecoder } from './WASMDecoder'

export interface DecoderCapabilities {
  /** HTTPS or localhost — required by WebCodecs. */
  secureContext: boolean
  /** VideoDecoder API present. */
  webCodecs: boolean
  /** WebGL2 available — both decoders render via WebGL. */
  webgl2: boolean
  /** WebAssembly + Web Worker — required by the WASM (tinyh264) decoder. */
  wasm: boolean
}

export function detectCapabilities(): DecoderCapabilities {
  const hasWindow = typeof window !== 'undefined'

  let webgl2 = false
  try {
    webgl2 = !!document.createElement('canvas').getContext('webgl2')
  } catch {
    webgl2 = false
  }

  return {
    secureContext: hasWindow && window.isSecureContext === true,
    webCodecs: hasWindow && 'VideoDecoder' in window,
    webgl2,
    wasm: typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined',
  }
}

/**
 * Selects the H.264 decoder for the current environment:
 * - WebCodecs — secure context (HTTPS / localhost): hardware decode, lowest latency,
 *   any profile.
 * - WASM (tinyh264) — plain HTTP: software decode, no media-element buffer, no secure
 *   context required. Decodes (constrained-)baseline only, which both sources emit
 *   (iOS VideoToolbox baseline; Android scrcpy pinned to baseline).
 * - null — neither available (caller shows guidance).
 *
 * Both render via WebGL2. There is no MSE tier: WebCodecs covers the secure path and
 * WASM covers plain HTTP without the <video> media-element buffer that made MSE slow.
 */
export function pickDecoder(caps: DecoderCapabilities = detectCapabilities()): Decoder | null {
  if (caps.secureContext && caps.webCodecs && caps.webgl2) return new WebCodecsDecoder()
  if (caps.wasm && caps.webgl2) return new WASMDecoder()
  return null
}
