// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountGame, cleanup } from '../test/mountGame'
import { Tilemap } from '../components/Tilemap'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const MAP = {
  width: 2,
  height: 1,
  tilewidth: 16,
  tileheight: 16,
  tilesets: [
    {
      firstgid: 1,
      name: 't',
      image: 't.png',
      columns: 1,
      tilewidth: 16,
      tileheight: 16,
      tilecount: 1,
      margin: 0,
      spacing: 0,
    },
  ],
  layers: [{ type: 'tilelayer', name: 'collision', visible: true, width: 2, height: 1, data: [1, 1] }],
}

const response = () => ({ ok: true, status: 200, statusText: 'OK', json: async () => MAP })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('<Tilemap> load cancellation', () => {
  it('a fetch that resolves after unmount creates no colliders', async () => {
    let resolveFetch!: (r: unknown) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((r) => (resolveFetch = r))),
    )
    const g = await mountGame(<Tilemap src="/map.json" />)
    g.rerender(null)
    resolveFetch(response())
    await flush()
    await flush()
    expect(g.engine.ecs.query('BoxCollider').length).toBe(0)
  })

  it('a fetch superseded by a src change creates no colliders; only the current map does', async () => {
    const pending: Array<(r: unknown) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((r) => pending.push(r))),
    )
    const g = await mountGame(<Tilemap src="/a.json" />)
    g.rerender(<Tilemap src="/b.json" />)
    expect(pending.length).toBe(2)
    pending[0](response())
    pending[1](response())
    await flush()
    await flush()
    expect(g.engine.ecs.query('BoxCollider').length).toBe(1)
  })
})
