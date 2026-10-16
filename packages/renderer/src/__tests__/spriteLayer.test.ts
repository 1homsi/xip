import { afterEach, describe, expect, it, vi } from 'vitest'
import { ECSWorld } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { SpriteLayer, SPRITE_HIDDEN, SPRITE_ADDITIVE } from '../spriteLayer'

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
  const draws: number[] = []
  const topology: [unknown, unknown][] = []
  const uploads: Float32Array[] = []
  const staticBuffers: Float32Array[] = []
  const tex: string[] = []
  const params: [string, string, string][] = []
  const blends: string[] = []
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_t, p: string) {
      if (/^[A-Z_0-9]+$/.test(p)) return p
      if (p === 'isContextLost') return () => false
      if (p.startsWith('get') || p.startsWith('create')) return () => ({})
      if (p === 'drawArraysInstanced')
        return (mode: unknown, _first: unknown, vertices: unknown, n: number) => {
          topology.push([mode, vertices])
          draws.push(n)
        }
      if (p === 'bufferSubData')
        return (_t: unknown, _o: unknown, data: Float32Array, src: number, len: number) =>
          uploads.push(data.slice(src, src + len))
      if (p === 'bufferData')
        return (_t: unknown, data: Float32Array | number, usage: unknown) => {
          if (usage === 'STATIC_DRAW' && data instanceof Float32Array) staticBuffers.push(data.slice())
        }
      if (p === 'texImage2D' || p === 'texSubImage2D') return () => tex.push(p)
      if (p === 'blendFunc') return (a: string, b: string) => blends.push(`${a}/${b}`)
      if (p === 'texParameteri')
        return (_t: unknown, pname: string, value: string) => params.push([_t as string, pname, value])
      if (p === 'getShaderParameter' || p === 'getProgramParameter') return () => true
      return () => true
    },
  })
  const canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100, getContext: () => gl }
  const rs = new RenderSystem(canvas as unknown as HTMLCanvasElement, new Map())
  return { rs, world: new ECSWorld(), draws, topology, uploads, staticBuffers, tex, params, blends }
}

describe('SpriteLayer', () => {
  it('grows, swap-removes and picks the topmost sprite', () => {
    const layer = new SpriteLayer({ capacity: 16 })
    for (let i = 0; i < 40; i++) layer.add(i * 10, 0, 10, 10, 0, 100 + i)
    expect(layer.count).toBe(40)
    expect(layer.capacity).toBeGreaterThanOrEqual(40)
    expect(layer.pick(12, 0)).toBe(101)
    layer.add(12, 0, 10, 10, 0, 999)
    expect(layer.pick(12, 0)).toBe(999)
    layer.flags[layer.count - 1] = SPRITE_HIDDEN
    expect(layer.pick(12, 0)).toBe(101)
    layer.removeAt(0)
    expect(layer.ids[0]).toBe(999)
    expect(layer.pick(-100, 0)).toBe(-1)
  })

  it('draws visible sprites in one instanced call and culls the rest', () => {
    const { rs, world, draws, topology, staticBuffers } = setup()
    const layer = new SpriteLayer()
    layer.add(0, 0, 4, 4)
    layer.add(10, 10, 4, 4)
    layer.add(5000, 0, 4, 4)
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    expect(draws).toEqual([2])
    expect(topology).toEqual([['TRIANGLE_STRIP', 4]])
    // Both renderers upload a quad; neither may keep the old 6-vertex (24-float) one.
    expect(staticBuffers.map((b) => b.length)).not.toContain(24)
    rs.removeSpriteLayer(layer)
    draws.length = 0
    rs.update(world, 1 / 60)
    expect(draws).toEqual([])
  })

  it('draws several atlases in one batch, ordered by sortKey', () => {
    const { rs, world, draws, uploads } = setup()
    const img = (w: number) =>
      ({ width: w, height: 16, naturalWidth: w, naturalHeight: 16 }) as unknown as HTMLImageElement
    const layer = new SpriteLayer({
      atlases: [
        { image: img(64), frameWidth: 16, frameHeight: 16 },
        { image: img(32), frameWidth: 16, frameHeight: 16 },
      ],
      sortByKey: true,
    })
    const ys = [30, 10, 20]
    ys.forEach((y, i) => {
      const k = layer.add(0, y, 8, 8, i, 100 + i)
      layer.atlas[k] = i % 2
      layer.sortKey[k] = y
    })
    rs.addSpriteLayer(layer)
    uploads.length = 0
    rs.update(world, 1 / 60)
    expect(draws).toEqual([3])
    const data = uploads[uploads.length - 1]
    const drawn = [0, 1, 2].map((n) => ({ y: data[n * 21 + 1], atlas: data[n * 21 + 17] }))
    expect(drawn.map((d) => d.y)).toEqual([10, 20, 30])
    expect(drawn.map((d) => d.atlas)).toEqual([1, 0, 0])
    // pick follows draw order: the y=30 sprite is drawn last, so it wins on overlap
    layer.y[1] = 30
    layer.sortKey[1] = 31
    expect(layer.pick(0, 30)).toBe(101)
    layer.sortKey[1] = 29
    expect(layer.pick(0, 30)).toBe(100)
  })

  it('calls onChange for every mutation path, including atlas setters and touch()', () => {
    const layer = new SpriteLayer()
    const onChange = vi.fn()
    layer.onChange = onChange
    layer.add(0, 0, 4, 4)
    layer.set(0, 1, 1)
    layer.resize(3)
    layer.removeAt(0)
    layer.touch()
    layer.clear()
    layer.dynamicSrc = 'x'
    layer.image = undefined
    layer.markAtlasDirty()
    expect(onChange).toHaveBeenCalledTimes(9)
    layer.onChange = null
    expect(() => layer.touch()).not.toThrow()
  })

  it('re-uploads an image atlas after markAtlasDirty, once, and not before', () => {
    const { rs, world, tex } = setup()
    const img = { width: 16, height: 16, naturalWidth: 16, naturalHeight: 16 } as unknown as HTMLCanvasElement
    const layer = new SpriteLayer({ image: img, frameWidth: 16, frameHeight: 16 })
    layer.add(0, 0, 8, 8)
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    const sub = () => tex.filter((t) => t === 'texSubImage2D').length
    expect(tex.filter((t) => t === 'texImage2D').length).toBeGreaterThan(0)
    expect(sub()).toBe(0)
    rs.update(world, 1 / 60)
    expect(sub()).toBe(0)
    layer.markAtlasDirty()
    rs.update(world, 1 / 60)
    expect(sub()).toBe(1)
    rs.update(world, 1 / 60)
    expect(sub()).toBe(1)
  })

  const img = (w: number, h = 16) =>
    ({ width: w, height: h, naturalWidth: w, naturalHeight: h }) as unknown as HTMLImageElement
  /** Decoded instances of the last upload: uv rect and atlas unit per instance. */
  const lastUVs = (uploads: Float32Array[], n: number) =>
    Array.from({ length: n }, (_, k) => {
      const d = uploads[uploads.length - 1]
      return { uv: Array.from(d.subarray(k * 21 + 13, k * 21 + 17)), unit: d[k * 21 + 17] }
    })

  it('uses an explicit frame table for UV rects and skips out-of-range frames', () => {
    const { rs, world, draws, uploads } = setup()
    const layer = new SpriteLayer({
      image: img(64, 32),
      frames: [
        { x: 0, y: 0, w: 16, h: 32 },
        { x: 32, y: 8, w: 32, h: 8 },
      ],
    })
    layer.add(0, 0, 8, 8, 0)
    layer.add(10, 0, 8, 8, 1)
    layer.add(20, 0, 8, 8, 2) // no such frame
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    expect(draws).toEqual([2])
    const [a, b] = lastUVs(uploads, 2)
    expect(a.uv).toEqual([0, 0, 0.25, 1])
    expect(b.uv).toEqual([0.5, 0.25, 0.5, 0.25])
  })

  it('insets frame and grid UVs by the given texture pixels', () => {
    const { rs, world, uploads } = setup()
    const layer = new SpriteLayer({
      atlases: [
        { image: img(64, 32), frames: [{ x: 16, y: 0, w: 16, h: 16 }], inset: 1 },
        { image: img(64, 32), frameWidth: 32, frameHeight: 32, inset: 2 },
      ],
    })
    layer.add(0, 0, 8, 8, 0)
    layer.add(10, 0, 8, 8, 0)
    layer.atlas[1] = 1
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    const [a, b] = lastUVs(uploads, 2)
    expect(a.uv).toEqual([17 / 64, 1 / 32, 14 / 64, 14 / 32])
    expect(b.uv).toEqual([2 / 64, 2 / 32, 28 / 64, 28 / 32])
  })

  it('grids honour spacing and margin', () => {
    const { rs, world, uploads } = setup()
    const layer = new SpriteLayer({
      image: img(70, 40),
      frameWidth: 16,
      frameHeight: 16,
      frameSpacing: 2,
      frameMargin: 3,
    })
    layer.add(0, 0, 8, 8, 0)
    layer.add(10, 0, 8, 8, 1)
    layer.add(20, 0, 8, 8, 4) // 4 columns of (70 - 6 + 2) / 18 = 3 -> second row, column 1
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    const [a, b, c] = lastUVs(uploads, 3)
    expect(a.uv.map((n) => +n.toFixed(5))).toEqual([3 / 70, 3 / 40, 16 / 70, 16 / 40].map((n) => +n.toFixed(5)))
    expect(b.uv[0]).toBeCloseTo(21 / 70)
    expect(c.uv[0]).toBeCloseTo(21 / 70)
    expect(c.uv[1]).toBeCloseTo(21 / 40)
  })

  it('draws more than 8 atlases: one call per run of sprites in the same group of 8', () => {
    const { rs, world, draws, uploads } = setup()
    const atlases = Array.from({ length: 20 }, () => ({ image: img(16), frameWidth: 16, frameHeight: 16 }))
    const layer = new SpriteLayer({ atlases, sortByKey: true })
    // atlas, sortKey: groups 0 0 1 1 2 0 -> runs of (0,0) (1,1) (2) (0)
    ;[0, 7, 8, 15, 19, 3].forEach((atlas, n) => {
      const i = layer.add(n * 10, 0, 8, 8)
      layer.atlas[i] = atlas
      layer.sortKey[i] = n
    })
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    expect(draws).toEqual([2, 2, 1, 1])
    // local unit = atlas & 7 (the shader picks the texture by unit)
    const units = uploads.flatMap((u) => Array.from({ length: u.length / 21 }, (_, k) => u[k * 21 + 17]))
    expect(units).toEqual([0, 7, 0, 7, 3, 3])
    layer.sortByKey = false
    layer.sortKey.fill(0)
    draws.length = 0
    layer.touch()
    rs.update(world, 1 / 60)
    expect(draws).toEqual([2, 2, 1, 1])
  })

  it('applies per-atlas sampling over the layer sampling', () => {
    const { rs, world, params } = setup()
    const layer = new SpriteLayer({
      sampling: 'nearest',
      atlases: [
        { image: img(16), frameWidth: 16, frameHeight: 16, sampling: 'linear' },
        { image: img(16), frameWidth: 16, frameHeight: 16 },
      ],
    })
    layer.add(0, 0, 8, 8)
    const j = layer.add(10, 0, 8, 8)
    layer.atlas[j] = 1
    rs.addSpriteLayer(layer)
    params.length = 0
    rs.update(world, 1 / 60)
    const mins = params.filter((p) => p[1] === 'TEXTURE_MIN_FILTER').map((p) => p[2])
    expect(mins).toContain('LINEAR')
    expect(mins).toContain('NEAREST')
  })

  it('writes per-sprite anchors: per-sprite override, frame pivot, grid pivot, layer default', () => {
    const { rs, world, uploads } = setup()
    const layer = new SpriteLayer({
      atlases: [
        {
          image: img(64, 32),
          frames: [
            { x: 0, y: 0, w: 32, h: 32, pivot: { x: 16, y: 32 } },
            { x: 32, y: 0, w: 32, h: 32 },
          ],
        },
        { image: img(32, 16), frameWidth: 16, frameHeight: 16, pivot: { x: 4, y: 8 } },
      ],
      anchorX: 0.25,
      anchorY: 0.75,
    })
    layer.add(0, 0, 8, 8, 0) // frame pivot -> 0.5, 1
    layer.add(10, 0, 8, 8, 1) // frame without pivot -> layer anchor
    const g = layer.add(20, 0, 8, 8, 0)
    layer.atlas[g] = 1 // grid pivot -> 0.25, 0.5
    const o = layer.add(30, 0, 8, 8, 0) // per-sprite override wins over the frame pivot
    layer.setAnchor(o, 0.1, 0.2)
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    const d = uploads[uploads.length - 1]
    const anchors = [0, 1, 2, 3].map((k) => [d[k * 21 + 5], d[k * 21 + 6]].map((n) => +n.toFixed(4)))
    expect(anchors).toEqual([
      [0.5, 1],
      [0.25, 0.75],
      [0.25, 0.5],
      [0.1, 0.2],
    ])
    layer.setAnchor(o) // cleared: back to the frame pivot
    rs.update(world, 1 / 60)
    expect([uploads[uploads.length - 1][3 * 21 + 5], uploads[uploads.length - 1][3 * 21 + 6]]).toEqual([0.5, 1])
  })

  it('splits draws at per-sprite additive runs and restores normal blending', () => {
    const { rs, world, draws, blends } = setup()
    const layer = new SpriteLayer({ sortByKey: true })
    for (let i = 0; i < 5; i++) {
      const k = layer.add(i * 10, 0, 8, 8)
      layer.sortKey[k] = i
      if (i === 1 || i === 2) layer.flags[k] |= SPRITE_ADDITIVE
    }
    rs.addSpriteLayer(layer)
    blends.length = 0
    rs.update(world, 1 / 60)
    expect(draws).toEqual([1, 2, 2]) // normal | additive x2 | normal x2
    const layerBlends = blends.filter((b) => b === 'SRC_ALPHA/ONE' || b === 'SRC_ALPHA/ONE_MINUS_SRC_ALPHA')
    expect(layerBlends.slice(-2)).toEqual(['SRC_ALPHA/ONE', 'SRC_ALPHA/ONE_MINUS_SRC_ALPHA'])
    // ending on an additive run still leaves normal blending behind
    layer.sortKey[0] = 10
    layer.flags[0] |= SPRITE_ADDITIVE
    layer.touch()
    blends.length = 0
    rs.update(world, 1 / 60)
    expect(blends.filter((b) => b.startsWith('SRC_ALPHA/')).at(-1)).toBe('SRC_ALPHA/ONE_MINUS_SRC_ALPHA')
  })

  it('writes colorAdd into instance slot 19 and keeps it through growth, swap-remove and reset', () => {
    const { rs, world, uploads } = setup()
    const layer = new SpriteLayer({ capacity: 2 })
    layer.add(0, 0, 8, 8)
    const ca = layer.enableColorAdd()
    ca[0] = 0x102030
    for (let i = 0; i < 20; i++) layer.add(10 + i * 3, 0, 8, 8)
    expect(layer.colorAdd!.length).toBe(layer.capacity)
    expect(layer.colorAdd![0]).toBe(0x102030)
    expect(layer.colorAdd![5]).toBe(0)
    layer.colorAdd![20] = 0xffffff
    layer.removeAt(1) // slot 20 -> 1
    expect(layer.colorAdd![1]).toBe(0xffffff)
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    const d = uploads[uploads.length - 1]
    expect(d[20]).toBe(0x102030)
    expect(d[21 + 20]).toBe(0xffffff)
    expect(d[42 + 20]).toBe(0)
  })
})
