import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const out = join(dir, '.out')
mkdirSync(out, { recursive: true })
const bundle = join(out, 'sprite-sort.mjs')
await build({
  entryPoints: [join(dir, 'sprite-sort.mts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundle,
})
const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
