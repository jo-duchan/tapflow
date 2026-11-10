import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sources } from './sourceFiles.mjs'

// **An address handed to someone else is decided in one place per layer** (#788, #794).
//
// Before this, eight places built "the address a teammate opens", five different ways: configuration,
// the Host header, the browser's location, a network-interface guess, a certificate name. Each was right
// where it was written and they disagreed — an invite dialog on the Vite server copied `localhost:3001`
// while the same invitation's email carried the configured LAN address. The fix moved the decision to
// `packages/relay/src/lib/publicUrl.ts` and the fallbacks to `packages/dashboard/lib/publicLink.ts`.
// Nothing about either file stops a ninth place, which is what this check is for.
//
// Four assertions, two per layer, and each pair is a spelling rule plus a structural one:
//
//  - relay, structure: only `publicUrl.ts` and `config.ts` read `relay.url` or a tunnel's `publicUrl`.
//    A copied "is anything configured?" condition was the defect in `proxyConfig.ts`, and it contains no
//    forbidden spelling at all — so a header ban alone would have passed it.
//  - relay, spelling: the Host header and `x-forwarded-proto` are read only where allowed, per file and
//    per pattern. `csrf.ts` compares Origin with Host and builds nothing. `passwordReset.ts` must never
//    be allowlisted: password-reset links use the configured public URL, not request headers (#777).
//  - dashboard, structure: only `publicLink.ts` reads `/api/v1/relay/host` or the two fields it returns.
//  - dashboard, spelling: `location` is read only as pathname/search/hash/hostname/protocol outside the
//    files allowed below. Allow-listing the properties rather than denying origin/host/href is what
//    catches destructuring, `${location}` and bracket access.
//
// **What it does not catch**, because a spelling check is a floor and not a fence: an origin assembled
// from allowed parts (`${location.protocol}//${location.hostname}`), a `location` reached through an
// alias, the bare `origin` global (`window.origin`, `self.origin` and `globalThis.origin` are caught), and
// anything in `packages/cli`, which is not walked — the CLI hands the relay a tunnel outcome and builds no
// teammate link of its own.
//
// Comments are blanked before matching, so this header and the doc comments that explain the rule do not
// trip it. Only `//` after whitespace counts as a comment: `${proto}//${location.host}` in a template
// literal is code, and a stripper that treated it as a comment would hide exactly the violation this
// check exists to find.

const root = join(import.meta.dirname, '../..')

/** Comments blanked, line count preserved. */
export const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/[^\r\n]*/, '$1'))
    .join('\n')

const read = (path) => code(readFileSync(join(root, path), 'utf8'))

// ── relay ──────────────────────────────────────────────────────────────────

const CONFIG_READ = /\.(relay\??\.url|tunnel\??\.publicUrl)\b/
const CONFIG_READERS = new Set(['packages/relay/src/lib/publicUrl.ts', 'packages/relay/src/lib/config.ts'])

const HEADER_READS = [
  ['headers.host', /\bheaders\??\.host\b/],
  ["headers['host']", /\bheaders(\?\.)?\[\s*['"`]host['"`]\s*\]/],
  ['host destructured from headers', /\{[^}]*\bhost\b[^}]*\}\s*=\s*[\w.]*\bheaders\b/],
  ['x-forwarded-proto', /x-forwarded-proto/i],
]

/** File → the header reads it is allowed, and why. */
const HEADER_ALLOWED = {
  'packages/relay/src/lib/csrf.ts': { reads: ["headers['host']"], why: 'compares Origin with Host for same-origin; builds no link (#5)' },
  'packages/relay/src/lib/clientAddress.ts': { reads: ['x-forwarded-proto'], why: 'only tests whether a trusted proxy sent it, to warn about a missing X-Forwarded-For; reads no value, builds no link' },
}

export function judgeRelayFile(path, text) {
  const offenders = []
  if (CONFIG_READ.test(text) && !CONFIG_READERS.has(path)) {
    offenders.push(`${path} reads relay.url or a tunnel publicUrl — decide addresses in lib/publicUrl.ts`)
  }
  const allowed = HEADER_ALLOWED[path]?.reads ?? []
  for (const [name, pattern] of HEADER_READS) {
    if (pattern.test(text) && !allowed.includes(name)) {
      offenders.push(`${path} reads ${name} — a client controls it (#6); build addresses in lib/publicUrl.ts`)
    }
  }
  const stale = allowed
    .filter((name) => !HEADER_READS.find(([n]) => n === name)[1].test(text))
    .map((name) => `${path} no longer reads ${name}: delete it from HEADER_ALLOWED`)
  return { offenders, stale }
}

// ── dashboard ──────────────────────────────────────────────────────────────

const RELAY_HOST_READ = /\/api\/v1\/relay\/host|\bpublicBaseUrl\b|\bagentRelayUrl\b/
const RELAY_HOST_READER = 'packages/dashboard/lib/publicLink.ts'

const LOCATION_READ = /\blocation\b(?!\.(pathname|search|hash|hostname|protocol)\b)|\bdocument\.(URL|baseURI)\b|\b(window|self|globalThis)\.origin\b/

/** Files allowed any read of `location`, and why. Allowing a whole file is coarse; see the header. */
const LOCATION_ALLOWED = {
  'packages/dashboard/lib/publicLink.ts': 'builds addresses for someone else, the one place that falls back to the page origin',
  'packages/dashboard/hooks/useRelay.ts': "connects this page to its own relay, where the page's own host is correct",
  'packages/dashboard/hooks/useDecoderStream.ts': '`typeof location` guard, not a read',
  'packages/dashboard/src/layouts/DashboardLayout.tsx': 'a react-router useLocation() variable named location',
  'packages/dashboard/lib/flowCapture/copy.ts': 'the name of a run reset item, `location` (#1139), and its label: strings, not a read',
}

export function judgeDashboardFile(path, text) {
  const offenders = []
  if (RELAY_HOST_READ.test(text) && path !== RELAY_HOST_READER) {
    offenders.push(`${path} reads /api/v1/relay/host or its fields — go through lib/publicLink.ts`)
  }
  if (LOCATION_READ.test(text) && !(path in LOCATION_ALLOWED)) {
    offenders.push(`${path} reads location beyond pathname/search/hash/hostname/protocol — an address for someone else comes from lib/publicLink.ts`)
  }
  return offenders
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('the rules match what they are meant to', () => {
  it('keeps a template literal that contains // as code', () => {
    expect(code('const u = `${proto}//${location.host}`')).toContain('location.host')
    expect(code('const a = 1 // location.origin')).not.toContain('location.origin')
    expect(code('/* location.origin */ const b = 2')).not.toContain('location.origin')
    expect(code('// req.headers.host\r\nexport const x = 1')).not.toContain('headers.host')
  })

  it('relay: flags a copied config condition and a config read through an option, not prose', () => {
    const copied = 'if (!cfg.tunnel?.publicUrl && !cfg.relay.url) return null'
    expect(judgeRelayFile('packages/relay/src/lib/other.ts', copied).offenders).toHaveLength(1)
    expect(judgeRelayFile('packages/relay/src/lib/publicUrl.ts', copied).offenders).toEqual([])
    expect(judgeRelayFile('packages/relay/src/RelayServer.ts', 'resolve(this.options.tunnel?.publicUrl)').offenders).toHaveLength(1)
    expect(judgeRelayFile('packages/relay/src/lib/other.ts', "'no public URL (tunnel.publicUrl / relay.url)'").offenders).toEqual([])
  })

  it.each([
    'const origin = `http://${req.headers.host}`',
    'const h = headers["host"]',
    "const h = req.headers['host']",
    'const h = req.headers?.host',
    "const h = req.headers?.['host']",
    'const { host } = req.headers',
    "const proto = req.headers['x-forwarded-proto']",
  ])('relay: flags a header read outside the allowlist — %s', (line) => {
    expect(judgeRelayFile('packages/relay/src/api/other.ts', line).offenders.length).toBeGreaterThan(0)
  })

  it('relay: a comment about the Host header is not a read', () => {
    const text = code('// `req.headers.host` and `x-forwarded-proto` are client-controlled\nexport const x = 1')
    expect(judgeRelayFile('packages/relay/src/lib/other.ts', text).offenders).toEqual([])
  })

  it('relay: reports an allowlisted read that disappears', () => {
    const { offenders, stale } = judgeRelayFile('packages/relay/src/lib/csrf.ts', 'export const noHeaders = true')
    expect(offenders).toEqual([])
    expect(stale).toEqual([expect.stringContaining("headers['host']")])
  })

  it.each([
    'const origin = `http://${req.headers.host}`',
    "const proto = req.headers['x-forwarded-proto']",
  ])('relay: flags a request-header read in passwordReset.ts after #777 — %s', (line) => {
    const { offenders, stale } = judgeRelayFile('packages/relay/src/api/passwordReset.ts', line)
    expect(offenders).toHaveLength(1)
    expect(stale).toEqual([])
  })

  it('dashboard: flags a relay-host read outside publicLink.ts', () => {
    expect(judgeDashboardFile('packages/dashboard/components/X.tsx', "fetch('/api/v1/relay/host')")).toHaveLength(1)
    expect(judgeDashboardFile('packages/dashboard/lib/publicLink.ts', "fetch('/api/v1/relay/host')")).toEqual([])
  })

  it.each([
    'const u = `${location.origin}/x`',
    'const { origin } = window.location',
    'const s = `${location}`',
    "const l = window['location']",
    'const b = document.baseURI',
    'const p = location.port',
    'const u = `${window.origin}/invite?token=${t}`',
    'const o = globalThis.origin',
  ])('dashboard: flags %s', (line) => {
    expect(judgeDashboardFile('packages/dashboard/components/X.tsx', line)).toHaveLength(1)
  })

  it.each([
    'const h = window.location.hash',
    'const p = location.pathname + location.search',
    "const local = window.location.hostname === 'localhost'",
    "const secure = location.protocol === 'https:'",
  ])('dashboard: allows %s', (line) => {
    expect(judgeDashboardFile('packages/dashboard/components/X.tsx', line)).toEqual([])
  })
})

describe('the tree follows the rules', () => {
  const relayFiles = sources('packages/relay/src')
  const dashboardFiles = sources('packages/dashboard')

  it('walks the whole of both layers', () => {
    // Floors from the measurement when this check was written. An empty or partial walk would make every
    // assertion below hold for nothing.
    expect(relayFiles.length).toBeGreaterThanOrEqual(56)
    expect(dashboardFiles.length).toBeGreaterThanOrEqual(113)
    expect(relayFiles).toContain('packages/relay/src/lib/csrf.ts')
    expect(dashboardFiles).toContain('packages/dashboard/hooks/useRelay.ts')
  })

  it('relay: addresses are decided only in lib/publicUrl.ts, and allowlisted header reads are still needed', () => {
    const offenders = []
    const stale = []
    for (const path of relayFiles) {
      const verdict = judgeRelayFile(path, read(path))
      offenders.push(...verdict.offenders)
      stale.push(...verdict.stale)
    }
    for (const path of Object.keys(HEADER_ALLOWED)) {
      expect(relayFiles, `${path} is allowlisted but no longer exists`).toContain(path)
    }
    expect(offenders).toEqual([])
    expect(stale).toEqual([])
  })

  it('dashboard: an address for someone else comes only from lib/publicLink.ts', () => {
    const offenders = dashboardFiles.flatMap((path) => judgeDashboardFile(path, read(path)))
    for (const path of Object.keys(LOCATION_ALLOWED)) {
      expect(dashboardFiles, `${path} is allowlisted but no longer exists`).toContain(path)
    }
    expect(offenders).toEqual([])
  })
})
