import { describe, expect, it } from 'vitest'
import { ECSWorld } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { createRecordingCanvas, installHeadlessCanvasDOM } from '../testing/recordingGL'
import { createFakeGlyphCanvas } from '../testing/fakeGlyphCanvas'
import { GlyphAtlas, TextLayer, TEXT_HIDDEN, TEXT_WORD_WRAP } from '../textLayer'
import { SpriteLayer } from '../spriteLayer'
import { createCamera2D } from '../components/camera2d'

function atlas(opts: ConstructorParameters<typeof GlyphAtlas>[0] = {}) {
  const fake = createFakeGlyphCanvas()
  return { atlas: new GlyphAtlas({ ...opts, createCanvas: fake.createCanvas }), fake }
}

function setup(layers: { text?: TextLayer[]; sprite?: SpriteLayer[] }) {
  installHeadlessCanvasDOM()
  const canvas = createRecordingCanvas(400, 300)
  const rs = new RenderSystem(canvas, new Map())
  const world = new ECSWorld()
  const cam = world.createEntity()
  world.addComponent(cam, createCamera2D({ x: 200, y: 150, zoom: 1 }))
  for (const l of layers.sprite ?? []) rs.addSpriteLayer(l)
  for (const l of layers.text ?? []) rs.addTextLayer(l)
  return { rs, world, gl: canvas.gl }
}

describe('GlyphAtlas', () => {
  it('rasterises each glyph once per style and shares pages', () => {
    const { atlas: a, fake } = atlas()
    const s = a.style({ fontSize: 10 })
    const g1 = a.glyph(s, 65)
    const g2 = a.glyph(s, 65)
    expect(g2).toBe(g1)
    expect(fake.drawn).toEqual(['A'])
    expect(g1.w).toBeGreaterThan(0)
    expect(a.glyph(s, 32).w).toBe(0) // space draws nothing
    const s2 = a.style({ fontSize: 10, outlineColor: '#000', outlineWidth: 2 })
    expect(s2).not.toBe(s)
    expect(a.style({ fontSize: 10 })).toBe(s)
    expect(a.glyph(s2, 65)).not.toBe(g1)
    expect(a.pages).toHaveLength(1)
  })

  it('distinguishes font weight in the style key', () => {
    const { atlas: a } = atlas()
    expect(a.style({ weight: 'bold' })).not.toBe(a.style({ weight: 'normal' }))
    expect(a.style({ weight: 'bold' }).font).toContain('bold')
  })

  it('resets and bumps generation when every page is full', () => {
    const { atlas: a } = atlas({ pageSize: 64, maxPages: 1 })
    const s = a.style({ fontSize: 8 })
    const gen = a.generation
    for (let cp = 33; cp < 33 + 200; cp++) a.glyph(s, cp)
    expect(a.generation).toBeGreaterThan(gen)
  })
})

describe('TextLayer layout', () => {
  it('measures, aligns and wraps', () => {
    const { atlas: a } = atlas()
    const layer = new TextLayer({ atlas: a, fontSize: 10 })
    // raster size = 20 (resolution 2): each glyph advances 12 raster px = 6 world px
    const i = layer.add('abcd', 0, 0)
    expect(layer.measure(i).width).toBeCloseTo(24)
    expect(layer.layout(i).lines).toBe(1)
    const j = layer.add('ab cd ef', 0, 0, { wordWrap: true, maxWidth: 20 })
    expect(layer.flags[j] & TEXT_WORD_WRAP).toBeTruthy()
    const lay = layer.layout(j)
    expect(lay.lines).toBe(3)
    expect(layer.measure(j).height).toBeCloseTo(3 * 12) // 3 lines x 1.2 x 10
    const k = layer.add('a\nbb', 0, 0)
    expect(layer.layout(k).lines).toBe(2)
    expect(layer.layout(k).width).toBeCloseTo(12 * 2)
  })

  it('re-lays out only when inputs change', () => {
    const { atlas: a } = atlas()
    const layer = new TextLayer({ atlas: a })
    const i = layer.add('hello', 0, 0)
    const l1 = layer.layout(i)
    expect(layer.layout(i)).toBe(l1)
    layer.setText(i, 'world')
    expect(layer.layout(i)).not.toBe(l1)
    expect(layer.layout(i).text).toBe('world')
  })

  it('swap-removes runs together with their layouts and picks the topmost', () => {
    const { atlas: a } = atlas()
    const layer = new TextLayer({ atlas: a, fontSize: 10 })
    layer.add('aaaa', 0, 0, { id: 7 })
    layer.add('bb', 100, 100, { id: 8 })
    layer.layout(1)
    expect(layer.pick(100, 100)).toBe(8)
    layer.removeAt(0)
    expect(layer.count).toBe(1)
    expect(layer.texts[0]).toBe('bb')
    expect(layer.ids[0]).toBe(8)
    expect(layer.pick(100, 100)).toBe(8)
    expect(layer.pick(-50, -50)).toBe(-1)
  })
})

describe('TextLayer rendering', () => {
  it('draws 1,000 labels in one instanced draw call with one texture', () => {
    const { atlas: a } = atlas()
    const layer = new TextLayer({ atlas: a, fontSize: 10 })
    for (let i = 0; i < 1000; i++) layer.add(`n${i % 10}`, (i % 40) * 10, Math.floor(i / 40) * 10 - 100, { anchorX: 0 })
    const { rs, world, gl } = setup({ text: [layer] })
    // Wide camera so everything is visible.
    world.getComponent<{ zoom: number; x: number; y: number }>(world.queryOne('Camera2D')!, 'Camera2D')!.zoom = 0.2
    rs.update(world, 1 / 60)
    const draws = gl.draws.filter((d) => d.kind === 'instanced')
    expect(draws).toHaveLength(1)
    expect(draws[0].count).toBe(2000)
    expect(rs.getStats().drawCalls).toBe(1)
    const row = rs.stats.layers.find((l) => l.kind === 'text')!
    expect(row.drawCalls).toBe(1)
    expect(row.instances).toBe(2000)
    expect(row.uploadBytes).toBeGreaterThan(0)
  })

  it('culls runs outside the view and skips hidden runs', () => {
    const { atlas: a } = atlas()
    const layer = new TextLayer({ atlas: a, fontSize: 10 })
    layer.add('ab', 200, 150)
    layer.add('ab', 9000, 150)
    const h = layer.add('ab', 200, 150)
    layer.flags[h] |= TEXT_HIDDEN
    const { rs, world, gl } = setup({ text: [layer] })
    rs.update(world, 1 / 60)
    expect(gl.draws.filter((d) => d.kind === 'instanced')[0].count).toBe(2)
  })

  it('sorts with sprite layers by zIndex', () => {
    const { atlas: a } = atlas()
    const low = new TextLayer({ atlas: a, zIndex: 1 })
    low.add('x', 200, 150)
    const high = new TextLayer({ atlas: a, zIndex: 9 })
    high.add('y', 200, 150)
    const sprites = new SpriteLayer({ zIndex: 5 })
    sprites.add(200, 150, 10, 10)
    sprites.add(210, 150, 10, 10)
    const { rs, world, gl } = setup({ text: [high, low], sprite: [sprites] })
    rs.update(world, 1 / 60)
    // text(z1) 1 glyph, sprites(z5) 2, text(z9) 1 glyph
    expect(gl.draws.map((d) => d.count)).toEqual([1, 2, 1])
  })

  it('uploads the atlas page once and only sub-rects afterwards', () => {
    const { atlas: a } = atlas()
    const layer = new TextLayer({ atlas: a })
    const i = layer.add('abc', 200, 150)
    const { rs, world, gl } = setup({ text: [layer] })
    rs.update(world, 1 / 60)
    const tex = gl.draws.find((d) => d.kind === 'instanced')!.texture!
    expect(tex.uploads).toBe(1)
    rs.update(world, 1 / 60)
    expect(tex.uploads).toBe(1)
    layer.setText(i, 'abcd')
    rs.update(world, 1 / 60)
    expect(tex.uploads).toBe(2) // one sub-rect for the new glyph
    expect(rs.getStats().textureCount).toBeGreaterThan(0)
  })
})

describe('TextLayer zoom-aware raster density', () => {
  it('steps up with zoom x dpr, with hysteresis, and only re-rasterises on a change', () => {
    const { atlas: a, fake } = atlas() // resolution 2
    const layer = new TextLayer({ atlas: a, fontSize: 10 })
    const i = layer.add('A', 0, 0)
    layer.updateDensity(1)
    expect(layer.rasterScale).toBe(1)
    const lay1 = layer.layout(i)
    expect(layer.atlasStyle(0).rasterSize).toBe(20)
    layer.updateDensity(2) // exactly the atlas resolution: still crisp
    expect(layer.rasterScale).toBe(1)
    layer.updateDensity(3)
    expect(layer.rasterScale).toBe(2)
    layer.updateDensity(8)
    expect(layer.rasterScale).toBe(4)
    expect(layer.atlasStyle(0).rasterSize).toBe(80)
    const lay4 = layer.layout(i)
    expect(lay4).not.toBe(lay1) // re-laid out in the new raster size
    expect(layer.measure(i).width).toBeCloseTo(6) // world size is unchanged
    layer.updateDensity(5) // hysteresis: stays at 4x until well below
    expect(layer.rasterScale).toBe(4)
    layer.updateDensity(1)
    expect(layer.rasterScale).toBe(1)
    // the 1x glyphs are still cached: going back costs no new rasterisation
    const drawn = fake.drawn.length
    layer.layout(i)
    expect(fake.drawn.length).toBe(drawn)
    // stable zoom does no work: same layout object, no new glyphs
    const l = layer.layout(i)
    layer.updateDensity(1)
    expect(layer.layout(i)).toBe(l)
  })

  it('can be switched off, and the renderer feeds it the camera density', () => {
    const { atlas: a } = atlas()
    const off = new TextLayer({ atlas: a, zoomAware: false })
    off.updateDensity(16)
    expect(off.rasterScale).toBe(1)
    const on = new TextLayer({ atlas: a, fontSize: 10 })
    on.add('hi', 200, 150)
    const { rs, world } = setup({ text: [on] })
    world.getComponent<{ zoom: number }>(world.queryOne('Camera2D')!, 'Camera2D')!.zoom = 4
    rs.update(world, 1 / 60)
    expect(on.rasterScale).toBe(2) // zoom 4 x dpr 1 over resolution 2
  })
})

describe('TextLayer draw order (radix sort)', () => {
  it('a rebuild and a later shuffle both match the comparator order', () => {
    const { atlas: a } = atlas()
    const layer = new TextLayer({ atlas: a, fontSize: 10, sortByKey: true })
    let s = 5
    const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32
    const reference = () =>
      Array.from({ length: layer.count }, (_, i) => i).sort((x, y) => layer.sortKey[x] - layer.sortKey[y] || x - y)
    for (let i = 0; i < 1500; i++) {
      layer.add('x', 0, 0)
      layer.sortKey[i] = next() < 0.3 ? Math.floor(next() * 4) : (next() - 0.5) * 900
    }
    expect(Array.from(layer.drawOrder().subarray(0, layer.count))).toEqual(reference())
    // Keys move a little: the steady insertion sort path, same answer.
    for (let i = 0; i < 1500; i += 3) layer.sortKey[i] += 0.5
    expect(Array.from(layer.drawOrder().subarray(0, layer.count))).toEqual(reference())
  })
})
