import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ECSWorld, createTransform } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { createRecordingCanvas, installHeadlessCanvasDOM } from '../testing/recordingGL'
import { createFakeGlyphCanvas } from '../testing/fakeGlyphCanvas'
import { GlyphAtlas, TextLayer } from '../textLayer'
import { SpriteLayer } from '../spriteLayer'
import { createCamera2D } from '../components/camera2d'
import { createSprite } from '../components/sprite'

// MAX_INSTANCES (16384) x 19 floats x 4 bytes: the size of the entity batch.
const ENTITY_BATCH_BYTES = 16384 * 19 * 4

let uninstall: () => void
beforeAll(() => {
  uninstall = installHeadlessCanvasDOM()
})
afterAll(() => uninstall())

/** Every byte size passed to bufferData, in call order. */
function setup() {
  const canvas = createRecordingCanvas(400, 300)
  const gl = canvas.gl
  const sizes: number[] = []
  const bufferData = gl.bufferData.bind(gl)
  gl.bufferData = (target: number, data: number | ArrayBufferView | null, usage: number) => {
    sizes.push(typeof data === 'number' ? data : (data?.byteLength ?? 0))
    bufferData(target, data as never, usage)
  }
  const rs = new RenderSystem(canvas, new Map())
  const world = new ECSWorld()
  const cam = world.createEntity()
  world.addComponent(cam, createCamera2D({ x: 200, y: 150, zoom: 1 }))
  return { rs, world, sizes }
}

function textLayer(glyphsPerRun: number, runs: number): TextLayer {
  const fake = createFakeGlyphCanvas()
  const layer = new TextLayer({ atlas: new GlyphAtlas({ createCanvas: fake.createCanvas }), fontSize: 10 })
  const text = 'x'.repeat(glyphsPerRun)
  for (let i = 0; i < runs; i++) layer.add(text, (i % 40) * 10, Math.floor(i / 40) * 10 - 100, { anchorX: 0 })
  return layer
}

describe('entity batch buffer', () => {
  it('is not allocated for an app that only draws layers', () => {
    const { rs, world, sizes } = setup()
    const crowd = new SpriteLayer({ name: 'crowd' })
    for (let i = 0; i < 10; i++) crowd.add(i * 10, 0, 8, 8)
    rs.addSpriteLayer(crowd)
    rs.addTextLayer(textLayer(2, 5))
    rs.update(world, 1 / 60)
    expect(Math.max(0, ...sizes)).toBeLessThan(ENTITY_BATCH_BYTES)
  })

  it('is allocated on the first entity sprite and reused after that', () => {
    const { rs, world, sizes } = setup()
    const e = world.createEntity()
    world.addComponent(e, createTransform(10, 10))
    world.addComponent(e, createSprite({ width: 8, height: 8 }))
    rs.update(world, 1 / 60)
    expect(sizes.filter((s) => s === ENTITY_BATCH_BYTES)).toHaveLength(1)
    rs.update(world, 1 / 60)
    expect(sizes.filter((s) => s === ENTITY_BATCH_BYTES)).toHaveLength(1)
  })

  it('is allocated again after a context restore, on the next entity draw', () => {
    const { rs, world, sizes } = setup()
    const e = world.createEntity()
    world.addComponent(e, createTransform(10, 10))
    world.addComponent(e, createSprite({ width: 8, height: 8 }))
    rs.update(world, 1 / 60)
    // The handler the 'webglcontextrestored' listener calls.
    ;(rs as unknown as { onContextRestored: () => void }).onContextRestored()
    expect(sizes.filter((s) => s === ENTITY_BATCH_BYTES)).toHaveLength(1)
    rs.update(world, 1 / 60)
    expect(sizes.filter((s) => s === ENTITY_BATCH_BYTES)).toHaveLength(2)
  })
})

describe('text batch buffer', () => {
  it('grows to the frame glyph count in power-of-two steps, not to MAX_BATCH', () => {
    const { rs, world, sizes } = setup()
    rs.addTextLayer(textLayer(1, 3))
    rs.update(world, 1 / 60)
    // Three one-glyph runs: 256 glyphs x 14 floats x 4 bytes.
    expect(Math.max(...sizes)).toBe(256 * 14 * 4)
  })

  it('still draws every glyph when the frame exceeds one step', () => {
    const { rs, world, sizes } = setup()
    rs.addTextLayer(textLayer(4, 300)) // 1,200 glyphs, all on screen with a wide camera
    world.getComponent<{ zoom: number }>(world.queryOne('Camera2D')!, 'Camera2D')!.zoom = 0.1
    rs.update(world, 1 / 60)
    expect(Math.max(...sizes)).toBe(2048 * 14 * 4)
    const draws = rs.stats.layers.find((l) => l.kind === 'text')!
    expect(draws.instances).toBe(1200)
  })
})
