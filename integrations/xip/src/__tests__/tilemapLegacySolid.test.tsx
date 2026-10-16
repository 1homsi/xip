// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountGame, cleanup } from '../test/mountGame'
import { Tilemap } from '../components/Tilemap'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Tile 1 is solid, tile 2 is not. Only tile 1 may get a collider.
const MAP = {
  width: 3,
  height: 1,
  tilewidth: 16,
  tileheight: 16,
  tilesets: [
    {
      firstgid: 1,
      name: 't',
      image: 't.png',
      columns: 2,
      tilewidth: 16,
      tileheight: 16,
      tilecount: 2,
      margin: 0,
      spacing: 0,
    },
  ],
  layers: [{ type: 'tilelayer', name: 'collision', visible: true, width: 3, height: 1, data: [1, 0, 2] }],
}

const response = () => ({ ok: true, status: 200, statusText: 'OK', json: async () => MAP })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('<Tilemap> legacy colliders with solidTiles', () => {
  it('mergeColliders={false} only collides with solid tiles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    )
    const g = await mountGame(<Tilemap src="/map.json" mergeColliders={false} solidTiles={[1]} />)
    await flush()
    await flush()
    expect(g.engine.ecs.query('BoxCollider').length).toBe(1)
  })
})
