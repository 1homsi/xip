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

const W = 70
const H = 40

function make(variants: Record<number, number[]> | undefined) {
  const l = new TileLayerData({
    width: W,
    height: H,
    chunkSize: 32,
    tileset: {
      image: { width: 32, height: 16 } as unknown as HTMLCanvasElement,
      tileWidth: 16,
      tileHeight: 16,
      columns: 2,
    },
    variants,
  })
  // A pattern with empty cells, plain ids, and two variant ids (one with a single entry).
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) l.setTile(x, y, (x * 7 + y * 3) % 5)
  return l
}

const world = (l: TileLayerData) =>
  ({
    query: () => [1],
    getComponent: () => createTileLayerComponent(l),
  }) as unknown as import('@xip/core').ECSWorld

/** The index data of the last full (page-sized) upload. */
function lastIndexData(calls: [string, unknown[]][]): Uint16Array | Uint32Array {
  const full = calls.filter(
    (c) => c[0] === 'texSubImage2D' && (c[1][8] instanceof Uint16Array || c[1][8] instanceof Uint32Array),
  )
  return full.at(-1)![1][8] as Uint16Array
}

describe('TileLayer variants baked into the index', () => {
  it('uploads the variant each cell draws, the same pick variantAt makes', () => {
    const l = make({ 1: [2, 3, 4], 2: [5], 3: [1, 2, 3, 4, 5] })
    const { gl, calls } = fakeGL()
    const r = new TileLayerRenderer(gl)
    r.prepare(world(l), 0)
    const data = lastIndexData(calls)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) expect(data[y * W + x]).toBe(l.variantAt(x, y))
    }
  })

  it('re-bakes every cell when the variants change', () => {
    const l = make({ 1: [2, 3, 4] })
    const { gl, calls } = fakeGL()
    const r = new TileLayerRenderer(gl)
    r.prepare(world(l), 0)
    calls.length = 0
    l.setVariants({ 1: [5, 4], 3: [2] })
    r.prepare(world(l), 0)
    const data = lastIndexData(calls)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) expect(data[y * W + x]).toBe(l.variantAt(x, y))
    }
  })

  it('bakes only the dirty cells of an edit', () => {
    const l = make({ 1: [2, 3, 4], 2: [5] })
    const { gl, calls } = fakeGL()
    const r = new TileLayerRenderer(gl)
    r.prepare(world(l), 0)
    calls.length = 0
    l.setTile(10, 5, 1)
    r.prepare(world(l), 0)
    const partial = calls.filter((c) => c[0] === 'texSubImage2D')
    expect(partial.length).toBe(1)
    expect(partial[0][1][4]).toBe(1)
    expect(partial[0][1][5]).toBe(1)
    const data = partial[0][1][8] as Uint16Array
    expect(data[5 * W + 10]).toBe(l.variantAt(10, 5))
  })

  it('uploads the layer ids unchanged when there are no variants', () => {
    const l = make(undefined)
    const { gl, calls } = fakeGL()
    const r = new TileLayerRenderer(gl)
    r.prepare(world(l), 0)
    expect(lastIndexData(calls)).toBe(l.tiles)
  })
})
