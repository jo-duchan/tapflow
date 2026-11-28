import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

const commonRules = {
  // A file that does not end in a newline costs the *next* commit rather than this one: appending a
  // line shows the unchanged closing brace as removed and re-added, and hands its blame to whoever
  // made that later edit. Added when every file already complied, so it enforces the convention
  // rather than starting a reformat — two files had drifted in an in-flight PR, which is what
  // showed there was nothing holding it.
  //
  // **It reaches 522 of the 539 files `git ls-files` reports**, and the gap is worth knowing rather
  // than closing here. One of the seventeen is the deliberate `typeAssertions.ts` exclusion above.
  // The other sixteen are nobody's decision: `playground/` and `docs/` have no `lint` script; each
  // package lints `src` only, so the `vitest.config.ts` files and `vitest.shared.ts` sit outside;
  // and the `**/*.mjs` ignore catches `postcss.config.mjs`, one agent script, and **this file** —
  // `!scripts/**` is anchored at the root, so it never reaches `packages/*/scripts/`. All seventeen
  // comply today, and nothing holds them there.
  //
  // Deprecated in core since 8.53 and **removed in 11.0.0**, which is the next major rather than a
  // distant one — the version is in the rule's own metadata. ESLint does report the use, in
  // `usedDeprecatedRules`; the stylish formatter this repo runs simply does not print it, so a
  // quiet `pnpm lint` is not evidence the rule is current. The migration is the `@stylistic/eol-last`
  // rule, which comes from the `@stylistic/eslint-plugin` package — a whole plugin as a new
  // dependency for one rule, and not worth adding before the upgrade needs it.
  'eol-last': ['error', 'always'],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
}

// A selector, not a rule of our own, and it knows nothing about function boundaries: a `fetch`
// in an event handler *registered* by an effect is flagged too. None exists today; one that
// appears takes a suppression with its reason, and the day there are several is the day for a
// rule that walks to the nearest function. It sees the call only where it is written: a fetch
// wrapped in a `useCallback` that the effect calls passes — CommentPanel's `load()` did, and was
// moved to Query when the review of this rule found it. So do `window.fetch` and a renamed `api`.
const effectFetchSelectors = ['useEffect', 'useLayoutEffect'].flatMap((hook) =>
  // `useEffect(...)` and `React.useEffect(...)`, the form the shadcn primitives use.
  [`[callee.name='${hook}']`, `[callee.property.name='${hook}']`].flatMap((effect) => [
    {
      selector: `CallExpression${effect} CallExpression[callee.name='fetch']`,
      message: `Read server data with TanStack Query (useQuery), not fetch inside ${hook}. See packages/dashboard/AGENTS.md.`,
    },
    {
      selector: `CallExpression${effect} CallExpression[callee.object.name='api']`,
      message: `Read server data with TanStack Query (useQuery), not api.* inside ${hook}. See packages/dashboard/AGENTS.md.`,
    },
  ]))

// **A test sits inside a `describe` named for the behaviour it holds.** Nearly every test file already
// did, and nothing said so; #1261 added another lone top-level `it`. A call to `it`/`test` in any form
// (`.skip`, `.only`, `.each()()`, a tagged `.each`) is flagged unless some `describe` or `suite` call
// encloses it, so a top-level `for` or `if` around a test is caught too: correlatedRequestsGated hid
// one that way. Hooks are not matched: a file-wide `beforeEach` at the top is a legitimate shape, and
// dozens of files use one, which is why `vitest/require-top-level-describe` (it flags hooks too) is not
// used. Out of reach: an `it` imported under another name, a `test.extend()` fixture, and an `it`
// inside a top-level helper that a describe calls (flagged, though it runs inside one). None exists.
// Every callee shape a test or suite call takes, for either side alike: `x()`, up to three modifiers
// (`x.concurrent.skip()`), and an `.each` called as a factory (`x.each([])()`) or as a tag
// (`x.each\`\`()`), each with modifiers too. One list for both sides, so a form recognised for tests
// is recognised for suites as well and neither drifts from the other.
const calledAs = (names) => ['callee.name', ...['callee', 'callee.callee', 'callee.tag'].flatMap((base) =>
  [1, 2, 3].map((depth) => `${base}${'.object'.repeat(depth)}.name`))]
  .map((path) => `[${path}=/^(${names})$/]`).join(', ')
const topLevelTestSelector = {
  selector: `CallExpression:matches(${calledAs('it|test')}):not(CallExpression:matches(${calledAs('describe|suite')}) *)`,
  message: 'Put the test inside a describe() named for the behaviour it checks, as the rest of the suite does.',
}

export default tseslint.config(
  // `!scripts/**` re-includes: a global ignore cannot be undone by a later `files` entry, so the
  // negation has to live here.
  // `typeAssertions.ts` is deliberately outside the protocol package's build tsconfig (it declares
  // values and must not reach `dist`), which puts it outside the typed-lint project service too.
  // It is type-checked by `tsconfig.assertions.json`, which is the only check that file needs.
  // `__tests__` is no longer ignored (#422). It was, and the two exclusions compounded: nothing typed
  // the test tree and nothing linted it, so a double could drift from the interface it doubled with
  // both gates green. Typed lint needs the files in a tsconfig to say anything at all, which is why
  // `src/__tests__/tsconfig.json` had to land first — with the tree outside every project, every rule here
  // failed as a parse error rather than reporting.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.mjs', '**/*.cjs', 'packages/protocol/src/typeAssertions.ts', '!scripts/**'] },

  // Repo tooling under scripts/ is .mjs, which the blanket ignore above covers. It is opted back
  // in because `dev-down` sends SIGKILL to processes it selects — the most destructive code in
  // the repo should not also be the only code nothing checks.
  {
    files: ['scripts/**/*.mjs'],
    ignores: [],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: globals.node, sourceType: 'module' },
    rules: commonRules,
  },

  // Node.js packages — .ts files (excludes dashboard)
  {
    files: ['**/*.ts'],
    ignores: ['packages/dashboard/**'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true },
    },
    rules: {
      ...commonRules,
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // Dashboard — .ts/.tsx files
  {
    files: ['packages/dashboard/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...commonRules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // **Server data is read with TanStack Query, not fetched in an effect** (packages/dashboard/
      // AGENTS.md). `set-state-in-effect` cannot hold that line: it does not see `setState` inside
      // `.then()`, which is how an effect fetch writes. So the call itself is flagged.
      'no-restricted-syntax': ['error', ...effectFetchSelectors],
      // **Toasts mount through the shadcn wrapper** (`components/ui/sonner.tsx`), so the toast's look lives in the
      // design system's one place. App.tsx imported sonner's `Toaster` directly for months, and the wrapper's icons,
      // colors and shadow never reached the screen while the spec and the Figma file were drawn from them.
      // `toast()` itself still comes from 'sonner', as shadcn's docs do it.
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'sonner',
          importNames: ['Toaster'],
          message: "Mount the shadcn wrapper: import { Toaster } from '@/components/ui/sonner'.",
        }],
      }],
    },
  },

  // Tests. `no-restricted-syntax` is replaced, not merged, by a later block, so the dashboard's
  // tests restate its effect-fetch selectors beside the test one rather than losing them.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**/*.test.mjs'],
    ignores: ['packages/dashboard/**'],
    rules: { 'no-restricted-syntax': ['error', topLevelTestSelector] },
  },
  {
    files: ['packages/dashboard/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...effectFetchSelectors, topLevelTestSelector] },
  },

  // The wrapper is the one file that mounts sonner's own Toaster.
  {
    files: ['packages/dashboard/components/ui/sonner.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // shadcn primitives are generated and re-synced from upstream, and their convention is to export
  // a `*Variants` helper next to the component. That trips the Fast Refresh hint in five files for a
  // structure we do not own and would have to re-fix on every upstream sync. Only that hint is
  // waived — every correctness rule still applies here, which is what caught the `Math.random()`
  // during render in sidebar.tsx.
  //
  // The scope is the directory, not the file's origin, and `ui/` also holds a few of our own
  // components (`search-input`, `tech-label`). They export a single component today so the rule
  // would not fire on them anyway — but the cost of this shortcut is that adding a hand-written
  // file here that exports a component *and* a helper loses the hint silently. Put such a file in
  // `components/` rather than `components/ui/`.
  {
    files: ['packages/dashboard/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
)
