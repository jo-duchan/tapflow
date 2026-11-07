/** The HID modifier bits on `input:key` (protocol `InputKey`), as `keyModifierBits` in `schema.ts` writes them. */
export const KEY_CTRL = 0x01
export const KEY_SHIFT = 0x02
export const KEY_ALT = 0x04
export const KEY_META = 0x08

const SHIFTED_DIGITS: Record<string, string> = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
}
const PUNCTUATION: Record<string, [string, string]> = {
  Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'],
  Backquote: ['`', '~'], Space: [' ', ' '],
}

/**
 * The character a key press types on a US layout, or `null` when it types none: an editing key, a chord, a key with no
 * character. The table Android's agent types through (`AndroidAgent` `input:key`), so a captured run of these replays
 * as `inputText` with the same characters there. iOS sends the key's HID usage and the simulator's keyboard settles
 * the character, which is the same on a US layout. `capsLock` is the device's Caps Lock as the keys before this one
 * left it.
 */
export function keyChar(code: string, modifiers: number, capsLock = false): string | null {
  if (modifiers & (KEY_CTRL | KEY_ALT | KEY_META)) return null
  const shift = (modifiers & KEY_SHIFT) !== 0
  // Caps Lock turns letters only, and shift turns them back.
  if (/^Key[A-Z]$/.test(code)) return shift !== capsLock ? code.slice(3) : code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return shift ? SHIFTED_DIGITS[code.slice(5)]! : code.slice(5)
  const p = Object.hasOwn(PUNCTUATION, code) ? PUNCTUATION[code]! : undefined
  return p ? p[shift ? 1 : 0] : null
}

/** The flow's names for the modifier bits, in the order `pressKey { modifiers }` lists them. */
export function modifierNames(modifiers: number): Array<'shift' | 'ctrl' | 'alt' | 'meta'> {
  const out: Array<'shift' | 'ctrl' | 'alt' | 'meta'> = []
  if (modifiers & KEY_SHIFT) out.push('shift')
  if (modifiers & KEY_CTRL) out.push('ctrl')
  if (modifiers & KEY_ALT) out.push('alt')
  if (modifiers & KEY_META) out.push('meta')
  return out
}
