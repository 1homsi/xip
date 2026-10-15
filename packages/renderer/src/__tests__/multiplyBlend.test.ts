import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ECSWorld, createTransform } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { createSprite } from '../components/sprite'
import { TileLayerData, createTileLayerComponent } from '../tileLayer'
import { SpriteLayer } from '../spriteLayer'
import { createRecordingCanvas, installHeadlessCanvasDOM } from '../testing/recordingGL'
import type { RecordedDraw } from '../testing/recordingGL'

let uninstall: () => void
beforeAll(() => {
  uninstall = installHeadlessCanvasDOM()
})
afterAll(() => uninstall())

const DST_COLOR = 0x0306
const ONE_MINUS_SRC_ALPHA = 0x0303

/**
 * The factor `dst` is multiplied by for a white source of alpha `a`: the shader writes rgb scaled by
 * mix(1, a, u_premul) and the blend is src * DST_COLOR + dst * (1 - a). A correct multiply is 1 - a + a * rgb = 1.
 */
function whiteFactor(d: RecordedDraw, a: number): number {
  expect(d.blend).toEqual([DST_COLOR, ONE_MINUS_SRC_ALPHA])
  const rgb = 1 * (1 + (a - 1) * d.premul)
  return rgb + (1 - a)
}

function setup() {
  const canvas = createRecordingCanvas(200, 100)
  return { gl: canvas.gl, rs: new RenderSystem(canvas, new Map()), world: new ECSWorld() }
}

describe('multiply blend with partial alpha', () => {
  it('a half-transparent white sprite leaves the backdrop unchanged', () => {
    const { gl, rs, world } = setup()
    const e = world.createEntity()
    world.addComponent(e, createTransform(100, 50))
    world.addComponent(
      e,
      createSprite({ width: 20, height: 20, color: '#ffffff', opacity: 0.5, blendMode: 'multiply' }),
    )
    rs.update(world, 1 / 60)
    const d = gl.draws.find((x) => x.blend[0] === DST_COLOR)!
    expect(whiteFactor(d, 0.5)).toBeCloseTo(1, 6)
  })

  it('a half-opacity white SpriteLayer leaves the backdrop unchanged', () => {
    const { gl, rs, world } = setup()
    const l = new SpriteLayer({ blend: 'multiply', opacity: 0.5 })
    l.add(0, 0, 8, 8)
    rs.addSpriteLayer(l)
    rs.update(world, 1 / 60)
    expect(whiteFactor(gl.draws[0], 0.5)).toBeCloseTo(1, 6)
  })

  it('a half-opacity white TileLayer leaves the backdrop unchanged', () => {
    const { gl, rs, world } = setup()
    const tiles = new TileLayerData({
      width: 2,
      height: 2,
      tileset: {
        image: { width: 8, height: 8 } as unknown as HTMLCanvasElement,
        tileWidth: 8,
        tileHeight: 8,
        columns: 1,
      },
      blend: 'multiply',
      opacity: 0.5,
    })
    tiles.fill(1)
    world.addComponent(world.createEntity(), createTileLayerComponent(tiles))
    rs.update(world, 1 / 60)
    expect(whiteFactor(gl.draws[0], 0.5)).toBeCloseTo(1, 6)
  })

  it('normal blending does not premultiply', () => {
    const { gl, rs, world } = setup()
    const l = new SpriteLayer()
    l.add(0, 0, 8, 8)
    rs.addSpriteLayer(l)
    rs.update(world, 1 / 60)
    expect(gl.draws[0].premul).toBe(0)
  })
})
