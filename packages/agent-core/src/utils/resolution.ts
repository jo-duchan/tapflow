/**
 * Per-session downscale cap (longest side, px) chosen by the viewer's context:
 *  - secure context (localhost / LAN-HTTPS) → 0 (native): WebCodecs hardware-decodes full res cheaply.
 *  - LAN-HTTP (non-secure) → 1280: the WASM (tinyh264) decoder is the bottleneck, so trim decode load.
 *  - external connection → 1000: bandwidth-constrained, downscale further.
 *
 * `override` (a platform/global TAPFLOW_MAX_SIZE) wins when set — including "0" to force native.
 * The LAN/external defaults are tunable via TAPFLOW_MAX_SIZE_LAN / TAPFLOW_MAX_SIZE_EXTERNAL.
 */
// Parse a px cap, honoring an explicit "0" (force native) — `Number(x) || fallback` would
// swallow "0" as falsy and wrongly return the fallback. Non-numeric/negative → fallback.
function parseCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function pickMaxSize(o: { secureContext: boolean; external: boolean; override?: string }): number {
  if (o.override !== undefined && o.override !== '') return parseCap(o.override, 0)
  if (o.external) return parseCap(process.env.TAPFLOW_MAX_SIZE_EXTERNAL, 1000)
  if (o.secureContext) return 0
  return parseCap(process.env.TAPFLOW_MAX_SIZE_LAN, 1280)
}
