import { mergeConfig, defineConfig } from 'vitest/config'
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
    // jsdom runs on vite's client resolution, not the SSR one `sourceFirst` sets, so without this every flow-runner
    // import here loaded `dist` — measured with DEBUG=vite:resolve: `@tapflowio/flow-runner/browser ->
    // flow-runner/dist/browser.js`, and a flow-runner change passed or failed here by what was last built. `source`
    // prepended to vite's own `defaultClientConditions`, never replacing them (see vitest.shared.ts on `decimal.js`);
    // scripts/__tests__/testsReadSource.test.mjs holds the list to vite's and plants a marker to prove it lands.
    conditions: ['source', 'module', 'browser', 'development|production'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
  },
}))
