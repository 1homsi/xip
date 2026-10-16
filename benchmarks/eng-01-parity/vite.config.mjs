import { defineConfig } from 'vite'
import path from 'node:path'

const target = process.env.XIP_PARITY_RENDER
if (!target) throw new Error('set XIP_PARITY_RENDER to the package render.js entry')
const dist = path.dirname(target)

export default defineConfig({
  root: path.dirname(new URL(import.meta.url).pathname),
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      { find: /^xipjs\/render$/, replacement: target },
      // Engine-internal components that are not on the render entry (the SDF shapes). They
      // import the same ../context.js as render.js, so they share the engine's React context.
      { find: /^xip-shapes\/(.+)$/, replacement: `${path.join(dist, 'components')}/$1.js` },
    ],
    dedupe: ['react', 'react-dom'],
  },
})
