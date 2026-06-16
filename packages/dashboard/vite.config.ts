import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { compression } from 'vite-plugin-compression2'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    // Precompress text assets at build time so the relay can serve .br
    // straight from disk (no runtime compression — keeps CPU off the stream path).
    // Brotli only: it's the static-asset standard (smaller, broadly supported);
    // clients without br get the uncompressed original, so a .gz sibling would
    // just bloat the package for a near-nonexistent audience.
    compression({ include: /\.(js|css|html|svg|json)$/, algorithms: ['brotliCompress'], deleteOriginalAssets: false }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  build: {
    outDir: 'dist',
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
})
