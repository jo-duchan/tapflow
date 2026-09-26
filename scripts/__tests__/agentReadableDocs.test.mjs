// What an LLM agent gets when it reads tapflow.dev, and the two ways it was getting less than the
// site claimed.
//
// Measured against the live site on 2026-09-18: `/llms.txt` answered 200 while every page it linked
// existed only as HTML (`/guide/getting-started.md` → 404) and `/llms-full.txt` → 404. So the index
// worked and nothing it indexed did. Separately, `llms.txt` listed 18 of the 28 English pages —
// `guide/writing-flows`, `guide/network-control` and `guide/environment-setup` among the ten
// missing, so an agent reading only the index could not know those features exist.
//
// Two subjects, and they are checked differently on purpose:
//
//  - **The build hook** (`docs/.vitepress/agent-artifacts.mjs`) is run for real, against a temporary
//    directory. When this was written nothing in CI built the docs; the `docs` job in `ci.yml` now
//    does, but only on a PR that touches them, and a successful build says nothing about what the
//    hook wrote — so a check that asserted on the config literal instead would still be asserting
//    that we wrote a setting down, which is not the claim. Running the hook is also what makes the
//    `srcExclude` half real: the hook copies `siteConfig.pages`, so a page VitePress excluded is one
//    the hook never sees.
//  - **`llms.txt`** is inspected. It stays hand-written — the one-line description per link is the
//    value of an index, and generating it would replace 27 sentences with 27 slugs. What is checked
//    is the set, because the set is what drifted — and, since the 2026-09 restructure, the grouping:
//    each `## ` section is a top-level sidebar group listing the same pages in the same order, and
//    the Korean sidebar mirrors the English one. That replaced a page-count pin, which every docs PR
//    adding a page had to edit and which made those PRs conflict with each other.
//
// **Absence assertions are paired**, per `contributing/test-and-guard-coverage.md` rule 2, and the
// pairing differs by case — an earlier version of this header claimed one shape for all three,
// which is rule 1's defect rather than a wording slip:
//
//  - `AGENTS.md` gets the real thing: the same fixture, run again with the file listed in `pages`,
//    asserting it now appears.
//  - ko and the landing pages get a unit assertion on the predicate plus a **non-empty floor** on
//    the bundle. Without that floor `not.toContain` passes on an empty file, which is the exact
//    failure rule 2 describes — and `full` defaults to `''` when the bundle is missing entirely.
//
// **What this suite does NOT verify**: that VitePress actually applies `srcExclude` to
// `siteConfig.pages`. `PAGES` below is a hand-written list with `AGENTS.md` removed by the test,
// so it models that behaviour rather than checking it. Confirming it needs a real `pnpm docs:build`
// and a look at its output, which the `docs` CI job runs but does not inspect; it was checked by
// hand on 2026-09-18 — `dist` held no `AGENTS.html`, and the sitemap dropped from 58 entries to 56.
//
// Mutations run by hand, per rule 1 — every claim this header makes was made to fail:
//
//  - `isTranslation` → `() => false`: the ko pair goes red (ko body appears in the bundle).
//  - `isLanding` → `() => false`: the landing pair goes red.
//  - `isLanding` → `(s) => /^layout:\s*home\s*$/m.test(s)`, dropping the frontmatter scoping: red.
//    This one **survived** the first version of this suite, because the prose fixture had no
//    frontmatter at all and so returned false through the early return rather than through the
//    scoping. Rule 5: the fixture carried the property by accident.
//  - the frontmatter strip removed from the bundle: red on `guide/two.md`'s `description:`.
//  - `emitAgentArtifacts` copying skipped: red on the first page.
//  - one link deleted from `llms.txt`: the set comparison names it.
//  - one apex URL planted in `docs/public/robots.txt`: the origin check names the file.
//  - `srcExclude` emptied in `config.ts`: the structural check goes red.
//  - `txt` dropped from `TEXT_EXT`: red, because the origin check anchors on the two files it is
//    about. Under a bare count floor this **survived** — 1,037 files still cleared it while
//    `robots.txt` and `llms.txt` had left the scan.
//  - (2026-09-27) the Network Control and Audio rows swapped in `llms.txt`: the grouping case red,
//    though the set comparison stayed green — order is what it adds. One KO sidebar link pointed at
//    the old `/ko/guide/audio`, and `collapsed` dropped from one KO group: the mirror case red on each.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  emitAgentArtifacts,
  isLanding,
  isTranslation,
  pageUrl,
} from '../../docs/.vitepress/agent-artifacts.mjs'
import { SKIP_PATHS, SKIP_PATHS_SOURCE } from './sourceFiles.mjs'
import config from '../../docs/.vitepress/config.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const SITE = 'https://www.tapflow.dev'

// ---------------------------------------------------------------------------------------------
// The hook, run for real
// ---------------------------------------------------------------------------------------------

/** A miniature docs tree: a landing page, two English prose pages, the Korean locale, and a
 *  contributor file that `srcExclude` keeps out of `pages`. The bodies are distinct strings so an
 *  assertion can name which page's content reached the bundle. */
const FIXTURE = {
  'index.md': '---\nlayout: home\n\nhero:\n  name: tapflow\n  text: LANDING-HERO-TEXT\n---\n',
  'guide/one.md': '# One\n\nENGLISH-BODY-ONE\n',
  'guide/two.md': '---\ndescription: d\n---\n\n# Two\n\nENGLISH-BODY-TWO\n',
  // An empty frontmatter block — valid in VitePress, and what is left when the last key is
  // deleted. The first strip pattern required a body and left both fences in the bundle.
  'guide/three.md': '---\n---\n\n# Three\n\nENGLISH-BODY-THREE\n',
  'ko/index.md': '---\nlayout: home\n\nhero:\n  name: tapflow\n---\n',
  'ko/guide/one.md': '# 하나\n\nKOREAN-BODY-ONE\n',
  'AGENTS.md': '# contributor rules\n\nEXCLUDED-BODY\n',
}

/** What VitePress hands `buildEnd` once `srcExclude` has been applied — `AGENTS.md` is absent. */
const PAGES = Object.keys(FIXTURE).filter((p) => p !== 'AGENTS.md')

/** Writes FIXTURE to a fresh temp dir and returns `{ srcDir, outDir }`. */
function plant() {
  const base = mkdtempSync(join(tmpdir(), 'tapflow-agent-docs-'))
  const srcDir = join(base, 'src')
  const outDir = join(base, 'out')
  for (const [path, body] of Object.entries(FIXTURE)) {
    const target = join(srcDir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }
  mkdirSync(outDir, { recursive: true })
  return { base, srcDir, outDir }
}

/** Runs the hook over a temp tree and returns its result plus a snapshot of the output.
 *
 *  The output is read **before** the temp tree is removed, and the assertions run against the
 *  snapshot. A first version returned closures over `outDir` and every one of them saw a deleted
 *  directory — `existsSync` answered false for files the hook had just written, which reads exactly
 *  like the hook not writing them. */
async function run(pages = PAGES) {
  const { base, srcDir, outDir } = plant()
  try {
    const result = await emitAgentArtifacts({ srcDir, outDir, pages, hostname: SITE })
    /** @type {Map<string, string>} every file under outDir, by outDir-relative path */
    const out = new Map()
    const collect = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name)
        if (e.isDirectory()) collect(abs)
        else out.set(abs.slice(outDir.length + 1).replaceAll('\\', '/'), readFileSync(abs, 'utf8'))
      }
    }
    collect(outDir)
    return {
      ...result,
      full: out.get('llms-full.txt') ?? '',
      copiedOnDisk: (p) => out.has(p),
      read: (p) => out.get(p) ?? '',
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

describe('the build hook ships the source markdown', () => {
  it('copies every page byte for byte', async () => {
    const r = await run()
    // Existence first, and per page rather than as a count: a wrong path fails here rather than
    // reducing a total that nothing reads.
    expect(r.copied).toEqual([...PAGES].sort())
    for (const page of PAGES) {
      expect(r.copiedOnDisk(page), `${page} was not copied`).toBe(true)
      expect(r.read(page), `${page} differs from source`).toBe(FIXTURE[page])
    }
  })

  it('copies nothing that is not in `pages` — and copies it once it is', async () => {
    const excluded = await run()
    // The fixture really does contain the file; without this the next assertion would pass on a
    // tree that never had one.
    expect(Object.keys(FIXTURE)).toContain('AGENTS.md')
    expect(excluded.copiedOnDisk('AGENTS.md')).toBe(false)
    expect(excluded.full).not.toContain('EXCLUDED-BODY')

    // The mutation that creates the absence: hand the hook the same tree with the file listed.
    const included = await run([...PAGES, 'AGENTS.md'])
    expect(included.copiedOnDisk('AGENTS.md')).toBe(true)
    expect(included.full).toContain('EXCLUDED-BODY')
  })
})

describe('llms-full.txt carries the English prose and nothing else', () => {
  it('bundles exactly the English non-landing pages', async () => {
    const r = await run()
    expect(r.bundled).toEqual(['guide/one.md', 'guide/three.md', 'guide/two.md'])
    expect(r.full).toContain('ENGLISH-BODY-ONE')
    expect(r.full).toContain('ENGLISH-BODY-TWO')
    expect(r.full).toContain('ENGLISH-BODY-THREE')
  })

  it('leaves the translations out — and would include them if they were not translations', async () => {
    const r = await run()
    // Paired with its own mutation, since "the Korean body is absent" also describes an empty file.
    // The .md still ships: a translation is excluded from the bundle, not from the site.
    expect(r.copiedOnDisk('ko/guide/one.md')).toBe(true)
    expect(r.read('ko/guide/one.md')).toContain('KOREAN-BODY-ONE')
    // The floor: without it the next line passes on a bundle that was never written.
    expect(r.full).toContain('ENGLISH-BODY-ONE')
    expect(r.full).not.toContain('KOREAN-BODY-ONE')

    expect(isTranslation('ko/guide/one.md')).toBe(true)
    expect(isTranslation('guide/one.md')).toBe(false)
  })

  it('leaves the landing pages out — and would include them if they were not landings', async () => {
    const r = await run()
    expect(r.copiedOnDisk('index.md')).toBe(true)
    expect(r.read('index.md')).toContain('LANDING-HERO-TEXT')
    expect(r.full).toContain('ENGLISH-BODY-ONE')
    expect(r.full).not.toContain('LANDING-HERO-TEXT')

    expect(isLanding(FIXTURE['index.md'])).toBe(true)
    expect(isLanding(FIXTURE['guide/two.md'])).toBe(false)
    // `layout: home` written in the body is an example of the syntax, not a declaration of it.
    // The fixture carries a frontmatter block on purpose: without one, `isLanding` answers through
    // its `if (!frontmatter) return false` and the scoping this line exists for is never executed.
    expect(isLanding('---\ntitle: X\n---\n\n# Page\n\n```yaml\nlayout: home\n```\n')).toBe(false)
  })

  it('strips a page\'s own frontmatter, which would otherwise read as a section break', async () => {
    const r = await run()
    // `guide/two.md` has `---\ndescription: d\n---`. Left in, its two fences are indistinguishable
    // from the `---` this file puts between sections: measured on the first build, 29 bare `---`
    // lines against 27 sections, so splitting the bundle on `---` yielded an orphan chunk with no
    // URL header. The body survives the strip — that is the pair for the absence below.
    expect(r.full).toContain('ENGLISH-BODY-TWO')
    expect(r.full).not.toContain('description: d')
    // `guide/three.md`'s block is empty. It has no body to look for, so the separator count below
    // is what catches it: two surviving fences would make the total exceed one per section.
    expect(r.full).toContain('ENGLISH-BODY-THREE')
    // Every `---` in the bundle is a separator, so the count is one per section boundary.
    const separators = r.full.split('\n').filter((l) => l === '---').length
    expect(separators).toBe(r.bundled.length)
    // The .md copy is the source and keeps it.
    expect(r.read('guide/two.md')).toBe(FIXTURE['guide/two.md'])
  })

  it('cites each section by the URL the page is served at', async () => {
    const r = await run()
    expect(r.full).toContain(`# ${SITE}/guide/one`)
    expect(pageUrl('index.md', SITE)).toBe(`${SITE}/`)
    expect(pageUrl('guide/agent.md', SITE)).toBe(`${SITE}/guide/agent`)
  })
})

// ---------------------------------------------------------------------------------------------
// llms.txt, inspected
// ---------------------------------------------------------------------------------------------

const DOCS = join(ROOT, 'docs')

/** Every `.md` under `docs/`, as docs-relative paths. Walked from disk rather than listed by git,
 *  per `sourceFiles.mjs` — a page added and not yet committed is exactly the state a missing index
 *  entry is in. `sources()` itself is not reusable here: it walks `.ts`/`.tsx`. */
function docPages(dir = DOCS, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && !e.name.startsWith('.')) docPages(join(dir, e.name), out)
    } else if (e.name.endsWith('.md')) {
      out.push(join(dir, e.name).slice(DOCS.length + 1).replaceAll('\\', '/'))
    }
  }
  return out
}

/** The pages `llms.txt` is answerable for: English, prose, and part of the site. */
const indexablePages = () =>
  docPages()
    .filter((p) => !isTranslation(p))
    .filter((p) => !['AGENTS.md', 'CLAUDE.md'].includes(p))
    .filter((p) => !isLanding(readFileSync(join(DOCS, p), 'utf8')))
    .sort()

const llmsTxt = () => readFileSync(join(DOCS, 'public', 'llms.txt'), 'utf8')

/** `- [Title](url): description` — the link rows, as URLs. */
const indexedUrls = () =>
  [...llmsTxt().matchAll(/^- \[[^\]]+\]\((https?:\/\/[^)]+)\)/gm)].map((m) => m[1]).sort()

/** The sidebar's leaf links, depth first, in the order a reader sees them. */
const leaves = (items) => items.flatMap((i) => (i.items ? leaves(i.items) : [i.link]))

/** `llms.txt` cut at its `## ` headings: `[{ title, urls }]`, in file order. `###` stays inside. */
function llmsSections(text = llmsTxt()) {
  return text.split(/^## /m).slice(1).map((chunk) => ({
    title: chunk.slice(0, chunk.indexOf('\n')).trim(),
    urls: [...chunk.matchAll(/^- \[[^\]]+\]\((https?:\/\/[^)]+)\)/gm)].map((m) => m[1]),
  }))
}

/**
 * Where `llms.txt` and the sidebar disagree: each top-level sidebar group is one `## ` section of the
 * same name, in the same order, listing the same pages in the same order.
 */
function sectionProblems(sidebar, sections) {
  const problems = []
  const groups = sidebar.map((g) => g.text)
  const titles = sections.map((s) => s.title)
  if (groups.join('|') !== titles.join('|')) problems.push(`sections [${titles.join(', ')}] ≠ sidebar groups [${groups.join(', ')}]`)
  for (const g of sidebar) {
    const section = sections.find((s) => s.title === g.text)
    if (!section) continue
    const want = leaves(g.items).map((l) => `${SITE}${l}`)
    if (want.join('|') !== section.urls.join('|')) {
      problems.push(`${g.text}: llms.txt [${section.urls.map((u) => u.slice(SITE.length)).join(', ')}] ≠ sidebar [${want.map((u) => u.slice(SITE.length)).join(', ')}]`)
    }
  }
  return problems
}

/** Where the Korean sidebar stops mirroring the English one (same tree, links under `/ko`). */
function mirrorProblems(en, ko, path = '') {
  const problems = []
  if (en.length !== ko.length) problems.push(`${path || 'sidebar'}: ${en.length} entries in EN, ${ko.length} in KO`)
  en.forEach((e, i) => {
    const k = ko[i]
    if (!k) return
    const here = `${path}/${e.text}`
    if (Boolean(e.items) !== Boolean(k.items)) problems.push(`${here}: a group on one side only`)
    else if (e.items) problems.push(...mirrorProblems(e.items, k.items, here))
    else if (`/ko${e.link}` !== k.link) problems.push(`${here}: EN ${e.link}, KO ${k.link}`)
    if (Boolean(e.collapsed) !== Boolean(k.collapsed)) problems.push(`${here}: collapsed differs`)
  })
  return problems
}

const enSidebar = () => config.locales.root.themeConfig.sidebar
const koSidebar = () => config.locales.ko.themeConfig.sidebar

describe('llms.txt indexes the whole site', () => {
  it('lists every English page, and lists nothing that is not one', () => {
    const expected = indexablePages().map((p) => pageUrl(p, SITE)).sort()
    // A floor, not a pin: 27 pages on 2026-09-18 (28 English `.md` less the landing). A pin made
    // every docs PR that adds a page edit this line, and docs PRs that land one after another
    // conflicted on it. The floor keeps the comparison from passing on an empty walk.
    expect(expected.length).toBeGreaterThanOrEqual(27)
    expect(indexedUrls()).toEqual(expected)
  })

  it('is grouped like the sidebar: one section per top-level group, same pages, same order', () => {
    const sidebar = enSidebar()
    // Named, so a sidebar that failed to load cannot agree with an llms.txt that has no sections.
    expect(sidebar.map((g) => g.text)).toEqual(expect.arrayContaining(['Get started', 'Operate', 'Reference']))
    expect(leaves(sidebar)).toContain('/operate/agents')
    expect(sectionProblems(sidebar, llmsSections())).toEqual([])
  })

  it('reports a missing section, a page out of order, and a page in the wrong section', () => {
    const sidebar = [
      { text: 'A', items: [{ text: 'one', link: '/a/one' }, { text: 'g', items: [{ text: 'two', link: '/a/two' }] }] },
      { text: 'B', items: [{ text: 'three', link: '/b/three' }] },
      { text: 'C', items: [{ text: 'four', link: '/c/four' }] },
    ]
    const text = [
      '# t', '', '## A', '', `- [two](${SITE}/a/two): x`, '', '### sub', '', `- [one](${SITE}/a/one): x`, '',
      '## B', '', `- [three](${SITE}/b/three): x`, `- [four](${SITE}/c/four): x`, '',
    ].join('\n')
    expect(sectionProblems(sidebar, llmsSections(text))).toEqual([
      'sections [A, B] ≠ sidebar groups [A, B, C]',
      'A: llms.txt [/a/two, /a/one] ≠ sidebar [/a/one, /a/two]',
      'B: llms.txt [/b/three, /c/four] ≠ sidebar [/b/three]',
    ])
  })

  it('the Korean sidebar mirrors the English one', () => {
    expect(leaves(koSidebar())).toContain('/ko/operate/agents')
    expect(mirrorProblems(enSidebar(), koSidebar())).toEqual([])
  })

  it('reports a Korean sidebar that drifted', () => {
    const en = [{ text: 'A', items: [{ text: 'one', link: '/a' }, { text: 'g', collapsed: true, items: [{ text: 'two', link: '/b' }] }] }]
    const ko = [{ text: '가', items: [{ text: '하나', link: '/ko/a-renamed' }, { text: '그룹', items: [{ text: '둘', link: '/ko/b' }, { text: '셋', link: '/ko/c' }] }] }]
    expect(mirrorProblems(en, ko)).toEqual([
      '/A/one: EN /a, KO /ko/a-renamed',
      '/A/g: 1 entries in EN, 2 in KO',
      '/A/g: collapsed differs',
    ])
  })

  it('points at the canonical origin, so no link opens on a redirect', () => {
    const urls = indexedUrls()
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(url.startsWith(`${SITE}/`), url).toBe(true)
  })

  it('tells an agent where the source markdown and the bundle are', () => {
    const text = llmsTxt()
    expect(text).toContain(`${SITE}/llms-full.txt`)
    expect(text).toContain('`.md` suffix')
  })

  /**
   * **Both files say the bundle can arrive truncated.** Measured 2026-09-23: Claude Code's fetch cut
   * `llms-full.txt` at 99,973 of 191,529 characters and then answered that `tapflow reset` "is not
   * mentioned anywhere in the documentation" — the CLI, API and configuration references are all
   * past the cut. The warning belongs in the bundle's own header too, because that header is the
   * one part of it a truncated read still receives.
   */
  it('warns that a truncated fetch of the bundle loses the reference pages', async () => {
    expect(llmsTxt()).toMatch(/truncates or summarises a large fetch/)
    const r = await run()
    expect(r.full).toMatch(/truncates or summarises a large fetch/)
    // The length is derived from the pages, so it cannot go stale as the docs grow.
    expect(r.full).toMatch(/This file is about \d[\d,]* characters long/)
  })
})

// ---------------------------------------------------------------------------------------------
// One origin
// ---------------------------------------------------------------------------------------------

/** Text files that can carry a tapflow.dev URL. Extensions rather than a tree: the offender is a
 *  hand-written link, and those live in docs, READMEs, workflows and issue templates alike. */
const TEXT_EXT = /\.(md|txt|ts|tsx|mts|mjs|js|json|ya?ml)$/

/** Build output and local runtime state are not the repo.
 *
 *  `cache` is load-bearing: `docs/.vitepress/cache` holds 115 vite-optimised dependency bundles on
 *  a machine that has run the docs and nothing on a fresh clone, so without it this walk returned
 *  1,041 files here and 926 in CI — and the apex verdict depended on strings inside somebody
 *  else's bundle. `.tapflow-data` and `.tapflow` hold a local relay's database and logs, which can
 *  contain anything a dashboard user typed. */
const SKIP = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', '.git',
  '.work', '.vercel', '.internal', 'cache', '.tapflow-data', '.tapflow', '.playwright-mcp'])

// `SKIP_PATHS` is shared with `sourceFiles.mjs` — see the reason there. Two walkers reach that
// directory and fixing one of them left the other racing the dashboard build.

function textFiles(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !SKIP_PATHS.has(child)) textFiles(child, out)
    } else if (TEXT_EXT.test(e.name)) {
      out.push(child)
    }
  }
  return out
}

describe('the site has one origin', () => {
  it('never writes the apex, which answers 307', () => {
    const files = textFiles()
    // A count floor guards against the walk collapsing and nothing else. Measured: dropping `txt`
    // from TEXT_EXT still returned 1,037 files — clearing any round floor — while removing from
    // the scan the two files this check exists for. So anchor on those two by name; the count is
    // the anti-vacuity backstop under it (843 on 2026-09-18, caches excluded).
    expect(files).toContain(join(DOCS, 'public', 'robots.txt'))
    expect(files).toContain(join(DOCS, 'public', 'llms.txt'))
    expect(files).toContain(join(DOCS, '.vitepress', 'config.ts'))
    expect(files.length).toBeGreaterThan(700)
    // The dashboard build's copy is not the repo, and walking it is what made this test race the
    // build in `dashboardFirstLoadBudget.test.mjs`.
    //
    // **Two assertions, because the obvious one is vacuous on its own.** Filtering `files` by the
    // same absolute path `SKIP_PATHS` holds can only fail if the skip is deleted outright: rename
    // either directory and the filter returns `[]` while the race is back, and on a fresh clone the
    // directory does not exist at all (`packages/relay/public` is gitignored, 0 tracked files) so it
    // returns `[]` before anything has been built. The second one is what a rename trips.
    expect([...SKIP_PATHS].filter((p) => files.some((f) => f.startsWith(p)))).toEqual([])
    const buildScript = JSON.parse(readFileSync(SKIP_PATHS_SOURCE.manifest, 'utf8'))
      .scripts[SKIP_PATHS_SOURCE.script]
    expect(
      buildScript,
      `the dashboard build no longer writes ${SKIP_PATHS_SOURCE.mentions} — SKIP_PATHS is stale`,
    ).toContain(SKIP_PATHS_SOURCE.mentions)

    const offenders = files
      .filter((f) => /https:\/\/tapflow\.dev/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])

    // A spelling assertion is a floor, not a fence (rule 3): it catches forgetting, not a URL
    // assembled from parts. What keeps the config from drifting is the single constant, below.
  })

  it('builds every config URL from one constant', () => {
    const config = readFileSync(join(DOCS, '.vitepress', 'config.ts'), 'utf8')
    expect(config).toContain(`const SITE = '${SITE}'`)
    // The five sites that used to spell the origin: sitemap, JSON-LD, og:url, og:image, twitter:image.
    expect(config).toContain('hostname: SITE')
    expect(config).toContain("{ property: 'og:url', content: SITE }")
    expect(config.match(/\$\{SITE\}\/demo-thumbnail\.png/g)).toHaveLength(2)
  })
})

describe('the internal rules are not part of the public site', () => {
  it('excludes them from the build, and they are still on disk for INDEX.md', () => {
    const config = readFileSync(join(DOCS, '.vitepress', 'config.ts'), 'utf8')
    // `**/` rather than a bare name: a bare pattern matches the srcDir root only, so a second
    // AGENTS.md under a locale would publish itself.
    expect(config).toContain("srcExclude: ['**/AGENTS.md', '**/CLAUDE.md']")
    expect(existsSync(join(DOCS, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(DOCS, 'CLAUDE.md'))).toBe(true)
  })

  it('feeds the hook the excluded list rather than its own walk', () => {
    // `srcExclude` keeps these two out of the `.md` copies and the bundle only because the hook
    // copies what VitePress resolved. What holds that is the fixture test above — it plants
    // `AGENTS.md` in the tree and leaves it out of `pages`, so a hook that walked `srcDir` itself
    // goes red there. This line is the cheap structural echo of it, and nothing more: an earlier
    // version claimed the suite would stay green without it, which was simply untrue.
    const config = readFileSync(join(DOCS, '.vitepress', 'config.ts'), 'utf8')
    expect(config).toContain('pages: siteConfig.pages')
  })
})
