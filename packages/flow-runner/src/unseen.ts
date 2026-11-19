/**
 * Characters a person reading a flow cannot see: an icon font's glyph (the Private Use Area, a box in any other font),
 * a format character (a zero-width space, a direction mark), a control, a code point with no character, a line or
 * paragraph separator (an editor may break the line there, the file has none), and the characters that are letters by
 * their category but draw nothing — the Hangul fillers and the blank Braille cell, which apps use for a label that must
 * not be empty. Not the zero-width joiner and non-joiner: inside text they are part of it, in an emoji sequence or a
 * Persian or Indic word. Not a combining mark with nothing before it: no label was found made of one, and telling one
 * from a mark on a letter needs grapheme clusters.
 */
const BLANK = String.raw`\p{Co}\p{Cf}\p{Cc}\p{Cn}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800`
export const UNSEEN = new RegExp(String.raw`(?![\u200C\u200D])[${BLANK}]`, 'u')

/** Whether text shows a person anything: a character that is none of those, nor a joiner, nor a space. */
const SHOWN = new RegExp(String.raw`[^\s${BLANK}]`, 'u')
export const visible = (text: string): boolean => SHOWN.test(text)
