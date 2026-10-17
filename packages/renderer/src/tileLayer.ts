import type { LayerBlendMode } from './blendModes'
import type { Component } from '@xip/core'
import { registerTileRenderer } from './layerRegistry'
import { TileLayerRenderer } from './tileLayerGL'

/** Tile id storage. `0` is always empty; id `n` draws atlas tile `n - 1`. */
export type TileIdArray = Uint16Array | Uint32Array

export type TilesetImage = HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas

export interface Tileset {
  /** Loaded atlas image. The `<TileLayer>` component fills this from `src`. */
  image?: TilesetImage
  src?: string
  tileWidth: number
  tileHeight: number
  columns: number
  /** Pixels between tiles in the atlas. Default 0. */
  spacing?: number
  /** Pixels around the atlas edge. Default 0. */
  margin?: number
}

/** Animated tile: drawing `id` shows `frames[floor(t / duration) % frames.length]`. */
export interface TileAnimation {
  /** Tile ids (same id space as the layer) to cycle through. */
  frames: number[]
  /** Seconds per frame. */
  duration: number
}

export interface TileLayerOptions {
  /** Size in tiles. */
  width: number
  height: number
  tileset: Tileset
  /** Initial tiles (copied). Length must be width * height. */
  tiles?: ArrayLike<number>
  /** Use 32-bit ids. Default false (Uint16Array, ids up to 65535). */
  wideIds?: boolean
  /** World units per tile. Defaults to the tileset's pixel size. */
  tileWorldWidth?: number
  tileWorldHeight?: number
  /** World position of the layer's top-left corner. Default 0, 0. */
  x?: number
  y?: number
  /**
   * Draw order. Without `renderLayer` this only orders tile layers among
   * themselves (all of them draw beneath every sprite). With `renderLayer` it is
   * the same `zIndex` as `Sprite.zIndex` / `SpriteLayer.zIndex`.
   */
  zIndex?: number
  /**
   * Opt in to the shared draw order: name of a render layer (the same names
   * `Sprite.layer` and `SpriteLayer.layer` use, e.g. 'default', 'background').
   * The tile layer is then sorted together with sprites and sprite layers by
   * (render layer order, zIndex), so it can sit above a sprite or between two
   * sprite layers. At equal order and zIndex a tile layer draws before sprites.
   * Omit it to keep the legacy behaviour: drawn beneath all sprites.
   */
  renderLayer?: string
  /** Label shown in the per-layer stats (`stats.layers`). Default `tiles<N>` by draw order. */
  name?: string
  opacity?: number
  /** Whole-layer colour multiplier, 0xRRGGBBAA (alpha multiplies opacity). Default 0xffffffff. */
  tintColor?: number
  /** How the layer blends onto what is below it. Default 'normal'. */
  blend?: LayerBlendMode
  /** Chunk edge in tiles for dirty tracking and the Canvas2D cache. Default 32. */
  chunkSize?: number
  animations?: Record<number, TileAnimation>
  /**
   * Per-cell alternatives. Keys and values are tile ids, in the same id space as
   * `tiles` and the atlas (`0` is empty, id `n` is atlas tile `n - 1`), so a
   * variant may be any atlas tile, including another variant's key.
   *
   * A cell holding `id` draws `variants[id][tileHash(x, y) % min(255, list.length)]`,
   * then the animation frame for that result. The choice depends only on the
   * cell coordinates, so it never changes when tiles around it are edited and
   * is the same on every renderer. Lists are capped at 255 entries (extra
   * entries are ignored). Use {@link TileLayerData.variantAt} to read the chosen
   * id from CPU code instead of replicating the hash.
   */
  variants?: Record<number, number[]>
  /** Per-tile brightness variation from the tile hash, 0..1. Default 0. */
  jitter?: number
  /**
   * How the tile atlas is sampled when more than one atlas texel falls on a device
   * pixel (zoomed out). `'nearest'` (default): exact texels, crisp at any zoom but
   * shimmers when panning zoomed out. `'mipmap'`: a per-tile mip pyramid (built once
   * per atlas image, on the first minified draw) blended trilinearly in the shader;
   * tiles never bleed into their neighbours, and magnified/1:1 drawing stays exact.
   */
  minFilter?: TileMinFilter
  /**
   * Below this many device pixels per tile the tile is drawn with its atlas tile's
   * average colour instead of sampling texels. Default 2; 0 turns the average off
   * (useful with `minFilter: 'mipmap'`, whose top level is that average).
   */
  farZoomPx?: number
  /** Allocate the per-tile RGBA tint layer up front (otherwise on first setTint). */
  tinted?: boolean
  /** Allocate the per-tile additive bias layer up front (otherwise on first setBias). */
  biased?: boolean
  /**
   * Draw the base layers (those without a `renderLayer`) from a cached copy while the camera and
   * those layers stay still. A frame where the camera or a layer changed is drawn directly, as
   * without the flag, so this only pays off on a static layer such as terrain. Default false.
   */
  cache?: boolean
}

export type TileMinFilter = 'nearest' | 'mipmap'

/** Stable per-cell hash shared with the tile shader (variants, jitter). */
export function tileHash(x: number, y: number): number {
  let h = (Math.imul(x >>> 0, 1664525) + Math.imul(y >>> 0, 1013904223)) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 2246822519) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  return h
}

export interface TileLayerComponent extends Component {
  readonly type: 'TileLayer'
  layer: TileLayerData
}

/**
 * Wrap a layer as a component. Pass `wake` (usually `() => engine.loop.markDirty()`)
 * when adding the layer imperatively so on-demand loops wake on every change;
 * it is assigned to `layer.onChange`. The `<TileLayer>` component does this for you.
 */
export function createTileLayerComponent(layer: TileLayerData, wake?: () => void): TileLayerComponent {
  if (wake) layer.onChange = wake
  return { type: 'TileLayer', layer }
}

/**
 * A large tile grid stored as a typed array. Mutations only record which chunks
 * changed; renderers upload those chunks on the next frame.
 */
export class TileLayerData {
  readonly width: number
  readonly height: number
  readonly chunkSize: number
  readonly chunksX: number
  readonly chunksY: number
  readonly tiles: TileIdArray
  private _tileset: Tileset
  private _tileWorldWidth: number
  private _tileWorldHeight: number
  /** Label in the per-layer stats; empty = auto (`tiles<N>`). */
  name: string
  private _x: number
  private _y: number
  private _zIndex: number
  private _opacity: number
  private _tintColor: number
  private _blend: LayerBlendMode
  private _visible = true
  private _renderLayer: string | undefined

  /** Bumped by any change that affects the rendered image. */
  revision = 0
  /** Bumped by `setTiles` / `fill`; consumers re-upload everything. */
  fullVersion = 0
  /** Per-chunk change counter (used by the Canvas2D cache). */
  readonly chunkVersion: Uint32Array
  /** Pending dirty chunks since the last `consumeDirty()` (GPU consumer). */
  dirtyCount = 0
  readonly dirtyList: Int32Array
  /** Per chunk: minX, minY, maxX, maxY (inclusive, layer tile coords). */
  readonly dirtyRect: Int32Array
  private readonly dirtyFlag: Uint8Array

  /** id → current frame id, for ids below `lutSize`. Null when no animations. */
  lut: Uint32Array | null = null
  lutSize = 0
  lutVersion = 0
  private animIds: number[] = []
  private animFrames: number[][] = []
  private animDur: number[] = []
  private animCur: Int32Array = new Int32Array(0)
  private animFlag: Uint8Array = new Uint8Array(0)

  /** RGBA bytes per tile, multiplied with the tile colour; null until enabled. */
  tints: Uint8Array | null = null
  /** Bumped when the tint layer is (re)allocated or fully replaced. */
  tintVersion = 0
  /**
   * RGBA bytes per tile, ADDED to the tile colour after tint and jitter (rgb only, scaled by the
   * tile's alpha so empty texels stay empty): the way to brighten, since a tint can only darken.
   * Null until enabled.
   */
  biases: Uint8Array | null = null
  /** Bumped when the bias layer is (re)allocated or fully replaced. */
  biasVersion = 0
  /** See {@link TileLayerOptions.cache}. */
  cache: boolean
  private _jitter = 0
  private _minFilter: TileMinFilter = 'nearest'
  private _farZoomPx = 2
  /** Packed variant table: heads ((start << 8) | count) for ids < variantSize, then the id lists. */
  variantTable: Uint32Array | null = null
  variantSize = 0
  variantVersion = 0
  private variantLists: Record<number, number[]> = {}

  /**
   * Called after any mutation, including the `visible`/`x`/`y`/`zIndex`/`opacity`/
   * `tileset` setters. The `<TileLayer>` component points it at `engine.loop.markDirty()`
   * so on-demand loops wake; for a layer added imperatively pass a wake callback to
   * `createTileLayerComponent(layer, wake)` or assign it yourself.
   */
  onChange: (() => void) | null = null

  constructor(opts: TileLayerOptions) {
    registerTileRenderer((gl, stats) => new TileLayerRenderer(gl, stats))
    const { width, height } = opts
    if (!(width > 0 && height > 0)) throw new Error('[TileLayer] width and height must be positive')
    this.width = width | 0
    this.height = height | 0
    this.chunkSize = Math.max(1, (opts.chunkSize ?? 32) | 0)
    this.chunksX = Math.ceil(this.width / this.chunkSize)
    this.chunksY = Math.ceil(this.height / this.chunkSize)
    const n = this.width * this.height
    this.tiles = opts.wideIds ? new Uint32Array(n) : new Uint16Array(n)
    if (opts.tiles) this.copyIn(opts.tiles)
    this._tileset = opts.tileset
    this._tileWorldWidth = opts.tileWorldWidth ?? opts.tileset.tileWidth
    this._tileWorldHeight = opts.tileWorldHeight ?? opts.tileset.tileHeight
    this._x = opts.x ?? 0
    this._y = opts.y ?? 0
    this._zIndex = opts.zIndex ?? 0
    this.name = opts.name ?? ''
    this._opacity = opts.opacity ?? 1
    this._tintColor = (opts.tintColor ?? 0xffffffff) >>> 0
    this._blend = opts.blend ?? 'normal'
    this._renderLayer = opts.renderLayer
    const chunks = this.chunksX * this.chunksY
    this.chunkVersion = new Uint32Array(chunks)
    this.dirtyList = new Int32Array(chunks)
    this.dirtyRect = new Int32Array(chunks * 4)
    this.dirtyFlag = new Uint8Array(chunks)
    if (opts.animations) this.setAnimations(opts.animations)
    if (opts.variants) this.setVariants(opts.variants)
    this._jitter = opts.jitter ?? 0
    this._minFilter = opts.minFilter ?? 'nearest'
    this._farZoomPx = opts.farZoomPx ?? 2
    this.cache = opts.cache ?? false
    if (opts.tinted) this.enableTints()
    if (opts.biased) this.enableBias()
  }

  get minFilter(): TileMinFilter {
    return this._minFilter
  }
  set minFilter(v: TileMinFilter) {
    if (v === this._minFilter) return
    this._minFilter = v
    this.revision++
    this.onChange?.()
  }
  get farZoomPx(): number {
    return this._farZoomPx
  }
  set farZoomPx(v: number) {
    if (v === this._farZoomPx) return
    this._farZoomPx = v
    this.revision++
    this.onChange?.()
  }

  get jitter(): number {
    return this._jitter
  }
  set jitter(v: number) {
    if (v === this._jitter) return
    this._jitter = v
    this.revision++
    this.onChange?.()
  }

  /** Allocate the tint layer (all white, opaque). */
  enableTints(): Uint8Array {
    if (!this.tints) {
      this.tints = new Uint8Array(this.width * this.height * 4).fill(255)
      this.tintVersion++
      this.revision++
    }
    return this.tints
  }

  /** Allocate the additive bias layer (all zero = no change). */
  enableBias(): Uint8Array {
    if (!this.biases) {
      this.biases = new Uint8Array(this.width * this.height * 4)
      this.biasVersion++
      this.revision++
    }
    return this.biases
  }

  /**
   * Add 0xRRGGBB (0 = nothing, 0xffffff = full white) to one tile's colour. Marks only its
   * chunk dirty. Combine with `setTint` to darken and brighten the same tile.
   */
  setBias(x: number, y: number, rgb: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const b = this.biases ?? this.enableBias()
    const o = (y * this.width + x) * 4
    b[o] = (rgb >>> 16) & 255
    b[o + 1] = (rgb >>> 8) & 255
    b[o + 2] = rgb & 255
    b[o + 3] = 255
    this.markDirty(x, y)
  }

  /** Replace all biases: RGBA bytes (rgb used), length width * height * 4. Re-uploads once. */
  setBiases(rgba: ArrayLike<number>): void {
    const b = this.biases ?? this.enableBias()
    if (rgba.length !== b.length) throw new Error(`[TileLayer] expected ${b.length} bias bytes, got ${rgba.length}`)
    b.set(rgba)
    this.biasVersion++
    this.revision++
    this.onChange?.()
  }

  /** Tint one tile with 0xRRGGBBAA. Marks only its chunk dirty. */
  setTint(x: number, y: number, rgba: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const t = this.tints ?? this.enableTints()
    const o = (y * this.width + x) * 4
    t[o] = rgba >>> 24
    t[o + 1] = (rgba >>> 16) & 255
    t[o + 2] = (rgba >>> 8) & 255
    t[o + 3] = rgba & 255
    this.markDirty(x, y)
  }

  /** Replace all tints: RGBA bytes, length width * height * 4. */
  setTints(rgba: ArrayLike<number>): void {
    const t = this.tints ?? this.enableTints()
    if (rgba.length !== t.length) throw new Error(`[TileLayer] expected ${t.length} tint bytes, got ${rgba.length}`)
    t.set(rgba)
    this.tintVersion++
    this.revision++
    this.onChange?.()
  }

  /**
   * Replace the variant table. Keys and values are tile ids (the same id space as
   * `tiles` and the atlas). A cell holding `id` draws
   * `variants[id][tileHash(x, y) % min(255, list.length)]`, before animation;
   * lists are capped at 255 entries. Use {@link variantAt} for the chosen id.
   */
  setVariants(variants: Record<number, number[]>): void {
    this.variantLists = variants
    let maxId = -1
    let total = 0
    for (const key of Object.keys(variants)) {
      const id = Number(key)
      const list = variants[id]
      if (!(id > 0) || !list || list.length === 0) continue
      if (id > maxId) maxId = id
      total += Math.min(255, list.length)
    }
    if (maxId < 0) {
      this.variantTable = null
      this.variantSize = 0
    } else {
      const size = maxId + 1
      const table = new Uint32Array(size + total)
      let at = size
      for (const key of Object.keys(variants)) {
        const id = Number(key)
        const list = variants[id]
        if (!(id > 0) || !list || list.length === 0) continue
        const n = Math.min(255, list.length)
        table[id] = (at << 8) | n
        for (let k = 0; k < n; k++) table[at++] = list[k]
      }
      this.variantTable = table
      this.variantSize = size
    }
    this.variantVersion++
    this.revision++
    this.onChange?.()
  }

  /**
   * The tile id chosen at (x, y) after variants but before animation: the stored
   * id when it has no variants, else `list[tileHash(x, y) % min(255, list.length)]`.
   * Out of bounds returns 0. Lets CPU models agree with the renderer without
   * replicating the hash.
   */
  variantAt(x: number, y: number): number {
    const id = this.getTile(x, y)
    const list = this.variantLists[id]
    if (list && list.length > 0) return list[tileHash(x, y) % Math.min(255, list.length)]
    return id
  }

  /** The id actually drawn at (x, y): variant by hash, then animation frame. */
  visualTile(x: number, y: number): number {
    return this.resolveTile(this.variantAt(x, y))
  }

  get tileset(): Tileset {
    return this._tileset
  }
  set tileset(v: Tileset) {
    if (v === this._tileset) return
    this._tileset = v
    this.revision++
    this.onChange?.()
  }
  get tileWorldWidth(): number {
    return this._tileWorldWidth
  }
  set tileWorldWidth(v: number) {
    if (v === this._tileWorldWidth) return
    this._tileWorldWidth = v
    this.revision++
    this.onChange?.()
  }
  get tileWorldHeight(): number {
    return this._tileWorldHeight
  }
  set tileWorldHeight(v: number) {
    if (v === this._tileWorldHeight) return
    this._tileWorldHeight = v
    this.revision++
    this.onChange?.()
  }

  get x(): number {
    return this._x
  }
  set x(v: number) {
    if (v === this._x) return
    this._x = v
    this.revision++
    this.onChange?.()
  }
  get y(): number {
    return this._y
  }
  set y(v: number) {
    if (v === this._y) return
    this._y = v
    this.revision++
    this.onChange?.()
  }
  get zIndex(): number {
    return this._zIndex
  }
  set zIndex(v: number) {
    if (v === this._zIndex) return
    this._zIndex = v
    this.revision++
    this.onChange?.()
  }
  /** Render layer name when the tile layer takes part in the shared sprite sort; undefined = beneath all sprites. */
  get renderLayer(): string | undefined {
    return this._renderLayer
  }
  set renderLayer(v: string | undefined) {
    if (v === this._renderLayer) return
    this._renderLayer = v
    this.revision++
    this.onChange?.()
  }
  get opacity(): number {
    return this._opacity
  }
  set opacity(v: number) {
    if (v === this._opacity) return
    this._opacity = v
    this.revision++
    this.onChange?.()
  }
  get tintColor(): number {
    return this._tintColor
  }
  set tintColor(v: number) {
    v >>>= 0
    if (v === this._tintColor) return
    this._tintColor = v
    this.revision++
    this.onChange?.()
  }
  get blend(): LayerBlendMode {
    return this._blend
  }
  set blend(v: LayerBlendMode) {
    if (v === this._blend) return
    this._blend = v
    this.revision++
    this.onChange?.()
  }
  get visible(): boolean {
    return this._visible
  }
  set visible(v: boolean) {
    if (v === this._visible) return
    this._visible = v
    this.revision++
    this.onChange?.()
  }

  getTile(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0
    return this.tiles[y * this.width + x]
  }

  /** Set one tile. Marks only its chunk dirty. Returns false if out of bounds or unchanged. */
  setTile(x: number, y: number, id: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false
    const i = y * this.width + x
    if (this.tiles[i] === id) return false
    this.tiles[i] = id
    this.markDirty(x, y)
    return true
  }

  private markDirty(x: number, y: number): void {
    const cs = this.chunkSize
    const c = ((y / cs) | 0) * this.chunksX + ((x / cs) | 0)
    this.chunkVersion[c]++
    const r = c * 4
    if (this.dirtyFlag[c] === 0) {
      this.dirtyFlag[c] = 1
      this.dirtyList[this.dirtyCount++] = c
      this.dirtyRect[r] = x
      this.dirtyRect[r + 1] = y
      this.dirtyRect[r + 2] = x
      this.dirtyRect[r + 3] = y
    } else {
      if (x < this.dirtyRect[r]) this.dirtyRect[r] = x
      if (y < this.dirtyRect[r + 1]) this.dirtyRect[r + 1] = y
      if (x > this.dirtyRect[r + 2]) this.dirtyRect[r + 2] = x
      if (y > this.dirtyRect[r + 3]) this.dirtyRect[r + 3] = y
    }
    this.revision++
    this.onChange?.()
  }

  /**
   * Mark `w` x `h` tiles from (x, y) as changed after writing `layer.tiles`
   * directly. Clipped to the layer; every chunk the rect overlaps is queued for
   * upload with the overlapping part as its dirty rect. Cheaper than `touch()`
   * for local edits. For a single cell prefer `setTile`.
   */
  markDirtyRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.width, Math.ceil(x + w)) - 1
    const y1 = Math.min(this.height, Math.ceil(y + h)) - 1
    if (!(x1 >= x0 && y1 >= y0)) return
    const cs = this.chunkSize
    for (let cy = (y0 / cs) | 0, cyEnd = (y1 / cs) | 0; cy <= cyEnd; cy++) {
      for (let cx = (x0 / cs) | 0, cxEnd = (x1 / cs) | 0; cx <= cxEnd; cx++) {
        const c = cy * this.chunksX + cx
        this.chunkVersion[c]++
        const rx0 = Math.max(x0, cx * cs)
        const ry0 = Math.max(y0, cy * cs)
        const rx1 = Math.min(x1, cx * cs + cs - 1)
        const ry1 = Math.min(y1, cy * cs + cs - 1)
        const r = c * 4
        if (this.dirtyFlag[c] === 0) {
          this.dirtyFlag[c] = 1
          this.dirtyList[this.dirtyCount++] = c
          this.dirtyRect[r] = rx0
          this.dirtyRect[r + 1] = ry0
          this.dirtyRect[r + 2] = rx1
          this.dirtyRect[r + 3] = ry1
        } else {
          if (rx0 < this.dirtyRect[r]) this.dirtyRect[r] = rx0
          if (ry0 < this.dirtyRect[r + 1]) this.dirtyRect[r + 1] = ry0
          if (rx1 > this.dirtyRect[r + 2]) this.dirtyRect[r + 2] = rx1
          if (ry1 > this.dirtyRect[r + 3]) this.dirtyRect[r + 3] = ry1
        }
      }
    }
    this.revision++
    this.onChange?.()
  }

  /**
   * Call after writing `layer.tiles` directly when the changed area is unknown
   * or large: marks the whole layer dirty (a full re-upload on the next frame).
   */
  touch(): void {
    this.markAllDirty()
  }

  /** Replace every tile (copied). Length must equal width * height. */
  setTiles(tiles: ArrayLike<number>): void {
    this.copyIn(tiles)
    this.markAllDirty()
  }

  fill(id: number): void {
    this.tiles.fill(id)
    this.markAllDirty()
  }

  private copyIn(tiles: ArrayLike<number>): void {
    if (tiles.length !== this.tiles.length) {
      throw new Error(`[TileLayer] expected ${this.tiles.length} tiles, got ${tiles.length}`)
    }
    this.tiles.set(tiles)
  }

  private markAllDirty(): void {
    for (let c = 0; c < this.chunkVersion.length; c++) this.chunkVersion[c]++
    this.clearDirty()
    this.fullVersion++
    this.revision++
    this.onChange?.()
  }

  /** Reset the pending dirty list (called by the GPU consumer after uploading). */
  clearDirty(): void {
    for (let k = 0; k < this.dirtyCount; k++) this.dirtyFlag[this.dirtyList[k]] = 0
    this.dirtyCount = 0
  }

  /** Replace the animation table. Keys are tile ids; frames are tile ids. */
  setAnimations(animations: Record<number, TileAnimation>): void {
    const ids: number[] = []
    const frames: number[][] = []
    const durs: number[] = []
    let maxId = -1
    for (const key of Object.keys(animations)) {
      const id = Number(key)
      const a = animations[id]
      if (!a || a.frames.length === 0 || !(a.duration > 0) || !(id > 0)) continue
      ids.push(id)
      frames.push(a.frames.slice())
      durs.push(a.duration)
      if (id > maxId) maxId = id
    }
    this.animIds = ids
    this.animFrames = frames
    this.animDur = durs
    this.animCur = new Int32Array(ids.length).fill(-1)
    if (ids.length === 0) {
      this.lut = null
      this.lutSize = 0
      this.animFlag = new Uint8Array(0)
    } else {
      this.lutSize = maxId + 1
      this.lut = new Uint32Array(this.lutSize)
      for (let i = 0; i < this.lutSize; i++) this.lut[i] = i
      this.animFlag = new Uint8Array(this.lutSize)
      for (let k = 0; k < ids.length; k++) {
        this.lut[ids[k]] = frames[k][0]
        this.animFlag[ids[k]] = 1
      }
    }
    this.lutVersion++
    this.revision++
  }

  /** Advance animations to `time` seconds. O(animations), not O(tiles). Returns true if a frame changed. */
  updateAnimations(time: number): boolean {
    const lut = this.lut
    if (!lut) return false
    let changed = false
    for (let k = 0; k < this.animIds.length; k++) {
      const fr = this.animFrames[k]
      const idx = Math.floor(time / this.animDur[k]) % fr.length
      if (idx !== this.animCur[k]) {
        this.animCur[k] = idx
        if (lut[this.animIds[k]] !== fr[idx]) {
          lut[this.animIds[k]] = fr[idx]
          changed = true
        }
      }
    }
    if (changed) {
      this.lutVersion++
      this.revision++
    }
    return changed
  }

  /** Current frame id for `id` (identity unless animated). */
  resolveTile(id: number): number {
    return this.lut !== null && id < this.lutSize ? this.lut[id] : id
  }

  isAnimated(id: number): boolean {
    return id < this.lutSize && this.animFlag[id] === 1
  }
}

/**
 * Tiles of `layer` overlapping the world-space view rect, written to `out` as
 * [x0, y0, x1, y1) in tile coords, clipped to the layer. Returns false if empty.
 */
export function visibleTileRange(
  layer: TileLayerData,
  viewL: number,
  viewT: number,
  viewR: number,
  viewB: number,
  out: Int32Array | number[],
): boolean {
  const tw = layer.tileWorldWidth
  const th = layer.tileWorldHeight
  const x0 = Math.max(0, Math.floor((viewL - layer.x) / tw))
  const y0 = Math.max(0, Math.floor((viewT - layer.y) / th))
  const x1 = Math.min(layer.width, Math.ceil((viewR - layer.x) / tw))
  const y1 = Math.min(layer.height, Math.ceil((viewB - layer.y) / th))
  out[0] = x0
  out[1] = y0
  out[2] = x1
  out[3] = y1
  return x1 > x0 && y1 > y0
}

/** Same as {@link visibleTileRange} but in chunk coords. */
export function visibleChunkRange(
  layer: TileLayerData,
  viewL: number,
  viewT: number,
  viewR: number,
  viewB: number,
  out: Int32Array | number[],
): boolean {
  if (!visibleTileRange(layer, viewL, viewT, viewR, viewB, out)) return false
  const cs = layer.chunkSize
  out[0] = Math.floor(out[0] / cs)
  out[1] = Math.floor(out[1] / cs)
  out[2] = Math.ceil(out[2] / cs)
  out[3] = Math.ceil(out[3] / cs)
  return true
}

/** Source pixel rect of atlas tile index `t` (= id - 1). */
export function tileSourceX(ts: Tileset, t: number): number {
  return (ts.margin ?? 0) + (t % ts.columns) * (ts.tileWidth + (ts.spacing ?? 0))
}

export function tileSourceY(ts: Tileset, t: number): number {
  return (ts.margin ?? 0) + Math.floor(t / ts.columns) * (ts.tileHeight + (ts.spacing ?? 0))
}

export function isTilesetReady(ts: Tileset): boolean {
  const img = ts.image
  if (!img) return false
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
    return img.complete && img.naturalWidth > 0
  }
  return img.width > 0
}
