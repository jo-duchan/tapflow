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

/**
 * Whether this environment can decode H.264 — same condition as pickDecoder, but
 * evaluates capabilities without constructing a decoder (no worker spawn). Sent to the
 * agent as `acceptH264` at boot so it picks H.264 only when the browser can show it;
 * false → agent falls back to JPEG. WebGL2 is the floor (~95%); the rest get JPEG.
 */
export function canDecodeH264(caps: DecoderCapabilities = detectCapabilities()): boolean {
  return (caps.secureContext && caps.webCodecs && caps.webgl2) || (caps.wasm && caps.webgl2)
}

export type PerformanceMode = 'high' | 'standard' | 'unsupported'

/**
 * Maps the active decode path to the init wizard's performance profile labels, so the UI can show
 * the same wording (Standard / High performance) instead of decoder jargon. Same branch as
 * pickDecoder, evaluated without constructing a decoder:
 * - 'high' — WebCodecs (secure context): hardware decode.
 * - 'standard' — WASM (tinyh264): software decode on plain HTTP.
 * - 'unsupported' — neither (WebGL2 missing).
 */
export function performanceMode(caps: DecoderCapabilities = detectCapabilities()): PerformanceMode {
  if (caps.secureContext && caps.webCodecs && caps.webgl2) return 'high'
  if (caps.wasm && caps.webgl2) return 'standard'
  return 'unsupported'
}
