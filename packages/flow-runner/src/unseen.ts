/**
 * Characters a person reading a flow cannot see: an icon font's glyph (the Private Use Area, a box in any other font),
 * a format character (a zero-width space, a direction mark), a control, a code point with no character. Not the
 * zero-width joiner and non-joiner: inside text they are part of it, in an emoji sequence or a Persian or Indic word.
 */
export const UNSEEN = /(?![‌‍])[\p{Co}\p{Cf}\p{Cc}\p{Cn}]/u

/** Whether text shows a person anything: a character that is none of those, nor a joiner, nor a space. */
export const visible = (text: string): boolean => /[^\s\p{Co}\p{Cf}\p{Cc}\p{Cn}]/u.test(text)
