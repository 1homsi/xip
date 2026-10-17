import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ECSWorld, copyEngineStats, createEngineStats } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { SpriteLayer } from '../spriteLayer'
import { TileLayerData, createTileLayerComponent } from '../tileLayer'
import { createRecordingCanvas, installHeadlessCanvasDOM, type RecordingGLOptions } from '../testing/recordingGL'

let uninstall: () => void
beforeAll(() => {
  uninstall = installHeadlessCanvasDOM()
})
afterAll(() => uninstall())

function setup(opts: RecordingGLOptions = {}) {
  const canvas = createRecordingCanvas(800, 600, opts)
  const rs = new RenderSystem(canvas, new Map())
  return { gl: canvas.gl, rs, world: new ECSWorld() }
}

function tileLayer(opts: Partial<ConstructorParameters<typeof TileLayerData>[0]> = {}) {
  return new TileLayerData({
    width: 64,
    height: 64,
    tileset: {
      image: { width: 64, height: 64 } as unknown as HTMLCanvasElement,
      tileWidth: 16,
      tileHeight: 16,
      columns: 4,
    },
    ...opts,
  })
}

describe('per-layer stats and TileLayer textures', () => {
  it('lists tile then sprite layers with draws, instances and upload bytes', () => {
    const { rs, world } = setup()
    const tiles = tileLayer({ name: 'ground', zIndex: -1 })
    tiles.fill(1)
    world.addComponent(world.createEntity(), createTileLayerComponent(tiles))
    const crowd = new SpriteLayer({ name: 'crowd', zIndex: 2 })
    for (let i = 0; i < 3; i++) crowd.add(10 + i * 20, 10, 8, 8)
    rs.addSpriteLayer(crowd)
    const unnamed = new SpriteLayer({ name: 'fx', zIndex: 3 })
    unnamed.add(0, 0, 4, 4)
    rs.addSpriteLayer(unnamed)

    rs.update(world, 1 / 60)
    const [t, c, u] = rs.stats.layers
    expect(t).toMatchObject({ kind: 'tile', name: 'ground', zIndex: -1, drawCalls: 1 })
    expect(t.instances).toBeGreaterThan(0)
    expect(t.uploadBytes).toBe(64 * 64 * 2 + 64 * 64 * 4) // index page + atlas image
    expect(c).toMatchObject({
      kind: 'sprite',
      name: 'crowd',
      zIndex: 2,
      instances: 3,
      drawCalls: 1,
      uploadBytes: 3 * 84, // 21 floats per instance
    })
    expect(u.name).toBe('fx')
    expect(rs.stats.layers).toHaveLength(3)

    // Rows are rebuilt each frame (and stay allocation-stable).
    rs.update(world, 1 / 60)
    expect(rs.stats.layers[0]).toBe(t)
    expect(rs.stats.layers[0].uploadBytes).toBe(0)
    expect(rs.stats.layers[1].uploadBytes).toBe(0) // instances are retained between frames
    crowd.x[1] += 1
    crowd.touchRange(1)
    rs.update(world, 1 / 60)
    expect(rs.stats.layers[1].uploadBytes).toBe(84) // only the changed instance is uploaded
  })

  it('names unnamed tile layers by draw order', () => {
    const { rs, world } = setup()
    for (const z of [5, 1]) world.addComponent(world.createEntity(), createTileLayerComponent(tileLayer({ zIndex: z })))
    rs.update(world, 1 / 60)
    expect(rs.stats.layers.map((l) => [l.name, l.zIndex])).toEqual([
      ['tiles0', 1],
      ['tiles1', 5],
    ])
  })

  it('counts tile textures and uploads in the render totals', () => {
    const base = setup()
    base.rs.update(base.world, 1 / 60)
    const b = base.rs.stats

    const { rs, world } = setup()
    const tiles = tileLayer({ tinted: true })
    tiles.fill(1)
    const e = world.createEntity()
    world.addComponent(e, createTileLayerComponent(tiles))
    rs.update(world, 1 / 60)
    const s = rs.stats
    // index page (u16), tint page (rgba8) and the atlas image
    const bytes = 64 * 64 * 2 + 64 * 64 * 4 + 64 * 64 * 4
    expect(s.tile.textureCount).toBe(3)
    expect(s.tile.textureBytes).toBe(bytes)
    expect(s.textureCount).toBe(b.textureCount + 3)
    expect(s.textureBytes).toBe(b.textureBytes + bytes)
    expect(s.textureUploads).toBe(b.textureUploads + 3)
    expect(s.textureUploadBytes).toBe(b.textureUploadBytes + bytes)
    expect(rs.tileLayerStats.textureUploadBytes).toBe(bytes)

    // Steady state: textures stay counted, uploads are per frame.
    rs.update(world, 1 / 60)
    expect(s.textureCount).toBe(b.textureCount + 3)
    expect(s.textureBytes).toBe(b.textureBytes + bytes)
    expect(s.textureUploads).toBe(b.textureUploads)

    // A tint edit uploads just its chunk.
    tiles.setTint(1, 1, 0xff0000ff)
    rs.update(world, 1 / 60)
    expect(s.tile.textureUploads).toBeGreaterThanOrEqual(1)
    expect(s.textureUploadBytes).toBe(b.textureUploadBytes + s.tile.textureUploadBytes)
    expect(s.layers[0].uploadBytes).toBe(s.tile.textureUploadBytes)

    // Removing the layer frees its textures.
    world.destroyEntity(e)
    rs.update(world, 1 / 60)
    expect(s.tile.textureCount).toBe(0)
    expect(s.textureCount).toBe(b.textureCount)
    expect(s.textureBytes).toBe(b.textureBytes)
    expect(s.layers).toHaveLength(0)
  })

  it('counts lookup-table textures (variant picks live in the index, no table)', () => {
    const { rs, world } = setup()
    const tiles = tileLayer({ variants: { 1: [1, 2] }, animations: { 3: { frames: [3, 4], duration: 0.25 } } })
    tiles.fill(1)
    world.addComponent(world.createEntity(), createTileLayerComponent(tiles))
    rs.update(world, 1 / 60)
    // index page (u16) + atlas + LUT (4 u32)
    expect(rs.stats.tile.textureCount).toBe(3)
    expect(rs.stats.tile.textureBytes).toBe(64 * 64 * 2 + 64 * 64 * 4 + 16)
    expect(rs.stats.tile.textureUploadBytes).toBe(rs.stats.tile.textureBytes)
    expect(rs.stats.tile.lutUploads).toBe(1)
  })

  it('drops tile texture accounting on context restore', () => {
    const { gl, rs, world } = setup()
    const tiles = tileLayer()
    tiles.fill(1)
    world.addComponent(world.createEntity(), createTileLayerComponent(tiles))
    rs.update(world, 1 / 60)
    expect(rs.stats.tile.textureCount).toBe(2)
    gl.contextLost = true
    rs.update(world, 1 / 60)
    gl.contextLost = false
    rs.update(world, 1 / 60)
    // restored: the layer re-uploads into fresh textures and is counted once
    expect(rs.stats.tile.textureCount).toBe(2)
    expect(rs.stats.tile.textureBytes).toBe(64 * 64 * 2 + 64 * 64 * 4)
  })

  it('copyEngineStats deep-copies layers and tile stats', () => {
    const { rs, world } = setup()
    const tiles = tileLayer({ name: 'a' })
    tiles.fill(1)
    world.addComponent(world.createEntity(), createTileLayerComponent(tiles))
    rs.update(world, 1 / 60)
    const live = createEngineStats(rs.stats)
    expect(live.layers).toBe(rs.stats.layers)
    expect(live.tileLayerStats).toBe(rs.stats.tile)
    const copy = copyEngineStats(live)
    expect(copy.layers).toEqual(live.layers)
    expect(copy.layers).not.toBe(live.layers)
    expect(copy.layers[0]).not.toBe(live.layers[0])
    expect(copy.tileLayerStats).toEqual(live.tileLayerStats)
    const before = copy.layers[0].drawCalls
    live.layers[0].drawCalls = 99
    live.tileLayerStats.drawCalls = 99
    expect(copy.layers[0].drawCalls).toBe(before)
    expect(copy.tileLayerStats.drawCalls).not.toBe(99)
    // reusing an out object keeps its identity
    const again = copyEngineStats(live, copy)
    expect(again).toBe(copy)
    expect(again.layers).toBe(copy.render.layers)
  })
})

describe('GPU timing', () => {
  it('is off by default and does not touch the timer API', () => {
    const { gl, rs, world } = setup({ timerQuery: true })
    for (let i = 0; i < 5; i++) rs.update(world, 1 / 60)
    expect(gl.queryOps).toBe(0)
    expect(rs.stats.gpuMs).toBeNull()
    expect(rs.stats.gpuMsAvg).toBeNull()
    expect(rs.stats.gpuTimerSupported).toBeNull()
  })

  it('reads results a few frames late without blocking, then smooths', async () => {
    const { gl, rs, world } = setup({ timerQuery: { latency: 2, ns: 4e6 } })
    await expect(rs.setGpuTiming(true)).resolves.toBe(true)
    expect(rs.stats.gpuTimerSupported).toBe(true)
    rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBeNull() // not ready yet
    rs.update(world, 1 / 60)
    rs.update(world, 1 / 60)
    rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBe(4)
    expect(rs.stats.gpuMsAvg).toBe(4)
    gl.timerNs = 14e6
    for (let i = 0; i < 6; i++) rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBe(14)
    expect(rs.stats.gpuMsAvg).toBeGreaterThan(4)
    expect(rs.stats.gpuMsAvg).toBeLessThan(14)
    // The ring never runs out even when the GPU is slow: one query per frame at most.
    expect(gl.queries.length).toBeLessThanOrEqual(6)
  })

  it('skips samples instead of stalling when the GPU falls behind', async () => {
    const { gl, rs, world } = setup({ timerQuery: { latency: 1000 } })
    await rs.setGpuTiming(true)
    for (let i = 0; i < 20; i++) rs.update(world, 1 / 60)
    expect(gl.queries.length).toBe(6)
    expect(rs.stats.gpuMs).toBeNull()
  })

  it('discards results after a disjoint event', async () => {
    const { gl, rs, world } = setup({ timerQuery: { latency: 0, ns: 3e6 } })
    await rs.setGpuTiming(true)
    rs.update(world, 1 / 60)
    rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBe(3)
    gl.timerNs = 99e6
    rs.update(world, 1 / 60) // submits a 99ms query
    gl.disjoint = true
    rs.update(world, 1 / 60) // collect sees the disjoint flag and drops it
    expect(rs.stats.gpuMs).toBe(3)
    rs.update(world, 1 / 60)
    rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBe(99) // measurement resumes afterwards
  })

  it('reports unsupported contexts as null without errors', async () => {
    const { gl, rs, world } = setup()
    await expect(rs.setGpuTiming(true)).resolves.toBe(false)
    expect(rs.stats.gpuTimerSupported).toBe(false)
    for (let i = 0; i < 3; i++) rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBeNull()
    expect(rs.stats.gpuMsAvg).toBeNull()
    expect(gl.queries).toHaveLength(0)
  })

  it('survives context loss and restore', async () => {
    const { gl, rs, world } = setup({ timerQuery: { latency: 0, ns: 2e6 } })
    await rs.setGpuTiming(true)
    for (let i = 0; i < 3; i++) rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBe(2)
    gl.contextLost = true
    const ops = gl.queryOps
    rs.update(world, 1 / 60)
    expect(gl.queryOps).toBe(ops) // nothing touched while lost
    gl.contextLost = false
    gl.timerNs = 6e6
    for (let i = 0; i < 3; i++) rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBe(6)
    expect(rs.stats.gpuMsAvg).toBe(6) // average restarted with the new context
  })

  it('turns off cleanly and on again', async () => {
    const { gl, rs, world } = setup({ timerQuery: { latency: 0 } })
    await rs.setGpuTiming(true)
    for (let i = 0; i < 3; i++) rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBe(2)
    await expect(rs.setGpuTiming(false)).resolves.toBe(false)
    expect(rs.stats.gpuMs).toBeNull()
    expect(rs.stats.gpuTimerSupported).toBeNull()
    expect(gl.queries.every((q) => q.deleted)).toBe(true)
    const ops = gl.queryOps
    rs.update(world, 1 / 60)
    expect(gl.queryOps).toBe(ops)
    await expect(rs.setGpuTiming(true)).resolves.toBe(true)
    for (let i = 0; i < 3; i++) rs.update(world, 1 / 60)
    expect(rs.stats.gpuMs).toBe(2)
  })

  it('a request disabled while loading never starts', async () => {
    const { gl, rs, world } = setup({ timerQuery: true })
    const p = rs.setGpuTiming(true)
    void rs.setGpuTiming(false)
    await p
    rs.update(world, 1 / 60)
    expect(gl.queries).toHaveLength(0)
    expect(rs.stats.gpuTimerSupported).toBeNull()
  })
})
