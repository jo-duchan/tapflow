// What an LLM agent gets when it reads tapflow.dev.
//
// Measured on 2026-09-18 against the live site: `/llms.txt` answered 200, but every link in it
// pointed at a page that exists only as HTML, and `/llms-full.txt` was a 404. So the index worked
// and nothing it indexed did — an agent following a link had to strip VitePress's nav, sidebar and
// theme scripts back off to reach the prose. This hook closes that: the source markdown ships
// beside the HTML, and the English prose also ships as one file.
//
// **Written in `.mjs`, not `.ts`, so the root scripts suite can import it.** The hook's real
// operation is writing files, and `scripts/__tests__/agentReadableDocs.test.mjs` runs it against a
// temporary directory rather than asserting on a config literal. Nothing in CI builds the docs
// (`.github/workflows/` has no `docs:build`), so a test that needed a real build would not run at
// all.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readPageStatus } from './page-status.mjs'

/** The path prefix VitePress gives the Korean locale. */
const TRANSLATION_PREFIX = 'ko/'

/**
 * `true` for a page under the Korean locale.
 *
 * The Korean pages are a 1:1 translation — measured 2026-09-18, the two locales carry the same 28
 * paths with none missing on either side — so `llms-full.txt` would be the same document twice,
 * 223KB of it. They still ship as `.md`, which costs a copy and is what an agent needs when it
 * hands a Korean reader a link.
 *
 * @param {string} page srcDir-relative page path
 */
export const isTranslation = (page) => page.startsWith(TRANSLATION_PREFIX)

/**
 * The frontmatter block at the top of a page, if it has one.
 *
 * Only the **bundle** strips it. `llms-full.txt` separates its sections with a `---` line, and a
 * page's own frontmatter fences are two more of exactly that — measured on the first build, 29 bare
 * `---` lines against 27 sections, so an agent splitting the bundle on `---` got an orphan chunk
 * holding `guide/introduction.md`'s `description:` and no URL header. The `.md` copies keep it: they
 * are the source, and frontmatter is part of it.
 *
 * The body is optional. VitePress accepts an empty block, and a first version of this pattern
 * required at least one line between the fences — so `---\n---` survived the strip and put back
 * the two separators this exists to remove. An empty block is what an editor leaves behind after
 * the last key is deleted, which is exactly when nobody looks at the bundle.
 */
const FRONTMATTER = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/

/**
 * `true` for a VitePress `layout: home` page.
 *
 * The landing pages are hero frontmatter and nothing else — `docs/index.md`'s body is empty and its
 * frontmatter is four inline SVG icons. Concatenating that into `llms-full.txt` adds path data, not
 * documentation. The blurb at the top of `llms.txt` already says what the landing page says.
 *
 * Read from the frontmatter block only. A `layout: home` written in prose further down the page is
 * an example of the syntax, not a declaration of it.
 *
 * @param {string} source raw markdown
 */
export function isLanding(source) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (!frontmatter) return false
  return /^layout:\s*home\s*$/m.test(frontmatter[1])
}

/**
 * The public URL of a page, as `cleanUrls` serves it.
 *
 * @param {string} page srcDir-relative page path, e.g. `guide/agent.md`
 * @param {string} hostname origin with no trailing slash
 */
export function pageUrl(page, hostname) {
  const path = page.replace(/\.md$/, '')
  if (path === 'index') return `${hostname}/`
  return `${hostname}/${path.replace(/\/index$/, '/')}`
}

/**
 * The whole English documentation as one file.
 *
 * Each section is preceded by the page's own URL, so an agent that quotes a passage can cite the
 * page it came from rather than the bundle.
 *
 * An experimental or deprecated page also gets a `Status:` line under its URL. The bundle strips
 * frontmatter, and the page's banner is drawn by the theme from that frontmatter, so without this
 * line the bundle would present every page as stable.
 *
 * @param {{ page: string, source: string, status?: ReturnType<typeof readPageStatus> }[]} pages
 *   already filtered and ordered
 * @param {string} hostname origin with no trailing slash
 */
export function renderLlmsFull(pages, hostname) {
  // Derived, never typed: the docs grow, and a number written by hand here would be wrong by the
  // next page anyone adds.
  const approxChars = pages.reduce((n, { source }) => n + source.length, 0)
  const lengthLabel = `about ${Math.round(approxChars / 1000)},000 characters`
  const header = [
    '# tapflow — full documentation',
    '',
    '> Every English documentation page of tapflow, concatenated. The index with one-line',
    `> descriptions is at ${hostname}/llms.txt, and each page below is also served on its own at`,
    '> the path under its `#` heading with a `.md` suffix — an index page at `<dir>/index.md`.',
    '> Korean translations live under `/ko/` and carry the same content.',
    '>',
    // Said here as well as in llms.txt, because a tool that truncated this file still received the
    // header: it is the only line that reaches a reader who cannot see the reference pages below.
    `> This file is ${lengthLabel} long and the reference pages are at the end, so a tool that`,
    '> truncates or summarises a large fetch will not see them. Prefer the single page you need.',
    '',
  ].join('\n')

  const statusLine = (status) =>
    status.status === 'deprecated'
      ? `Status: deprecated, replaced by ${hostname}${status.replacedBy}`
      : `Status: ${status.status}`
  const sections = pages.map(({ page, source, status }) =>
    [`# ${pageUrl(page, hostname)}`, '', ...(status ? [statusLine(status), ''] : []), source.trimEnd(), ''].join(
      '\n',
    ),
  )

  return [header, ...sections].join('\n---\n\n')
}

/**
 * Copy every page's markdown into the build output and write `llms-full.txt` beside it.
 *
 * @param {object} input
 * @param {string} input.srcDir directory the pages are relative to
 * @param {string} input.outDir build output directory
 * @param {string[]} input.pages srcDir-relative `.md` paths — VitePress has already applied
 *   `srcExclude`, which is what keeps `AGENTS.md` and `CLAUDE.md` out of both artifacts.
 *   **Assumes every entry is a file on disk and is served at its own path**, which holds while the
 *   site configures no `rewrites` and has no dynamic routes. VitePress appends dynamic routes to
 *   this list as rendered paths with no source file, so adding a `[param].md` would need an on-disk
 *   check here, and adding `rewrites` would need `siteConfig.rewrites.map` to build the URLs.
 * @param {string} input.hostname origin with no trailing slash
 * @returns {Promise<{ copied: string[], bundled: string[] }>}
 */
export async function emitAgentArtifacts({ srcDir, outDir, pages, hostname }) {
  const ordered = [...pages].sort()
  const copied = []
  /** @type {{ page: string, source: string, status: ReturnType<typeof readPageStatus> }[]} */
  const bundled = []

  for (const page of ordered) {
    const source = await readFile(join(srcDir, page), 'utf8')
    const target = join(outDir, page)
    await mkdir(dirname(target), { recursive: true })
    // Copied rather than re-serialised: an agent asking for `.md` asked for the source, and a
    // round trip through a parser would quietly normalise it.
    await copyFile(join(srcDir, page), target)
    copied.push(page)
    if (!isTranslation(page) && !isLanding(source)) {
      bundled.push({
        page,
        source: source.replace(FRONTMATTER, '').trimStart(),
        status: readPageStatus(source, page),
      })
    }
  }

  await writeFile(join(outDir, 'llms-full.txt'), renderLlmsFull(bundled, hostname), 'utf8')

  return { copied, bundled: bundled.map(({ page }) => page) }
}
