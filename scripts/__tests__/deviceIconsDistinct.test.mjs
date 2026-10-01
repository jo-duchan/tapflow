// No two controls in one device toolbar are drawn with the same glyph.
//
// **Written because it happened.** #628's restart button took lucide's `Power`, which Android's own
// power key was already using — two buttons in the *same group*, two apart, with a byte-identical
// icon: one blanks the screen, the other throws away everything on the device. Nothing failed. The
// toolbar's own suite renders stand-in buttons, `androidButtonsClassified` checks names and slots,
// and neither has any reason to look at what is drawn.
//
// **The unit is one platform's toolbar, not one file.** `Play` and `Home` appear in both viewers on
// purpose — they are the same control implemented twice, which is exactly the symmetry
// `packages/dashboard/AGENTS.md` asks for. What must not repeat is two *different* controls inside
// the set a single tester is looking at, which is the toolbar's own icons plus one viewer's.
//
// **A name check, so a floor rather than a fence** — two distinct components drawing the same picture
// would pass. That is the right trade here: the failure this exists for is reaching for a name
// something else already took, and a name is precisely what that gets wrong.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const TOOLBAR = 'packages/dashboard/components/device/shared/SimulatorToolbar.tsx'
const VIEWERS = {
  iOS: 'packages/dashboard/components/device/IOSViewer.tsx',
  Android: 'packages/dashboard/components/device/AndroidViewer.tsx',
}

/**
 * Busy states, not identities.
 *
 * A spinner stands in for whatever control is waiting, so several controls share it by design — and
 * they are never on screen together as themselves. This is the only exemption, and it stays one:
 * an allowlist that grows quietly is the hole this file is trying not to become.
 */
const SHARED_BUSY = new Set(['Loader2'])

/**
 * The lucide components a file imports — everything it can draw.
 *
 * **Normalised past an alias**, because the identity that matters is the glyph and the alias is the
 * local name for it: `Power as RestartIcon` draws exactly what `Power` draws, and comparing raw
 * specifiers would have called them two different icons — letting the collision this file exists for
 * back in through a rename.
 */
function iconsIn(relPath) {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
  const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/)
  expect(imp, `${relPath} no longer imports from lucide-react — this check reads nothing`).toBeTruthy()
  return imp[1]
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter((s) => s.length > 0 && !SHARED_BUSY.has(s))
}

describe('a device toolbar draws each control differently', () => {
  it('reads real icon lists, so nothing passes by comparing empty sets', () => {
    // Anti-vacuity floor from the measured counts at the time of writing: toolbar 9, iOS 3,
    // Android 7. A regex that matched nothing would satisfy every assertion below.
    expect(iconsIn(TOOLBAR).length, 'the toolbar list parsed as empty').toBeGreaterThanOrEqual(6)
    for (const [platform, path] of Object.entries(VIEWERS)) {
      expect(iconsIn(path).length, `${platform}'s list parsed as empty`).toBeGreaterThanOrEqual(3)
    }
  })

  for (const [platform, path] of Object.entries(VIEWERS)) {
    it(`gives every ${platform} control its own icon`, () => {
      const all = [...iconsIn(TOOLBAR), ...iconsIn(path)]
      const seen = new Set()
      const repeated = [...new Set(all.filter((n) => seen.size === seen.add(n).size))]
      expect(
        repeated,
        `These icons are drawn by more than one control in the ${platform} toolbar, so two buttons\n`
        + '  that do different things look identical. Pick another glyph for the newer one — and not a\n'
        + '  near neighbour of one already there: `RotateCw` is rotate, so a bare circular arrow moves\n'
        + '  the collision rather than ending it.',
      ).toEqual([])
    })
  }

  it('keeps the two platforms drawing shared controls the same way', () => {
    // The other direction, and the reason this file cannot simply demand global uniqueness: a control
    // both platforms have must look the same on both, or a tester switching between them is relearning
    // the toolbar.
    //
    // **Named rather than merely counted.** This asserted only that *something* was shared, while the
    // sentence above it claimed `Play` and `Home` were the whole overlap — so a version where both of
    // those stopped being shared and some unrelated icon started would have passed under a comment
    // saying otherwise. Naming them makes a change to the overlap a decision: adding a control both
    // platforms have should fail here once, and be added here on purpose.
    const shared = iconsIn(VIEWERS.iOS)
      .filter((n) => iconsIn(VIEWERS.Android).includes(n))
      .sort()
    expect(shared, 'the set of controls both platforms draw the same way changed')
      // Volume and power joined in #785's follow-up: iOS reaches its hardware buttons from the same
      // "⋯" menu Android's moved into, drawn with the same glyphs.
      .toEqual(['Home', 'Play', 'Power', 'Volume1', 'Volume2'])
  })
})
