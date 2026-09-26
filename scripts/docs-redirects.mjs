#!/usr/bin/env node
// Writes the `redirects` block of `docs/vercel.json` from `docs/.vitepress/moves.json`.
//
//   node scripts/docs-redirects.mjs          # prints what would be written
//   node scripts/docs-redirects.mjs --write  # rewrites docs/vercel.json
//
// `moves.json` is the source and `vercel.json` the output, so a move is edited in one place.
// `scripts/__tests__/docsMoves.test.mjs` fails when the two disagree — run this with `--write`
// after editing `moves.json`.
//
// Explicit rules, one per URL, not `:path*` patterns: a pattern on `/guide/:path*` would also
// swallow any page added under `/guide/` later. Vercel applies `redirects` before the filesystem, so a rule whose
// source is still a page would hide that page.
//
// `permanent: true` answers 308. A browser keeps the request's `#fragment` across a redirect whose
// `Location` has none (RFC 9110 §10.2.2), so `/guide/agent#remote-relay-authentication` lands on
// `/operate/agents#remote-relay-authentication` without anything here knowing about fragments.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(import.meta.dirname, '..')
export const MOVES_PATH = join(ROOT, 'docs', '.vitepress', 'moves.json')
export const VERCEL_PATH = join(ROOT, 'docs', 'vercel.json')

/**
 * The Vercel rules for a `moves.json` object, in a stable order.
 *
 * - `pages`: each old page URL answers for four sources — the English page, its Korean twin under
 *   `/ko`, and the `.md` copy of each (`docs/.vitepress/agent-artifacts.mjs` ships one beside
 *   every page).
 * - `aliases`: URLs that were never pages, so there is no `.md` copy; mirrored under `/ko`.
 * - `files`: static files under `docs/public`, one rule each, not mirrored.
 */
export function redirectsFrom(moves) {
  const rule = (source, destination) => ({ source, destination, permanent: true })
  const out = []
  for (const [from, to] of Object.entries(moves.pages ?? {})) {
    out.push(rule(from, to), rule(`/ko${from}`, `/ko${to}`), rule(`${from}.md`, `${to}.md`), rule(`/ko${from}.md`, `/ko${to}.md`))
  }
  for (const [from, to] of Object.entries(moves.aliases ?? {})) {
    out.push(rule(from, to), rule(`/ko${from}`, `/ko${to}`))
  }
  for (const [from, to] of Object.entries(moves.files ?? {})) {
    out.push(rule(from, to))
  }
  return out
}

export const loadMoves = () => JSON.parse(readFileSync(MOVES_PATH, 'utf8'))

/**
 * Where a URL path lands after the redirects above — `/ko/guide/agent` → `/ko/operate/agents` —
 * or the path unchanged when nothing moved it. One hop, because `docsMoves` forbids chains.
 * Page and alias moves only: this is for page URLs, which is what a `#fragment` link names.
 */
export function resolveMoved(path, moves) {
  const locale = path === '/ko' || path.startsWith('/ko/') ? '/ko' : ''
  const rest = path.slice(locale.length)
  const to = moves.pages?.[rest] ?? moves.aliases?.[rest]
  return to === undefined ? path : `${locale}${to}`
}

/** `vercel.json` as it should read: the existing keys, with `redirects` replaced. */
export function vercelConfig(current, moves) {
  return { ...current, redirects: redirectsFrom(moves) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const moves = JSON.parse(readFileSync(MOVES_PATH, 'utf8'))
  const current = JSON.parse(readFileSync(VERCEL_PATH, 'utf8'))
  const next = `${JSON.stringify(vercelConfig(current, moves), null, 2)}\n`
  if (process.argv.includes('--write')) {
    writeFileSync(VERCEL_PATH, next)
    console.log(`wrote ${redirectsFrom(moves).length} redirects to docs/vercel.json`)
  } else {
    process.stdout.write(next)
  }
}
