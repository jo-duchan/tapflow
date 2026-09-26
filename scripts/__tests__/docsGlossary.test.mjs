// The Korean user docs spell each concept one way. The source of truth is the 용어집 table in
// `docs/AGENTS.md`; this check holds the part of it that a spelling can decide.
//
// Before this check the same page could say 릴레이 in one sentence and `relay` in the next, and
// 디바이스 and 기기 sat side by side across 14 pages. The glossary applies to **prose only**: a
// command, a config key, a path or a literal dashboard label is copied, not translated, so the scan
// strips those before it looks.
//
// What is stripped, in order: frontmatter and fenced / indented code blocks (`proseLines`, shared
// with the other doc checks), then per line HTML comments, inline code, link targets `](...)`,
// reference-link definitions, autolinks, HTML tags and explicit heading ids `{#...}`. The last one
// matters: a heading whose text was changed keeps its old anchor as `{#...-디렉토리}`, so the
// forbidden spelling survives on purpose inside the id.
//
// **What this does NOT catch.** It is a spelling floor, not a style review (see
// `contributing/test-and-guard-coverage.md` rule 3). It does not judge whether a bare 에이전트
// means tapflow's agent or a coding agent, it does not check that PAT is spelled out on first use,
// and it skips frontmatter, so the hero text in `docs/ko/index.md` is outside it. A hyphen-joined word
// (`relay-agent`) is not caught, since hyphens also build identifiers like `tapflow-agent`. A list
// continuation paragraph indented four spaces or more is skipped with the indented-code rule in
// `proseLines` (none exist in docs/ko today). English pages are
// not scanned: the English column has no forbidden spelling a regex can decide.
//
// Mutations run by hand before commit, per rule 1 — each claim above was made to fail:
//
//  - 디바이스 planted in a prose line of `docs/ko/guide/scaling.md`: red, naming file and line.
//  - inline-code stripping removed: red on `relay.url`-style spans across the real pages.
//  - fence stripping removed (`proseLines` swapped for a plain split): red on command blocks.
//  - link-target stripping removed: red on `(/ko/guide/configure#명령이-쓰는-설치-디렉토리)`.
//  - `{#...}` stripping removed: red on the kept anchors.
//  - each allowlist entry deleted in turn: red on the line it covers.
//  - the page walk pointed at an empty directory: the floor goes red.
//  - `/` put back into the relay lookarounds: red on the `relay/agent` fixture line.
//  - the allowlist's file scope removed: red on the out-of-scope `**Agent**` case.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { proseLines } from '../lib/prose-lines.mjs'

const root = join(import.meta.dirname, '../..')
const koDir = join(root, 'docs/ko')

/** Forbidden spellings in Korean prose, with the spelling to use instead. */
const FORBIDDEN = [
  { re: /디바이스/g, use: '기기' },
  { re: /디렉토리/g, use: '디렉터리' },
  { re: /QA\s?팀/g, use: '팀원 / 팀 전체' },
  // A Latin word on its own. `tapflow-agent` and `agent.lean` are not words here. `/` is not a
  // boundary: link targets are already stripped, so `relay/agent` in prose is two words.
  { re: /(?<![A-Za-z0-9_.-])relays?(?![A-Za-z0-9_-])/gi, use: '릴레이' },
  { re: /(?<![A-Za-z0-9_.-])agents?(?![A-Za-z0-9_-])/gi, use: '에이전트' },
]

/**
 * Spans that contain a forbidden word legitimately. Kept small: each one is a literal the reader
 * sees elsewhere exactly as written, so translating it would point them at something that
 * does not exist.
 */
const ALLOW = [
  { text: '**Agent**', files: ['operate/agents.md', 'troubleshooting/install-and-agents.md', 'operate/team-and-roles.md'], reason: 'token Type label in Settings → Tokens, shown as-is in the dashboard' },
  { text: '**AGENT ALREADY RUNNING**', files: ['troubleshooting/install-and-agents.md'], reason: 'literal CLI output the reader will see' },
  { text: '에이전트 (Agents)', files: ['reference/api.md'], reason: 'API reference heading glossing the English resource group' },
  { text: '릴레이 (Relay)', files: ['reference/api.md'], reason: 'API reference heading glossing the English resource group' },
  { text: '디바이스 팜', files: ['reference/sustainability.md'], reason: 'industry term (device farm); "기기 팜" is not a phrase anyone searches for' },
]

const stripLine = (line) => line
  .replace(/<!--.*?-->/g, ' ')
  .replace(/(`+)[^`]*?\1/g, ' ')
  .replace(/\]\([^)]*\)/g, ']')
  .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/, ' ')
  .replace(/<https?:[^>]*>/g, ' ')
  .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  .replace(/\{#[^}]*\}/g, ' ')

/** Every forbidden spelling in a markdown body's prose, and the allowlist entries it used. */
export function findViolations(body, file = '') {
  const found = []
  const used = new Set()
  const lines = body.split(/\r?\n/)
  let cursor = 0                                   // proseLines yields in order; a repeated line keeps its own number
  for (const { raw } of proseLines(body, { skipFrontmatter: true })) {
    cursor = lines.indexOf(raw, cursor) + 1
    const lineNo = cursor
    let text = stripLine(raw)
    for (const a of ALLOW) {
      if (a.files.includes(file) && text.includes(a.text)) {
        used.add(a.text)
        text = text.split(a.text).join(' ')
      }
    }
    for (const { re, use } of FORBIDDEN) {
      for (const m of text.matchAll(re)) found.push({ line: lineNo, word: m[0], use })
    }
  }
  return { found, used }
}

function pages(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...pages(p))
    else if (p.endsWith('.md')) out.push(p)
  }
  return out
}

function scan(dir) {
  const violations = []
  const used = new Set()
  const files = pages(dir)
  for (const f of files) {
    // Posix separators: the allowlist names files with `/`, and `relative` gives `\` on Windows.
    const r = findViolations(readFileSync(f, 'utf8'), relative(dir, f).split(sep).join('/'))
    for (const v of r.found) violations.push(`${relative(root, f)}:${v.line}: "${v.word}" → ${v.use}`)
    r.used.forEach((u) => used.add(u))
  }
  return { files, violations, used }
}

describe('docs glossary (docs/AGENTS.md 용어집)', () => {
  it('finds forbidden spellings in prose and nowhere else', () => {
    const body = [
      '---',
      'title: 디바이스 in frontmatter',
      '---',
      '# 기기 부팅 {#디바이스-부팅}',
      '',
      '`relay.url`과 `tapflow agent start`는 코드입니다. [링크](/ko/guide/configure#설치-디렉토리)',
      '<span data-x="relay">표시</span> **Agent** 토큰',
      '',
      '```sh',
      'tapflow relay start # 디바이스 디렉토리',
      '```',
      '',
      '디바이스를 고르고 relay가 agent를 부릅니다. 디렉토리와 QA팀.',
      'relay/agent 구간',
    ].join('\n')
    const { found } = findViolations(body, 'operate/agents.md')
    expect(found.map((v) => [v.line, v.word])).toEqual([
      [13, '디바이스'], [13, '디렉토리'], [13, 'QA팀'], [13, 'relay'], [13, 'agent'],
      [14, 'relay'], [14, 'agent'],
    ])
  })

  it('an allowlist entry only covers the files it names', () => {
    expect(findViolations('**Agent** 토큰', 'operate/agents.md').found).toEqual([])
    expect(findViolations('**Agent** 토큰', 'guide/scaling.md').found.map((v) => v.word)).toEqual(['Agent'])
  })

  it('catches a forbidden word planted in a page tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-glossary-'))
    try {
      mkdirSync(join(dir, 'guide'))
      writeFileSync(join(dir, 'guide/a.md'), '# 제목\n\n기기를 고릅니다.\n')
      expect(scan(dir).violations).toEqual([])
      writeFileSync(join(dir, 'guide/a.md'), '# 제목\n\n디바이스를 고릅니다.\n')
      expect(scan(dir).violations).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('docs/ko prose uses the glossary spelling', () => {
    const { files, violations } = scan(koDir)
    // Measured 2026-09-26: 28 pages. Below that, the walk broke rather than the docs got clean.
    expect(files.length).toBeGreaterThanOrEqual(28)
    expect(violations).toEqual([])
  })

  it('every allowlist entry is still needed', () => {
    const { used } = scan(koDir)
    expect(ALLOW.map((a) => a.text).filter((t) => !used.has(t))).toEqual([])
  })
})
