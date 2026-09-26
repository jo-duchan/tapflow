// The English and Korean docs have the same shape, and neither goes below H3.
//
// `docs/AGENTS.md` says every page is written in both languages with the same structure, and that
// Korean is the source. Nothing checked it. On 2026-09-26 every pair's heading sequence matched, which
// held by care rather than by anything that would notice it stop. Three things are compared per pair,
// and each catches a different drift:
//
//  - **both files exist** — a page added in one locale only.
//  - **the heading levels, in order** — a section added, dropped or promoted on one side. Compared as
//    the sequence (`2 3 3 2 …`), not as per-level totals, because moving an H3 from one section to
//    another keeps every total and changes the page.
//  - **the explicit `{#id}` set** — the ids links and shipped code are allowed to depend on. A Korean
//    auto-slug is the heading's text, so `{#id}` is the only anchor stable across a translation edit;
//    one present in a single locale means a link that works in one language and not the other.
//    **Only ASCII ids are compared.** A Hangul `{#id}` is a Korean page keeping the auto-slug an old
//    heading had (`{#데이터-디렉토리}` after the text became 디렉터리), so an existing Korean link keeps
//    working. It has no English counterpart by construction, and requiring one would force the rename
//    that id exists to avoid.
//
// **No H4.** VitePress's outline stops at H3 by default, so an H4 is a heading no reader can navigate
// to from the page's own table of contents, and one is usually a sign the page wants splitting.
// A page may be granted an exact count in `H4_ALLOWED`, and an entry that no longer matches fails too,
// so it cannot outlive its reason. The map is empty: the only page that had H4s (`guide/self-hosting`)
// was split in 2026-09 and its tunnel and VPS walkthroughs became H3s on `operate/external-access`.
//
// Setext headings and HTML `<h2>` are not counted as headings (the docs use neither).
//
// Headings are read from the source rather than the rendered page, skipping frontmatter and fenced
// blocks. A `####` inside a code fence is an example of the syntax, not a heading, and the fixtures
// carry one on purpose (rule 5 of `contributing/test-and-guard-coverage.md`: the fixture must carry
// the property the code looks at).
//
// Mutations run by hand on 2026-09-26: deleting one `###` from `docs/ko/guide/agent.md` failed the
// sequence case naming the page and position; deleting `{#stream-lag}` from the English
// troubleshooting page failed the id case; adding a `####` to `docs/guide/audio.md` failed the H4
// case; deleting `docs/ko/guide/scaling.md` failed the pairing case by name. In `headings()`,
// dropping the frontmatter skip failed the parity fixture, and dropping the fence skip failed both
// fixtures — **and left the real-tree cases green**, since no page has a `#` line inside a fence at the
// same depth on one side only. That is what the fixtures are for. On 2026-09-27, with the allowance
// emptied: `### 1. Set up Caddy…` turned back into an H4 in `docs/operate/external-access.md` failed
// the H4 case, and the sequence case beside it.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DOCS = join(import.meta.dirname, '..', '..', 'docs')
const NOT_PAGES = new Set(['AGENTS.md', 'CLAUDE.md'])

/** Pages allowed H4s, with the exact count. Empty — see the header. Prefer splitting the page. */
const H4_ALLOWED = new Map()

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

/** ATX headings outside frontmatter and fenced blocks, as `{ level, id }` (`id`: explicit `{#id}`). */
function headings(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  let i = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end !== -1) i = end + 1
  }
  const out = []
  let fence
  for (; i < lines.length; i++) {
    const line = lines[i]
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = undefined
      continue
    }
    if (fence) continue
    const h = line.match(/^ {0,3}(#{1,6})\s+(.*)$/)
    if (h) out.push({ level: h[1].length, id: h[2].match(/\{#([^}\s]+)\}\s*$/)?.[1] })
  }
  return out
}

/** `guide/x.md` ↔ `ko/guide/x.md`. */
const twin = (p) => (p.startsWith('ko/') ? p.slice(3) : `ko/${p}`)

/** Every pairing, sequence and id problem across `pages` (path → source), as readable lines. */
function parityProblems(pages) {
  const problems = []
  for (const p of pages.keys()) {
    if (!pages.has(twin(p))) problems.push(`${p}: no ${twin(p)}`)
  }
  for (const [en, enSrc] of pages) {
    if (en.startsWith('ko/') || !pages.has(twin(en))) continue
    const a = headings(enSrc)
    const b = headings(pages.get(twin(en)))
    const seqA = a.map((h) => h.level).join(' ')
    const seqB = b.map((h) => h.level).join(' ')
    if (seqA !== seqB) {
      const at = a.findIndex((h, k) => b[k]?.level !== h.level)
      problems.push(`${en}: heading levels differ from ${twin(en)} at heading ${at === -1 ? a.length + 1 : at + 1} (en: ${seqA} | ko: ${seqB})`)
    }
    const ascii = (id) => id && /^[\x21-\x7e]+$/.test(id)
    const idsA = a.map((h) => h.id).filter(ascii).sort()
    const idsB = b.map((h) => h.id).filter(ascii).sort()
    const onlyA = idsA.filter((x) => !idsB.includes(x))
    const onlyB = idsB.filter((x) => !idsA.includes(x))
    if (onlyA.length || onlyB.length) {
      problems.push(`${en}: explicit ids differ — en only: [${onlyA.join(', ')}], ko only: [${onlyB.join(', ')}]`)
    }
  }
  return problems
}

/** Pages whose H4-or-deeper count is not exactly what `allowed` grants (0 when unlisted). */
function deepHeadingProblems(pages, allowed = H4_ALLOWED) {
  const problems = []
  for (const [p, src] of pages) {
    const n = headings(src).filter((h) => h.level >= 4).length
    const grant = allowed.get(p) ?? 0
    if (n !== grant) {
      problems.push(grant === 0
        ? `${p}: ${n} heading(s) below H3`
        : `${p}: allowed ${grant} heading(s) below H3, has ${n} — update or remove the H4_ALLOWED entry`)
    }
  }
  for (const p of allowed.keys()) if (!pages.has(p)) problems.push(`${p}: in H4_ALLOWED but not a page`)
  return problems
}

const site = () => new Map(docPages().map((p) => [p, readFileSync(join(DOCS, p), 'utf8')]))

describe('EN and KO docs have the same structure', () => {
  it('pairs every page, with the same heading sequence and explicit ids', () => {
    const pages = site()
    expect(parityProblems(pages)).toEqual([])
    // A floor, not a pin: 28 pairs on 2026-09-26 (27 prose pages and the landing). The pairing
    // above is what holds EN == KO; this only keeps a walk that found nothing from passing as "no
    // problems". After the verdict, so a missing twin is reported by name first.
    expect(pages.size).toBeGreaterThanOrEqual(56)
    expect([...pages.values()].reduce((n, s) => n + headings(s).length, 0)).toBeGreaterThan(500)
  })

  it('reports a missing twin, a moved heading, and an id on one side only', () => {
    const fence = '```md\n#### an example, not a heading\n```\n'
    const pages = new Map([
      ['guide/a.md', `---\n# a YAML comment, not a heading\ntitle: A\n---\n# A\n\n## One {#one}\n\n### Sub\n\n## Two {#two}\n\n${fence}`],
      ['ko/guide/a.md', `# 가\n\n## 하나 {#one}\n\n## 둘 {#two-ko}\n\n### 하위\n\n${fence}`],
      ['guide/b.md', '# B\n'],
      ['ko/guide/c.md', '# 다\n'],
      ['guide/same.md', `# S\n\n## X {#x}\n\n## Old title\n\n${fence}`],
      ['ko/guide/same.md', '# 에스\n\n## 엑스 {#x}\n\n## 옛 제목 {#옛-제목}\n'],
    ])
    expect(parityProblems(pages)).toEqual([
      'guide/b.md: no ko/guide/b.md',
      'ko/guide/c.md: no guide/c.md',
      'guide/a.md: heading levels differ from ko/guide/a.md at heading 3 (en: 1 2 3 2 | ko: 1 2 2 3)',
      'guide/a.md: explicit ids differ — en only: [two], ko only: [two-ko]',
    ])
  })
})

describe('user docs stop at H3', () => {
  it('has no H4 outside the allowance, and the allowance is exact', () => {
    expect(deepHeadingProblems(site())).toEqual([])
  })

  it('reports a new H4, an allowance that no longer matches, and ignores one in a fence', () => {
    const pages = new Map([
      ['guide/new.md', '# N\n\n## S\n\n#### Too deep\n'],
      ['guide/fenced.md', '# F\n\n```md\n#### example\n```\n'],
      ['guide/self-hosting.md', '# SH\n\n#### one\n'],
    ])
    expect(deepHeadingProblems(pages, new Map([['guide/self-hosting.md', 3], ['guide/gone.md', 1]]))).toEqual([
      'guide/new.md: 1 heading(s) below H3',
      'guide/self-hosting.md: allowed 3 heading(s) below H3, has 1 — update or remove the H4_ALLOWED entry',
      'guide/gone.md: in H4_ALLOWED but not a page',
    ])
  })
})
