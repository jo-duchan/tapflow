import type { BrowserToRelay } from '../index.js'

/**
 * Flow Capture's record (#1125), as the relay keeps it and returns it from `/api/v1/sessions/:id/capture/snapshot`.
 * Not a WebSocket message: here because the relay writes it and flow-runner's capture module reads it, and two copies
 * of its shape would drift. Types only — the main entry's rule.
 */

/** The browser messages a capture keeps: the inputs, and the commands that change what is on the device. */
export type CapturedMessage = Extract<BrowserToRelay, { type:
  | 'input:touch:start' | 'input:touch:move' | 'input:touch:end' | 'input:touch:cancel'
  | 'input:pinch:start' | 'input:pinch:move' | 'input:pinch:end'
  | 'input:key' | 'input:button' | 'input:type' | 'input:rotate' | 'input:posture' | 'input:keyboard:toggle'
  | 'app:install' | 'app:launch' | 'app:clear-state' | 'open-url'
  | 'clipboard:write' | 'clipboard:read' | 'network:set'
}>

export type CaptureEntry =
  /** `at` is the relay's clock when it passed the message on. */
  | { at: number; kind: 'input'; msg: CapturedMessage }
  /** The agent's answer to an acked input, so a refused or failed one can be told from one that landed. */
  | { at: number; kind: 'ack'; requestId: string; ok: boolean }
  /** The device's chrome changed (a turn, a fold), images emptied. `unknown`: agent chrome is not validated by the
   *  relay, so a reader narrows it. It lags a turn by 0.6–3.6 s, so it describes the steps, it does not place them. */
  | { at: number; kind: 'chrome'; chrome: unknown }

export interface CaptureSnapshot {
  id: string
  takenAt: number
  entries: CaptureEntry[]
  /** Entries were dropped to stay inside the budget: moves thinned (a gesture keeps its last one), then old gestures. */
  thinned: boolean
}
