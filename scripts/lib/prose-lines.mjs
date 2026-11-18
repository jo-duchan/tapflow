/**
 * The lines of a markdown body that are actually prose: no fenced block, no indented block, and
 * — with `skipFrontmatter` — nothing inside the leading `---` delimiters.
 *
 * Shared on purpose. Both markers below are switches that turn a gate OFF, so a body that merely
 * QUOTES one must not trip it; every doc in this repo prints both verbatim. `extractReason` had
 * this guard and `parseBackfills` was written without it, which is exactly the kind of drift a
 * second copy invites.
 */
export function* proseLines(body, { skipFrontmatter = false } = {}) {
  const lines = body.split(/\r?\n/)
  let i = 0
  if (skipFrontmatter && lines[0]?.trim() === '---') {
    i = 1
    while (i < lines.length && lines[i].trim() !== '---') i++
    i++                                            // step past the closing delimiter
  }
  let fence = null
  for (; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null
      }
      continue
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length }
      continue
    }
    if (/^ {4,}|^\t/.test(raw)) continue           // indented code block
    yield { raw, line, index: i }
  }
}
