import { afterEach, describe, expect, it, vi } from 'vitest'
import { ECSWorld, createTransform } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { createCamera2D } from '../components/camera2d'
import { createCircleShape, createLineShape, createPolygonShape } from '../components/shapes'
import { createGradient } from '../components/gradient'
import { createSprite } from '../components/sprite'
import { triangulate } from '../shapeGL'

afterEach(() => vi.restoreAllMocks())

function setup() {
  const ctx2d = new Proxy({} as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : () => ({ addColorStop: () => {} })),
    set: (t, p: string, v) => ((t[p] = v), true),
  })
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = createElement(tag)
    if (tag === 'canvas') Object.defineProperty(el, 'getContext', { value: () => ctx2d })
    return el
  })
  const draws: { kind: string; n: number }[] = []
  const instancedGeometry: [unknown, unknown][] = []
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_t, p: string) {
      if (/^[A-Z_0-9]+$/.test(p)) return p
      if (p === 'isContextLost') return () => false
      if (p.startsWith('get') || p.startsWith('create')) return () => ({})
      if (p === 'drawArraysInstanced')
        return (mode: unknown, _f: unknown, vertices: unknown, n: number) => {
          instancedGeometry.push([mode, vertices])
          draws.push({ kind: 'inst', n })
        }
      if (p === 'drawArrays') return (_m: unknown, _f: unknown, n: number) => draws.push({ kind: 'arr', n })
      return () => true
    },
  })
  const canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100, getContext: () => gl }
  const rs = new RenderSystem(canvas as unknown as HTMLCanvasElement, new Map())
  const world = new ECSWorld()
  world.addComponent(world.createEntity(), createCamera2D({}))
  const add = (...comps: object[]) => {
    const e = world.createEntity()
    world.addComponent(e, createTransform(0, 0))
    for (const c of comps) world.addComponent(e, c as never)
    return e
  }
  return { rs, world, draws, instancedGeometry, add }
}

describe('Circle / Line / Polygon / Gradient on WebGL', () => {
  it('20 lines draw in one instanced call', () => {
    const { rs, world, draws, add } = setup()
    for (let i = 0; i < 20; i++) add(createLineShape({ endX: 10 + i, endY: 5, color: '#ff0000' }))
    rs.update(world, 1 / 60)
    expect(draws).toEqual([{ kind: 'inst', n: 20 }])
    expect(rs.stats.drawCalls).toBe(1)
  })

  it('circles are one instance each and invisible / off-screen shapes are skipped', () => {
    const { rs, world, draws, instancedGeometry, add } = setup()
    add(createCircleShape({ radius: 10 }))
    add(createCircleShape({ radius: 10, strokeColor: '#00ff00', strokeWidth: 2 }))
    add(createCircleShape({ radius: 10, visible: false }))
    const far = world.createEntity()
    world.addComponent(far, createTransform(9000, 9000))
    world.addComponent(far, createCircleShape({ radius: 10 }))
    rs.update(world, 1 / 60)
    expect(draws).toEqual([{ kind: 'inst', n: 2 }])
    expect(instancedGeometry).toEqual([['TRIANGLE_STRIP', 4]])
  })

  it('polygons fill with triangles (concave included) and stroke with segments', () => {
    const { rs, world, draws, add } = setup()
    // an L shape: 6 vertices, 4 triangles
    const L = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 30 },
      { x: 0, y: 30 },
    ]
    add(createPolygonShape({ points: L, strokeColor: '#fff', strokeWidth: 2 }))
    rs.update(world, 1 / 60)
    expect(draws).toEqual([
      { kind: 'arr', n: 12 },
      { kind: 'inst', n: 6 },
    ])
    expect(triangulate(L)).toHaveLength(12)
  })

  it('shapes share the z-order with sprites: a sprite above a circle is drawn after it', () => {
    const { rs, world, draws, add } = setup()
    add(createSprite({ width: 8, height: 8, color: '#f00', zIndex: 0 }))
    add(createCircleShape({ radius: 10, zIndex: 5 }))
    add(createSprite({ width: 8, height: 8, color: '#0f0', zIndex: 10 }))
    rs.update(world, 1 / 60)
    // sprite batch, circle batch, sprite batch
    expect(draws.map((d) => d.n)).toEqual([1, 1, 1])
    expect(draws.map((d) => d.kind)).toEqual(['inst', 'inst', 'inst'])
  })

  it('a gradient draws one textured quad and is baked once', () => {
    const { rs, world, draws, add } = setup()
    const create = vi.spyOn(document, 'createElement')
    add(
      createGradient({
        stops: [
          { offset: 0, color: '#000' },
          { offset: 1, color: '#fff' },
        ],
        width: 50,
        height: 30,
      }),
    )
    rs.update(world, 1 / 60)
    rs.update(world, 1 / 60)
    expect(draws).toEqual([
      { kind: 'inst', n: 1 },
      { kind: 'inst', n: 1 },
    ])
    expect(create.mock.calls.filter(([t]) => t === 'canvas')).toHaveLength(1)
  })

  it('never takes the idle shortcut while shapes exist', () => {
    const { rs, world, draws, add } = setup()
    rs.setIdleFrameSkip(true)
    add(createLineShape({ endX: 5, endY: 5 }))
    for (let i = 0; i < 3; i++) rs.update(world, 1 / 60)
    expect(draws).toHaveLength(3)
  })
})

describe('triangulate', () => {
  it('covers the area of a concave polygon exactly', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 2, y: 1 },
      { x: 0, y: 4 },
    ]
    const idx = triangulate(pts)
    let area = 0
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]]]
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2
    }
    // shoelace area of the whole polygon
    let full = 0
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      full += a.x * b.y - b.x * a.y
    }
    expect(area).toBeCloseTo(Math.abs(full) / 2)
  })

  it('handles either winding and degenerate input', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ]
    expect(triangulate(sq)).toHaveLength(6)
    expect(triangulate([...sq].reverse())).toHaveLength(6)
    expect(triangulate(sq.slice(0, 2))).toEqual([])
  })
})
