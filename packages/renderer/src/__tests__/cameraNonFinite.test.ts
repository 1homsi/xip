import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ECSWorld, createTransform } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { Canvas2DRenderSystem } from '../canvas2dRenderSystem'
import { createCamera2D, type Camera2DComponent } from '../components/camera2d'
import { createRecordingCanvas, installHeadlessCanvasDOM } from '../testing/recordingGL'
import { fakeCanvas } from './fakeCanvas2D'

let uninstall: () => void
beforeAll(() => {
  uninstall = installHeadlessCanvasDOM()
})
afterAll(() => uninstall())
beforeEach(() => vi.stubGlobal('OffscreenCanvas', undefined))
afterEach(() => vi.unstubAllGlobals())

type Backend = 'webgl' | 'canvas2d'

function setup(backend: Backend, camOpts: Partial<Camera2DComponent>) {
  const entityIds = new Map<string, number>()
  const rs =
    backend === 'webgl'
      ? new RenderSystem(createRecordingCanvas(800, 600), entityIds)
      : new Canvas2DRenderSystem(fakeCanvas(800, 600).canvas, entityIds)
  const world = new ECSWorld()
  const camEntity = world.createEntity()
  const cam = createCamera2D({ followEntityId: 'player', ...camOpts })
  world.addComponent(camEntity, cam)
  const player = world.createEntity()
  const tf = createTransform(100, 50)
  world.addComponent(player, tf)
  entityIds.set('player', player)
  const step = (frames = 1) => {
    for (let i = 0; i < frames; i++) rs.update(world, 1 / 60)
  }
  return { cam, tf, step }
}

describe.each<Backend>(['webgl', 'canvas2d'])('camera follow with a non-finite target (%s)', (backend) => {
  const modes: [string, Partial<Camera2DComponent>][] = [
    ['smoothing', { smoothing: 0.85 }],
    ['dead zone', { deadZone: { w: 40, h: 40 } }],
    ['no smoothing', {}],
  ]

  it.each(modes)('holds the camera while the target is NaN, then follows again (%s)', (_name, opts) => {
    const { cam, tf, step } = setup(backend, opts)
    step(300)
    expect(Number.isFinite(cam.x)).toBe(true)
    const heldX = cam.x
    const heldY = cam.y

    tf.x = NaN
    tf.y = Infinity
    step(5)
    expect(cam.x).toBe(heldX)
    expect(cam.y).toBe(heldY)

    tf.x = -200
    tf.y = 300
    step(600)
    expect(Number.isFinite(cam.x)).toBe(true)
    expect(Number.isFinite(cam.y)).toBe(true)
    expect(cam.x).toBeLessThan(0)
    expect(cam.y).toBeGreaterThan(100)
  })

  it('heals a camera that is already NaN', () => {
    const { cam, step } = setup(backend, { smoothing: 0.85 })
    cam.x = NaN
    cam.y = NaN
    step(300)
    expect(cam.x).toBeCloseTo(100, 1)
    expect(cam.y).toBeCloseTo(50, 1)
  })

  it('resets a zero, negative or non-finite zoom', () => {
    for (const zoom of [0, -2, NaN, Infinity]) {
      const { cam, step } = setup(backend, { zoom })
      step()
      expect(cam.zoom).toBe(1)
    }
  })
})
