// `docs/reference/cli.md` (and its Korean twin) against the commands and flags the CLI registers —
// both directions.
//
// **The subject is the built program, not this package's source text.** `createCli()` returns the
// `cac` instance `index.ts` parses, so the walk sees exactly what `tapflow --help` would: an option
// added through a helper, a loop or a spread is still an option here. Reading `program.ts` as text
// would miss all three.
//
// What each side contributes:
//
//  - **Code:** every `cli.commands` entry, its `--long` option names, and — for a command whose
//    positional is `subcommand` — the subcommands its description lists as `(subcommand: a | b)`.
//    That parenthetical is the one place a subcommand is declared: `cac` sees `relay <subcommand>`
//    and dispatches inside the action. A command taking `subcommand` without the parenthetical fails
//    the walk outright instead of contributing nothing.
//  - **Docs:** every `## \`tapflow …\`` heading, the `--flag` in the first cell of a table row under
//    it, and the `--flag`s on a `tapflow <command> …` line inside a fenced block — which is how
//    `migrate net-filter --ignore-running-devices` is documented. Flags in running prose are not
//    read: the data-dir section mentions `tapflow relay start --port` in passing, and troubleshooting
//    remedies mention flags of other tools.
//
// **Each direction has an in-memory mutation beside it** (`contributing/test-and-guard-coverage.md`
// rule 2): an empty diff is what a broken parser produces too, so the planted cases below prove the
// real-tree assertion can see each kind of drift. Mutations also run by hand against the real files
// on 2026-09-26: deleting the `--lines` row from `docs/reference/cli.md` failed the EN case; renaming
// `--artifacts` in `program.ts` failed both locales in both directions.
//
// **Not seen**: a subcommand's existence comes from its description's `(subcommand: …)` list, not from
// the action's dispatch, so deleting a branch while keeping the description stays green. Short-only
// options (`-x`) are ignored both ways, and an invocation inside a fenced block is not checked against
// real commands.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CAC } from 'cac'
import { createCli } from '../program.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const DOCS = {
  en: path.join(repoRoot, 'docs/reference/cli.md'),
  ko: path.join(repoRoot, 'docs/ko/reference/cli.md'),
}

/**
 * Global options `cac` adds itself (`cli.help()`, `cli.version()`), which every CLI has. The
 * reference documents commands; spending a table on `--help` would teach nothing.
 */
const GLOBAL_ALLOWLIST = new Set(['--help', '--version'])

/** Command name → its `--long` flags. */
type Surface = Map<string, Set<string>>

const longNames = (rawName: string) =>
  rawName.split(',').map((s) => s.trim().split(/\s/)[0]).filter((n) => n.startsWith('--'))

/** What the program registers: every invocable `tapflow <command> [sub]`, and each command's flags. */
function codeSurface(cli: CAC): { invocations: Set<string>; flags: Surface; globals: Set<string> } {
  const invocations = new Set<string>()
  const flags: Surface = new Map()
  for (const cmd of cli.commands) {
    // An alias would be an invocation the doc could never be asked for. None exist; if one is added,
    // this walk has to learn it rather than skip it.
    if (cmd.aliasNames.length > 0) throw new Error(`${cmd.name}: aliases are not walked — extend cliDocsParity`)
    const sub = cmd.args.find((a) => a.value === 'subcommand')
    if (sub) {
      const listed = cmd.description.match(/\(subcommand: ([^)]+)\)/)
      if (!listed) throw new Error(`${cmd.rawName}: takes <subcommand> but its description lists none as "(subcommand: a | b)"`)
      for (const s of listed[1].split('|')) invocations.add(`${cmd.name} ${s.trim()}`)
      if (!sub.required) invocations.add(cmd.name)
    } else {
      invocations.add(cmd.name)
    }
    flags.set(cmd.name, new Set(cmd.options.flatMap((o) => longNames(o.rawName))))
  }
  const globals = new Set(cli.globalCommand.options.flatMap((o) => longNames(o.rawName)))
  return { invocations, flags, globals }
}

/** What the page documents, by the same keys. */
function docSurface(markdown: string): { invocations: Set<string>; tableFlags: Surface; blockFlags: Surface } {
  const invocations = new Set<string>()
  const tableFlags: Surface = new Map()
  const blockFlags: Surface = new Map()
  const add = (m: Surface, k: string, v: string) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v)

  let section: string | undefined
  let fence: string | undefined
  for (const line of markdown.split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})/)
    if (f) {
      if (!fence) fence = f[1]
      else if (line.trim().startsWith(fence)) fence = undefined
      continue
    }
    if (fence) {
      const inv = line.match(/^\s*tapflow\s+([a-z][a-z-]*)(.*)$/)
      if (inv) for (const m of inv[2].matchAll(/(?:^|\s)(--[a-z0-9][a-z0-9-]*)/g)) add(blockFlags, inv[1], m[1])
      continue
    }
    const h = line.match(/^##\s+`tapflow\s+([^`]+)`\s*$/)
    if (h) {
      const words = h[1].trim().split(/\s+/)
      invocations.add(words.join(' '))
      section = words[0]
      continue
    }
    if (/^##\s/.test(line)) { section = undefined; continue }
    const row = line.match(/^\|\s*`(--[a-z0-9][a-z0-9-]*)/)
    if (row && section) add(tableFlags, section, row[1])
  }
  return { invocations, tableFlags, blockFlags }
}

/** Both directions, as sorted human-readable lines. Empty means the page and the program agree. */
function parity(cli: CAC, markdown: string): { undocumented: string[]; nonexistent: string[] } {
  const code = codeSurface(cli)
  const doc = docSurface(markdown)
  const undocumented: string[] = []
  const nonexistent: string[] = []

  for (const inv of code.invocations) if (!doc.invocations.has(inv)) undocumented.push(`tapflow ${inv}`)
  for (const inv of doc.invocations) if (!code.invocations.has(inv)) nonexistent.push(`tapflow ${inv}`)

  for (const [cmd, flags] of code.flags) {
    for (const flag of flags) {
      if (!doc.tableFlags.get(cmd)?.has(flag) && !doc.blockFlags.get(cmd)?.has(flag)) {
        undocumented.push(`tapflow ${cmd} ${flag}`)
      }
    }
  }
  for (const source of [doc.tableFlags, doc.blockFlags]) {
    for (const [cmd, flags] of source) {
      for (const flag of flags) {
        const known = code.flags.get(cmd)?.has(flag) || (code.globals.has(flag) && GLOBAL_ALLOWLIST.has(flag))
        if (!known) nonexistent.push(`tapflow ${cmd} ${flag}`)
      }
    }
  }
  for (const g of code.globals) if (!GLOBAL_ALLOWLIST.has(g)) undocumented.push(`tapflow ${g} (global)`)

  return { undocumented: [...new Set(undocumented)].sort(), nonexistent: [...new Set(nonexistent)].sort() }
}

describe.each(Object.entries(DOCS))('docs/%s cli.md matches the registered CLI', (_locale, file) => {
  const markdown = readFileSync(file, 'utf8')

  it('documents every command and flag, and nothing the CLI lacks', () => {
    const cli = createCli()
    // Floors, measured 2026-09-26, so an empty walk on either side cannot read as agreement: 16
    // invocations (14 commands, three of them split into subcommands) and 25 command flags; 26 since `flow run --no-record` (2026-10-11).
    const code = codeSurface(cli)
    expect(code.invocations.size).toBe(16)
    expect([...code.flags.values()].reduce((n, s) => n + s.size, 0)).toBe(26)
    expect(docSurface(markdown).invocations.size).toBe(16)

    expect(parity(cli, markdown)).toEqual({ undocumented: [], nonexistent: [] })
  })

  it('sees a flag added to the program and missing from the page', () => {
    const cli = createCli()
    cli.commands.find((c) => c.name === 'flow')!.option('--planted-flag', 'x')
    expect(parity(cli, markdown).undocumented).toEqual(['tapflow flow --planted-flag'])
  })

  it('sees a documented flag the program does not have', () => {
    const planted = markdown.replace(
      /^\| `--lines <n>`.*$/m,
      (row) => `${row}\n| \`--ghost-flag\` | — | x |`,
    )
    expect(planted).not.toBe(markdown)
    expect(parity(createCli(), planted).nonexistent).toEqual(['tapflow logs --ghost-flag'])
  })

  it('sees a table row removed, and a command block flag removed', () => {
    const noRow = markdown.replace(/^\| `--lines <n>`.*\n/m, '')
    expect(noRow).not.toBe(markdown)
    expect(parity(createCli(), noRow).undocumented).toEqual(['tapflow logs --lines'])

    // `--ignore-running-devices` is documented only by a fenced invocation — the path a table-only
    // parser would lose.
    const noBlock = markdown.replace(/^tapflow migrate net-filter --ignore-running-devices$/m, 'tapflow migrate net-filter')
    expect(noBlock).not.toBe(markdown)
    expect(parity(createCli(), noBlock).undocumented).toEqual(['tapflow migrate --ignore-running-devices'])
  })

  it('sees a command added, and a subcommand documented that the description no longer lists', () => {
    const cli = createCli()
    cli.command('planted', 'x')
    expect(parity(cli, markdown).undocumented).toEqual(['tapflow planted'])

    const shrunk = createCli()
    const migrate = shrunk.commands.find((c) => c.name === 'migrate')!
    migrate.description = migrate.description.replace('data-dir | ', '')
    expect(parity(shrunk, markdown).nonexistent).toEqual(['tapflow migrate data-dir'])
  })

  it('refuses a subcommand command that declares no subcommands, rather than skipping it', () => {
    const cli = createCli()
    cli.command('widget <subcommand>', 'no list here')
    expect(() => parity(cli, markdown)).toThrow(/lists none/)
  })
})
