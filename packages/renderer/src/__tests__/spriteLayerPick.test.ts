import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpriteLayer, SPRITE_FLIP_X, SPRITE_HIDDEN, NO_SPRITE } from '../spriteLayer'

afterEach(() => vi.restoreAllMocks())

/** A 2x1 grid atlas image (cells 16x16): cell 0 opaque only in its top-left 8x8, cell 1 fully opaque. */
function maskedImage() {
  const w = 32
  const h = 16
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) px[(y * w + x) * 4 + 3] = x >= 16 || (x < 8 && y < 8) ? 255 : 0
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = createElement(tag)
    if (tag === 'canvas')
      Object.defineProperty(el, 'getContext', {
        configurable: true,
        value: () => ({ drawImage() {}, getImageData: () => ({ data: px }) }),
      })
    return el
  })
  return { width: w, height: h } as unknown as HTMLCanvasElement
}

describe('SpriteLayer picking', () => {
  it('hit region from the frame table finds padded cells by their footprint only', () => {
    const l = new SpriteLayer({
      image: { width: 64, height: 32 } as unknown as HTMLCanvasElement,
      // 32x32 cell, building footprint is the bottom 32x12 strip
      frames: [{ x: 0, y: 0, w: 32, h: 32, hit: { x: 0, y: 20, w: 32, h: 12 } }],
      anchorX: 0.5,
      anchorY: 1,
    })
    l.add(100, 100, 32, 32, 0, 7) // quad spans x 84..116, y 68..100; footprint y 88..100
    expect(l.pick(100, 70)).toBe(NO_SPRITE) // transparent roof corner: not a hit
    expect(l.pick(100, 95)).toBe(7)
    expect(l.pickId(100, 70)).toBeUndefined()
    expect(l.pickId(100, 95)).toBe(7)
    expect(l.pickIndex(100, 70)).toBe(-1)
  })

  it('atlas-level hit rect applies to every grid cell; per-sprite fractions override it', () => {
    const l = new SpriteLayer({
      image: { width: 32, height: 16 } as unknown as HTMLCanvasElement,
      frameWidth: 16,
      frameHeight: 16,
      hit: { x: 4, y: 4, w: 8, h: 8 },
      anchorX: 0,
      anchorY: 0,
    })
    l.add(0, 0, 16, 16, 0, 1)
    expect(l.pickIndex(1, 1)).toBe(-1)
    expect(l.pickIndex(8, 8)).toBe(0)
    l.setHitRect(0, 0, 0, 0.25, 0.25) // override: top-left quarter
    expect(l.pickIndex(1, 1)).toBe(0)
    expect(l.pickIndex(8, 8)).toBe(-1)
    l.setHitRect(0) // clear
    expect(l.pickIndex(8, 8)).toBe(0)
  })

  it('opaque bounds are read from the atlas alpha, per frame', () => {
    const l = new SpriteLayer({
      image: maskedImage(),
      frameWidth: 16,
      frameHeight: 16,
      hit: 'opaque',
      anchorX: 0,
      anchorY: 0,
    })
    l.add(0, 0, 32, 32, 0) // cell 0: opaque 8x8 top-left -> quad 32: hit x,y in [0,16)
    l.add(100, 0, 32, 32, 1) // cell 1 fully opaque
    expect(l.pickIndex(10, 10)).toBe(0)
    expect(l.pickIndex(20, 20)).toBe(-1)
    expect(l.pickIndex(120, 20)).toBe(1)
  })

  it('markAtlasDirty makes alpha picks read the repainted pixels', () => {
    const px = new Uint8ClampedArray(16 * 16 * 4).fill(255)
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = createElement(tag)
      if (tag === 'canvas')
        Object.defineProperty(el, 'getContext', {
          configurable: true,
          value: () => ({ drawImage() {}, getImageData: () => ({ data: px }) }),
        })
      return el
    })
    const image = { width: 16, height: 16, naturalWidth: 16, naturalHeight: 16 } as unknown as HTMLCanvasElement
    const l = new SpriteLayer({ image, frameWidth: 16, frameHeight: 16, anchorX: 0, anchorY: 0 })
    const a = l.add(0, 0, 16, 16, 0)
    expect(l.pickIndex(8, 8, { alpha: 10 })).toBe(a)
    px.fill(0) // repaint the canvas fully transparent, then tell the layer
    l.markAtlasDirty(0)
    expect(l.pickIndex(8, 8, { alpha: 10 })).toBe(-1)
  })

  it('alpha test rejects transparent texels inside the hit rect, honouring flips', () => {
    const l = new SpriteLayer({ image: maskedImage(), frameWidth: 16, frameHeight: 16, anchorX: 0, anchorY: 0 })
    const a = l.add(0, 0, 16, 16, 0)
    expect(l.pickIndex(12, 12)).toBe(a) // whole quad, no alpha test
    expect(l.pickIndex(12, 12, { alpha: 10 })).toBe(-1)
    expect(l.pickIndex(4, 4, { alpha: 10 })).toBe(a)
    l.pickAlpha = 10
    expect(l.pickIndex(12, 12)).toBe(-1)
    // flipping around the anchor mirrors both the quad and the texel lookup
    l.flags[a] |= SPRITE_FLIP_X
    expect(l.pickIndex(-4, 4)).toBe(a)
    expect(l.pickIndex(4, 4)).toBe(-1)
  })

  it('pickAll returns every sprite at the point, topmost first, skipping hidden ones', () => {
    const l = new SpriteLayer({ sortByKey: true })
    for (let i = 0; i < 3; i++) {
      l.add(0, 0, 10, 10, 0, 10 + i)
      l.sortKey[i] = i
    }
    l.add(50, 50, 10, 10, 0, 99)
    expect(l.pickAll(0, 0)).toEqual([12, 11, 10])
    l.flags[1] |= SPRITE_HIDDEN
    expect(l.pickAll(0, 0)).toEqual([12, 10])
    expect(l.pickAll(500, 500)).toEqual([])
    expect(l.pickAllIndices(0, 0)).toEqual([2, 0])
  })

  it('pickNearest finds the closest hit rect within the radius; inside beats near; ties go on top', () => {
    const l = new SpriteLayer()
    l.add(0, 0, 10, 10, 0, 1) // x -5..5
    l.add(20, 0, 10, 10, 0, 2) // x 15..25
    expect(l.pickNearest(10, 0, 3)).toBeUndefined() // 5 away from both
    expect(l.pickNearest(10, 0, 5)).toBe(2) // equal distance: the later (top) sprite wins
    expect(l.pickNearest(7, 0, 5)).toBe(1) // 2 away from sprite 1, 8 from sprite 2
    expect(l.pickNearest(0, 0, 0)).toBe(1) // inside, radius 0
    l.add(0, 0, 4, 4, 0, 3) // small sprite on top of sprite 1
    expect(l.pickNearest(0, 0, 10)).toBe(3)
    expect(l.pickNearestIndex(1000, 1000, 5)).toBe(-1)
  })

  it('maps string keys to stable int32 ids and back', () => {
    const l = new SpriteLayer()
    const i = l.add(0, 0, 10, 10, 0, 'person:42')
    l.add(30, 0, 10, 10, 0, 'person:43')
    l.add(60, 0, 10, 10, 0, 'person:42') // same key, same id
    expect(l.ids[i]).toBe(l.intern('person:42'))
    expect(l.ids[2]).toBe(l.ids[0])
    expect(l.pickKey(0, 0)).toBe('person:42')
    expect(l.pickKey(30, 0)).toBe('person:43')
    expect(l.pickKey(500, 0)).toBeUndefined()
    expect(l.keyOf(5)).toBeUndefined()
    expect(l.ids[i]).toBeGreaterThanOrEqual(0x40000000)
  })

  it('per-sprite hit rects survive growth and swap-remove', () => {
    const l = new SpriteLayer({ capacity: 2, anchorX: 0, anchorY: 0 })
    for (let i = 0; i < 40; i++) l.add(i * 100, 0, 10, 10, 0, i)
    l.setHitRect(39, 0, 0, 0.5, 0.5)
    l.removeAt(0) // sprite 39 moves into slot 0
    expect(l.ids[0]).toBe(39)
    expect(l.pickIndex(3900 + 2, 2)).toBe(0)
    expect(l.pickIndex(3900 + 8, 8)).toBe(-1)
    expect(l.pickIndex(100 + 8, 8)).toBe(1) // others keep the full quad
  })

  it('picks around the sprite pivot and per-sprite anchors survive growth and swap-remove', () => {
    const l = new SpriteLayer({
      image: { width: 32, height: 32 } as unknown as HTMLCanvasElement,
      frames: [{ x: 0, y: 0, w: 32, h: 32, pivot: { x: 16, y: 32 } }],
      capacity: 2,
    })
    l.add(100, 100, 32, 32, 0, 1) // bottom-centre pivot: quad x 84..116, y 68..100
    expect(l.pickIndex(100, 90)).toBe(0)
    expect(l.pickIndex(100, 110)).toBe(-1)
    for (let i = 0; i < 40; i++) l.add(1000 + i * 100, 0, 10, 10, 0, 10 + i)
    l.setAnchor(40, 0, 0) // top-left anchor for the last sprite (slot 40, x 4900)
    l.removeAt(1) // slot 40 moves into slot 1
    expect(l.ids[1]).toBe(49)
    expect(l.pickIndex(4905, 5)).toBe(1)
    expect(l.pickIndex(4895, -5)).toBe(-1)
    expect(l.pickIndex(100, 90)).toBe(0)
  })
})
