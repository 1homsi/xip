import type { Sampling } from './textureFilter'
import type { LayerBlendMode } from './blendModes'
import { registerSpriteLayerRenderer } from './layerRegistry'
import { radixSortOrder } from './radixSort'
import { SpriteLayerRenderer } from './spriteLayerGL'
import { SPRITE_FLIP_X, SPRITE_FLIP_Y, SPRITE_HIDDEN, SPRITE_UNTEXTURED } from './spriteLayerFlags'
import { frameRect, opaqueBounds, readAtlasMask, type AtlasMask, type FrameHit, type PickSource } from './spritePick'

export type { FrameHit, PickSource } from './spritePick'

/**
 * What `pick()` returns for "nothing here". `-1` is also a valid caller id (ids are Int32),
 * so prefer `pickId()` / `pickKey()` / `pickIndex()` (-1 is never an index), which cannot be confused with an id.
 */
export const NO_SPRITE = -1

export interface PickOptions {
  /**
   * Only count texels whose alpha is above this (0-255) as hits. Reads the atlas
   * pixels once (cached; call `invalidateHitMasks()` after repainting a dynamic canvas).
   * Default: the layer's `pickAlpha` (0 = off).
   */
  alpha?: number
}

export {
  ATLASES_PER_DRAW,
  MAX_LAYER_ATLASES,
  SPRITE_FLIP_X,
  SPRITE_FLIP_Y,
  SPRITE_HIDDEN,
  SPRITE_UNTEXTURED,
  SPRITE_SWAY,
  SPRITE_ADDITIVE,
} from './spriteLayerFlags'

export type SpriteLayerImage = HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas

/** One frame of an atlas frame table, in texture pixels (origin top-left). */
export interface AtlasFrame {
  x: number
  y: number
  w: number
  h: number
  /** Hit region for picking in frame pixels (e.g. a building's footprint), or `'opaque'`. Default: the whole frame. */
  hit?: FrameHit
  /** Pivot in frame pixels from the frame's top-left (e.g. a building's base centre). Default: the layer anchor. */
  pivot?: { x: number; y: number }
}

/** One texture of a sprite layer, sliced into a uniform grid or an explicit frame table. */
export interface LayerAtlas {
  src?: string
  image?: SpriteLayerImage
  /** A dynamic canvas id from useDynamicCanvas or `engine.createDynamicCanvas`. */
  dynamicSrc?: string
  /** Grid cell size in texture pixels; `frame` indexes cells row-major. Omit for one whole-texture frame. */
  frameWidth?: number
  frameHeight?: number
  frameColumns?: number
  /**
   * Bumped by {@link SpriteLayer.markAtlasDirty}: when it changes, an `image` that is a canvas
   * (or any mutable source) is uploaded to the GPU again. Ignored for `src` and `dynamicSrc`.
   */
  imageVersion?: number
  /**
   * Hit region for picking, in frame pixels, applied to every grid cell (frame
   * tables use per-frame `hit`): a rect, or `'opaque'` for the bounds of each frame's
   * non-transparent pixels. Default: the whole frame.
   */
  hit?: FrameHit
  /**
   * Pivot (the point that sits at the sprite's x, y and that it rotates around), in frame
   * pixels from the frame's top-left, applied to every grid cell (needs `frameWidth`/`frameHeight`).
   * Frame tables use per-frame `pivot`. Default: the layer's `anchorX`/`anchorY`.
   */
  pivot?: { x: number; y: number }
  /** Grid only: pixels between cells. Default 0. */
  frameSpacing?: number
  /** Grid only: pixels around the atlas edge before the first cell. Default 0. */
  frameMargin?: number
  /**
   * Explicit frame rects in texture pixels, indexed by the sprite's `frame`
   * (irregular atlases, no repacking). When set it replaces the grid. Sprites whose
   * `frame` is out of range are not drawn. Replace the array (or call
   * `layer.touch()`) after editing it.
   */
  frames?: AtlasFrame[]
  /**
   * Shrink every frame's UV rect by this many texture pixels on each side
   * (grid and frame table) so linear filtering and mipmaps do not bleed in
   * neighbouring cells. Default 0.
   */
  inset?: number
  /** Texture filtering for this atlas; falls back to the layer's `sampling`, then the engine default. */
  sampling?: Sampling
}

/**
 * Vertex sway for sprites with SPRITE_SWAY (trees, grass, banners), evaluated
 * on the GPU from a time uniform: no per-frame CPU rewrite of the sprites.
 * The top of each quad moves horizontally, the base stays put.
 */
export interface SpriteLayerWind {
  /** Peak sideways offset of the top, as a fraction of the sprite height. Default 0.04. */
  amplitude?: number
  /** Sway cycles per second. Default 0.5. */
  speed?: number
  /** Phase change per world pixel along x, so neighbours do not sway in lockstep (radians). Default 0.01. */
  frequency?: number
  /**
   * Whole-pixel sway for pixel art: the offset is quantised to this step in world
   * pixels (`true` = 1) and the canopy moves rigidly, so texels stay on the pixel
   * grid. The quad is grown sideways by the maximum sway and the fragment shader
   * shifts the texels, so atlas frames must have transparent room only if you use
   * `sampling: 'linear'`. Sprites should have a positive width.
   */
  snap?: number | boolean
  /**
   * Fraction of the sprite height, measured from the base, that stays fixed
   * (0..0.99). Above it the sprite bends. Default 0 (smooth) or 0.5 (`snap`),
   * so a tree trunk stays put while only the canopy moves.
   */
  fromY?: number
}

export interface SpriteLayerOptions extends LayerAtlas {
  /** Initial capacity; grows automatically. */
  capacity?: number
  /**
   * Several textures (up to {@link MAX_LAYER_ATLASES}); each sprite picks one with
   * `atlas[i]`. Atlases are bound in groups of {@link ATLASES_PER_DRAW}: sprites whose
   * atlases share a group (`atlas >> 3`) draw in one call, a change of group in draw
   * order starts a new one. When omitted, `src`/`image`/`dynamicSrc` + frame
   * size form atlas 0.
   */
  atlases?: LayerAtlas[]
  /** Draw (and pick) in ascending `sortKey[i]` order, e.g. y for depth. Default: insertion order. */
  sortByKey?: boolean
  /** Render layer name and z-index, sorted together with regular sprites. */
  layer?: string
  zIndex?: number
  /** Label shown in the per-layer stats (`stats.layers`). Defaults to `layer`. */
  name?: string
  sampling?: Sampling
  anchorX?: number
  anchorY?: number
  visible?: boolean
  /** Default alpha threshold (0-255) for picking; 0 (default) hits the whole hit rect. */
  pickAlpha?: number
  /** GPU sway for sprites with SPRITE_SWAY. */
  wind?: SpriteLayerWind | null
  /** Whole-layer opacity multiplier 0..1. Default 1. */
  opacity?: number
  /** Whole-layer colour multiplier, 0xRRGGBBAA (alpha multiplies opacity). Default 0xffffffff. */
  tintColor?: number
  /** How the layer blends onto what is below it. Default 'normal'. */
  blend?: LayerBlendMode
}

/**
 * Struct-of-arrays sprite batch for data-driven games: thousands of sprites
 * written straight from simulation data, no entity or React node per sprite.
 * Write the arrays directly and call `touch()`, or use `set()`.
 */
export class SpriteLayer {
  count = 0
  capacity = 0
  version = 0
  /** @internal retained-buffer dirty tracking, consumed by the renderer. */
  _dAll = true
  _dLo = 0x7fffffff
  _dHi = -1
  _repack = false
  x!: Float32Array
  y!: Float32Array
  w!: Float32Array
  h!: Float32Array
  rotation!: Float32Array
  frame!: Uint32Array
  /** Index into `atlases` per sprite. */
  atlas!: Uint8Array
  /** 0xRRGGBBAA tint multiplied with the texture (or the fill color without one). */
  color!: Uint32Array
  /** Bit flags: SPRITE_FLIP_X | SPRITE_FLIP_Y | SPRITE_HIDDEN | SPRITE_UNTEXTURED | SPRITE_SWAY. */
  flags!: Uint8Array
  /**
   * Draw order key when `sortByKey` is set (lower draws first). Float64: depths
   * 0.0001 apart stay distinct at y = 4000 (a float32 key collapses them).
   */
  sortKey!: Float64Array
  /**
   * Optional secondary key (allocate with {@link enableSortKey2}): sprites with an
   * equal `sortKey` draw in ascending `sortKey2`, then in slot order.
   */
  sortKey2: Float64Array | null = null
  /** Caller ids returned by pick(); defaults to the index at insertion. */
  ids!: Int32Array

  atlases: LayerAtlas[]
  sortByKey: boolean
  layer: string
  zIndex: number
  /** Label in the per-layer stats. */
  name: string
  sampling: Sampling | undefined
  anchorX: number
  anchorY: number
  visible: boolean
  /** Default alpha threshold (0-255) for picking; 0 = off. */
  pickAlpha: number
  /**
   * Per-sprite anchor override, 2 floats per sprite (anchorX, anchorY as fractions of the quad);
   * NaN in the first = use the frame / atlas pivot or the layer anchor. Null until {@link enableAnchors}.
   */
  anchor: Float32Array | null = null
  /**
   * Additive colour per sprite, 0xRRGGBB, ADDED to the sprite's colour after tint (scaled by its
   * alpha): brighten, flash or glow, where `color` can only darken. Null until {@link enableColorAdd}.
   */
  colorAdd: Uint32Array | null = null
  /**
   * Per-sprite hit rect override, 4 floats per sprite (x0, y0, x1, y1) as fractions of the
   * sprite's quad; NaN in x0 = none. Null until {@link enableHitRects}.
   */
  hit: Float32Array | null = null
  /**
   * Where picking reads atlas pixels from (set by the RenderSystem: loaded `src` images and
   * dynamic canvases); atlases with an `image` need no resolver.
   */
  pixelSource: ((atlas: LayerAtlas) => PickSource | undefined) | null = null

  private _masks = new Map<LayerAtlas, AtlasMask | null>()
  private _keyIds = new Map<string, number>()
  private _keys: string[] = []

  /**
   * Called after any mutation through the layer's methods and `touch()`. The React hook uses it
   * to wake an `onDemand` loop. Direct typed-array writes are not seen: call `touch()` after them.
   */
  onChange: (() => void) | null = null

  private _opacity: number
  private _wind: SpriteLayerWind | null
  /**
   * Optional per-sprite sway multiplier (default 1) for sprites with SPRITE_SWAY,
   * e.g. a stiff oak 0.3 and tall grass 1.5. Allocated by `ensureSwayScale()`.
   */
  swayScale: Float32Array | null = null
  private _tintColor: number
  private _blend: LayerBlendMode
  private _order = new Int32Array(0)
  private _inOrder = new Uint8Array(0)
  private _scratch = new Int32Array(0)
  private _orderCount = 0
  /** Sprites in the last {@link drawOrder} (visible ones only when `sortByKey`). */
  orderCount = 0

  constructor(options: SpriteLayerOptions = {}) {
    registerSpriteLayerRenderer((gl) => new SpriteLayerRenderer(gl))
    const {
      src,
      image,
      dynamicSrc,
      frameWidth,
      frameHeight,
      frameColumns,
      frameSpacing,
      frameMargin,
      frames,
      inset,
      hit,
    } = options
    this.atlases = options.atlases ?? [
      { src, image, dynamicSrc, frameWidth, frameHeight, frameColumns, frameSpacing, frameMargin, frames, inset, hit },
    ]
    this.sortByKey = options.sortByKey ?? false
    this.layer = options.layer ?? 'default'
    this.zIndex = options.zIndex ?? 0
    this.name = options.name ?? this.layer
    this.sampling = options.sampling
    this.anchorX = options.anchorX ?? 0.5
    this.anchorY = options.anchorY ?? 0.5
    this.visible = options.visible ?? true
    this.pickAlpha = options.pickAlpha ?? 0
    this._opacity = options.opacity ?? 1
    this._wind = options.wind ?? null
    this._tintColor = (options.tintColor ?? 0xffffffff) >>> 0
    this._blend = options.blend ?? 'normal'
    this.grow(Math.max(16, options.capacity ?? 256))
  }

  /** Wind for SPRITE_SWAY sprites; `null` turns the sway off. Time-driven: the loop must keep rendering. */
  get wind(): SpriteLayerWind | null {
    return this._wind
  }
  set wind(v: SpriteLayerWind | null) {
    this._wind = v
    this._dAll = true
    this.changed()
  }

  /** Allocate (filled with 1) and return the per-sprite sway multiplier array. */
  ensureSwayScale(): Float32Array {
    this._dAll = true
    if (!this.swayScale || this.swayScale.length < this.capacity) {
      const next = new Float32Array(this.capacity).fill(1)
      if (this.swayScale) next.set(this.swayScale.subarray(0, this.count))
      this.swayScale = next
    }
    return this.swayScale
  }

  get opacity(): number {
    return this._opacity
  }
  set opacity(v: number) {
    if (v === this._opacity) return
    this._opacity = v
    this.changed()
  }
  get tintColor(): number {
    return this._tintColor
  }
  set tintColor(v: number) {
    v >>>= 0
    if (v === this._tintColor) return
    this._tintColor = v
    this.changed()
  }
  get blend(): LayerBlendMode {
    return this._blend
  }
  set blend(v: LayerBlendMode) {
    if (v === this._blend) return
    this._blend = v
    this.changed()
  }

  /** Atlas 0's url (single-atlas shorthand). */
  get src(): string | undefined {
    return this.atlases[0]?.src
  }
  set src(v: string | undefined) {
    this.atlas0().src = v
    this.touch()
  }
  get image(): SpriteLayerImage | undefined {
    return this.atlases[0]?.image
  }
  set image(v: SpriteLayerImage | undefined) {
    this.atlas0().image = v
    this.touch()
  }
  get dynamicSrc(): string | undefined {
    return this.atlases[0]?.dynamicSrc
  }
  set dynamicSrc(v: string | undefined) {
    this.atlas0().dynamicSrc = v
    this.touch()
  }
  get frameWidth(): number {
    return this.atlases[0]?.frameWidth ?? 0
  }
  set frameWidth(v: number) {
    this.atlas0().frameWidth = v
    this.touch()
  }
  get frameHeight(): number {
    return this.atlases[0]?.frameHeight ?? 0
  }
  set frameHeight(v: number) {
    this.atlas0().frameHeight = v
    this.touch()
  }
  get frameColumns(): number | undefined {
    return this.atlases[0]?.frameColumns
  }
  set frameColumns(v: number | undefined) {
    this.atlas0().frameColumns = v
    this.touch()
  }

  private atlas0(): LayerAtlas {
    if (this.atlases.length === 0) this.atlases.push({})
    return this.atlases[0]
  }

  private grow(capacity: number): void {
    const copy = <T extends Float32Array | Float64Array | Uint32Array | Uint8Array | Int32Array>(
      old: T | undefined,
      make: new (n: number) => T,
    ): T => {
      const next = new make(capacity)
      if (old) next.set(old.subarray(0, this.count))
      return next
    }
    this.x = copy(this.x, Float32Array)
    this.y = copy(this.y, Float32Array)
    this.w = copy(this.w, Float32Array)
    this.h = copy(this.h, Float32Array)
    this.rotation = copy(this.rotation, Float32Array)
    this.frame = copy(this.frame, Uint32Array)
    this.atlas = copy(this.atlas, Uint8Array)
    this.color = copy(this.color, Uint32Array)
    this.flags = copy(this.flags, Uint8Array)
    this.sortKey = copy(this.sortKey, Float64Array)
    if (this.sortKey2) this.sortKey2 = copy(this.sortKey2, Float64Array)
    if (this.colorAdd) this.colorAdd = copy(this.colorAdd, Uint32Array)
    if (this.anchor) {
      const next = new Float32Array(capacity * 2).fill(NaN)
      next.set(this.anchor.subarray(0, this.count * 2))
      this.anchor = next
    }
    if (this.hit) {
      const next = new Float32Array(capacity * 4).fill(NaN)
      next.set(this.hit.subarray(0, this.count * 4))
      this.hit = next
    }
    this.ids = copy(this.ids, Int32Array)
    if (this.swayScale) {
      const next = new Float32Array(capacity).fill(1)
      next.set(this.swayScale.subarray(0, this.count))
      this.swayScale = next
    }
    this.capacity = capacity
  }

  /** Make room for `n` sprites, keeping existing data. */
  reserve(n: number): void {
    if (n > this.capacity) this.grow(Math.max(n, this.capacity * 2))
  }

  /** Set the sprite count (new slots are zeroed, white, visible). */
  resize(n: number): void {
    this.reserve(n)
    for (let i = this.count; i < n; i++) this.reset(i, i)
    this.markSlots(Math.min(this.count, n), Math.max(this.count, n))
    this.count = n
    this.changed()
  }

  private reset(i: number, id: number): void {
    this.rotation[i] = 0
    this.frame[i] = 0
    this.atlas[i] = 0
    this.color[i] = 0xffffffff
    this.flags[i] = 0
    this.sortKey[i] = 0
    if (this.sortKey2) this.sortKey2[i] = 0
    if (this.hit) this.hit[i * 4] = NaN
    if (this.anchor) this.anchor[i * 2] = NaN
    if (this.colorAdd) this.colorAdd[i] = 0
    this.ids[i] = id
    if (this.swayScale) this.swayScale[i] = 1
  }

  /** `id` is returned by `pick()`; a string is interned to a number (see {@link intern}). Default: the slot index at insertion. */
  add(x: number, y: number, w: number, h: number, frame = 0, id?: number | string): number {
    const i = this.count
    this.reserve(i + 1)
    this.count = i + 1
    this.markSlots(i, i)
    this.reset(i, typeof id === 'string' ? this.intern(id) : (id ?? i))
    this.x[i] = x
    this.y[i] = y
    this.w[i] = w
    this.h[i] = h
    this.frame[i] = frame
    this.changed()
    return i
  }

  set(i: number, x: number, y: number, frame?: number): void {
    this.x[i] = x
    this.y[i] = y
    if (frame !== undefined) this.frame[i] = frame
    this.markSlots(i, i)
    this.changed()
  }

  /** Swap-remove: the last sprite moves into slot `i`. */
  removeAt(i: number): void {
    const last = --this.count
    this.markSlots(i, i)
    if (i !== last) {
      this.x[i] = this.x[last]
      this.y[i] = this.y[last]
      this.w[i] = this.w[last]
      this.h[i] = this.h[last]
      this.rotation[i] = this.rotation[last]
      this.frame[i] = this.frame[last]
      this.atlas[i] = this.atlas[last]
      this.color[i] = this.color[last]
      this.flags[i] = this.flags[last]
      this.sortKey[i] = this.sortKey[last]
      if (this.sortKey2) this.sortKey2[i] = this.sortKey2[last]
      if (this.hit) this.hit.copyWithin(i * 4, last * 4, last * 4 + 4)
      if (this.anchor) this.anchor.copyWithin(i * 2, last * 2, last * 2 + 2)
      if (this.colorAdd) this.colorAdd[i] = this.colorAdd[last]
      this.ids[i] = this.ids[last]
      if (this.swayScale) this.swayScale[i] = this.swayScale[last]
    }
    this.changed()
  }

  clear(): void {
    this.count = 0
    this.changed()
  }

  /**
   * Call after writing the arrays directly: marks EVERY sprite possibly changed. The renderer keeps
   * the packed instances of unchanged sprites between frames, so it re-checks all of them (cheap
   * compare, repack only what differs). Prefer {@link touchRange} when you know which slots you wrote.
   */
  touch(): void {
    this._dAll = true
    this.changed()
  }

  /**
   * Call after writing sprites `i0 .. i1` (inclusive) directly. Only those slots are re-checked and
   * repacked and only their bytes are uploaded; everything else is reused from the last frame.
   * Several calls between frames merge. Sort keys, hidden flags, atlas/frame/colour are all covered.
   */
  touchRange(i0: number, i1: number = i0): void {
    this.markSlots(i0, i1)
    this.changed()
  }

  /** @internal */
  markSlots(lo: number, hi: number): void {
    if (lo < this._dLo) this._dLo = lo
    if (hi > this._dHi) this._dHi = hi
  }

  /**
   * Re-upload atlas `i`'s `image` on the next frame. Call it after repainting a canvas that is
   * used as `image`; sources that never change need no call.
   */
  markAtlasDirty(i = 0): void {
    const a = this.atlases[i]
    if (!a) return
    a.imageVersion = (a.imageVersion ?? 0) + 1
    this._repack = true
    this.changed()
  }

  private changed(): void {
    this.version++
    this.onChange?.()
  }

  /** Allocate the secondary sort key (zeros). Ties on `sortKey` break on it, then on slot order. */
  enableSortKey2(): Float64Array {
    if (!this.sortKey2) this.sortKey2 = new Float64Array(this.capacity)
    return this.sortKey2
  }

  /**
   * Draw order (indices into the arrays): ascending `sortKey`, then `sortKey2`,
   * then slot, over the first {@link orderCount} entries. With `sortByKey` hidden
   * sprites are left out; without it this is slot order. Updated incrementally from
   * the previous order whatever changed in between (keys drifting, `clear()` + `add()`
   * rebuilds, swap-removes, flag toggles): near-linear when the order is mostly kept,
   * with a fallback to a full sort when it is not.
   */
  drawOrder(): Int32Array {
    const n = this.count
    if (this._order.length < n) {
      const cap = Math.max(n, this._order.length * 2)
      const next = new Int32Array(cap)
      next.set(this._order.subarray(0, this._orderCount))
      this._order = next
      const inOrder = new Uint8Array(cap)
      inOrder.set(this._inOrder)
      this._inOrder = inOrder
    }
    const order = this._order
    if (!this.sortByKey) {
      for (let i = 0; i < n; i++) order[i] = i
      this.orderCount = n
      if (this._orderCount !== 0) {
        this._inOrder.fill(0)
        this._orderCount = 0
      }
      return order
    }
    const inOrder = this._inOrder
    const flags = this.flags
    // Keep the previous order minus sprites that are gone or hidden now ...
    let m = 0
    for (let k = 0; k < this._orderCount; k++) {
      const i = order[k]
      if (i < n && (flags[i] & SPRITE_HIDDEN) === 0) order[m++] = i
      else inOrder[i] = 0
    }
    // ... then append visible sprites that were not in it (new slots, shown again).
    for (let i = 0; i < n; i++) {
      if (inOrder[i] === 0 && (flags[i] & SPRITE_HIDDEN) === 0) {
        order[m++] = i
        inOrder[i] = 1
      }
    }
    this._orderCount = m
    this.orderCount = m
    const K = this.sortKey
    const K2 = this.sortKey2
    // Insertion sort is O(m) for an almost-sorted order; bail out to a full sort if it is not.
    let budget = 8 * m + 256
    for (let i = 1; i < m; i++) {
      const v = order[i]
      const k = K[v]
      let j = i - 1
      while (j >= 0) {
        const a = order[j]
        const ka = K[a]
        if (ka < k || (ka === k && !this.after(a, v, K2))) break
        order[j + 1] = a
        j--
        if (--budget < 0) {
          order[j + 1] = v
          this.fullSort(order, m, K, K2, n)
          return order
        }
      }
      order[j + 1] = v
    }
    return order
  }

  /** Whether slot `a` sorts after slot `v` when their primary keys are equal. */
  private after(a: number, v: number, K2: Float64Array | null): boolean {
    if (K2 !== null) {
      const x = K2[a]
      const y = K2[v]
      if (x !== y) return x > y
    }
    return a > v
  }

  /**
   * Full sort of the `m` visible slots (`_inOrder` marks them, `n` = count). A radix sort
   * over the seeded slot order keeps the slot tie-break; the comparator covers NaN keys.
   */
  private fullSort(order: Int32Array, m: number, K: Float64Array, K2: Float64Array | null, n: number): void {
    const inOrder = this._inOrder
    let j = 0
    for (let i = 0; i < n; i++) if (inOrder[i] === 1) order[j++] = i
    if (this._scratch.length < m) this._scratch = new Int32Array(order.length)
    if (radixSortOrder(order, this._scratch, m, K, K2)) return
    order.subarray(0, m).sort((a, b) => {
      const d = K[a] - K[b]
      if (d !== 0 && d === d) return d
      if (K2 !== null) {
        const e = K2[a] - K2[b]
        if (e !== 0 && e === e) return e
      }
      return a - b
    })
  }

  /** Allocate the additive colour array (zeros = no change). Write 0xRRGGBB, then `touch()`. */
  enableColorAdd(): Uint32Array {
    this._dAll = true
    if (!this.colorAdd) this.colorAdd = new Uint32Array(this.capacity)
    return this.colorAdd
  }

  // ── Anchors / pivots ───────────────────────────────────────────────────────

  /** Allocate the per-sprite anchor override (all unset). */
  enableAnchors(): Float32Array {
    this._dAll = true
    if (!this.anchor) this.anchor = new Float32Array(this.capacity * 2).fill(NaN)
    return this.anchor
  }

  /** Set sprite `i`'s anchor (fractions of its quad); `setAnchor(i)` clears it. */
  setAnchor(i: number, ax?: number, ay?: number): void {
    const a = this.enableAnchors()
    if (ax === undefined) a[i * 2] = NaN
    else {
      a[i * 2] = ax
      a[i * 2 + 1] = ay ?? ax
    }
    this.markSlots(i, i)
    this.changed()
  }

  /** Whether any atlas defines a pivot (grid-wide or in its frame table). */
  hasPivots(): boolean {
    for (const at of this.atlases) {
      if (at.pivot) return true
      if (at.frames) for (const f of at.frames) if (f.pivot) return true
    }
    return false
  }

  /** Resolved anchor of sprite `i` (per-sprite, then frame / atlas pivot, then the layer anchor), into `_ax`/`_ay`. */
  resolveAnchor(i: number, usePivots: boolean): void {
    this._ax = this.anchorX
    this._ay = this.anchorY
    const per = this.anchor
    if (per && per[i * 2] === per[i * 2]) {
      this._ax = per[i * 2]
      this._ay = per[i * 2 + 1]
      return
    }
    if (!usePivots) return
    const atlas = this.atlases[this.atlas[i]]
    if (!atlas || (this.flags[i] & SPRITE_UNTEXTURED) !== 0) return
    const table = atlas.frames
    if (table !== undefined) {
      const f = table[this.frame[i]]
      const p = f?.pivot ?? atlas.pivot
      if (f && p && f.w > 0 && f.h > 0) {
        this._ax = p.x / f.w
        this._ay = p.y / f.h
      }
    } else if (atlas.pivot && (atlas.frameWidth ?? 0) > 0 && (atlas.frameHeight ?? 0) > 0) {
      this._ax = atlas.pivot.x / atlas.frameWidth!
      this._ay = atlas.pivot.y / atlas.frameHeight!
    }
  }

  /** Output of {@link resolveAnchor}. */
  _ax = 0.5
  _ay = 0.5

  // ── Picking ────────────────────────────────────────────────────────────────

  /** Allocate the per-sprite hit rect override (all unset). */
  enableHitRects(): Float32Array {
    if (!this.hit) this.hit = new Float32Array(this.capacity * 4).fill(NaN)
    return this.hit
  }

  /** Set sprite `i`'s hit rect as fractions of its quad (0..1 each); `setHitRect(i)` clears it. */
  setHitRect(i: number, x0?: number, y0?: number, x1?: number, y1?: number): void {
    const h = this.enableHitRects()
    if (x0 === undefined) h[i * 4] = NaN
    else {
      h[i * 4] = x0
      h[i * 4 + 1] = y0!
      h[i * 4 + 2] = x1!
      h[i * 4 + 3] = y1!
    }
  }

  /** Forget cached atlas alpha masks and opaque bounds (call after repainting a dynamic canvas atlas). */
  invalidateHitMasks(): void {
    this._masks.clear()
  }

  /** Stable int32 id for a string key (for `add(..., 'person:42')`); `keyOf` maps it back. Ids start at 2^30. */
  intern(key: string): number {
    let id = this._keyIds.get(key)
    if (id === undefined) {
      id = 0x40000000 + this._keys.length
      this._keyIds.set(key, id)
      this._keys.push(key)
    }
    return id
  }

  /** The string behind an interned id, or undefined. */
  keyOf(id: number): string | undefined {
    return id >= 0x40000000 ? this._keys[id - 0x40000000] : undefined
  }

  private _hx0 = 0
  private _hy0 = 0
  private _hx1 = 0
  private _hy1 = 0
  private readonly _fr = { x: 0, y: 0, w: 0, h: 0 }
  private readonly _frac = new Float32Array(4)

  private maskOf(atlas: LayerAtlas): AtlasMask | null {
    const src = (atlas.image as PickSource | undefined) ?? this.pixelSource?.(atlas)
    if (!src) return null
    let m = this._masks.get(atlas)
    if (m === undefined || (m !== null && m.source !== src)) {
      m = readAtlasMask(src)
      // not loaded / unreadable yet: retry next time instead of caching the miss
      if (m) this._masks.set(atlas, m)
    }
    return m ?? null
  }

  /** Hit region of sprite `i` as fractions of its quad, into `_frac`; false = nothing is hittable. */
  private hitFractions(i: number): boolean {
    const f = this._frac
    f[0] = 0
    f[1] = 0
    f[2] = 1
    f[3] = 1
    const per = this.hit
    if (per && per[i * 4] === per[i * 4]) {
      f[0] = per[i * 4]
      f[1] = per[i * 4 + 1]
      f[2] = per[i * 4 + 2]
      f[3] = per[i * 4 + 3]
      return true
    }
    const a = this.atlas[i]
    const atlas = this.atlases[a]
    if (!atlas || (this.flags[i] & SPRITE_UNTEXTURED) !== 0) return true
    const frame = this.frame[i]
    const table = atlas.frames
    const spec = table !== undefined ? table[frame]?.hit : atlas.hit
    if (spec === undefined) return true
    const fr = this._fr
    if (spec === 'opaque') {
      const m = this.maskOf(atlas)
      if (!m || !frameRect(atlas, frame, m.w, m.h, fr)) return true
      let b = m.bounds.get(frame)
      if (b === undefined) {
        b = opaqueBounds(m, fr, 0)
        m.bounds.set(frame, b)
      }
      if (b === null) return false
      f.set(b)
      return true
    }
    let fw: number
    let fh: number
    if (table !== undefined) {
      const t = table[frame]
      if (!t) return true
      fw = t.w
      fh = t.h
    } else {
      fw = atlas.frameWidth ?? 0
      fh = atlas.frameHeight ?? 0
      if (!(fw > 0 && fh > 0)) {
        const m = this.maskOf(atlas)
        if (!m) return true
        fw = m.w
        fh = m.h
      }
    }
    f[0] = spec.x / fw
    f[1] = spec.y / fh
    f[2] = (spec.x + spec.w) / fw
    f[3] = (spec.y + spec.h) / fh
    return true
  }

  /** World hit rect of sprite `i` into _hx0.._hy1 (rotation ignored); false if not hittable. */
  private hitRect(i: number): boolean {
    let w = this.w[i]
    let h = this.h[i]
    const fl = this.flags[i]
    this.resolveAnchor(i, this._pivots)
    let left = this.x[i] - this._ax * w
    let top = this.y[i] - this._ay * h
    if (fl & SPRITE_FLIP_X) left = this.x[i] - (1 - this._ax) * w
    if (fl & SPRITE_FLIP_Y) top = this.y[i] - (1 - this._ay) * h
    if (w < 0) {
      left += w
      w = -w
    }
    if (h < 0) {
      top += h
      h = -h
    }
    if (!this.hitFractions(i)) return false
    const f = this._frac
    let u0 = f[0],
      u1 = f[2],
      v0 = f[1],
      v1 = f[3]
    if (fl & SPRITE_FLIP_X) {
      const t = u0
      u0 = 1 - u1
      u1 = 1 - t
    }
    if (fl & SPRITE_FLIP_Y) {
      const t = v0
      v0 = 1 - v1
      v1 = 1 - t
    }
    this._hx0 = left + u0 * w
    this._hx1 = left + u1 * w
    this._hy0 = top + v0 * h
    this._hy1 = top + v1 * h
    return true
  }

  /** Whether the texel under the world point is above the alpha threshold (true when it cannot be read). */
  private alphaHit(i: number, wx: number, wy: number, threshold: number): boolean {
    const atlas = this.atlases[this.atlas[i]]
    if (!atlas || (this.flags[i] & SPRITE_UNTEXTURED) !== 0) return true
    const m = this.maskOf(atlas)
    if (!m) return true
    const fr = this._fr
    if (!frameRect(atlas, this.frame[i], m.w, m.h, fr)) return false
    const fl = this.flags[i]
    let w = this.w[i]
    let h = this.h[i]
    this.resolveAnchor(i, this._pivots)
    let left = this.x[i] - this._ax * w
    let top = this.y[i] - this._ay * h
    if (fl & SPRITE_FLIP_X) left = this.x[i] - (1 - this._ax) * w
    if (fl & SPRITE_FLIP_Y) top = this.y[i] - (1 - this._ay) * h
    if (w < 0) {
      left += w
      w = -w
    }
    if (h < 0) {
      top += h
      h = -h
    }
    let u = (wx - left) / w
    let v = (wy - top) / h
    if (fl & SPRITE_FLIP_X) u = 1 - u
    if (fl & SPRITE_FLIP_Y) v = 1 - v
    const tx = Math.min(m.w - 1, Math.max(0, Math.floor(fr.x + u * fr.w)))
    const ty = Math.min(m.h - 1, Math.max(0, Math.floor(fr.y + v * fr.h)))
    return m.alpha[ty * m.w + tx] > threshold
  }

  private _pivots = false

  private visit(): { order: Int32Array | null; n: number } {
    this._pivots = this.hasPivots()
    const order = this.sortByKey ? this.drawOrder() : null
    return { order, n: order ? this.orderCount : this.count }
  }

  /**
   * Topmost sprite index at the world point (rotation ignored), or -1 (never a valid index).
   * The point must be inside the sprite's hit rect (per-sprite `hit`, the frame's / atlas's `hit`,
   * or the whole quad) and, with `alpha` / `pickAlpha`, on a texel above that alpha.
   */
  pickIndex(wx: number, wy: number, opts?: PickOptions): number {
    const { order, n } = this.visit()
    const alpha = opts?.alpha ?? this.pickAlpha
    for (let k = n - 1; k >= 0; k--) {
      const i = order ? order[k] : k
      if (this.flags[i] & SPRITE_HIDDEN) continue
      if (!this.hitRect(i)) continue
      if (wx < this._hx0 || wx >= this._hx1 || wy < this._hy0 || wy >= this._hy1) continue
      if (alpha > 0 && !this.alphaHit(i, wx, wy, alpha)) continue
      return i
    }
    return -1
  }

  /** Every sprite index at the point, topmost first (appended to `out`). */
  pickAllIndices(wx: number, wy: number, out: number[] = [], opts?: PickOptions): number[] {
    const { order, n } = this.visit()
    const alpha = opts?.alpha ?? this.pickAlpha
    for (let k = n - 1; k >= 0; k--) {
      const i = order ? order[k] : k
      if (this.flags[i] & SPRITE_HIDDEN) continue
      if (!this.hitRect(i)) continue
      if (wx < this._hx0 || wx >= this._hx1 || wy < this._hy0 || wy >= this._hy1) continue
      if (alpha > 0 && !this.alphaHit(i, wx, wy, alpha)) continue
      out.push(i)
    }
    return out
  }

  /**
   * Index of the sprite whose hit rect is nearest to the point within `radius` world units
   * (distance 0 when the point is inside; ties go to the topmost), or -1. Ignores `alpha`.
   */
  pickNearestIndex(wx: number, wy: number, radius: number): number {
    const { order, n } = this.visit()
    let best = -1
    let bestD = radius * radius
    for (let k = n - 1; k >= 0; k--) {
      const i = order ? order[k] : k
      if (this.flags[i] & SPRITE_HIDDEN) continue
      if (!this.hitRect(i)) continue
      const dx = wx < this._hx0 ? this._hx0 - wx : wx > this._hx1 ? wx - this._hx1 : 0
      const dy = wy < this._hy0 ? this._hy0 - wy : wy > this._hy1 ? wy - this._hy1 : 0
      const d = dx * dx + dy * dy
      if (d < bestD || (best < 0 && d <= bestD)) {
        best = i
        bestD = d
        if (d === 0) break // topmost sprite containing the point
      }
    }
    return best
  }

  /**
   * Id of the topmost sprite at the world point, or -1. Compatibility: -1 is also a valid
   * Int32 id and {@link NO_SPRITE}; use {@link pickId} or {@link pickIndex} to tell a miss apart.
   */
  pick(wx: number, wy: number, opts?: PickOptions): number {
    const i = this.pickIndex(wx, wy, opts)
    return i < 0 ? NO_SPRITE : this.ids[i]
  }

  /** Id of the topmost sprite at the point, or `undefined` when nothing is there. */
  pickId(wx: number, wy: number, opts?: PickOptions): number | undefined {
    const i = this.pickIndex(wx, wy, opts)
    return i < 0 ? undefined : this.ids[i]
  }

  /** The string key (see {@link intern}) of the topmost sprite at the point, or undefined. */
  pickKey(wx: number, wy: number, opts?: PickOptions): string | undefined {
    const id = this.pickId(wx, wy, opts)
    return id === undefined ? undefined : this.keyOf(id)
  }

  /** Id of the sprite nearest to the point within `radius` (see {@link pickNearestIndex}), or undefined. */
  pickNearest(wx: number, wy: number, radius: number): number | undefined {
    const i = this.pickNearestIndex(wx, wy, radius)
    return i < 0 ? undefined : this.ids[i]
  }

  /** Ids of every sprite at the point, topmost first. */
  pickAll(wx: number, wy: number, opts?: PickOptions): number[] {
    return this.pickAllIndices(wx, wy, [], opts).map((i) => this.ids[i])
  }
}
