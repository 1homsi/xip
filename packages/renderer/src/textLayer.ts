import { registerTextLayerRenderer } from './layerRegistry'
import { TextLayerRenderer } from './textLayerGL'
import { GlyphAtlas, type AtlasStyle, type GlyphStyleOptions } from './glyphAtlas'
import { parseCSSColor } from './colorParser'
import type { LayerBlendMode } from './blendModes'

export { GlyphAtlas } from './glyphAtlas'
export type { GlyphAtlasOptions, GlyphStyleOptions, Glyph, AtlasStyle, AtlasPage } from './glyphAtlas'

export const TEXT_HIDDEN = 1
export const TEXT_WORD_WRAP = 2

export type TextRunAlign = 'left' | 'center' | 'right'
const ALIGN: Record<TextRunAlign, number> = { left: 0, center: 1, right: 2 }

/** Floats per laid-out glyph: x, y, w, h (raster px, block-relative), u0, v0, u1, v1, page. */
export const LAYOUT_GLYPH_FLOATS = 9

export interface TextLayerOptions extends GlyphStyleOptions {
  /** Initial run capacity; grows automatically. */
  capacity?: number
  /** Render layer name and z-index, sorted together with sprites and sprite layers. */
  layer?: string
  zIndex?: number
  visible?: boolean
  /** Layer-wide opacity multiplier. Default 1. */
  opacity?: number
  /** Draw runs in ascending `sortKey[i]` order (e.g. y for depth) instead of insertion order. */
  sortByKey?: boolean
  /** Whole-layer colour multiplier, 0xRRGGBBAA. Default 0xffffffff. */
  tintColor?: number
  /** How the layer blends onto what is below it. Default 'normal'. */
  blend?: LayerBlendMode
  /** Share glyphs with other layers by passing the same atlas. Default: the process-wide atlas. */
  atlas?: GlyphAtlas
  /**
   * Re-rasterise glyphs at a higher density when the camera zooms in (zoom x device
   * pixel ratio above the atlas `resolution`), so labels stay crisp. Steps 1x, 2x, 4x
   * of the atlas resolution with hysteresis; sizes already built stay cached until the
   * atlas fills. Default true; never goes below the atlas `resolution`.
   */
  zoomAware?: boolean
}

export interface TextRunOptions {
  /** Font size in world px. Default: the style's nominal size. */
  size?: number
  /** 0xRRGGBBAA or a CSS colour; multiplies the baked glyph colour (white = unchanged). */
  color?: number | string
  /** Extra alpha 0..1. */
  alpha?: number
  /** 0..1 position of the text block's anchor point (default 0.5, 0.5: centred). */
  anchorX?: number
  anchorY?: number
  align?: TextRunAlign
  /** Wrap width in world px (needs `wordWrap`). */
  maxWidth?: number
  wordWrap?: boolean
  /** Line height as a multiple of the font size. Default 1.2. */
  lineHeight?: number
  rotation?: number
  /** Style id from `addStyle()` (default 0 = the layer's style). */
  style?: number
  id?: number
}

/** Cached layout of one run, in raster px relative to the block's top-left. */
export interface RunLayout {
  text: string
  style: number
  wrapW: number
  align: number
  lh: number
  gen: number
  /** The atlas style (incl. raster density) the layout was built for. */
  ref: AtlasStyle | null
  glyphs: Float32Array
  /** Number of glyph quads in `glyphs`. */
  n: number
  width: number
  height: number
  lines: number
}

function toRGBA(c: number | string): number {
  if (typeof c === 'number') return c >>> 0
  const [r, g, b, a] = parseCSSColor(c)
  return (
    ((Math.round(r * 255) << 24) | (Math.round(g * 255) << 16) | (Math.round(b * 255) << 8) | Math.round(a * 255)) >>> 0
  )
}

// Scratch for the layout pass (never held across calls).
let scratchGlyphs: { g: import('./glyphAtlas').Glyph; cp: number }[] = []

/**
 * Many text labels in one instanced draw. Struct-of-arrays like SpriteLayer:
 * write the arrays directly and call `touch()`, or use `add` / `setText`.
 * Glyphs come from a shared on-demand atlas, so 1,000 labels cost one texture
 * and one draw call. Sorts with sprites by `layer` + `zIndex`.
 *
 * Runs are laid out in raster px once and re-laid out only when the text,
 * style, wrap width, alignment or line height change.
 */
export class TextLayer {
  count = 0
  capacity = 0
  version = 0
  /** Called on every mutation (`add`, `setText`, `touch()` ...); `useTextLayer` wires it to wake an `onDemand` loop. */
  onChange: (() => void) | null = null
  x!: Float32Array
  y!: Float32Array
  /** Font size in world px. */
  size!: Float32Array
  rotation!: Float32Array
  /** 0xRRGGBBAA multiplier. */
  color!: Uint32Array
  anchorX!: Float32Array
  anchorY!: Float32Array
  /** Wrap width in world px, used when TEXT_WORD_WRAP is set. */
  maxWidth!: Float32Array
  lineHeight!: Float32Array
  /** 0 left, 1 center, 2 right. */
  align!: Uint8Array
  /** TEXT_HIDDEN | TEXT_WORD_WRAP. */
  flags!: Uint8Array
  /** Index into `styles`. */
  style!: Uint16Array
  alpha!: Float32Array
  /** Draw order key when `sortByKey` is set (lower draws first). */
  sortKey!: Float32Array
  ids!: Int32Array
  /** The text of each run. Change with `setText()` (or write and call `touch()`). */
  texts: string[] = []

  layer: string
  zIndex: number
  visible: boolean
  opacity: number
  sortByKey: boolean
  private _tintColor: number
  private _blend: LayerBlendMode
  readonly atlas: GlyphAtlas
  /** Style options; index 0 is the layer's own. */
  readonly styles: GlyphStyleOptions[]
  private readonly _layouts: (RunLayout | undefined)[] = []
  private readonly _atlasStyles: (AtlasStyle | undefined)[] = []
  private _atlasGen = -1
  /** Raster density multiplier chosen from the camera zoom (1, 2 or 4). */
  private _k = 1
  readonly zoomAware: boolean
  private _order = new Int32Array(0)
  private _orderCount = -1
  private _structure = 0
  private _orderStructure = -1

  constructor(options: TextLayerOptions = {}) {
    registerTextLayerRenderer((gl) => new TextLayerRenderer(gl))
    const { capacity, layer, zIndex, visible, opacity, atlas, sortByKey, tintColor, blend, zoomAware, ...style } =
      options
    this.zoomAware = zoomAware ?? true
    this.atlas = atlas ?? GlyphAtlas.shared
    this.styles = [style]
    this.layer = layer ?? 'default'
    this.zIndex = zIndex ?? 0
    this.visible = visible ?? true
    this.opacity = opacity ?? 1
    this.sortByKey = sortByKey ?? false
    this._tintColor = (tintColor ?? 0xffffffff) >>> 0
    this._blend = blend ?? 'normal'
    this.grow(Math.max(16, capacity ?? 64))
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

  private grow(capacity: number): void {
    const copy = <T extends Float32Array | Uint32Array | Uint8Array | Int32Array | Uint16Array>(
      old: T | undefined,
      make: new (n: number) => T,
    ): T => {
      const next = new make(capacity)
      if (old) next.set(old.subarray(0, this.count))
      return next
    }
    this.x = copy(this.x, Float32Array)
    this.y = copy(this.y, Float32Array)
    this.size = copy(this.size, Float32Array)
    this.rotation = copy(this.rotation, Float32Array)
    this.color = copy(this.color, Uint32Array)
    this.anchorX = copy(this.anchorX, Float32Array)
    this.anchorY = copy(this.anchorY, Float32Array)
    this.maxWidth = copy(this.maxWidth, Float32Array)
    this.lineHeight = copy(this.lineHeight, Float32Array)
    this.align = copy(this.align, Uint8Array)
    this.flags = copy(this.flags, Uint8Array)
    this.style = copy(this.style, Uint16Array)
    this.alpha = copy(this.alpha, Float32Array)
    this.sortKey = copy(this.sortKey, Float32Array)
    this.ids = copy(this.ids, Int32Array)
    this.capacity = capacity
  }

  reserve(n: number): void {
    if (n > this.capacity) this.grow(Math.max(n, this.capacity * 2))
  }

  /** Register another style (font/outline/shadow) and return its id for `add({ style })`. */
  addStyle(options: GlyphStyleOptions): number {
    this.styles.push({ ...this.styles[0], ...options })
    return this.styles.length - 1
  }

  /** The atlas style a run's glyphs come from. */
  atlasStyle(id: number): AtlasStyle {
    if (this._atlasGen !== this.atlas.generation) this._atlasGen = this.atlas.generation
    return (this._atlasStyles[id] ??= this.atlas.style(this.styles[id] ?? this.styles[0], this._k))
  }

  /** Current raster density multiplier over the atlas resolution. */
  get rasterScale(): number {
    return this._k
  }

  /**
   * Choose the raster density for a camera density (zoom x device pixel ratio).
   * Goes up as soon as the current one would blur, and only comes down well below
   * it (hysteresis), so a zoom animation does not thrash the atlas. Free when stable.
   */
  updateDensity(density: number): void {
    if (!this.zoomAware) return
    const need = density / this.atlas.resolution
    let k = this._k
    if (need > k) k = need > 2 ? 4 : 2
    else if (need < k * 0.35) k = need < 0.7 ? 1 : 2
    if (k !== this._k) {
      this._k = k
      this._atlasStyles.length = 0
    }
  }

  add(text: string, x: number, y: number, o: TextRunOptions = {}): number {
    const i = this.count
    this.reserve(i + 1)
    this.count = i + 1
    const styleId = o.style ?? 0
    this.texts[i] = text
    this._layouts[i] = undefined
    this.x[i] = x
    this.y[i] = y
    this.size[i] = o.size ?? this.styles[styleId]?.fontSize ?? this.styles[0].fontSize ?? 16
    this.rotation[i] = o.rotation ?? 0
    this.color[i] = o.color === undefined ? 0xffffffff : toRGBA(o.color)
    this.anchorX[i] = o.anchorX ?? 0.5
    this.anchorY[i] = o.anchorY ?? 0.5
    this.maxWidth[i] = o.maxWidth ?? 0
    this.lineHeight[i] = o.lineHeight ?? 1.2
    this.align[i] = ALIGN[o.align ?? 'center']
    this.flags[i] = o.wordWrap ? TEXT_WORD_WRAP : 0
    this.style[i] = styleId
    this.alpha[i] = o.alpha ?? 1
    this.sortKey[i] = 0
    this.ids[i] = o.id ?? i
    this._structure++
    this.changed()
    return i
  }

  setText(i: number, text: string): void {
    if (this.texts[i] === text) return
    this.texts[i] = text
    this.changed()
  }

  set(i: number, x: number, y: number): void {
    this.x[i] = x
    this.y[i] = y
    this.changed()
  }

  /** Swap-remove: the last run moves into slot `i`. */
  removeAt(i: number): void {
    const last = --this.count
    if (i !== last) {
      for (const a of [
        this.x,
        this.y,
        this.size,
        this.rotation,
        this.color,
        this.anchorX,
        this.anchorY,
        this.maxWidth,
        this.lineHeight,
        this.align,
        this.flags,
        this.style,
        this.alpha,
        this.sortKey,
        this.ids,
      ] as { [k: number]: number }[])
        a[i] = a[last]
      this.texts[i] = this.texts[last]
      this._layouts[i] = this._layouts[last]
    }
    this.texts.length = last
    this._layouts.length = last
    this._structure++
    this.changed()
  }

  clear(): void {
    this.count = 0
    this.texts.length = 0
    this._layouts.length = 0
    this._structure++
    this.changed()
  }

  /** Call after writing the arrays directly so idle-frame skipping redraws (and an `onDemand` loop wakes). */
  touch(): void {
    this.changed()
  }

  private changed(): void {
    this.version++
    this.onChange?.()
  }

  /**
   * Draw order (indices into the arrays): ascending `sortKey` when `sortByKey`
   * is set. Keys that drift a little between frames cost a near-linear
   * insertion sort.
   */
  drawOrder(): Int32Array {
    const n = this.count
    if (this._order.length < n) this._order = new Int32Array(Math.max(n, this._order.length * 2))
    const order = this._order
    if (this._orderCount !== n || this._orderStructure !== this._structure || !this.sortByKey) {
      for (let i = 0; i < n; i++) order[i] = i
      this._orderCount = n
      this._orderStructure = this._structure
      if (this.sortByKey) {
        const K = this.sortKey
        order.subarray(0, n).sort((a, b) => K[a] - K[b] || a - b)
      }
      return order
    }
    const K = this.sortKey
    for (let i = 1; i < n; i++) {
      const v = order[i]
      const k = K[v]
      let j = i - 1
      while (j >= 0 && (K[order[j]] > k || (K[order[j]] === k && order[j] > v))) {
        order[j + 1] = order[j]
        j--
      }
      order[j + 1] = v
    }
    return order
  }

  /** The last computed layout of run `i` without refreshing it. */
  layoutIfCached(i: number): RunLayout | undefined {
    return this._layouts[i]
  }

  /** Cached glyph layout of run `i` (rebuilt only when its inputs changed). */
  layout(i: number): RunLayout {
    const text = this.texts[i] ?? ''
    const styleId = this.style[i]
    const atlas = this.atlas
    const size = this.size[i]
    const s = this.atlasStyle(styleId)
    const scale = size / s.rasterSize
    const wrapW = this.flags[i] & TEXT_WORD_WRAP && this.maxWidth[i] > 0 ? this.maxWidth[i] / scale : 0
    const align = this.align[i]
    const lh = this.lineHeight[i]
    const cur = this._layouts[i]
    if (
      cur !== undefined &&
      cur.text === text &&
      cur.style === styleId &&
      cur.wrapW === wrapW &&
      cur.align === align &&
      cur.lh === lh &&
      cur.gen === atlas.generation &&
      cur.ref === s
    )
      return cur
    const out = layoutText(atlas, s, text, wrapW, align, lh, cur)
    out.style = styleId
    out.ref = s
    out.text = text
    this._layouts[i] = out
    return out
  }

  /** Size of run `i` in world px (after layout). */
  measure(i: number): { width: number; height: number } {
    const l = this.layout(i)
    const sc = this.size[i] / this.atlasStyle(this.style[i]).rasterSize
    return { width: l.width * sc, height: l.height * sc }
  }

  /** Index of the topmost run whose block contains the world point (rotation ignored), or -1. */
  pickIndex(wx: number, wy: number): number {
    const order = this.sortByKey ? this.drawOrder() : null
    for (let k = this.count - 1; k >= 0; k--) {
      const i = order ? order[k] : k
      if (this.flags[i] & TEXT_HIDDEN) continue
      const { width, height } = this.measure(i)
      const left = this.x[i] - this.anchorX[i] * width
      const top = this.y[i] - this.anchorY[i] * height
      if (wx >= left && wx < left + width && wy >= top && wy < top + height) return i
    }
    return -1
  }

  /** Id of the topmost run at the world point, or -1. */
  pick(wx: number, wy: number): number {
    const i = this.pickIndex(wx, wy)
    return i < 0 ? -1 : this.ids[i]
  }
}

/**
 * Lay a string out into glyph quads (raster px, relative to the block's
 * top-left). Newlines always break; with `wrapW > 0` lines also break at
 * spaces. Code points are laid out one by one (no shaping or kerning), so
 * right-to-left and complex scripts need the Text component instead.
 */
export function layoutText(
  atlas: GlyphAtlas,
  s: AtlasStyle,
  text: string,
  wrapW: number,
  align: number,
  lh: number,
  reuse?: RunLayout,
): RunLayout {
  for (let attempt = 0; attempt < 2; attempt++) {
    const gen = atlas.generation
    let n = 0
    const list = scratchGlyphs
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      const e = (list[n++] ??= { g: null as never, cp: 0 })
      e.cp = cp
      e.g = cp === 10 ? (null as never) : atlas.glyph(s, cp)
    }
    if (atlas.generation !== gen) continue // atlas reset mid-layout: glyph refs are stale
    return place(atlas, s, list, n, wrapW, align, lh, reuse)
  }
  return place(atlas, s, scratchGlyphs, 0, wrapW, align, lh, reuse)
}

function place(
  atlas: GlyphAtlas,
  s: AtlasStyle,
  list: { g: import('./glyphAtlas').Glyph; cp: number }[],
  n: number,
  wrapW: number,
  align: number,
  lh: number,
  reuse?: RunLayout,
): RunLayout {
  const lineH = lh * s.rasterSize
  const baseOff = (lineH - (s.ascent + s.descent)) / 2 + s.ascent
  // Pass 1: break into lines (start index, end index, width).
  const lineStart: number[] = [0]
  const lineEnd: number[] = []
  const lineW: number[] = []
  let w = 0
  let lastSpace = -1
  let wAtSpace = 0
  let start = 0
  for (let i = 0; i < n; i++) {
    const e = list[i]
    if (e.cp === 10) {
      lineEnd.push(i)
      lineW.push(w)
      lineStart.push(i + 1)
      start = i + 1
      w = 0
      lastSpace = -1
      continue
    }
    const adv = e.g.advance
    if (e.cp === 32) {
      lastSpace = i
      wAtSpace = w
    }
    if (wrapW > 0 && w + adv > wrapW && i > start && e.cp !== 32) {
      if (lastSpace >= start) {
        lineEnd.push(lastSpace)
        lineW.push(wAtSpace)
        lineStart.push(lastSpace + 1)
        start = lastSpace + 1
        // Re-measure the carried-over tail of the word.
        w = 0
        for (let k = start; k < i; k++) w += list[k].g.advance
      } else {
        lineEnd.push(i)
        lineW.push(w)
        lineStart.push(i)
        start = i
        w = 0
      }
      lastSpace = -1
    }
    w += adv
  }
  lineEnd.push(n)
  lineW.push(w)
  let blockW = 0
  for (const lw of lineW) if (lw > blockW) blockW = lw
  // Pass 2: quads.
  let count = 0
  for (let l = 0; l < lineEnd.length; l++) for (let i = lineStart[l]; i < lineEnd[l]; i++) if (list[i].g.w > 0) count++
  let glyphs = reuse?.glyphs
  if (!glyphs || glyphs.length < count * LAYOUT_GLYPH_FLOATS)
    glyphs = new Float32Array(Math.max(count, 4) * LAYOUT_GLYPH_FLOATS)
  let o = 0
  for (let l = 0; l < lineEnd.length; l++) {
    const lw = lineW[l]
    let pen = align === 0 ? 0 : align === 1 ? (blockW - lw) / 2 : blockW - lw
    const base = l * lineH + baseOff
    for (let i = lineStart[l]; i < lineEnd[l]; i++) {
      const g = list[i].g
      if (g.w > 0) {
        glyphs[o] = pen + g.ox
        glyphs[o + 1] = base - g.oy
        glyphs[o + 2] = g.w
        glyphs[o + 3] = g.h
        glyphs[o + 4] = g.u0
        glyphs[o + 5] = g.v0
        glyphs[o + 6] = g.u1
        glyphs[o + 7] = g.v1
        glyphs[o + 8] = g.page
        o += LAYOUT_GLYPH_FLOATS
      }
      pen += g.advance
    }
  }
  return {
    text: '',
    style: 0,
    wrapW,
    align,
    lh,
    gen: atlas.generation,
    ref: s,
    glyphs,
    n: count,
    width: blockW,
    height: lineEnd.length * lineH,
    lines: lineEnd.length,
  }
}
