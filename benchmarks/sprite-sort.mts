import { performance } from 'node:perf_hooks'
import { SpriteLayer } from '../packages/renderer/src/spriteLayer.ts'

const args = process.argv.slice(2).filter((arg) => arg !== '--')
const count = Number(args[0] ?? 3000)
const frames = Number(args[1] ?? 1000)
const changed = Math.min(Number(args[2] ?? 32), count)
const layer = new SpriteLayer({ capacity: count, sortByKey: true })
for (let i = 0; i < count; i++) {
  layer.add(i, 0, 1, 1)
  layer.sortKey[i] = i
}
layer.drawOrder()

const baselineOrder = Int32Array.from({ length: count }, (_, i) => i)
const baselineKeys = new Float64Array(count)
for (let i = 0; i < count; i++) baselineKeys[i] = i

function measure(fn: () => void): number {
  for (let i = 0; i < 100; i++) fn()
  const samples: number[] = []
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    for (let frame = 0; frame < frames; frame++) fn()
    samples.push(((performance.now() - start) * 1000) / frames)
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}

// the key wobbles by `swing`: 0.1 never passes a neighbour (integer keys), 1.6 reorders a few neighbours every frame
function scenario(swing: number) {
  let tick = 0
  const fullSortUs = measure(() => {
    tick++
    for (let i = 0; i < changed; i++) baselineKeys[i] = i + Math.sin(tick + i) * swing
    baselineOrder.sort((a, b) => baselineKeys[a] - baselineKeys[b] || a - b)
  })
  tick = 0
  const retainedUs = measure(() => {
    tick++
    for (let i = 0; i < changed; i++) layer.sortKey[i] = i + Math.sin(tick + i) * swing
    layer.touchRange(0, changed - 1)
    layer.drawOrder()
  })
  return { fullSortUs, retainedUs }
}
const still = scenario(0.1)
const reordering = scenario(1.6)

const cachedUs = measure(() => {
  layer.drawOrder()
})

console.log(`sorted sprites: ${count}; changed keys/frame: ${changed}; frames/run: ${frames}; median of 5 runs`)
for (const [name, r] of [
  ['keys keep their order', still],
  ['keys reorder neighbours', reordering],
] as const) {
  console.log(
    `${name}: full sort ${r.fullSortUs.toFixed(2)} µs/frame; touched-order fix-up ${r.retainedUs.toFixed(2)} µs/frame (${(r.fullSortUs / r.retainedUs).toFixed(1)}x)`,
  )
}
console.log(`unchanged cached order: ${cachedUs.toFixed(3)} µs/frame`)
