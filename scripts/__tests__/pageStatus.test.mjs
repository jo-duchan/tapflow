// A page's status (experimental / deprecated) and the platform badges, held to one source.
//
// The status is written once, in the page's frontmatter (`docs/.vitepress/page-status.mjs`). The
// banner, the sidebar badge and the `llms-full.txt` line are derived from it; `docs/public/llms.txt`
// is written by hand, so this suite is what keeps it in step. Before this, the same warning box was
// copied into five pages in two languages, and the sidebar said nothing at all.
//
// The platform half: every feature page used to carry both an iOS and an Android badge, which said
// nothing, and a lone "iOS" badge read as "supported" rather than "only". Badges now mark only what
// one platform alone has, in exactly four phrases.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import {
  readPageStatus,
  withStatusBadges,
  linkToPage,
} from '../../docs/.vitepress/page-status.mjs'
import { emitAgentArtifacts } from '../../docs/.vitepress/agent-artifacts.mjs'
import config from '../../docs/.vitepress/config.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const DOCS = join(ROOT, 'docs')
const SITE = 'https://www.tapflow.dev'

/** Every `.md` under docs/, srcDir-relative, minus build output, deps and contributor files. */
function docsPages() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['.vitepress', 'node_modules', 'public'].includes(e.name)) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.name.endsWith('.md') && !['AGENTS.md', 'CLAUDE.md'].includes(e.name)) {
        out.push(relative(DOCS, abs).replaceAll('\\', '/'))
      }
    }
  }
  walk(DOCS)
  return out.sort()
}

/** `true` when `text` carries the icon badge for this status, labelled for both sight and speech. */
function hasBadge(text, status, label) {
  const badge = new RegExp(`<span class="status-badge ${status}" title="${label}"><svg [^>]*aria-hidden="true"[^>]*>.+?</svg><span class="status-badge-label">${label}</span></span>$`)
  return badge.test(text)
}

const read = (page) => readFileSync(join(DOCS, page), 'utf8')

/** `{ page, line }` for every link row of llms.txt, page as the srcDir-relative `.md` path. */
function llmsRows() {
  return readFileSync(join(DOCS, 'public', 'llms.txt'), 'utf8')
    .split('\n')
    .map((line) => ({ line, m: /^- \[[^\]]+\]\((https:\/\/www\.tapflow\.dev\/[^)]*)\)/.exec(line) }))
    .filter(({ m }) => m)
    .map(({ line, m }) => ({ line, page: linkToPage(m[1].slice(SITE.length)) }))
}

/** The suffix a llms.txt row must end with for this status, or `null` for a stable page. */
function expectedSuffix(status) {
  if (!status) return null
  if (status.status === 'experimental') return ' (experimental)'
  return ` (deprecated → ${SITE}${status.replacedBy})`
}

describe('readPageStatus', () => {
  it('reads a stable page as null', () => {
    expect(readPageStatus('---\ntitle: A\n---\n\n# A\n')).toBeNull()
    expect(readPageStatus('# No frontmatter\n')).toBeNull()
    expect(readPageStatus('---\n---\n\n# Empty block\n')).toBeNull()
  })

  it('reads experimental, quoted or not', () => {
    expect(readPageStatus('---\ntitle: A\nstatus: experimental\n---\n')).toEqual({ status: 'experimental' })
    expect(readPageStatus('---\nstatus: "experimental"\n---\n')).toEqual({ status: 'experimental' })
  })

  it('reads deprecated with its replacement', () => {
    expect(readPageStatus('---\nstatus: deprecated\nreplacedBy: /automation/flows\n---\n')).toEqual({
      status: 'deprecated',
      replacedBy: '/automation/flows',
    })
  })

  it('ignores a status written in the body, which is an example rather than a declaration', () => {
    expect(readPageStatus('---\ntitle: A\n---\n\nstatus: experimental\n')).toBeNull()
  })

  it('refuses a misspelled or indented key, instead of reading the page as stable', () => {
    expect(() => readPageStatus('---\nStatus: experimental\n---\n', 'x.md')).toThrow(/x\.md.*status:/)
    expect(() => readPageStatus('---\n status: experimental\n---\n')).toThrow(/status:/)
  })

  it('drops a trailing comment, but keeps a # inside quotes', () => {
    expect(readPageStatus('---\nstatus: experimental  # until #1211\n---\n')).toEqual({ status: 'experimental' })
    expect(
      readPageStatus('---\nstatus: deprecated # old\nreplacedBy: "/a/b#c"\n---\n'),
    ).toEqual({ status: 'deprecated', replacedBy: '/a/b#c' })
  })

  it('refuses a value it does not know, instead of reading it as stable', () => {
    expect(() => readPageStatus('---\nstatus: experimnetal\n---\n', 'x.md')).toThrow(/x\.md.*experimnetal/)
  })

  it('refuses deprecated with no replacement, a relative one, or one carrying the locale', () => {
    expect(() => readPageStatus('---\nstatus: deprecated\n---\n')).toThrow(/replacedBy/)
    expect(() => readPageStatus('---\nstatus: deprecated\nreplacedBy: flows\n---\n')).toThrow(/replacedBy/)
    expect(() => readPageStatus('---\nstatus: deprecated\nreplacedBy: /ko/flows\n---\n')).toThrow(/replacedBy/)
  })
})

describe('withStatusBadges', () => {
  const base = mkdtempSync(join(tmpdir(), 'tapflow-page-status-'))
  const files = {
    'a/exp.md': '---\nstatus: experimental\n---\n# Exp\n',
    'a/old.md': '---\nstatus: deprecated\nreplacedBy: /a/stable\n---\n# Old\n',
    'a/stable.md': '# Stable\n',
    'a.md': '---\nstatus: experimental\n---\n# Group page\n',
    'ko/a/exp.md': '---\nstatus: experimental\n---\n# 실험\n',
  }
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(base, p)), { recursive: true })
    writeFileSync(join(base, p), body)
  }
  const sidebar = [
    {
      text: 'Group',
      items: [
        { text: 'Exp', link: '/a/exp' },
        { text: 'Old', link: '/a/old' },
        { text: 'Stable', link: '/a/stable' },
        // A linked sub-group: its text is an llms.txt `###` heading, so it is never marked.
        { text: 'Sub', link: '/a', items: [{ text: 'Exp again', link: '/a/exp' }] },
      ],
    },
  ]

  it('marks page entries from their frontmatter and leaves groups alone', () => {
    try {
      const [group] = withStatusBadges(sidebar, (p) => readFileSync(join(base, p), 'utf8'), 'en')
      expect(group.text).toBe('Group')
      expect(group.items[0].text.startsWith('Exp <span')).toBe(true)
      expect(hasBadge(group.items[0].text, 'experimental', 'Experimental')).toBe(true)
      expect(hasBadge(group.items[1].text, 'deprecated', 'Deprecated')).toBe(true)
      expect(group.items.slice(2).map((i) => i.text)).toEqual(['Stable', 'Sub'])
      expect(hasBadge(group.items[3].items[0].text, 'experimental', 'Experimental')).toBe(true)
      // The input is not mutated: config.ts passes its literal sidebars straight in.
      expect(sidebar[0].items[0].text).toBe('Exp')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('withStatusBadges, localized', () => {
  it('uses the Korean label under /ko', () => {
    const base = mkdtempSync(join(tmpdir(), 'tapflow-page-status-ko-'))
    try {
      mkdirSync(join(base, 'ko', 'a'), { recursive: true })
      writeFileSync(join(base, 'ko', 'a', 'exp.md'), '---\nstatus: experimental\n---\n')
      const [item] = withStatusBadges([{ text: '실험', link: '/ko/a/exp' }], (p) => readFileSync(join(base, p), 'utf8'), 'ko')
      expect(item.text.startsWith('실험 <span')).toBe(true)
      expect(hasBadge(item.text, 'experimental', '실험적')).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('llms-full.txt status line', () => {
  it('puts the status under the page URL, since the bundle strips frontmatter', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tapflow-page-status-full-'))
    try {
      const srcDir = join(base, 'src')
      const outDir = join(base, 'out')
      const pages = {
        'a/exp.md': '---\nstatus: experimental\n---\n\n# Exp\n\nEXP-BODY\n',
        'a/old.md': '---\nstatus: deprecated\nreplacedBy: /a/stable\n---\n\n# Old\n\nOLD-BODY\n',
        'a/stable.md': '---\ntitle: Stable\n---\n\n# Stable\n\nSTABLE-BODY\n',
      }
      for (const [p, body] of Object.entries(pages)) {
        mkdirSync(dirname(join(srcDir, p)), { recursive: true })
        writeFileSync(join(srcDir, p), body)
      }
      mkdirSync(outDir)
      await emitAgentArtifacts({ srcDir, outDir, pages: Object.keys(pages), hostname: SITE })
      const full = readFileSync(join(outDir, 'llms-full.txt'), 'utf8')
      expect(full).toContain(`# ${SITE}/a/exp\n\nStatus: experimental\n\n# Exp`)
      expect(full).toContain(`# ${SITE}/a/old\n\nStatus: deprecated, replaced by ${SITE}/a/stable\n\n# Old`)
      expect(full).toContain(`# ${SITE}/a/stable\n\n# Stable`)
      expect(full.match(/^Status:/gm)).toHaveLength(2)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('the real docs', () => {
  const pages = docsPages()

  it('finds the pages it checks', () => {
    // Without this, an empty walk would pass every check below.
    expect(pages.length).toBeGreaterThan(50)
    expect(pages.filter((p) => readPageStatus(read(p), p)?.status === 'experimental').length).toBeGreaterThan(0)
  })

  it('gives a Korean page the same status as its English page', () => {
    const mismatched = pages
      .filter((p) => p.startsWith('ko/'))
      .filter((ko) => {
        const en = ko.slice('ko/'.length)
        if (!pages.includes(en)) return false
        return JSON.stringify(readPageStatus(read(ko), ko)) !== JSON.stringify(readPageStatus(read(en), en))
      })
    expect(mismatched).toEqual([])
  })

  it('ends each llms.txt row with the status its page declares, and only then', () => {
    const rows = llmsRows()
    expect(rows.length).toBeGreaterThan(40)
    const wrong = rows
      .map(({ line, page }) => {
        const suffix = expectedSuffix(readPageStatus(read(page), page))
        const marked = / \((experimental|deprecated → [^)]*)\)$/.exec(line)?.[0] ?? null
        return marked === suffix ? null : `${page}: expected ${suffix ?? 'no suffix'}, found ${marked ?? 'none'}`
      })
      .filter(Boolean)
    expect(wrong).toEqual([])
  })

  it('points a deprecated page at a page that exists', () => {
    const dangling = pages
      .map((p) => ({ p, s: readPageStatus(read(p), p) }))
      .filter(({ s }) => s?.status === 'deprecated')
      .filter(({ s }) => !pages.includes(linkToPage(s.replacedBy)))
      .map(({ p }) => p)
    expect(dangling).toEqual([])
  })

  it('has no hand-written status box left in a page body', () => {
    const boxed = pages.filter((p) => /^::: (warning|danger) (Experimental|Deprecated|실험적|지원 중단)/m.test(read(p)))
    expect(boxed).toEqual([])
  })

  it('marks the sidebar entry of an experimental page, and not of a stable one', () => {
    // A positive control on the config as loaded: the unit test above proves the function, this
    // proves config.ts calls it on both locales.
    const find = (items, link) => {
      for (const item of items) {
        if (item.link === link && !item.items) return item
        const hit = item.items && find(item.items, link)
        if (hit) return hit
      }
      return null
    }
    const en = config.locales.root.themeConfig.sidebar
    const ko = config.locales.ko.themeConfig.sidebar
    const experimental = pages.find((p) => !p.startsWith('ko/') && readPageStatus(read(p))?.status === 'experimental')
    const link = `/${experimental.replace(/\.md$/, '')}`
    expect(hasBadge(find(en, link)?.text ?? '', 'experimental', 'Experimental')).toBe(true)
    expect(hasBadge(find(ko, `/ko${link}`)?.text ?? '', 'experimental', '실험적')).toBe(true)
    expect(find(en, '/testing/app-center')?.text).toBe('App Center')
  })
})

describe('badges in page bodies', () => {
  const ALLOWED = {
    en: ['iOS only', 'Android only', 'Experimental', 'Deprecated'],
    ko: ['iOS 전용', 'Android 전용', '실험적', '지원 중단 예정'],
  }
  const badges = (source) => [...source.matchAll(/<Badge\b[^>]*?\btext="([^"]*)"/g)].map((m) => m[1])

  it('reads every badge, including the ones this rule forbids', () => {
    // The pattern must see a bare platform badge, or the check below passes on a page full of them.
    expect(badges('<Badge type="info" text="iOS" /> <Badge type="info" text="Android" />')).toEqual(['iOS', 'Android'])
  })

  it('uses only the allowed phrases, in the page language', () => {
    const wrong = docsPages().flatMap((p) => {
      const allowed = ALLOWED[p.startsWith('ko/') ? 'ko' : 'en']
      return badges(read(p))
        .filter((t) => !allowed.includes(t))
        .map((t) => `${p}: "${t}"`)
    })
    expect(wrong).toEqual([])
  })
})
