// Docs videos live in `docs/public/media/`.
//
// One folder, so the videos are easy to find, to size up, and to move somewhere else later if the
// repository outgrows them. **Only the location is enforced.** Size (about 2 MB a clip), silence,
// 5–15 s, one action per clip and a poster image are recommendations in
// `.claude/commands/write-docs.md` §6: the intro and setup videos run long by nature, and a check
// that had to exempt both would be a list of exceptions rather than a rule.
//
// Images are not covered. `docs/public/demo-thumbnail.png` stays at the root on purpose:
// `packages/cli/README.md` (published to npm) loads it through raw.githubusercontent.com, which no
// Vercel redirect can reach, and `config.ts` uses it as the `og:image`.
//
// The absence assertion is paired (`contributing/test-and-guard-coverage.md` rule 2): the fixture
// plants a video outside the folder, in upper case and nested, and it must be reported. The real
// walk is anchored on the two videos by name, so a walk that found nothing cannot pass.
//
// Mutations run by hand on 2026-09-27: `docs/public/media/tapflow-setup.mp4` copied to
// `docs/public/tapflow-setup.mp4` — red, naming it; `mov` dropped from `VIDEO` — the fixture's
// `.MOV` went unreported and the fixture case failed.
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const PUBLIC = join(import.meta.dirname, '..', '..', 'docs', 'public')
const VIDEO = /\.(mp4|webm|mov)$/i

/** Every file under `dir`, as `dir`-relative posix paths. */
function files(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) files(abs, base, out)
    else out.push(abs.slice(base.length + 1).replaceAll('\\', '/'))
  }
  return out.sort()
}

/** Videos in `paths` (relative to docs/public) that are not under `media/`. */
export const misplacedVideos = (paths) => paths.filter((p) => VIDEO.test(p) && !p.startsWith('media/'))

describe('docs videos live in docs/public/media/', () => {
  it('on the real tree', () => {
    const all = files(PUBLIC)
    expect(all).toEqual(expect.arrayContaining(['media/tapflow-demo.mp4', 'media/tapflow-setup.mp4']))
    expect(misplacedVideos(all)).toEqual([])
  })

  it('reports a video anywhere else, whatever the case of its extension', () => {
    expect(misplacedVideos([
      'media/ok.mp4',
      'media/nested/ok.webm',
      'demo-thumbnail.png',
      'clip.mp4',
      'guide/clip.webm',
      'Clip.MOV',
      'mediax/clip.mp4',
    ])).toEqual(['clip.mp4', 'guide/clip.webm', 'Clip.MOV', 'mediax/clip.mp4'])
  })
})
