// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountGame, cleanup } from '../test/mountGame'
import { Tilemap } from '../components/Tilemap'
import type { SpriteComponent } from '@xip/renderer'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const FLIP_H = 0x80000000
const FLIP_V = 0x40000000

const tileset = {
  firstgid: 1,
  name: 't',
  image: 't.png',
  columns: 2,
  tilewidth: 16,
  tileheight: 16,
  tilecount: 4,
  margin: 0,
  spacing: 0,
}

function mapWith(layer: { name: string; type: 'tilelayer'; data: number[] }) {
  return {
    width: 2,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    tilesets: [tileset],
    layers: [{ visible: true, width: 2, height: 1, ...layer }],
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function stubMap(map: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => map })),
  )
}

describe('<Tilemap> Tiled GID flag bits', () => {
  it('a flipped tile uses the frame of its tile id and mirrors the sprite', async () => {
    // Tile id 2 (second column of the sheet), horizontally flipped.
    stubMap(mapWith({ name: 'ground', type: 'tilelayer', data: [(FLIP_H | 2) >>> 0, 0] }))
    const g = await mountGame(<Tilemap src="/map.json" />)
    await flush()
    await flush()
    const [eid] = g.engine.ecs.query('Sprite')
    const sprite = g.engine.ecs.getComponent<SpriteComponent>(eid, 'Sprite')!
    expect(sprite.frame).toMatchObject({ sx: 16, sy: 0 })
    expect(sprite.flipX).toBe(true)
    expect(sprite.flipY).toBe(false)
  })

  it('a vertically flipped tile mirrors the sprite vertically', async () => {
    stubMap(mapWith({ name: 'ground', type: 'tilelayer', data: [(FLIP_V | 1) >>> 0, 0] }))
    const g = await mountGame(<Tilemap src="/map.json" />)
    await flush()
    await flush()
    const [eid] = g.engine.ecs.query('Sprite')
    const sprite = g.engine.ecs.getComponent<SpriteComponent>(eid, 'Sprite')!
    expect(sprite.flipX).toBe(false)
    expect(sprite.flipY).toBe(true)
  })

  it('a hex-rotated tile uses the frame of its tile id', async () => {
    // Bit 28 is Tiled's hex 120° rotation flag; it must not leak into the tile id.
    stubMap(mapWith({ name: 'ground', type: 'tilelayer', data: [0x10000000 | 2, 0] }))
    const g = await mountGame(<Tilemap src="/map.json" />)
    await flush()
    await flush()
    const [eid] = g.engine.ecs.query('Sprite')
    const sprite = g.engine.ecs.getComponent<SpriteComponent>(eid, 'Sprite')!
    expect(sprite.frame).toMatchObject({ sx: 16, sy: 0 })
  })

  it('a flipped solid tile still gets a collider', async () => {
    stubMap(
      mapWith({
        name: 'walls',
        type: 'tilelayer',
        data: [(FLIP_H | 1) >>> 0, 0],
      }),
    )
    const g = await mountGame(<Tilemap src="/map.json" solidTiles={[1]} collisionLayer="walls" />)
    await flush()
    await flush()
    expect(g.engine.ecs.query('BoxCollider').length).toBe(1)
  })
})
