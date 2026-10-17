import { describe, expect, it } from 'vitest'
import { TileLayerData, createTileLayerComponent } from '../tileLayer'
import { TileLayerRenderer } from '../tileLayerGL'

function fakeGL() {
  const calls: [string, unknown[]][] = []
  const consts = new Map<string, number>()
  let next = 1
  const gl = new Proxy({ canvas: { width: 800, height: 600 } } as Record<string, unknown>, {
    get(t, p) {
      if (typeof p !== 'string') return undefined
      if (p in t) return t[p]
      if (/^[A-Z0-9_]+$/.test(p)) {
        if (!consts.has(p)) consts.set(p, 0x1000 + consts.size)
        return consts.get(p)
      }
      return (...args: unknown[]) => {
        calls.push([p, args])
        if (p.startsWith('create')) return { id: next++, kind: p }
        if (p === 'getShaderParameter' || p === 'getProgramParameter') return true
        if (p === 'getParameter') return 4096
        if (p === 'getUniformLocation') return { name: args[1] }
        return undefined
      }
    },
  })
  return { gl: gl as unknown as WebGL2RenderingContext, calls }
}

function make(opts: Partial<ConstructorParameters<typeof TileLayerData>[0]> = {}) {
  const l = new TileLayerData({
    width: 70,
    height: 40,
    chunkSize: 32,
    tileset: {
      image: { width: 32, height: 16 } as unknown as HTMLCanvasElement,
      tileWidth: 16,
      tileHeight: 16,
      columns: 2,
    },
    ...opts,
  })
  l.fill(1)
  return l
}

const world = (l: TileLayerData) =>
  ({
    query: () => [1],
    getComponent: () => createTileLayerComponent(l),
  }) as unknown as import('@xip/core').ECSWorld

const count = (calls: [string, unknown[]][], name: string) => calls.filter((c) => c[0] === name).length

describe('TileLayer base-pass cache', () => {
  it('does nothing unless a base layer sets cache', () => {
    const l = make()
    const { gl, calls } = fakeGL()
    const r = new TileLayerRenderer(gl)
    r.prepare(world(l), 0)
    calls.length = 0
    expect(r.renderBase(0, 0, 1, 800, 600, 0, 0, 1, 800, 600, 0, 0, 0)).toBe(false)
    expect(calls).toEqual([])
  })

  it('copies a still frame from the cache and draws directly while the camera or a layer moves', () => {
    const l = make({ cache: true })
    const { gl, calls } = fakeGL()
    const r = new TileLayerRenderer(gl)
    const w = world(l)
    const frame = (x: number) => {
      calls.length = 0
      r.prepare(w, 0)
      const drawn = r.renderBase(x, 0, 1, 800, 600, 0, 0, 1, 800, 600, 0, 0, 0)
      return { drawn, draws: count(calls, 'drawArrays'), blits: count(calls, 'blitFramebuffer') }
    }
    // First frame: nothing to compare with, so a direct draw.
    expect(frame(0)).toEqual({ drawn: true, draws: 1, blits: 0 })
    // Still for the first time: draw into the cache and copy it.
    expect(frame(0)).toEqual({ drawn: true, draws: 1, blits: 1 })
    // Still and cached: the copy alone.
    expect(frame(0)).toEqual({ drawn: true, draws: 0, blits: 1 })
    // Camera moved: direct again, no copy.
    expect(frame(5)).toEqual({ drawn: true, draws: 1, blits: 0 })
    expect(frame(5)).toEqual({ drawn: true, draws: 1, blits: 1 })
    // A tile changed: the layer's revision is part of the key, so it draws directly.
    l.setTile(1, 1, 2)
    expect(frame(5)).toEqual({ drawn: true, draws: 1, blits: 0 })
  })

  it('draws the cache as a plain copy into the default framebuffer and reports no draw calls on copy frames', () => {
    const l = make({ cache: true })
    const { gl, calls } = fakeGL()
    const r = new TileLayerRenderer(gl)
    const w = world(l)
    for (let i = 0; i < 2; i++) {
      r.prepare(w, 0)
      r.renderBase(0, 0, 1, 800, 600, 0, 0, 1, 800, 600, 0, 0, 0)
    }
    calls.length = 0
    r.prepare(w, 0)
    r.renderBase(0, 0, 1, 800, 600, 0, 0, 1, 800, 600, 0, 0, 0)
    expect(r.stats.drawCalls).toBe(0)
    const blit = calls.find((c) => c[0] === 'blitFramebuffer')!
    expect(blit[1].slice(0, 6)).toEqual([0, 0, 800, 600, 0, 0])
    expect(blit[1].slice(6, 8)).toEqual([800, 600])
    // Reads the cache, writes the default framebuffer (null), and leaves nothing bound.
    const binds = calls.filter((c) => c[0] === 'bindFramebuffer')
    expect(binds.length).toBe(3)
    expect(binds[0][1][1]).not.toBeNull()
    expect(binds[1][1][1]).toBeNull()
    expect(binds[2][1][1]).toBeNull()
    expect(count(calls, 'drawArrays')).toBe(0)
  })

  it('starts over after a context restore', () => {
    const l = make({ cache: true })
    const { gl, calls } = fakeGL()
    const r = new TileLayerRenderer(gl)
    const w = world(l)
    for (let i = 0; i < 3; i++) {
      r.prepare(w, 0)
      r.renderBase(0, 0, 1, 800, 600, 0, 0, 1, 800, 600, 0, 0, 0)
    }
    r.contextRestored()
    calls.length = 0
    r.prepare(w, 0)
    expect(r.renderBase(0, 0, 1, 800, 600, 0, 0, 1, 800, 600, 0, 0, 0)).toBe(true)
    expect(count(calls, 'drawArrays')).toBe(1)
    expect(count(calls, 'blitFramebuffer')).toBe(0)
  })
})
