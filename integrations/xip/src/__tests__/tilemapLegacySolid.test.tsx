// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountGame, cleanup } from '../test/mountGame'
import { Tilemap } from '../components/Tilemap'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Tile 1 is solid, tile 2 is not. Only tile 1 may get a collider.
function mapWith(data: number[]) {
  return {
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
    layers: [{ type: 'tilelayer', name: 'collision', visible: true, width: 3, height: 1, data }],
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

async function countLegacyColliders(data: number[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => mapWith(data) })),
  )
  const g = await mountGame(<Tilemap src="/map.json" mergeColliders={false} solidTiles={[1]} />)
  await flush()
  await flush()
  return g.engine.ecs.query('BoxCollider').length
}

describe('<Tilemap> legacy colliders with solidTiles', () => {
  it('a non-solid tile between solid tiles gets no collider', async () => {
    expect(await countLegacyColliders([1, 0, 2])).toBe(1)
  })

  it('solid runs split at a non-solid tile', async () => {
    expect(await countLegacyColliders([1, 2, 1])).toBe(2)
  })
})
