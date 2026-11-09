import { activityLabel } from '../engine.js'
import { keyChar, modifierNames } from './keys.js'
import type { CapturedStep } from './match.js'
import type { Point, RawStep } from './segment.js'

const pct = ([x, y]: Point): string => `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`
const chars = (text: string): string => `${[...text].length} chars`

/**
 * A recorded action in the flow's own words, before it is matched: `tapOn 40%, 60%`. Never what was typed, pasted or
 * opened — a count, or the step's name alone — so a list of steps can be shown wherever the dialog is.
 */
export function rawStepLabel(raw: RawStep): string {
  switch (raw.kind) {
    case 'tap': return `tapOn ${pct(raw.point)}`
    case 'longPress': return `longPressOn ${pct(raw.point)} (${raw.durationMs}ms)`
    case 'swipe': return `swipe ${pct(raw.from)} → ${pct(raw.to)}`
    case 'holdDrag': return `longPressOn ${pct(raw.from)}, then drag`
    case 'pinch': return 'pinch'
    // Its text is only what the computer's keyboard typed; the person gives the rest (#1140).
    case 'text': return raw.askValue ? 'inputText (password)' : `inputText (${chars(raw.text)})`
    case 'type': return `inputText (${chars(raw.text)})`
    case 'paste': return `inputText (${chars(raw.text)}, pasted)`
    case 'key': {
      const mods = modifierNames(raw.modifiers)
      // A chord's letter types nothing, but a shifted one would; either way the label never names a character.
      const key = keyChar(raw.code, raw.modifiers & 0x02) !== null ? 'character' : raw.code
      return `pressKey ${[...mods, key].join('+')}`
    }
    case 'button': return `pressButton ${raw.name}${raw.heldMs !== undefined && raw.heldMs >= 500 ? ' (held)' : ''}`
    case 'rotate': return raw.to && 'orientation' in raw.to ? `setOrientation ${raw.to.orientation}` : 'setOrientation'
    case 'posture': return 'setPosture'
    case 'keyboardToggle': return 'keyboard'
    case 'keyboardKey': return 'keyboard key'
    case 'imeAction': return 'imeAction'
    case 'launch': return 'launchApp'
    case 'install': return 'install'
    case 'clearState': return 'clearState'
    case 'openUrl': return 'openUrl'
    case 'network': return raw.offline ? 'network offline' : 'network online'
    case 'cut': return 'cut'
  }
}

/** A captured step's name: the flow step's watcher label once matched, the raw action's before. */
export function capturedStepLabel(c: CapturedStep): string {
  return c.step ? activityLabel(c.step) : rawStepLabel(c.raw)
}
