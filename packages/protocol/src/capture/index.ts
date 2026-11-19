import type { BrowserToRelay, FieldReadReason, FocusedField, KeyboardState, TouchObservation } from '../index.js'

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
  /**
   * The keyboard-focused text field, read by the relay while the person was typing (#1135): what the keys really typed,
   * which the keys alone cannot say (the device's IME, its language, Caps Lock). `focus` is read at a run's first
   * character and says which field it went into; `value` is read once the person has paused and says what it holds.
   * `requestedAt` is when the relay asked and `at` when the answer came, so a reader can tell a read that saw the
   * field after the last key and before the next input from one that raced either.
   */
  | { at: number; kind: 'field'; phase: 'focus' | 'value'; requestedAt: number; field: FocusedField | null; reason?: FieldReadReason; keyboard?: KeyboardState; language?: string }
  /**
   * The soft keyboard, read by the relay around a person's inputs (#1135): what tells a tap on the keyboard from a tap
   * on the app. `settled` is a read that matched the one before it, taken once the keyboard stopped moving.
   */
  | { at: number; kind: 'keyboard'; requestedAt: number; keyboard: KeyboardState; settled: boolean }
  /** What a gesture's touch-down hit, seen from inside the app (record-time observation): `requestId` is the gesture's
   *  `input:touch:end`'s. Absent for a touch the agent could not observe — a reader falls back per touch. */
  | { at: number; kind: 'touched'; requestId: string; touched: TouchObservation }

export interface CaptureSnapshot {
  id: string
  takenAt: number
  entries: CaptureEntry[]
  /** Entries were dropped to stay inside the budget: moves thinned (a gesture keeps its last one), then old gestures. */
  thinned: boolean
  /** The `requestId`s of the inputs whose screen the relay holds a picture of (1b-3b), read one at a time from
   *  `GET …/capture/snapshot/thumbnails/:requestId`. Absent from a relay that keeps none. */
  thumbnails?: string[]
}
