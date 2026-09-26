// A docs page that moves keeps its old URL, and every `#fragment` the site ever rendered keeps landing.
//
// The docs were reorganised by reader task in 2026-09 (`/guide/*` → `/get-started/`, `/testing/`,
// `/operate/`, `/automation/`). Old URLs are in READMEs published to npm, in shipped agent code, in
// bookmarks and in other people's pages, none of which a docs PR can edit. Three things hold them:
//
//  - comment/`<pre>` stripping removed from render(): the fixture's commented-out and fenced ids count as present.
//  - **`docs/.vitepress/moves.json` is the single source for the redirects.** `docs/vercel.json` is
//    generated from it by `scripts/docs-redirects.mjs --write`, and this suite fails when the two
//    disagree. A move also may not chain (a destination that is itself a source means two hops, and
//    a later move must rewrite the earlier destination instead), may not point at a page that does
//    not exist, and may not leave its source as a page — Vercel applies `redirects` before the
//    filesystem, so that page would be unreachable.
//  - **`docs/.vitepress/frozen-ids.json` is every id rendered on main at 74bc7dc8**, the commit before
//    the restructure: heading ids plus `<a id>` / `<a name>` targets, per page, EN and KO. Each is
//    followed through `moves.json` to the page it lands on today and must exist there. A heading
//    rename therefore has to keep `{#old-id}`, add an `<a id>`, or add a Moved-sections entry. The
//    set is frozen — nothing regenerates it — because a regenerated set would agree with whatever the
//    docs say now, which is the drift it exists to catch. Random ids (VitePress's code-group tabs are
//    `tab-<nanoid>`) were left out when it was taken; they change every render and nobody links them.
//  - **Moved sections** (`<a id="…" data-moved-to="/new/page#id">`, the successor of a split page):
//    every target must resolve, and an entry whose id is still a heading on the same page is dead —
//    the heading wins, and the entry was supposed to be removed when the section came back.
//
// The ids come from VitePress's own renderer with `config.ts`'s `markdown` block, the same way
// `docsAnchors.test.mjs` gets them, so the NFC slugify and explicit `{#id}`s are the site's.
//
// **Absence assertions are paired** (`contributing/test-and-guard-coverage.md` rule 2). "No missing
// ids", "no chains", "no dead entries" is also what an empty walk reports, so each has a planted
// fixture judged by the same function, and the real-tree cases carry floors — the Moved-sections one
// too, since the three pages split in 2026-09 (`guide/self-hosting`, `guide/troubleshooting`,
// `dashboard/overview`) left 126 entries across their successors, EN and KO.
//
// Mutations run by hand on 2026-09-27, per rule 1:
//  - `## 1. Install tapflow {#_1-install-tapflow}` reworded to `## 1. Install the CLI` in
//    `docs/get-started/quick-start.md`: the frozen case named `/guide/getting-started#_1-install-tapflow`.
//    Deleting only the `{#…}` **survives**, correctly: the English explicit ids equal the auto-slugs,
//    so they change nothing until the wording does — which is the point of writing them.
//  - `<a id="_1-tapflow-설치">` removed from the KO Quick Start, and `<a id="https-보안-컨텍스트">`
//    from the KO configuration page: frozen case red on each.
//  - one rule deleted from `docs/vercel.json`: the agreement case failed.
//  - `/guide/agent` → `/operate/agent` (no such page) in `moves.json`: the agreement, destination
//    and frozen cases all failed, the last naming the 32 ids behind the two locales.
//  - `docs/operate/agents.md` copied back to `docs/guide/agent.md`: the shadowed-source case.
//  - `docs/public/media/tapflow-setup.mp4` copied back to the root: the shadowed-file case.
//  - `resolveMoved` made to return its input: the frozen case reported 250 ids, and the two fixtures
//    that follow a move failed.
//  - in the functions: the chain check, the dead-entry check and the target-id check each disabled
//    in turn — the fixture for each went red, the real-tree cases stayed green (nothing to find yet).
//  - after the three pages were split, the same day: the `ios-simulator-service-version-mismatch`
//    entry deleted from `docs/troubleshooting.md` — the frozen case, the real Moved-sections case
//    (its named entry) and both docsAnchors shipped-URL cases red; `<a id="dashboard-overview">`
//    deleted from `docs/testing.md` — the frozen case named it; a `## Backup` heading added to
//    `docs/operate/deployment.md` — the dead-entry case named `/operate/deployment#backup`;
//    `data-moved-to` renamed away on `docs/troubleshooting.md`, leaving plain `<a id>`s — the frozen
//    case stayed green, correctly, and the floor went red at 83; `/guide/self-hosting` dropped from
//    `moves.json` — the agreement, frozen and legacy-URL cases red.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import config from '../../docs/.vitepress/config.ts'
import { createMarkdownRenderer } from '../../docs/node_modules/vitepress/dist/node/index.js'
import { loadMoves, redirectsFrom, resolveMoved, vercelConfig, VERCEL_PATH } from '../docs-redirects.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const DOCS = join(ROOT, 'docs')
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

/** `guide/agent.md` → `/guide/agent`, `index.md` → `/`, `ko/index.md` → `/ko/`. */
const urlOf = (file) => `/${file.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')}`

const decodeEntities = (s) =>
  s.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

let md
beforeAll(async () => {
  md = await createMarkdownRenderer(DOCS, config.markdown, '/', { warn: () => {} })
})

/**
 * One page, rendered: every id a fragment can land on (any `id`, and `<a name>`), the heading ids on
 * their own, and its Moved-sections entries as `{ id, to }`.
 */
function render(relPath, source) {
  const html = md.render(source, { path: join(DOCS, relPath), relativePath: relPath, cleanUrls: true })
    // An id inside an HTML comment or a code block renders as text, not as a target: without this a
    // commented-out section, or a `text` fence showing the syntax, would count as the id still existing.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
  const ids = new Set([
    ...[...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<a\b[^>]*\sname="([^"]*)"/g)].map((m) => m[1]),
  ].map(decodeEntities))
  const headingIds = new Set([...html.matchAll(/<h[1-6]\b[^>]*\sid="([^"]*)"/g)].map((m) => decodeEntities(m[1])))
  const moved = [...html.matchAll(/<a\b([^>]*)>/g)]
    .map((m) => m[1])
    .filter((attrs) => /\sdata-moved-to="/.test(attrs))
    .map((attrs) => ({
      id: decodeEntities(attrs.match(/\sid="([^"]*)"/)?.[1] ?? ''),
      to: decodeEntities(attrs.match(/\sdata-moved-to="([^"]*)"/)[1]),
    }))
  return { ids, headingIds, moved }
}

/** `rendered`: URL path → render(). */
let site
function renderSite() {
  site ??= new Map(docPages().map((p) => [urlOf(p), render(p, readFileSync(join(DOCS, p), 'utf8'))]))
  return site
}

/** Frozen (url → ids) entries that no longer land, as `url#id → holder (why)`. */
function missingFrozen(frozen, rendered, moves) {
  const missing = []
  for (const [url, ids] of Object.entries(frozen)) {
    const holder = resolveMoved(url, moves)
    const page = rendered.get(holder)
    for (const id of ids) {
      if (!page) missing.push(`${url}#${id} → ${holder} (no such page)`)
      else if (!page.ids.has(id)) missing.push(`${url}#${id} → ${holder} (no such id)`)
    }
  }
  return missing
}

/** Problems with the move table itself, given the set of page URLs and the files under docs/public. */
function moveTableProblems(moves, pageUrls, publicFiles) {
  const problems = []
  const rules = redirectsFrom(moves)
  const sources = new Set(rules.map((r) => r.source))
  for (const r of rules) {
    if (sources.has(r.destination)) problems.push(`chain: ${r.source} → ${r.destination} → another move`)
  }
  const pageish = { ...moves.pages, ...moves.aliases }
  for (const [from, to] of Object.entries(pageish)) {
    for (const locale of ['', '/ko']) {
      if (!pageUrls.has(`${locale}${to}`)) problems.push(`${locale}${from} → ${locale}${to}: no such page`)
    }
  }
  for (const from of Object.keys(moves.pages ?? {})) {
    for (const locale of ['', '/ko']) {
      if (pageUrls.has(`${locale}${from}`)) problems.push(`${locale}${from} is still a page — the redirect would hide it`)
    }
  }
  for (const [from, to] of Object.entries(moves.files ?? {})) {
    if (!publicFiles.has(to)) problems.push(`${from} → ${to}: no such file under docs/public`)
    if (publicFiles.has(from)) problems.push(`${from} is still a file under docs/public — the redirect would hide it`)
  }
  return problems
}

/**
 * Moved-sections problems across `rendered`: a target that does not resolve, and an entry whose id
 * is also a heading on its own page (dead — the heading answers first).
 */
function movedSectionProblems(rendered, moves) {
  const problems = []
  for (const [url, { headingIds, moved }] of rendered) {
    for (const { id, to } of moved) {
      if (!id) problems.push(`${url}: a data-moved-to entry has no id`)
      else if (headingIds.has(id)) problems.push(`${url}#${id}: dead entry — still a heading on this page`)
      const hash = to.indexOf('#')
      const path = hash === -1 ? to : to.slice(0, hash)
      const fragment = hash === -1 ? '' : decodeURIComponent(to.slice(hash + 1))
      const page = rendered.get(resolveMoved(path, moves))
      if (!page) problems.push(`${url}#${id} → ${to}: no such page`)
      else if (fragment && !page.ids.has(fragment)) problems.push(`${url}#${id} → ${to}: no #${fragment} there`)
    }
  }
  return problems
}

function publicFiles(dir = join(DOCS, 'public'), out = new Set()) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) publicFiles(abs, out)
    else out.add(abs.slice(join(DOCS, 'public').length).replaceAll('\\', '/'))
  }
  return out
}

describe('docs/vercel.json is generated from moves.json', () => {
  it('holds exactly the rules moves.json produces, and its other keys', () => {
    const moves = loadMoves()
    const vercel = JSON.parse(readFileSync(VERCEL_PATH, 'utf8'))
    expect(vercel, 'run `node scripts/docs-redirects.mjs --write`').toEqual(vercelConfig(vercel, moves))
    expect(vercel.cleanUrls).toBe(true)
    expect(vercel.outputDirectory).toBe('.vitepress/dist')
    // Floor, and one rule by name per kind, so an empty table cannot agree with an empty file.
    // 17 page moves × 4 + 2 aliases × 2 + 2 files on 2026-09-27.
    expect(vercel.redirects.length).toBeGreaterThanOrEqual(74)
    expect(vercel.redirects).toEqual(expect.arrayContaining([
      { source: '/guide/agent', destination: '/operate/agents', permanent: true },
      { source: '/ko/guide/agent', destination: '/ko/operate/agents', permanent: true },
      { source: '/guide/agent.md', destination: '/operate/agents.md', permanent: true },
      { source: '/ko/guide/agent.md', destination: '/ko/operate/agents.md', permanent: true },
      { source: '/guide', destination: '/get-started/introduction', permanent: true },
      { source: '/tapflow-demo.mp4', destination: '/media/tapflow-demo.mp4', permanent: true },
    ]))
  })

  it('every rule is permanent', () => {
    const vercel = JSON.parse(readFileSync(VERCEL_PATH, 'utf8'))
    expect(vercel.redirects.filter((r) => r.permanent !== true)).toEqual([])
  })
})

describe('the move table is sound', () => {
  it('no chains, every destination exists, no source is still a page', () => {
    const pageUrls = new Set(docPages().map(urlOf))
    expect(pageUrls.size).toBeGreaterThanOrEqual(56)
    expect(moveTableProblems(loadMoves(), pageUrls, publicFiles())).toEqual([])
  })

  it('reports a chain, a missing destination, a shadowed source, and a missing file', () => {
    const pages = new Set(['/new/a', '/ko/new/a', '/old/c', '/ko/old/c', '/next/b', '/ko/next/b'])
    const files = new Set(['/media/v.mp4', '/v2.mp4'])
    const moves = {
      pages: { '/old/a': '/new/a', '/old/b': '/old/a', '/old/c': '/new/a', '/old/d': '/nowhere' },
      files: { '/v.mp4': '/media/v.mp4', '/v2.mp4': '/media/v2.mp4' },
    }
    expect(moveTableProblems(moves, pages, files)).toEqual([
      'chain: /old/b → /old/a → another move',
      'chain: /ko/old/b → /ko/old/a → another move',
      'chain: /old/b.md → /old/a.md → another move',
      'chain: /ko/old/b.md → /ko/old/a.md → another move',
      '/old/b → /old/a: no such page',
      '/ko/old/b → /ko/old/a: no such page',
      '/old/d → /nowhere: no such page',
      '/ko/old/d → /ko/nowhere: no such page',
      '/old/c is still a page — the redirect would hide it',
      '/ko/old/c is still a page — the redirect would hide it',
      '/v2.mp4 → /media/v2.mp4: no such file under docs/public',
      '/v2.mp4 is still a file under docs/public — the redirect would hide it',
    ])
  })
})

describe('every id the site rendered before the restructure still lands', () => {
  it('follows each frozen id through moves.json to an id on the page it lands on', () => {
    const frozen = JSON.parse(readFileSync(join(DOCS, '.vitepress', 'frozen-ids.json'), 'utf8'))
    expect(frozen.frozenAt).toBe('74bc7dc8616900d6d156b2a1ab49cb07a0ed5be9')
    const entries = Object.entries(frozen.pages)
    // 54 pages with ids (the two landings have none), 655 ids — measured when the set was taken.
    // The named pairs are the shipped and README URLs a restructure is most likely to break.
    expect(entries.length).toBe(54)
    expect(entries.reduce((n, [, ids]) => n + ids.length, 0)).toBe(655)
    expect(frozen.pages['/reference/configuration']).toContain('https-secure-context')
    expect(frozen.pages['/ko/reference/configuration']).toContain('https-보안-컨텍스트')
    expect(frozen.pages['/guide/troubleshooting']).toContain('ios-simulator-service-version-mismatch')
    expect(frozen.pages['/guide/self-hosting']).toContain('docker-compose-lan-server')
    expect(frozen.pages['/guide/agent']).toContain('remote-relay-authentication')
    expect(frozen.pages['/ko/guide/getting-started']).toContain('_1-tapflow-설치')
    expect(missingFrozen(frozen.pages, renderSite(), loadMoves())).toEqual([])
  })

  it('reports an id that is gone, a page that is gone, and follows a move', () => {
    const rendered = new Map([
      ['/new/a', render('new/a.md', '# A\n\n## Kept\n\n## Renamed {#old-slug}\n\n<a id="옛-제목"></a>\n\n<!-- <a id="in-comment"></a> -->\n\n```text\n<a id="in-fence"></a>\n```\n')],
      ['/b', render('b.md', '# B\n\n## Other\n')],
    ])
    const moves = { pages: { '/old/a': '/new/a' } }
    const frozen = {
      '/old/a': ['kept', 'old-slug', '옛-제목', 'dropped', 'in-comment', 'in-fence'],
      '/b': ['other', 'gone'],
      '/c': ['x'],
    }
    expect(missingFrozen(frozen, rendered, moves)).toEqual([
      '/old/a#dropped → /new/a (no such id)',
      '/old/a#in-comment → /new/a (no such id)',
      '/old/a#in-fence → /new/a (no such id)',
      '/b#gone → /b (no such id)',
      '/c#x → /c (no such page)',
    ])
  })
})

describe('Moved-sections entries resolve and are not dead', () => {
  it('on the real site', () => {
    const rendered = renderSite()
    // Floor and names, so a render that stopped seeing `data-moved-to` cannot pass as "no problems":
    // 126 entries on 2026-09-27 (14 + 43 + 6 per locale on `operate/deployment`, `troubleshooting`,
    // `testing`). The named ones are the shipped fragment and the README one.
    const entries = [...rendered].flatMap(([url, { moved }]) => moved.map((m) => `${url}#${m.id} → ${m.to}`))
    expect(entries.length).toBeGreaterThanOrEqual(126)
    expect(entries).toEqual(expect.arrayContaining([
      '/troubleshooting#ios-simulator-service-version-mismatch → /troubleshooting/ios-simulator#ios-simulator-service-version-mismatch',
      '/operate/deployment#docker-compose-lan-server → /operate/docker#docker-compose-lan-server',
      '/ko/operate/deployment#docker-compose-lan-서버 → /ko/operate/docker#docker-compose-lan-서버',
    ]))
    expect(movedSectionProblems(rendered, loadMoves())).toEqual([])
  })

  it('reports a dead entry, a missing target id, a missing target page — and accepts a good one', () => {
    const successor = [
      '# Deployment',
      '',
      '## Scenarios',
      '',
      '## Moved sections {#moved-sections}',
      '',
      '- <a id="docker-compose-lan-server" data-moved-to="/operate/docker#docker-compose-lan-server"></a>[Docker](/operate/docker#docker-compose-lan-server)',
      '- <a id="scenarios" data-moved-to="/operate/docker#scenarios"></a>[dead](/operate/docker)',
      '- <a id="external-access" data-moved-to="/operate/docker#nope"></a>[x](/operate/docker)',
      '- <a id="외부-접속" data-moved-to="/old/place#x"></a>[x](/operate/docker)',
      '- <a id="moved-by-redirect" data-moved-to="/old/docker#docker-compose-lan-server"></a>[x](/operate/docker)',
      '',
    ].join('\n')
    const rendered = new Map([
      ['/operate/deployment', render('operate/deployment.md', successor)],
      ['/operate/docker', render('operate/docker.md', '# Docker\n\n## Docker Compose (LAN server) {#docker-compose-lan-server}\n\n## Scenarios\n')],
    ])
    const moves = { pages: { '/old/docker': '/operate/docker' } }
    expect(rendered.get('/operate/deployment').moved).toHaveLength(5)
    expect(movedSectionProblems(rendered, moves)).toEqual([
      '/operate/deployment#scenarios: dead entry — still a heading on this page',
      '/operate/deployment#external-access → /operate/docker#nope: no #nope there',
      '/operate/deployment#외부-접속 → /old/place#x: no such page',
    ])
  })
})
