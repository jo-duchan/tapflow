// Every `#fragment` a docs page links to, and every one shipped code opens, lands on an id that exists.
//
// **VitePress's dead-link check ignores fragments** (vuejs/vitepress#354): it answers whether
// `/guide/agent` exists and never whether `#remote-relay-authentication` is on it. A heading rename
// therefore breaks every link into it with the build green — and a Korean heading's auto-slug is its
// text, so on the Korean pages *any* wording edit is a rename. Two of those links are compiled into
// shipped code (the dashboard's HTTPS notice and the iOS agent's CoreSimulator error), where no docs
// build could ever see them.
//
// **The ids come from VitePress's own renderer, not from a slug reimplemented here.**
// `createMarkdownRenderer` is the markdown-it instance the build uses, handed the `markdown` block of
// `docs/.vitepress/config.ts` itself — so the NFC slugify, explicit `{#id}`s, the `-1` suffix on a
// repeated heading and the text extracted from inline code are all whatever the site does. A
// reimplementation would drift from the site the first time either changed, and it would drift
// silently, because it would still agree with itself. The same render yields the links: markdown
// links, raw `<a href>` and `.md` rewrites all arrive as `href`s, and a link written inside a code
// block does not, because it was escaped.
//
// Cheap on purpose: no build, about half a second for all the pages, so it runs on every PR in
// `pnpm test:scripts` — including a PR that edits only `packages/`, which is the one that can break a
// shipped URL while the docs CI job is skipped by its path filter.
//
// **Absence assertions are paired** (`contributing/test-and-guard-coverage.md` rule 2): "no broken
// anchors" is also what an empty link walk or a parser that finds no fragments reports. Each real-tree
// case has a planted fixture beside it, rendered by the same renderer and judged by the same function,
// that must be reported — a missing id, a Hangul id one character off, a page that does not exist, a
// same-page fragment, and a shipped URL whose heading is gone. And the real walk is anchored on named
// links, not only a count.
//
// Mutations run by hand on 2026-09-26, per rule 1:
//  - `## Remote relay authentication` renamed in `docs/guide/agent.md`: the docs case named all seven
//    links into it, across five pages.
//  - the explicit id removed from the Korean `## Docker 컨테이너에서 첫 관리자 계정 만들기` heading:
//    failed on `ko/dashboard/setup.md` and `ko/guide/self-hosting.md`.
//  - `## HTTPS (secure context)` renamed in `docs/reference/configuration.md`: the shipped-URL case
//    named `PerformanceModeNotice.tsx`, and the docs case the two pages linking the same heading.
//  - the fragment in `PerformanceModeNotice.tsx` edited instead: the named-URL assertion failed.
//  - before `<a name>` counted as a target, the real tree reported ten false misses on the
//    performance footnotes — the check was wrong, not the page, and the fixture now carries one.
//
// **Shipped URLs follow the redirects; in-repo links do not.** A URL in a released agent or an npm
// README cannot be edited, so it is judged after `docs/.vitepress/moves.json` has moved its path,
// the way a browser reaches it. `LEGACY_URLS` keeps the ones that have shipped in their original
// form after the source moves on. In-repo links are rewritten when a page moves, so they resolve
// as written. Mutations on 2026-09-27: `## HTTPS (secure context) {#https-secure-context}` reworded
// without its id — the docs, shipped, legacy and planted cases all failed, and with the id kept all
// passed; `/guide/agent` pointed at a missing page in `moves.json` — the legacy case named
// `#remote-relay-authentication`; `resolveMoved` made to return its input — the legacy case named
// both README URLs and the planted redirect case went red.
//
// **Not seen**: fragments in frontmatter hero `link:`s and in `config.ts` nav/sidebar links (they are
// not rendered markdown; none carry a `#` today), and URLs in `.js`/`.mjs`/`.swift` files under
// packages/ (none today). Shipped URLs are read from `.ts`/`.tsx` sources and the READMEs.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import config from '../../docs/.vitepress/config.ts'
import { createMarkdownRenderer } from '../../docs/node_modules/vitepress/dist/node/index.js'
import { sources } from './sourceFiles.mjs'
import { loadMoves, resolveMoved } from '../docs-redirects.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const DOCS = join(ROOT, 'docs')
/** Absolute links to the site count as internal: a page's prose may spell one out. Only the `www`
 *  origin — `agentReadableDocs.test.mjs` already forbids the apex, which answers 307. */
const SITE_ORIGINS = ['https://www.tapflow.dev']

/** Contributor files `srcExclude` keeps off the site — not pages, so nothing may link into them. */
const NOT_PAGES = new Set(['AGENTS.md', 'CLAUDE.md'])

function docPages(dir = DOCS, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'public' && !e.name.startsWith('.')) docPages(join(dir, e.name), out)
    } else if (e.name.endsWith('.md') && !NOT_PAGES.has(e.name)) {
      out.push(join(dir, e.name).slice(DOCS.length + 1).replaceAll('\\', '/'))
    }
  }
  return out.sort()
}

const decodeEntities = (s) =>
  s.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

let md
beforeAll(async () => {
  md = await createMarkdownRenderer(DOCS, config.markdown, '/', { warn: () => {} })
})

/** One page, rendered: the ids it defines and the hrefs it links, in source order. */
function render(relPath, source) {
  const html = md.render(source, { path: join(DOCS, relPath), relativePath: relPath, cleanUrls: true })
    // An id inside an HTML comment or a code block renders as text, not as a target: without this a
    // commented-out section, or a `text` fence showing the syntax, would count as the id still existing.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
  // A fragment also scrolls to `<a name="…">` (HTML's legacy anchor), which is how
  // `reference/performance.md` numbers its footnotes — so both count as a target.
  const ids = new Set([
    ...[...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<a\b[^>]*\sname="([^"]*)"/g)].map((m) => m[1]),
  ].map(decodeEntities))
  // The permalink VitePress puts beside every heading points at its own heading, so it can only ever
  // agree. Left in, it would inflate the count the floors below read.
  const hrefs = [...html.matchAll(/<a\b([^>]*)>/g)]
    .filter((m) => !/class="header-anchor"/.test(m[1]))
    .map((m) => m[1].match(/\shref="([^"]*)"/)?.[1])
    .filter((h) => h !== undefined)
    .map(decodeEntities)
  return { ids, hrefs }
}

/** `guide/agent`, `guide/`, `/ko/` → the page file that serves it, or undefined. */
function pageFor(urlPath, pages) {
  let p = urlPath.replace(/^\//, '').replace(/\.(html|md)$/, '')
  if (p === '' || p.endsWith('/')) p += 'index'
  return [`${p}.md`, `${p}/index.md`].find((c) => pages.has(c))
}

/**
 * Resolves `href` as written on `fromPage` to `{ page, fragment }`, or null when it is not an internal
 * link with a fragment. `page` is undefined when the link names a page that does not exist.
 */
function target(href, fromPage, pages) {
  let rest = href
  const origin = SITE_ORIGINS.find((o) => rest === o || rest.startsWith(`${o}/`) || rest.startsWith(`${o}#`))
  if (origin) rest = rest.slice(origin.length) || '/'
  else if (/^[a-z][a-z0-9+.-]*:/i.test(rest) || rest.startsWith('//')) return null
  const hash = rest.indexOf('#')
  if (hash === -1) return null
  const fragment = decodeURIComponent(rest.slice(hash + 1))
  if (fragment === '') return null
  const path = rest.slice(0, hash).replace(/\?.*$/, '')
  if (path === '') return { page: fromPage, fragment }
  const abs = path.startsWith('/') ? path : posix.join('/', posix.dirname(fromPage), path)
  return { page: pageFor(abs, pages), fragment }
}

/**
 * Every fragment link across `rendered` (page → render()) that misses, as `from → href (why)`,
 * plus the links checked, so a caller can tell an empty walk from a clean one.
 */
function brokenAnchors(rendered) {
  const broken = []
  const checked = []
  for (const [from, { hrefs }] of rendered) {
    for (const href of hrefs) {
      const t = target(href, from, rendered)
      if (!t) continue
      checked.push(`${from} → ${href}`)
      if (!t.page) broken.push(`${from} → ${href} (no such page)`)
      else if (!rendered.get(t.page).ids.has(t.fragment)) broken.push(`${from} → ${href} (no #${t.fragment} on ${t.page})`)
    }
  }
  return { broken, checked }
}

/** `https://www.tapflow.dev/…#…` URLs in the given files, as `file → url`. */
function shippedUrls(files) {
  const out = []
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    for (const m of text.matchAll(/https?:\/\/(?:www\.)?tapflow\.dev\/[^\s'"`)<>\\]*#[^\s'"`)<>\\]+/g)) {
      out.push({ file, url: m[0] })
    }
  }
  return out
}

/**
 * Each shipped URL judged against the rendered docs, the same way a page's link is — except that its
 * path is first followed through `docs/.vitepress/moves.json`, because a shipped URL cannot be edited
 * and reaches the page through the redirect. In-repo links do not get this: they are rewritten when
 * a page moves.
 */
function brokenShipped(urls, rendered, moves = { pages: {} }) {
  const redirected = (url) => {
    const m = url.match(/^(https?:\/\/(?:www\.)?tapflow\.dev)(\/[^#?]*)(.*)$/)
    return m ? `${m[1]}${resolveMoved(m[2], moves)}${m[3]}` : url
  }
  return urls
    .map(({ file, url }) => ({ file, url, t: target(redirected(url), 'index.md', rendered) }))
    .filter(({ t }) => !t || !t.page || !rendered.get(t.page).ids.has(t.fragment))
    .map(({ file, url }) => `${file} → ${url}`)
}

/**
 * URLs with a fragment that shipped somewhere no docs PR can edit: compiled into the dashboard or an
 * agent, or printed in a README published to npm. Kept in their original form forever; see the case
 * that reads them. Add one when a release ships a new one — do not remove one when the source moves on.
 */
const LEGACY_URLS = [
  'https://www.tapflow.dev/reference/configuration#https-secure-context',          // dashboard PerformanceModeNotice.tsx
  'https://www.tapflow.dev/guide/troubleshooting#ios-simulator-service-version-mismatch', // ios-agent simctl.ts
  'https://www.tapflow.dev/guide/self-hosting#docker-compose-lan-server',          // READMEs
  'https://www.tapflow.dev/guide/agent#remote-relay-authentication',               // READMEs, before 2026-09-27
  'https://www.tapflow.dev/guide/environment-setup#tapflow-setup',                 // READMEs, before 2026-09-27
]

let site
function renderSite() {
  site ??= new Map(docPages().map((p) => [p, render(p, readFileSync(join(DOCS, p), 'utf8'))]))
  return site
}

describe('docs fragment links land on an id', () => {
  it('every internal link with a #fragment, EN and KO', () => {
    const rendered = renderSite()
    // A floor, not a pin: 56 pages on 2026-09-26 (28 English, 28 Korean, contributor files
    // excluded). Pages are added in most docs PRs, and `docsLocaleParity` already pairs them.
    expect(rendered.size).toBeGreaterThanOrEqual(56)
    const { broken, checked } = brokenAnchors(rendered)
    // Anchored by name — a Hangul auto-slug, an explicit id, a same-page link — so a walk that
    // silently stopped decoding, rewriting or resolving one kind cannot pass on the others. The
    // count is the backstop under them (104 on 2026-09-26).
    expect(checked).toContain('ko/reference/cli.md → /ko/operate/agents#원격-릴레이-인증')
    expect(checked).toContain('dashboard/setup.md → /reference/configuration#create-the-first-admin-account-in-a-docker-container-tapflow-admin-email')
    expect(checked).toContain('reference/cli.md → #tapflow-migrate-net-filter')
    expect(checked.length).toBeGreaterThanOrEqual(100)
    expect(broken).toEqual([])
  })

  it('reports a missing id, a Hangul id one character off, a missing page, and a bad same-page link — and accepts the ids the site has', () => {
    const fixture = new Map([
      ['guide/a.md', render('guide/a.md', '# A\n\n## 외부 접속\n\n## Explicit {#explicit-id}\n\n## Twice\n\n## Twice\n\n1. <a name="legacy"></a> A footnote\n')],
      ['guide/b.md', render('guide/b.md', [
        '# B',
        '',
        '[ok](./a.md#외부-접속) [ok](/guide/a#explicit-id) [ok](/guide/a#twice-1) [ok](/guide/a#legacy) [ok](#b)',
        '[bad](/guide/a#nope) [bad](./a#외부-접속2) [bad](/guide/zz#x) [bad](#nope)',
        '[ignored](https://example.com/x#y) [ignored](/guide/a)',
        '',
        '```md',
        '[not a link](/guide/a#inside-a-code-block)',
        '```',
        '',
      ].join('\n'))],
    ])
    const { broken, checked } = brokenAnchors(fixture)
    expect(checked).toHaveLength(9)
    expect(broken).toEqual([
      'guide/b.md → /guide/a#nope (no #nope on guide/a.md)',
      'guide/b.md → ./a#외부-접속2 (no #외부-접속2 on guide/a.md)',
      'guide/b.md → /guide/zz#x (no such page)',
      'guide/b.md → #nope (no #nope on guide/b.md)',
    ])
  })
})

describe('the docs URLs shipped code opens land on an id', () => {
  it('every tapflow.dev URL with a #fragment under packages/ and in the READMEs', () => {
    // The READMEs ship too: the root one on GitHub, packages/cli's on npm (it is in `files`).
    const readmes = ['README.md', ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/README.md`)]
      .filter((f) => existsSync(join(ROOT, f)))
    const files = [...sources('packages'), ...readmes]
    const urls = shippedUrls(files)
    // Named, because these two are why the check exists — the first two a docs reorganisation would
    // break (DOCS-AUDIT-PLAN). A walk that stopped reaching `packages/dashboard/components` or the
    // agent's `src` would drop one of them without changing any verdict.
    expect(urls.map((u) => u.url)).toEqual(expect.arrayContaining([
      'https://www.tapflow.dev/reference/configuration#https-secure-context',
      'https://www.tapflow.dev/guide/troubleshooting#ios-simulator-service-version-mismatch',
      'https://www.tapflow.dev/guide/self-hosting#docker-compose-lan-server',
    ]))
    expect(brokenShipped(urls, renderSite(), loadMoves())).toEqual([])
  })

  it('every URL that has ever shipped with a #fragment, in its original form', () => {
    // A URL compiled into a released agent or printed in a README published to npm is out of reach
    // for good — editing the source today does not edit the copies already installed. So these stay
    // listed after the code that held them moves on, and resolve through the redirects.
    expect(brokenShipped(LEGACY_URLS.map((url) => ({ file: 'LEGACY_URLS', url })), renderSite(), loadMoves())).toEqual([])
  })

  it('reports a shipped URL whose heading is gone, and follows a redirect only when one exists', () => {
    const rendered = renderSite()
    const planted = [
      { file: 'x.ts', url: 'https://www.tapflow.dev/reference/configuration#https-secure-context' },
      { file: 'y.ts', url: 'https://www.tapflow.dev/reference/configuration#renamed-heading' },
      { file: 'z.ts', url: 'https://www.tapflow.dev/guide/moved-page#anything' },
      { file: 'r.ts', url: 'https://www.tapflow.dev/guide/agent#remote-relay-authentication' },
      { file: 's.ts', url: 'https://www.tapflow.dev/guide/agent#renamed-heading' },
    ]
    expect(brokenShipped(planted, rendered, loadMoves())).toEqual([
      'y.ts → https://www.tapflow.dev/reference/configuration#renamed-heading',
      'z.ts → https://www.tapflow.dev/guide/moved-page#anything',
      's.ts → https://www.tapflow.dev/guide/agent#renamed-heading',
    ])
    // Without the move table the old page is simply gone, so the redirect is what made `r.ts` land.
    expect(brokenShipped(planted.filter((u) => u.file === 'r.ts'), rendered)).toEqual([
      'r.ts → https://www.tapflow.dev/guide/agent#remote-relay-authentication',
    ])
  })
})

describe('the renderer is the site\'s', () => {
  it('is handed config.ts\'s markdown block, whose slugify keeps Hangul composed', () => {
    // Without the config's `anchor.slugify`, VitePress's default NFKD slug splits each syllable into
    // jamo and every Korean fragment in the tree reports as missing — loud, but for the wrong reason.
    expect(config.markdown?.anchor?.slugify).toBeTypeOf('function')
    expect(existsSync(join(DOCS, 'node_modules', 'vitepress', 'dist', 'node', 'index.js'))).toBe(true)
    const { ids } = render('guide/x.md', '## 외부 접속\n')
    expect([...ids]).toEqual(['외부-접속'])
    expect('외부-접속'.normalize('NFC')).toBe('외부-접속')
  })
})
