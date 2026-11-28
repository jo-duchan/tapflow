// A page's maturity, read from one place: its own frontmatter.
//
//   status: experimental            # may change in a minor release, listed in the CHANGELOG
//   status: deprecated              # still works, on its way out
//   replacedBy: /path/to/new-page   # required with `deprecated`, written without the `/ko` prefix
//
// No `status` means the page is stable. The banner at the top of the page (`theme/PageStatus.vue`),
// the badge beside the page's sidebar entry (`config.ts`), the status line in `llms-full.txt`
// (`agent-artifacts.mjs`) and the suffix in `docs/public/llms.txt` all follow this value, so moving a
// page to stable is one deleted line. The first three are derived; `llms.txt` is written by hand, and
// `scripts/__tests__/pageStatus.test.mjs` holds it to the frontmatter.
//
// **Written in `.mjs`, not `.ts`**, for the same reason as `agent-artifacts.mjs`: the root scripts
// suite imports it. And read with a hand-written pattern rather than a YAML parser: the root tests
// import `config.ts`, which imports this, and pnpm's strict layout gives the root no access to the
// docs package's dependencies. The caller hands in the file reader, so the tests can point it at a
// fixture tree and the module stays free of Node imports.

export const STATUSES = /** @type {const} */ (['experimental', 'deprecated'])

/** The sidebar badge's tooltip and screen-reader label, per locale. */
export const STATUS_LABELS = {
  en: { experimental: 'Experimental', deprecated: 'Deprecated' },
  ko: { experimental: '실험적', deprecated: '지원 중단 예정' },
}

// The sidebar shows an icon, not the word: "Experimental" beside a long title wrapped it onto a
// second line, and seven in a row read as noise. The word stays as the tooltip and as hidden text, so
// a screen reader still announces it; the page's own banner spells out what it means.
//
// Icons from Lucide (https://lucide.dev), `flask-conical` and `circle-alert`, ISC License,
// Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT);
// all other copyright (c) for Lucide are held by Lucide Contributors 2022.
const ICONS = {
  experimental:
    '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  deprecated:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
}

/**
 * The sidebar badge's HTML: an icon, with the label as its tooltip and as visually hidden text.
 *
 * @param {'experimental' | 'deprecated'} status
 * @param {'en' | 'ko'} locale
 */
export function statusBadge(status, locale) {
  const label = STATUS_LABELS[locale][status]
  return (
    `<span class="status-badge ${status}" title="${label}">` +
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[status]}</svg>` +
    `<span class="status-badge-label">${label}</span></span>`
  )
}

/** The frontmatter block's body, or `''` when the page has none. */
function frontmatterOf(source) {
  return /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(source)?.[1] ?? ''
}

/** One top-level scalar key, quotes stripped, or a trailing ` # comment` dropped when unquoted. */
function scalar(frontmatter, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(frontmatter)
  if (!m) return undefined
  const quoted = /^(['"])(.*)\1$/.exec(m[1])
  return quoted ? quoted[2] : m[1].replace(/[ \t]+#.*$/, '')
}

/**
 * The page's status, or `null` for a stable page.
 *
 * Throws on a value outside STATUSES and on `deprecated` without a `replacedBy` path, so a typo
 * fails the config load (and with it `pnpm docs:build` and the root tests) instead of quietly
 * reading as stable.
 *
 * @param {string} source raw markdown
 * @param {string} [where] page path, for the error message
 * @returns {{ status: 'experimental' } | { status: 'deprecated', replacedBy: string } | null}
 */
export function readPageStatus(source, where = 'page') {
  const fm = frontmatterOf(source)
  const status = scalar(fm, 'status')
  // `Status:` or an indented ` status:` is not the key above, and reading it as stable is the one
  // mistake nothing downstream would notice: the llms.txt check compares against this same reading.
  if (status === undefined && /^[ \t]*status[ \t]*:/im.test(fm)) {
    throw new Error(`${where}: write the key as a lowercase, unindented "status:"`)
  }
  if (status === undefined || status === '') return null
  if (!STATUSES.includes(/** @type {never} */ (status))) {
    throw new Error(`${where}: status "${status}" is not one of ${STATUSES.join(', ')}`)
  }
  if (status === 'experimental') return { status }
  const replacedBy = scalar(fm, 'replacedBy')
  if (!replacedBy || !replacedBy.startsWith('/') || replacedBy.startsWith('/ko/')) {
    throw new Error(`${where}: status "deprecated" needs replacedBy: /path, written without /ko`)
  }
  return { status, replacedBy }
}

/** The srcDir-relative markdown file a sidebar link points at (`/testing` → `testing.md`). */
export function linkToPage(link) {
  return `${link.replace(/^\//, '').replace(/\/$/, '/index')}.md`
}

/**
 * The sidebar with a status badge appended to each page entry's text.
 *
 * Only entries with no children are marked: a group label is not a page's status, and a top-level
 * group's text is compared against `llms.txt`'s `##` headings by `agentReadableDocs`. The badge
 * is a `<span>` because VitePress renders sidebar text with `v-html`; the prev/next footer renders the
 * same text the same way, and `custom.css` hides the badge there.
 *
 * @template {{ text?: string, link?: string, items?: any[] }} T
 * @param {T[]} sidebar
 * @param {(page: string) => string} readPage raw markdown of a srcDir-relative page path
 * @param {'en' | 'ko'} locale
 * @returns {T[]}
 */
export function withStatusBadges(sidebar, readPage, locale) {
  const mark = (item) => {
    if (item.items) return { ...item, items: item.items.map(mark) }
    if (!item.link) return item
    const page = linkToPage(item.link)
    const found = readPageStatus(readPage(page), page)
    if (!found) return item
    return { ...item, text: `${item.text} ${statusBadge(found.status, locale)}` }
  }
  return sidebar.map(mark)
}
