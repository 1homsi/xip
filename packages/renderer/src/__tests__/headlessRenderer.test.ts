import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ECSWorld, createTransform } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { createSprite } from '../components/sprite'
import { createText } from '../components/text'
import { createRecordingCanvas, installHeadlessCanvasDOM } from '../testing/recordingGL'

let uninstall: () => void
beforeAll(() => {
  uninstall = installHeadlessCanvasDOM()
})
afterAll(() => uninstall())

function setup(captureInstances = true) {
  const canvas = createRecordingCanvas(800, 600, { captureInstances })
  const rs = new RenderSystem(canvas, new Map())
  const world = new ECSWorld()
  return { canvas, gl: canvas.gl, rs, world }
}

function addSprite(world: ECSWorld, x: number, y: number, opts: Parameters<typeof createSprite>[0]) {
  const e = world.createEntity()
  world.addComponent(e, createTransform(x, y))
  world.addComponent(e, createSprite(opts))
  return e
}

describe('headless recording renderer', () => {
  it('records one instanced draw with sprite transforms and colors', () => {
    const { gl, rs, world } = setup()
    addSprite(world, 10, 20, { width: 16, height: 8, color: '#ff0000' })
    addSprite(world, -30, 40, { width: 4, height: 4, color: '#ff0000', zIndex: 1 })
    rs.update(world, 1 / 60)

    const instanced = gl.draws.filter((d) => d.kind === 'instanced')
    expect(instanced).toHaveLength(1)
    expect(instanced[0]).toMatchObject({ mode: gl.TRIANGLE_STRIP, vertices: 4 })
    const inst = gl.frameInstances()
    expect(inst).toHaveLength(2)
    expect(inst[0]).toMatchObject({ x: 10, y: 20, width: 16, height: 8, r: 1, g: 0, b: 0, a: 1 })
    expect(inst[1]).toMatchObject({ x: -30, y: 40, width: 4, height: 4 })

    expect(rs.stats.drawCalls).toBe(1)
    expect(rs.stats.batches).toBe(1)
    expect(rs.stats.instances).toBe(2)
    expect(rs.stats.spritesConsidered).toBe(2)
  })

  it('splits batches by color key and culls sprites outside the camera', () => {
    const { gl, rs, world } = setup(false)
    addSprite(world, 0, 0, { width: 10, height: 10, color: '#ff0000' })
    addSprite(world, 5, 5, { width: 10, height: 10, color: '#00ff00' })
    addSprite(world, 50_000, 0, { width: 10, height: 10, color: '#00ff00' })
    rs.update(world, 1 / 60)
    expect(gl.draws.filter((d) => d.kind === 'instanced').map((d) => d.count)).toEqual([1, 1])
    expect(rs.stats.spritesCulled).toBe(1)
    expect(rs.stats.instances).toBe(2)
  })

  it('resets per-frame counters every frame and tracks text cache hits (canvas-path text)', () => {
    const { rs, world } = setup(false)
    addSprite(world, 0, 0, { width: 10, height: 10 })
    const t = world.createEntity()
    world.addComponent(t, createTransform(0, 0))
    // Complex scripts use per-entity textures; plain text batches through the glyph atlas.
    world.addComponent(t, createText({ text: 'مرحبا' }))
    rs.update(world, 1 / 60)
    const draws1 = rs.stats.drawCalls
    const texBytes = rs.stats.textureBytes
    rs.update(world, 1 / 60)
    expect(rs.stats.drawCalls).toBe(draws1)
    expect(rs.stats.textCacheMisses).toBe(1)
    expect(rs.stats.textCacheHits).toBe(1)
    expect(rs.stats.textureBytes).toBe(texBytes)
    expect(rs.stats.textureCount).toBeGreaterThan(0)
    expect(rs.stats.frames).toBe(2)
  })

  it('counts dynamic canvas uploads and texture memory', () => {
    const { rs, world } = setup(false)
    const big = createRecordingCanvas(512, 256)
    const before = rs.stats.textureBytes
    rs.registerDynamicCanvas('map', big)
    expect(rs.stats.textureBytes - before).toBe(512 * 256 * 4)
    addSprite(world, 0, 0, { width: 512, height: 256, dynamicSrc: 'map' })
    rs.markDynamicCanvasDirty('map')
    rs.update(world, 1 / 60)
    expect(rs.stats.textureUploads).toBe(1)
    expect(rs.stats.textureUploadBytes).toBe(512 * 256 * 4)
    rs.update(world, 1 / 60)
    expect(rs.stats.textureUploads).toBe(0)
    rs.unregisterDynamicCanvas('map')
    expect(rs.stats.textureBytes).toBe(before)
  })
})
