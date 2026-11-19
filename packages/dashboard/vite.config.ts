import { defineConfig, defaultClientConditions } from 'vite'
import { reactWithCompiler } from './reactPlugin'
import { compression } from 'vite-plugin-compression2'
import path from 'path'

export default defineConfig(({ command }) => ({
  plugins: [
    // **The React Compiler memoises for us, so the hand-written memoisation can stop growing.**
    // This package has 62 `useCallback` and 3 `useMemo` against **zero** `memo()` components —
    // most of that is stabilising effect dependencies, which the compiler does without being asked.
    //
    // Enabled only after the linter agreed. `eslint-plugin-react-hooks@7`'s recommended set carries
    // the compiler's own diagnostics (`refs`, `purity`, `immutability`, `globals`,
    // `set-state-in-render`, `static-components` among its 16 rules), it has been on in
    // `eslint.config.mjs` all along, and it reports no errors. It caught a `useRef` written during
    // render while #828 was being written, which is the evidence that it bites rather than
    // decorates.
    //
    // All 16 are on. `react-hooks/set-state-in-effect` was the last, off over 15 violations until
    // #845 cleared them, so a clean lint here now says every diagnostic in the set passes. Neither
    // of the two rules that actually gate compilation is among them.
    //
    // A file the compiler cannot prove safe is skipped, not miscompiled; `--verbose` on a build
    // prints which.
    reactWithCompiler(),
    // Precompress text assets to .br at build time (brotli only) so the relay serves them with no runtime CPU.
    compression({ include: /\.(js|css|html|svg|json)$/, algorithms: ['brotliCompress', 'gzip'], deleteOriginalAssets: false }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
    // `pnpm dev` loads sibling packages from source, so the Flow Capture dialog works on a fresh
    // checkout and picks up a flow-runner edit without a rebuild. A build keeps reading `dist`,
    // which CI and both Dockerfiles build first. `source` is prepended to vite's own conditions,
    // never replacing them — the same rule as `vitest.shared.ts`.
    ...(command === 'serve' ? { conditions: ['source', ...defaultClientConditions] } : {}),
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Only split families the app shell already loads synchronously, plus charts.
        // Grouping @radix-ui / react-hook-form here was measured and reverted: it turned
        // lazy dialog and form code into modulepreloads, adding ~14 kB Brotli to first paint.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined

          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react'
          }

          if (id.includes('/react-router/') || id.includes('/react-router-dom/')) {
            return 'vendor-router'
          }

          if (id.includes('/@visx/') || id.includes('/d3-array/')) {
            return 'vendor-charts'
          }

          return undefined
        },
      },
    },
  },
  // ESM worker (tinyh264.worker imports tinyh264) — 'es' format so the worker chunk
  // can code-split its static imports. Default 'iife' breaks on code-split workers.
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
    },
  },
}))
