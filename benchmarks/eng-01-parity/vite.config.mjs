import { defineConfig } from 'vite'
import path from 'node:path'

const target = process.env.XIP_PARITY_RENDER
if (!target) throw new Error('set XIP_PARITY_RENDER to the package render.js entry')

export default defineConfig({
  root: path.dirname(new URL(import.meta.url).pathname),
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [{ find: /^xipjs\/render$/, replacement: target }], dedupe: ['react', 'react-dom'] },
})
