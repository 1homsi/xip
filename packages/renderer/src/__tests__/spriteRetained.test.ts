import { afterEach, describe, expect, it, vi } from 'vitest'
import { ECSWorld } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { SpriteLayer, SPRITE_HIDDEN } from '../spriteLayer'

afterEach(() => vi.restoreAllMocks())

const F = 21

/** RenderSystem on a fake GL that mirrors the instance buffer and records every draw's instances. */
function setup() {
  const ctx2d = new Proxy({} as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : () => ({ addColorStop: () => {} })),
    set: (t, p: string, v) => ((t[p] = v), true),
  })
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = createElement(tag)
    if (tag === 'canvas') Object.defineProperty(el, 'getContext', { configurable: true, value: () => ctx2d })
    return el
  })
  const bufs = new Map<object, Float32Array>()
  let bound: object | null = null
  let firstAttrOffset = 0
  const frame = { draws: [] as number[][], uploads: [] as { off: number; floats: number }[] }
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_t, p: string) {
      if (/^[A-Z_0-9]+$/.test(p)) return p
      if (p === 'isContextLost') return () => false
      if (p === 'createBuffer') return () => ({})
      if (p.startsWith('get') || p.startsWith('create')) return () => ({})
      if (p === 'bindBuffer') return (_t: unknown, b: object | null) => (bound = b)
      if (p === 'bufferData')
        return (_t: unknown, size: number) => {
          if (bound) bufs.set(bound, new Float32Array(size / 4))
        }
      if (p === 'bufferSubData')
        return (_t: unknown, off: number, data: Float32Array, src: number, len: number) => {
          bufs.get(bound!)?.set(data.subarray(src, src + len), off / 4)
          frame.uploads.push({ off, floats: len })
        }
      if (p === 'vertexAttribPointer')
        return (loc: number, _s: number, _t: unknown, _n: unknown, _st: number, off: number) => {
          if (loc === 2) firstAttrOffset = off
        }
      if (p === 'drawArraysInstanced')
        return (_m: unknown, _f: unknown, _c: unknown, n: number) => {
          const b = bufs.get(bound!)
          if (b) frame.draws.push(Array.from(b.subarray(firstAttrOffset / 4, firstAttrOffset / 4 + n * F)))
        }
      if (p === 'getShaderParameter' || p === 'getProgramParameter') return () => true
      return () => true
    },
  })
  const canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100, getContext: () => gl }
  const rs = new RenderSystem(canvas as unknown as HTMLCanvasElement, new Map())
  const world = new ECSWorld()
  const run = () => {
    frame.draws = []
    frame.uploads = []
    rs.update(world, 1 / 60)
    return { draws: frame.draws.flat(), uploads: [...frame.uploads], calls: frame.draws.length }
  }
  return { rs, run }
}

const img = (w: number, h = 16) =>
  ({ width: w, height: h, naturalWidth: w, naturalHeight: h }) as unknown as HTMLImageElement
const make = (opts: ConstructorParameters<typeof SpriteLayer>[0] = {}) =>
  new SpriteLayer({ image: img(64), frameWidth: 16, frameHeight: 16, ...opts })

describe('retained SpriteLayer instances', () => {
  it('uploads nothing for a static layer but keeps drawing it', () => {
    const { rs, run } = setup()
    const l = make()
    for (let i = 0; i < 50; i++) l.add(i, 5, 8, 8, i % 4)
    rs.addSpriteLayer(l)
    const a = run()
    expect(a.uploads.reduce((s, u) => s + u.floats, 0)).toBe(50 * F)
    const b = run()
    expect(b.uploads).toEqual([])
    expect(b.calls).toBe(1)
    expect(b.draws).toEqual(a.draws)
  })

  it('touchRange re-checks and uploads only the written slots', () => {
    const { rs, run } = setup()
    const l = make()
    for (let i = 0; i < 100; i++) l.add(i, 5, 8, 8)
    rs.addSpriteLayer(l)
    run()
    l.x[40] = 77
    l.x[41] = 78
    l.touchRange(40, 41)
    const r = run()
    expect(r.uploads).toEqual([{ off: 40 * F * 4, floats: 2 * F }])
    expect(r.draws[40 * F]).toBe(77)
    expect(r.draws[41 * F]).toBe(78)
  })

  it('incrementally repacks a touched slot in sorted draw order when its key is unchanged', () => {
    const { rs, run } = setup()
    const l = make({ sortByKey: true })
    for (let i = 0; i < 100; i++) {
      const slot = l.add(i, 5, 8, 8)
      l.sortKey[slot] = 99 - i
    }
    rs.addSpriteLayer(l)
    run()
    l.x[40] = 77
    l.touchRange(40)
    const r = run()
    const order = Array.from(l.drawOrder().subarray(0, l.orderCount))
    const packedPosition = order.indexOf(40)
    expect(r.uploads).toEqual([{ off: packedPosition * F * 4, floats: F }])
    expect(r.draws[packedPosition * F]).toBe(77)
  })

  it('repacks a sorted layer whose order changed even when pick() already consumed the new order', () => {
    const { rs, run } = setup()
    const l = make({ sortByKey: true })
    for (let i = 0; i < 100; i++) {
      const slot = l.add(i, 5, 8, 8)
      l.sortKey[slot] = i
    }
    rs.addSpriteLayer(l)
    run()
    l.x[10] = 77
    l.sortKey[10] = 1000 // now drawn last
    l.touchRange(10)
    l.pick(0, 0) // sorts the layer before the renderer sees it
    const r = run()
    expect(r.draws[99 * F]).toBe(77)
    expect(r.draws[10 * F]).toBe(11)
  })

  it('uploads every repacked sprite when touched sorted slots land at descending packed positions', () => {
    const { rs, run } = setup()
    const l = make({ sortByKey: true })
    for (let i = 0; i < 400; i++) {
      const slot = l.add(-30 + i * 0.01, 5, 8, 8)
      l.sortKey[slot] = 100 + i
    }
    // slots 100..102 are drawn first, in the order 100, 102, 101
    l.sortKey[100] = 10
    l.sortKey[101] = 15
    l.sortKey[102] = 12
    rs.addSpriteLayer(l)
    run()
    l.x[100] = 51
    l.x[101] = 52
    l.x[102] = 53
    l.touchRange(100, 102)
    const r = run()
    const order = Array.from(l.drawOrder().subarray(0, l.orderCount))
    for (const [slot, x] of [
      [100, 51],
      [101, 52],
      [102, 53],
    ])
      expect(r.draws[order.indexOf(slot) * F]).toBe(x)
  })

  it('finds the touched slot draw segment efficiently across interleaved atlases', () => {
    const { rs, run } = setup()
    const atlas = () => ({ image: img(64), frameWidth: 16, frameHeight: 16 })
    const l = new SpriteLayer({ atlases: [atlas(), atlas()], sortByKey: true })
    for (let i = 0; i < 100; i++) {
      const slot = l.add(i, 5, 8, 8)
      l.atlas[slot] = i & 1
      l.sortKey[slot] = i
    }
    rs.addSpriteLayer(l)
    run()
    l.x[75] = 77
    l.touchRange(75)
    const r = run()
    expect(r.uploads).toEqual([{ off: 75 * F * 4, floats: F }])
    expect(r.draws[75 * F]).toBe(77)
  })

  it('touch() verifies every sprite and uploads only the ones that differ', () => {
    const { rs, run } = setup()
    const l = make()
    for (let i = 0; i < 100; i++) l.add(i, 5, 8, 8)
    rs.addSpriteLayer(l)
    run()
    l.x[10] = 1.5
    l.frame[60] = 3
    l.color[61] = 0xff0000ff
    l.touch()
    const r = run()
    const floats = r.uploads.reduce((s, u) => s + u.floats, 0)
    expect(floats).toBeLessThan(100 * F)
    expect(r.draws[10 * F]).toBe(1.5)
    expect(r.draws[61 * F + 9]).toBe(1) // red channel written
    expect(r.draws[61 * F + 10]).toBe(0)
    l.touch()
    expect(run().uploads).toEqual([])
  })

  it('draws like a fresh layer through random edits, hides, removes, rebuilds and view changes', () => {
    let seed = 99
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) as number
    const a = setup()
    const b = setup()
    const mk = () => make({ sortByKey: true, capacity: 4 })
    const live = mk()
    a.rs.addSpriteLayer(live)
    const fill = (l: SpriteLayer, snap: SpriteLayer) => {
      l.clear()
      for (let i = 0; i < snap.count; i++) {
        const k = l.add(snap.x[i], snap.y[i], snap.w[i], snap.h[i], snap.frame[i], snap.ids[i])
        l.color[k] = snap.color[i]
        l.flags[k] = snap.flags[i]
        l.sortKey[k] = snap.sortKey[i]
        l.rotation[k] = snap.rotation[i]
      }
    }
    for (let i = 0; i < 40; i++) {
      const k = live.add(rnd() * 300 - 50, rnd() * 100, 8, 8, (rnd() * 4) | 0)
      live.sortKey[k] = live.y[k]
    }
    for (let step = 0; step < 120; step++) {
      const op = (rnd() * 6) | 0
      if (op === 0) {
        const k = live.add(rnd() * 300 - 50, rnd() * 100, 8, 8, (rnd() * 4) | 0)
        live.sortKey[k] = live.y[k]
      } else if (op === 1 && live.count > 5) live.removeAt((rnd() * live.count) | 0)
      else if (op === 2) {
        const i = (rnd() * live.count) | 0
        live.flags[i] ^= SPRITE_HIDDEN
        live.touchRange(i)
      } else if (op === 3) {
        for (let q = 0; q < 6; q++) {
          const i = (rnd() * live.count) | 0
          live.x[i] += rnd() * 40 - 20
          live.y[i] = rnd() * 100
          live.sortKey[i] = live.y[i]
          live.frame[i] = (rnd() * 4) | 0
          live.color[i] = (rnd() * 0xffffffff) >>> 0
          live.touchRange(i)
        }
      } else if (op === 4) {
        for (let i = 0; i < live.count; i++) live.rotation[i] = rnd()
        live.touch()
      }
      // op 5: no change at all
      const ra = a.run()
      const fresh = mk()
      fill(fresh, live)
      const c = setup()
      c.rs.addSpriteLayer(fresh)
      const rc = c.run()
      expect(ra.draws.length).toBe(rc.draws.length)
      expect(ra.draws).toEqual(rc.draws)
      void b
    }
  })

  it('a growing layer (capacity change) re-creates the buffer and draws everything', () => {
    const { rs, run } = setup()
    const l = make({ capacity: 2 })
    l.add(0, 0, 8, 8)
    rs.addSpriteLayer(l)
    run()
    for (let i = 1; i < 40; i++) l.add(i, 0, 8, 8)
    const r = run()
    expect(r.draws.length).toBe(40 * F)
    expect(r.draws[39 * F]).toBe(39)
  })

  it('repacks after the atlas changes (markAtlasDirty with an edited frame table)', () => {
    const { rs, run } = setup()
    const frames = [{ x: 0, y: 0, w: 16, h: 16 }]
    const l = new SpriteLayer({ image: img(64), frames })
    l.add(0, 0, 8, 8, 0)
    rs.addSpriteLayer(l)
    const a = run()
    expect(a.draws[15]).toBeCloseTo(0.25)
    frames[0].w = 32
    l.markAtlasDirty()
    expect(run().draws[15]).toBeCloseTo(0.5)
  })
})
