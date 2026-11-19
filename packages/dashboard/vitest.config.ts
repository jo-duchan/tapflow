import { mergeConfig, defineConfig } from 'vitest/config'
import { defaultClientConditions } from 'vite'
import { reactWithCompiler } from './reactPlugin'
import path from 'path'
import { sourceFirst } from '../../vitest.shared'

// `sourceFirst`: this package's tests import a sibling, and must see its source rather than the
// last thing built of it. See vitest.shared.ts.
export default mergeConfig(sourceFirst, defineConfig({
  // The compiler runs here too: a suite that exercises uncompiled source is not testing what
  // ships, and the output differs — memoised callbacks, hoisted values, different identities.
  plugins: [reactWithCompiler()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
    // jsdom runs on vite's client resolution, not the SSR one `sourceFirst` sets, so without this every sibling import
    // here (flow-runner, protocol) loaded `dist` — measured with DEBUG=vite:resolve: `@tapflowio/flow-runner/browser ->
    // flow-runner/dist/browser.js`, and a flow-runner change passed or failed here by what was last built. `source`
    // prepended to vite's own conditions, as `vite.config.ts` does for `serve`, never replacing them (vitest.shared.ts
    // on `decimal.js`). scripts/__tests__/testsReadSource.test.mjs plants a marker in `dist` to prove it lands on source.
    conditions: ['source', ...defaultClientConditions],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
  },
}))
