import { describe, it, expect } from 'vitest'
import { transformSync } from '@babel/core'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/**
 * **No function in this package is skipped by the compiler because somebody silenced a lint rule.**
 *
 * `babel-plugin-react-compiler` refuses to compile a function that carries a suppression for one of
 * two rules, and it does so *silently* — a skipped function still works, just unmemoised. That is
 * how both device viewers compiled nothing until #830, with every test green.
 *
 * **The bundle cannot hold this.** `dashboardFirstLoadBudget.test.mjs` asserts the compiler ran, by
 * finding `react.memo_cache_sentinel` in the built entry chunk — but a suppression added to one
 * component removes that component's share of 161 sentinels and leaves the rest. Measured today:
 * the streaming surface carries 73 of them in a chunk the entry assertion never opens, so a
 * threshold there would be a proxy for this and a bad one. This asks the compiler directly.
 *
 * The check is the skip *reason*, not a count. A skip for syntax the compiler cannot lower yet is
 * fine and there are 14 of them; a skip for a suppression is a choice someone made, and this is
 * where they find out what it cost.
 */

const PKG = join(import.meta.dirname, '..', '..')
const ROOTS = ['src', 'components', 'hooks', 'lib']

/**
 * The two rules the compiler bails on, from its own `DEFAULT_ESLINT_SUPPRESSIONS`. Named here so
 * the failure message can say which suppressions to look for — the plugin's message quotes the
 * line it found, so this list is for the reader rather than for the matching.
 */
const BAILING_RULES = ['react-hooks/exhaustive-deps', 'react-hooks/rules-of-hooks']

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') sourceFiles(p, out) }
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

interface Event { kind: string; fnName?: string; detail?: { reason?: string; description?: string } }

function census() {
  const compiled: string[] = []
  const suppressed: string[] = []
  const otherSkips: string[] = []

  for (const root of ROOTS) {
    for (const file of sourceFiles(join(PKG, root))) {
      const events: Event[] = []
      transformSync(readFileSync(file, 'utf8'), {
        filename: file, babelrc: false, configFile: false,
        // `jsx` only for `.tsx`. On a `.ts` file it makes `<T>(x) => …` ambiguous and the parser
        // reads the generic as an unclosed element — `lib/api.ts` fails to parse with it on.
        parserOpts: { plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] },
        plugins: [['babel-plugin-react-compiler', {
          logger: { logEvent: (_f: unknown, e: Event) => events.push(e) },
        }]],
      })
      const rel = file.slice(PKG.length + 1)
      for (const e of events) {
        if (e.kind === 'CompileSuccess') { compiled.push(`${rel}:${e.fnName ?? '?'}`); continue }
        const why = e.detail?.reason ?? e.detail?.description ?? e.kind
        ;(/ESLint rules were disabled|Found suppression/.test(why) ? suppressed : otherSkips)
          .push(`${rel}: ${why.split('\n')[0].slice(0, 100)}`)
      }
    }
  }
  return { compiled, suppressed, otherSkips }
}

const result = census()

describe('the React Compiler is not being switched off a function at a time', () => {
  it('asks the same Babel the build asks', () => {
    // **The census is only evidence if it runs the compiler the build runs.** `@babel/core` is a
    // devDependency here *and* a dependency of `@vitejs/plugin-react`, and the two are the same
    // install only while their ranges agree — measured, 8.0.6 and 7.29.7 disagree about whether
    // `AndroidViewer` compiles, so a drift between them would have this file reporting on a
    // toolchain nothing ships.
    //
    // Comparing resolved paths rather than pinning exact versions: pinning two packages would be a
    // rule nothing enforces, while this fails the moment pnpm gives the plugin a different copy.
    const here = createRequire(join(import.meta.dirname, '..', '..', 'package.json'))
    const plugin = createRequire(here.resolve('@vitejs/plugin-react'))
    expect(
      here.resolve('@babel/core'),
      'this test and the vite react plugin resolved different copies of @babel/core',
    ).toBe(plugin.resolve('@babel/core'))
  })

  it('skips nothing because of an eslint suppression', () => {
    expect(
      result.suppressed,
      `These functions are not compiled because a lint rule is suppressed inside them.\n` +
      `Only ${BAILING_RULES.join(' and ')} do this; every other react-hooks rule is free.\n` +
      `Move the suppression out of the component, or fix what it silences.\n\n` +
      result.suppressed.join('\n'),
    ).toEqual([])
  })

  it('still compiles the surfaces a tester spends the session on', () => {
    // A whole-package count would drift with every page added. These are the streaming path, the two
    // files #830 was about and the device screen they share with the watch page, named so that losing
    // one of them says which.
    const files = new Set(result.compiled.map((c) => c.split(':')[0]))
    for (const f of [
      'components/device/AndroidViewer.tsx',
      'components/device/IOSViewer.tsx',
      'components/device/AndroidDeviceScreen.tsx',
      'components/device/IOSDeviceScreen.tsx',
      'hooks/useAndroidScreen.ts',
      'hooks/useIOSScreen.ts',
      'src/pages/QASession.tsx',
    ]) {
      expect(files, `${f} compiles no functions at all`).toContain(f)
    }
  })

  it('compiles most of the package, so an empty census cannot read as success', () => {
    // Anti-vacuity: a census that walked nothing, or a plugin that silently stopped loading, gives
    // zero suppressed skips and passes the first test. 158 compiled on 2026-09-22.
    expect(result.compiled.length).toBeGreaterThan(120)
  })
})
