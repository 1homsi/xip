import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ECSWorld, createTransform } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { createCamera2D } from '../components/camera2d'
import { createSprite } from '../components/sprite'
import { SpriteLayer } from '../spriteLayer'
import { createRecordingCanvas, installHeadlessCanvasDOM } from '../testing/recordingGL'

let uninstall: () => void
beforeAll(() => {
  uninstall = installHeadlessCanvasDOM()
})
afterAll(() => uninstall())

/** Records every `new Image()` and lets the test fail or finish it. */
class FakeImage {
  static all: FakeImage[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  complete = false
  naturalWidth = 0
  naturalHeight = 0
  failed = false
  src = ''
  constructor() {
    FakeImage.all.push(this)
  }
}

let now = 0
beforeEach(() => {
  FakeImage.all = []
  now = 1000
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setup() {
  const rs = new RenderSystem(createRecordingCanvas(800, 600), new Map())
  const world = new ECSWorld()
  world.addComponent(world.createEntity(), createCamera2D({}))
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) rs.update(world, 1 / 60)
  }
  // Every frame, every request that is still pending comes back as a 404.
  const failingFrames = (n: number) => {
    for (let i = 0; i < n; i++) {
      rs.update(world, 1 / 60)
      for (const img of FakeImage.all) if (!img.failed) ((img.failed = true), img.onerror?.())
    }
  }
  return { rs, world, frame, failingFrames }
}

const requests = (src: string) => FakeImage.all.filter((i) => i.src === src)

describe('a 404 image is not re-requested every frame', () => {
  it('SpriteLayer atlas src', () => {
    const { rs, failingFrames } = setup()
    const layer = new SpriteLayer({ src: '/missing-atlas.png', frameWidth: 16, frameHeight: 16 })
    layer.add(10, 10, 16, 16, 0, 1)
    rs.addSpriteLayer(layer)

    failingFrames(120)
    expect(requests('/missing-atlas.png')).toHaveLength(1)

    // After the retry window it tries once more, and only once.
    now += 6000
    failingFrames(60)
    expect(requests('/missing-atlas.png')).toHaveLength(2)
  })

  it('Sprite component src', () => {
    const { world, failingFrames } = setup()
    const e = world.createEntity()
    world.addComponent(e, createTransform(0, 0))
    world.addComponent(e, createSprite({ src: '/missing-sprite.png', width: 16, height: 16 }))

    failingFrames(120)
    expect(requests('/missing-sprite.png')).toHaveLength(1)
  })

  it('warns once per failed load, not per frame', () => {
    const { rs, failingFrames } = setup()
    const layer = new SpriteLayer({ src: '/warn.png', frameWidth: 16, frameHeight: 16 })
    layer.add(10, 10, 16, 16, 0, 1)
    rs.addSpriteLayer(layer)
    failingFrames(120)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
