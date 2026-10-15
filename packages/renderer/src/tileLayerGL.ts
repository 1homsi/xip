import { setBlendFunc } from './blendModes'
import {
  createTileLayerRenderStats,
  type ECSWorld,
  type LayerStats,
  type RenderStats,
  type TileLayerRenderStats,
} from '@xip/core'
import { buildTileMips } from './tileMips'
import { isTilesetReady, visibleTileRange, type TileLayerData, type TileLayerComponent } from './tileLayer'

// One quad per visible page; the fragment shader looks the tile id up in an
// integer index texture and fetches the exact atlas texel (no filtering, so no
// bleeding or seams at any zoom / DPR).
const TILE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform vec4 u_rect;
uniform vec2 u_origin;
uniform vec2 u_tileWorld;
uniform vec2 u_pageOrigin;
uniform vec2 u_camPos;
uniform float u_zoom;
uniform vec2 u_canvasSize;
uniform vec2 u_shake;
out vec2 v_tile;
void main() {
  vec2 t = mix(u_rect.xy, u_rect.zw, a_corner);
  vec2 world = u_origin + t * u_tileWorld;
  float cx = 2.0 * u_zoom / u_canvasSize.x * (world.x - u_camPos.x) + 2.0 * u_shake.x / u_canvasSize.x;
  float cy = -2.0 * u_zoom / u_canvasSize.y * (world.y - u_camPos.y) - 2.0 * u_shake.y / u_canvasSize.y;
  gl_Position = vec4(cx, cy, 0.0, 1.0);
  v_tile = t - u_pageOrigin;
}
`

const TILE_FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
in vec2 v_tile;
uniform sampler2D u_atlas;
uniform usampler2D u_index;
uniform usampler2D u_lut;
uniform usampler2D u_var;
uniform sampler2D u_tint;
uniform sampler2D u_bias;
uniform int u_hasBias;
uniform sampler2D u_avg;
uniform sampler2D u_mip;
uniform float u_lod;
uniform uint u_lutSize;
uniform int u_lutW;
uniform uint u_varSize;
uniform int u_varW;
uniform ivec2 u_pageSize;
uniform ivec2 u_pageCell;
uniform ivec4 u_ts;
uniform int u_margin;
uniform float u_opacity;
uniform vec4 u_layerTint;
// 1 for the 'multiply' layer blend: premultiply so DST_COLOR x ONE_MINUS_SRC_ALPHA is dst * (1 - a + a * rgb).
uniform float u_premul;
uniform float u_jitter;
uniform int u_hasTint;
uniform int u_useAvg;
out vec4 fragColor;
uint tileHash(uvec2 p) {
  uint h = p.x * 1664525u + p.y * 1013904223u;
  h ^= h >> 16;
  h *= 2246822519u;
  h ^= h >> 13;
  return h;
}
uint fetchU(usampler2D t, int w, uint i) {
  return texelFetch(t, ivec2(int(i) % w, int(i) / w), 0).r;
}
// Bilinear tap inside one tile of mip level L (clamped to the tile: no bleeding), premultiplied.
vec4 mipTap(int t, int L, vec2 f) {
  ivec2 tsz = max(u_ts.xy >> L, ivec2(1));
  vec2 p = f * vec2(tsz) - 0.5;
  vec2 pf = floor(p);
  vec2 w = p - pf;
  ivec2 i0 = clamp(ivec2(pf), ivec2(0), tsz - 1);
  ivec2 i1 = clamp(ivec2(pf) + 1, ivec2(0), tsz - 1);
  ivec2 org = ivec2(t % u_ts.z, t / u_ts.z) * tsz;
  vec4 a = texelFetch(u_mip, org + i0, L);
  vec4 b = texelFetch(u_mip, org + ivec2(i1.x, i0.y), L);
  vec4 c = texelFetch(u_mip, org + ivec2(i0.x, i1.y), L);
  vec4 d = texelFetch(u_mip, org + i1, L);
  a.rgb *= a.a; b.rgb *= b.a; c.rgb *= c.a; d.rgb *= d.a;
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
void main() {
  ivec2 cell = clamp(ivec2(floor(v_tile)), ivec2(0), u_pageSize - 1);
  uint id = texelFetch(u_index, cell, 0).r;
  if (id == 0u) discard;
  uint h = tileHash(uvec2(cell + u_pageCell));
  if (id < u_varSize) {
    uint head = fetchU(u_var, u_varW, id);
    uint n = head & 255u;
    if (n > 0u) id = fetchU(u_var, u_varW, (head >> 8) + h % n);
  }
  if (id < u_lutSize) id = fetchU(u_lut, u_lutW, id);
  if (id == 0u) discard;
  int t = int(id - 1u);
  vec4 c;
  if (u_useAvg == 1) {
    c = texelFetch(u_avg, ivec2(t % u_ts.z, t / u_ts.z), 0);
  } else if (u_lod > 0.0) {
    // Minified: blend two levels of the per-tile mip pyramid (trilinear), no cross-tile bleeding.
    int l0 = int(floor(u_lod));
    vec2 f = fract(v_tile);
    vec4 m = mipTap(t, l0, f);
    float fr = u_lod - float(l0);
    if (fr > 0.0) m = mix(m, mipTap(t, l0 + 1, f), fr);
    c = vec4(m.a > 0.0 ? m.rgb / m.a : vec3(0.0), m.a);
  } else {
    ivec2 tsz = u_ts.xy;
    ivec2 px = clamp(ivec2(floor(fract(v_tile) * vec2(tsz))), ivec2(0), tsz - 1);
    ivec2 org = ivec2(u_margin) + ivec2(t % u_ts.z, t / u_ts.z) * (tsz + u_ts.w);
    c = texelFetch(u_atlas, org + px, 0);
  }
  if (u_hasTint == 1) c *= texelFetch(u_tint, cell, 0);
  if (u_jitter > 0.0) c.rgb *= 1.0 + (float(h >> 8 & 255u) / 255.0 - 0.5) * u_jitter;
  if (u_hasBias == 1) c.rgb += texelFetch(u_bias, cell, 0).rgb * c.a;
  fragColor = vec4(c.rgb * u_layerTint.rgb, c.a * u_opacity * u_layerTint.a);
  fragColor.rgb *= mix(1.0, fragColor.a, u_premul);
}
`

const MAX_PAGE = 4096
const MAX_LUT_W = 2048

interface Page {
  tex: WebGLTexture
  tint: WebGLTexture | null
  bias: WebGLTexture | null
  x0: number
  y0: number
  w: number
  h: number
}

interface LayerGL {
  pages: Page[]
  pagesX: number
  pageTiles: number
  wide: boolean
  fullVersion: number
  lutTex: WebGLTexture | null
  lutW: number
  lutCap: number
  lutPad: Uint32Array | null
  lutVersion: number
  atlasTex: WebGLTexture | null
  atlasImage: unknown
  avgTex: WebGLTexture | null
  mipTex: WebGLTexture | null
  mipLevels: number
  mipImage: unknown
  tintVersion: number
  biasVersion: number
  varTex: WebGLTexture | null
  varW: number
  varVersion: number
  drawnRevision: number
  seenFrame: number
}

interface Uniforms {
  rect: WebGLUniformLocation | null
  origin: WebGLUniformLocation | null
  tileWorld: WebGLUniformLocation | null
  pageOrigin: WebGLUniformLocation | null
  camPos: WebGLUniformLocation | null
  zoom: WebGLUniformLocation | null
  canvasSize: WebGLUniformLocation | null
  shake: WebGLUniformLocation | null
  lutSize: WebGLUniformLocation | null
  lutW: WebGLUniformLocation | null
  pageSize: WebGLUniformLocation | null
  ts: WebGLUniformLocation | null
  margin: WebGLUniformLocation | null
  opacity: WebGLUniformLocation | null
  layerTint: WebGLUniformLocation | null
  premul: WebGLUniformLocation | null
  varSize: WebGLUniformLocation | null
  varW: WebGLUniformLocation | null
  pageCell: WebGLUniformLocation | null
  jitter: WebGLUniformLocation | null
  hasTint: WebGLUniformLocation | null
  hasBias: WebGLUniformLocation | null
  useAvg: WebGLUniformLocation | null
  lod: WebGLUniformLocation | null
}

export type { TileLayerRenderStats }

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`[TileLayer] shader compile error: ${gl.getShaderInfoLog(s)}`)
  }
  return s
}

/** WebGL2 renderer for {@link TileLayerData} components. Owned by the RenderSystem. */
export class TileLayerRenderer {
  /** Per-layer entries of the current frame, in draw order (same objects every frame). */
  readonly layerStats: LayerStats[] = []
  private cur: LayerStats = TileLayerRenderer.noLayer()
  private readonly texBytes = new Map<WebGLTexture, number>()
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private vbo: WebGLBuffer | null = null
  private dummyLut: WebGLTexture | null = null
  private dummyRGBA: WebGLTexture | null = null
  private u: Uniforms | null = null
  private maxTex = 2048
  private readonly states = new Map<TileLayerData, LayerGL>()
  private readonly layers: TileLayerData[] = []
  /** Layers with a `renderLayer`: drawn by the RenderSystem interleaved with sprites (see {@link drawSorted}). */
  readonly sorted: TileLayerData[] = []
  private cam = { x: 0, y: 0, zoom: 1, w: 1, h: 1, sx: 0, sy: 0, dpr: 1 }
  private readonly range = new Int32Array(4)
  private time = 0
  private frame = 0
  private lastLayerCount = 0

  // What `fold` has already added to the render stats this frame / for live textures.
  private foldU = 0
  private foldB = 0
  private foldTex = 0

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly stats: TileLayerRenderStats = createTileLayerRenderStats(),
  ) {}

  fold(s: RenderStats, own: number, first: boolean): void {
    const t = this.stats
    if (first) {
      this.foldU = this.foldB = 0
      for (const e of this.layerStats) s.layers.push(e)
    }
    s.textureUploads += t.textureUploads - this.foldU
    s.textureUploadBytes += t.textureUploadBytes - this.foldB
    s.textureBytes += t.textureBytes - this.foldTex
    s.textureCount = own + t.textureCount
    this.foldU = t.textureUploads
    this.foldB = t.textureUploadBytes
    this.foldTex = t.textureBytes
  }

  private static noLayer(): LayerStats {
    return { kind: 'tile', name: '', zIndex: 0, instances: 0, drawCalls: 0, uploadBytes: 0 }
  }

  /** Counts a texture upload of `bytes` against the frame totals and the current layer. */
  private up(bytes: number): void {
    const st = this.stats
    st.textureUploads++
    st.textureUploadBytes += bytes
    this.cur.uploadBytes += bytes
  }

  /** Registers a live texture's size (called on every create, again on re-size). */
  private track<T extends WebGLTexture | null>(tex: T, bytes: number): T {
    if (tex) {
      const st = this.stats
      st.textureBytes += bytes - (this.texBytes.get(tex) ?? 0)
      this.texBytes.set(tex, bytes)
      st.textureCount = this.texBytes.size
    }
    return tex
  }

  private free(tex: WebGLTexture | null): void {
    if (!tex) return
    const b = this.texBytes.get(tex)
    if (b !== undefined) {
      this.texBytes.delete(tex)
      this.stats.textureBytes -= b
      this.stats.textureCount = this.texBytes.size
    }
    this.gl.deleteTexture(tex)
  }

  /**
   * Collect layers, advance animations and upload pending changes.
   * Returns true when the tile image changed since the last frame.
   */
  prepare(world: ECSWorld, dt: number): boolean {
    const st = this.stats
    st.indexUploads = 0
    st.uploadedTexels = 0
    st.lutUploads = 0
    st.drawCalls = 0
    st.textureUploads = 0
    st.textureUploadBytes = 0
    this.frame++
    this.time += dt
    const layers = this.layers
    layers.length = 0
    const ids = world.query('TileLayer')
    for (let i = 0; i < ids.length; i++) {
      const c = world.getComponent<TileLayerComponent>(ids[i], 'TileLayer')
      if (!c) continue
      const l = c.layer
      // insertion sort by zIndex (few layers, stable)
      let j = layers.length
      layers.push(l)
      while (j > 0 && layers[j - 1].zIndex > l.zIndex) {
        layers[j] = layers[j - 1]
        j--
      }
      layers[j] = l
    }

    const sorted = this.sorted
    sorted.length = 0
    for (let i = 0; i < layers.length; i++) if (layers[i].renderLayer !== undefined) sorted.push(layers[i])

    let changed = layers.length !== this.lastLayerCount
    this.lastLayerCount = layers.length

    const ls = this.layerStats
    while (ls.length < layers.length) ls.push(TileLayerRenderer.noLayer())
    ls.length = layers.length

    if (layers.length > 0) {
      this.ensureProgram()
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i]
        const e = (this.cur = ls[i])
        e.name = layer.name || `tiles${i}`
        e.zIndex = layer.zIndex
        e.instances = 0
        e.drawCalls = 0
        e.uploadBytes = 0
        layer.updateAnimations(this.time)
        const s = this.ensureLayer(layer)
        s.seenFrame = this.frame
        this.upload(layer, s)
        if (s.drawnRevision !== layer.revision) changed = true
        else if (s.atlasImage !== layer.tileset.image && isTilesetReady(layer.tileset)) changed = true
      }
    }

    if (this.states.size > layers.length) {
      for (const [layer, s] of this.states) {
        if (s.seenFrame !== this.frame) {
          this.deleteLayer(s)
          this.states.delete(layer)
        }
      }
    }
    return changed
  }

  render(
    camX: number,
    camY: number,
    zoom: number,
    canvasW: number,
    canvasH: number,
    shakeX: number,
    shakeY: number,
    dpr = 1,
  ): void {
    this.stats.drawCalls = 0
    const c = this.cam
    c.x = camX
    c.y = camY
    c.zoom = zoom
    c.w = canvasW
    c.h = canvasH
    c.sx = shakeX
    c.sy = shakeY
    c.dpr = dpr
    this.drawLayers(false)
  }

  /**
   * Draw one layer from {@link sorted} with the camera of the last `render()`.
   * The caller restores its own GL program afterwards.
   */
  drawSorted(layer: TileLayerData): void {
    this.drawLayers(true, layer)
  }

  private drawLayers(sortedOnly: boolean, only?: TileLayerData): void {
    const layers = this.layers
    if (layers.length === 0 || !this.program || !this.u) return
    const { gl } = this
    const u = this.u
    const { x: camX, y: camY, zoom, w: canvasW, h: canvasH, sx: shakeX, sy: shakeY, dpr } = this.cam
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.uniform2f(u.camPos, camX, camY)
    gl.uniform1f(u.zoom, zoom)
    gl.uniform2f(u.canvasSize, canvasW, canvasH)
    gl.uniform2f(u.shake, shakeX, shakeY)
    const halfW = canvasW / (2 * zoom)
    const halfH = canvasH / (2 * zoom)
    const cx = camX - shakeX / zoom
    const cy = camY - shakeY / zoom
    const r = this.range

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]
      if (only ? layer !== only : (layer.renderLayer !== undefined) !== sortedOnly) continue
      const s = this.states.get(layer)!
      this.cur = this.layerStats[i]
      s.drawnRevision = layer.revision
      if (!layer.visible || layer.opacity <= 0 || !isTilesetReady(layer.tileset)) continue
      if (!visibleTileRange(layer, cx - halfW, cy - halfH, cx + halfW, cy + halfH, r)) continue
      if (s.atlasImage !== layer.tileset.image) this.uploadAtlas(layer, s)

      const ts = layer.tileset
      gl.uniform2f(u.origin, layer.x, layer.y)
      gl.uniform2f(u.tileWorld, layer.tileWorldWidth, layer.tileWorldHeight)
      gl.uniform4i(u.ts, ts.tileWidth, ts.tileHeight, ts.columns, ts.spacing ?? 0)
      gl.uniform1i(u.margin, ts.margin ?? 0)
      gl.uniform1f(u.opacity, layer.opacity)
      const tc = layer.tintColor
      gl.uniform4f(
        u.layerTint,
        (tc >>> 24) / 255,
        ((tc >>> 16) & 255) / 255,
        ((tc >>> 8) & 255) / 255,
        (tc & 255) / 255,
      )
      if (layer.blend !== 'normal') setBlendFunc(gl, layer.blend)
      gl.uniform1f(u.premul, layer.blend === 'multiply' ? 1 : 0)
      gl.uniform1ui(u.lutSize, s.lutTex ? layer.lutSize : 0)
      gl.uniform1i(u.lutW, s.lutW || 1)
      gl.uniform1ui(u.varSize, s.varTex ? layer.variantSize : 0)
      gl.uniform1i(u.varW, s.varW || 1)
      gl.uniform1f(u.jitter, layer.jitter)
      // Below ~2 device pixels per tile, one texel per pixel aliases; use the tile's average colour.
      const pxPerTile = Math.min(layer.tileWorldWidth, layer.tileWorldHeight) * zoom * dpr
      gl.uniform1i(u.useAvg, s.avgTex && pxPerTile < layer.farZoomPx ? 1 : 0)
      // Minified: atlas texels per device pixel; mipmap mode filters instead of point-sampling.
      let lod = 0
      if (layer.minFilter === 'mipmap') {
        const texelsPerPx = Math.max(
          ts.tileWidth / (layer.tileWorldWidth * zoom * dpr),
          ts.tileHeight / (layer.tileWorldHeight * zoom * dpr),
        )
        if (texelsPerPx > 1.2) {
          if (s.mipImage !== ts.image) this.uploadMips(layer, s)
          if (s.mipTex) lod = Math.min(Math.log2(texelsPerPx), s.mipLevels)
        }
      }
      gl.uniform1f(u.lod, lod)
      const tinted = layer.tints !== null
      gl.uniform1i(u.hasTint, tinted ? 1 : 0)
      const biased = layer.biases !== null
      gl.uniform1i(u.hasBias, biased ? 1 : 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, s.atlasTex)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, s.lutTex ?? this.dummyLut)
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, s.varTex ?? this.dummyLut)
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_2D, s.avgTex ?? this.dummyRGBA)
      gl.activeTexture(gl.TEXTURE6)
      gl.bindTexture(gl.TEXTURE_2D, s.mipTex ?? this.dummyRGBA)

      for (let p = 0; p < s.pages.length; p++) {
        const pg = s.pages[p]
        const x0 = Math.max(r[0], pg.x0)
        const y0 = Math.max(r[1], pg.y0)
        const x1 = Math.min(r[2], pg.x0 + pg.w)
        const y1 = Math.min(r[3], pg.y0 + pg.h)
        if (x1 <= x0 || y1 <= y0) continue
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_2D, tinted && pg.tint ? pg.tint : this.dummyRGBA)
        gl.activeTexture(gl.TEXTURE7)
        gl.bindTexture(gl.TEXTURE_2D, biased && pg.bias ? pg.bias : this.dummyRGBA)
        gl.uniform2i(u.pageCell, pg.x0, pg.y0)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, pg.tex)
        gl.uniform4f(u.rect, x0, y0, x1, y1)
        gl.uniform2f(u.pageOrigin, pg.x0, pg.y0)
        gl.uniform2i(u.pageSize, pg.w, pg.h)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        this.stats.drawCalls++
        this.cur.drawCalls++
        this.cur.instances += (x1 - x0) * (y1 - y0)
      }
      if (layer.blend !== 'normal') setBlendFunc(gl, 'normal')
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindVertexArray(null)
  }

  /** GL objects die with the context; drop them so they are rebuilt lazily. */
  contextRestored(): void {
    this.states.clear()
    this.texBytes.clear()
    this.stats.textureCount = 0
    this.stats.textureBytes = 0
    this.program = null
    this.vao = null
    this.vbo = null
    this.dummyLut = null
    this.dummyRGBA = null
    this.u = null
    this.lastLayerCount = -1
  }

  dispose(): void {
    const { gl } = this
    for (const s of this.states.values()) this.deleteLayer(s)
    this.states.clear()
    if (this.program) gl.deleteProgram(this.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.vbo) gl.deleteBuffer(this.vbo)
    if (this.dummyLut) gl.deleteTexture(this.dummyLut)
    if (this.dummyRGBA) gl.deleteTexture(this.dummyRGBA)
    this.contextRestored()
  }

  private ensureProgram(): void {
    if (this.program) return
    const { gl } = this
    const prog = gl.createProgram()!
    const vs = compile(gl, gl.VERTEX_SHADER, TILE_VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, TILE_FRAG)
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`[TileLayer] program link error: ${gl.getProgramInfoLog(prog)}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    this.program = prog
    const loc = (n: string) => gl.getUniformLocation(prog, n)
    this.u = {
      rect: loc('u_rect'),
      origin: loc('u_origin'),
      tileWorld: loc('u_tileWorld'),
      pageOrigin: loc('u_pageOrigin'),
      camPos: loc('u_camPos'),
      zoom: loc('u_zoom'),
      canvasSize: loc('u_canvasSize'),
      shake: loc('u_shake'),
      lutSize: loc('u_lutSize'),
      lutW: loc('u_lutW'),
      pageSize: loc('u_pageSize'),
      ts: loc('u_ts'),
      margin: loc('u_margin'),
      opacity: loc('u_opacity'),
      layerTint: loc('u_layerTint'),
      premul: loc('u_premul'),
      varSize: loc('u_varSize'),
      varW: loc('u_varW'),
      pageCell: loc('u_pageCell'),
      jitter: loc('u_jitter'),
      hasTint: loc('u_hasTint'),
      hasBias: loc('u_hasBias'),
      useAvg: loc('u_useAvg'),
      lod: loc('u_lod'),
    }
    gl.useProgram(prog)
    gl.uniform1i(loc('u_atlas'), 0)
    gl.uniform1i(loc('u_index'), 1)
    gl.uniform1i(loc('u_lut'), 2)
    gl.uniform1i(loc('u_var'), 3)
    gl.uniform1i(loc('u_tint'), 4)
    gl.uniform1i(loc('u_bias'), 7)
    gl.uniform1i(loc('u_avg'), 5)
    gl.uniform1i(loc('u_mip'), 6)

    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    this.vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
    gl.bindVertexArray(null)

    this.dummyLut = this.createIntTexture(1, 1, true, false)
    this.dummyRGBA = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.dummyRGBA)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    this.maxTex = Math.min(MAX_PAGE, (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 2048)
  }

  private createIntTexture(w: number, h: number, wide: boolean, count = true): WebGLTexture {
    const { gl } = this
    const tex = gl.createTexture()!
    if (count) this.track(tex, w * h * (wide ? 4 : 2))
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, wide ? gl.R32UI : gl.R16UI, w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  private ensureLayer(layer: TileLayerData): LayerGL {
    let s = this.states.get(layer)
    if (s) return s
    const pageTiles = Math.max(layer.chunkSize, Math.floor(this.maxTex / layer.chunkSize) * layer.chunkSize)
    const wide = layer.tiles instanceof Uint32Array
    const pages: Page[] = []
    const pagesX = Math.ceil(layer.width / pageTiles)
    const pagesY = Math.ceil(layer.height / pageTiles)
    for (let py = 0; py < pagesY; py++) {
      for (let px = 0; px < pagesX; px++) {
        const x0 = px * pageTiles
        const y0 = py * pageTiles
        const w = Math.min(pageTiles, layer.width - x0)
        const h = Math.min(pageTiles, layer.height - y0)
        pages.push({ tex: this.createIntTexture(w, h, wide), tint: null, bias: null, x0, y0, w, h })
      }
    }
    s = {
      pages,
      pagesX,
      pageTiles,
      wide,
      fullVersion: -1,
      lutTex: null,
      lutW: 0,
      lutCap: 0,
      lutPad: null,
      lutVersion: -1,
      atlasTex: null,
      atlasImage: null,
      avgTex: null,
      mipTex: null,
      mipLevels: 0,
      mipImage: null,
      tintVersion: -1,
      biasVersion: -1,
      varTex: null,
      varW: 0,
      varVersion: -1,
      drawnRevision: -1,
      seenFrame: 0,
    }
    this.states.set(layer, s)
    return s
  }

  private upload(layer: TileLayerData, s: LayerGL): void {
    const { gl } = this
    let tintsFresh = false
    if (layer.tints && s.tintVersion !== layer.tintVersion) {
      this.uploadTintsFull(layer, s)
      tintsFresh = true
    }
    let biasFresh = false
    if (layer.biases && s.biasVersion !== layer.biasVersion) {
      this.uploadBiasFull(layer, s)
      biasFresh = true
    }
    const needFull = s.fullVersion !== layer.fullVersion
    if (needFull || layer.dirtyCount > 0) {
      const fmt = gl.RED_INTEGER
      const type = s.wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
      gl.activeTexture(gl.TEXTURE1)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layer.width)
      if (needFull) {
        for (let p = 0; p < s.pages.length; p++) {
          const pg = s.pages[p]
          this.subUpload(layer, pg, pg.x0, pg.y0, pg.w, pg.h, fmt, type)
          // setTiles/fill drop the pending dirty list, so a setTint made in the same frame would
          // otherwise never reach the GPU: re-upload the page's tints with the full replace.
          if (layer.tints && pg.tint && !tintsFresh) this.tintUpload(layer, pg, pg.x0, pg.y0, pg.w, pg.h)
          if (layer.biases && pg.bias && !biasFresh) this.biasUpload(layer, pg, pg.x0, pg.y0, pg.w, pg.h)
        }
        s.fullVersion = layer.fullVersion
      } else {
        const rect = layer.dirtyRect
        for (let k = 0; k < layer.dirtyCount; k++) {
          const o = layer.dirtyList[k] * 4
          const x0 = rect[o]
          const y0 = rect[o + 1]
          const pg = s.pages[Math.floor(y0 / s.pageTiles) * s.pagesX + Math.floor(x0 / s.pageTiles)]
          const w = rect[o + 2] - x0 + 1
          const h = rect[o + 3] - y0 + 1
          this.subUpload(layer, pg, x0, y0, w, h, fmt, type)
          if (layer.tints && pg.tint) this.tintUpload(layer, pg, x0, y0, w, h)
          if (layer.biases && pg.bias) this.biasUpload(layer, pg, x0, y0, w, h)
        }
      }
      layer.clearDirty()
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.activeTexture(gl.TEXTURE0)
    }
    if (s.lutVersion !== layer.lutVersion) this.uploadLut(layer, s)
    if (s.varVersion !== layer.variantVersion) this.uploadVariants(layer, s)
  }

  private uploadTintsFull(layer: TileLayerData, s: LayerGL): void {
    const { gl } = this
    s.tintVersion = layer.tintVersion
    gl.activeTexture(gl.TEXTURE4)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layer.width)
    for (const pg of s.pages) {
      if (!pg.tint) {
        pg.tint = this.track(gl.createTexture()!, pg.w * pg.h * 4)
        gl.bindTexture(gl.TEXTURE_2D, pg.tint)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, pg.w, pg.h)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      }
      this.tintUpload(layer, pg, pg.x0, pg.y0, pg.w, pg.h)
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    gl.activeTexture(gl.TEXTURE0)
  }

  // Expects UNPACK_ROW_LENGTH = layer.width.
  private tintUpload(layer: TileLayerData, pg: Page, x: number, y: number, w: number, h: number): void {
    const { gl } = this
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, pg.tint)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x - pg.x0, y - pg.y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, layer.tints!, 0)
    this.up(w * h * 4)
    gl.activeTexture(gl.TEXTURE1)
  }

  private uploadBiasFull(layer: TileLayerData, s: LayerGL): void {
    const { gl } = this
    s.biasVersion = layer.biasVersion
    gl.activeTexture(gl.TEXTURE7)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layer.width)
    for (const pg of s.pages) {
      if (!pg.bias) {
        pg.bias = this.track(gl.createTexture()!, pg.w * pg.h * 4)
        gl.bindTexture(gl.TEXTURE_2D, pg.bias)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, pg.w, pg.h)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      }
      this.biasUpload(layer, pg, pg.x0, pg.y0, pg.w, pg.h)
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    gl.activeTexture(gl.TEXTURE0)
  }

  // Expects UNPACK_ROW_LENGTH = layer.width.
  private biasUpload(layer: TileLayerData, pg: Page, x: number, y: number, w: number, h: number): void {
    const { gl } = this
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(gl.TEXTURE_2D, pg.bias)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x - pg.x0, y - pg.y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, layer.biases!, 0)
    this.up(w * h * 4)
    gl.activeTexture(gl.TEXTURE1)
  }

  private uploadVariants(layer: TileLayerData, s: LayerGL): void {
    const { gl } = this
    s.varVersion = layer.variantVersion
    this.free(s.varTex)
    s.varTex = null
    const table = layer.variantTable
    if (!table) return
    const w = Math.min(table.length, MAX_LUT_W)
    const h = Math.ceil(table.length / w)
    const data = w * h === table.length ? table : new Uint32Array(w * h)
    if (data !== table) data.set(table)
    s.varTex = this.createIntTexture(w, h, true)
    s.varW = w
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, data, 0)
    this.up(w * h * 4)
  }

  private subUpload(
    layer: TileLayerData,
    pg: Page,
    x: number,
    y: number,
    w: number,
    h: number,
    fmt: number,
    type: number,
  ): void {
    const { gl } = this
    gl.bindTexture(gl.TEXTURE_2D, pg.tex)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x - pg.x0, y - pg.y0, w, h, fmt, type, layer.tiles, 0)
    this.stats.indexUploads++
    this.stats.uploadedTexels += w * h
    this.up(w * h * (layer.tiles instanceof Uint32Array ? 4 : 2))
  }

  private uploadLut(layer: TileLayerData, s: LayerGL): void {
    const { gl } = this
    s.lutVersion = layer.lutVersion
    const lut = layer.lut
    if (!lut) {
      this.free(s.lutTex)
      s.lutTex = null
      s.lutW = 0
      s.lutCap = 0
      s.lutPad = null
      return
    }
    const w = Math.min(lut.length, MAX_LUT_W)
    const h = Math.ceil(lut.length / w)
    if (!s.lutTex || s.lutCap !== w * h || s.lutW !== w) {
      this.free(s.lutTex)
      s.lutTex = this.createIntTexture(w, h, true)
      s.lutW = w
      s.lutCap = w * h
      s.lutPad = w * h === lut.length ? null : new Uint32Array(w * h)
    }
    let src = lut
    if (s.lutPad) {
      s.lutPad.set(lut)
      src = s.lutPad
    }
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, s.lutTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, src, 0)
    gl.activeTexture(gl.TEXTURE0)
    this.stats.lutUploads++
    this.up(w * h * 4)
  }

  private uploadAtlas(layer: TileLayerData, s: LayerGL): void {
    const { gl } = this
    this.free(s.atlasTex)
    const tex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.tileset.image as TexImageSource)
    const im = layer.tileset.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
    const atlasBytes = (im.naturalWidth || im.width || 0) * (im.naturalHeight || im.height || 0) * 4
    this.track(tex, atlasBytes)
    this.up(atlasBytes)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    s.atlasTex = tex
    s.atlasImage = layer.tileset.image
    this.free(s.avgTex)
    s.avgTex = this.createAverageTexture(layer)
    this.free(s.mipTex)
    s.mipTex = null
    s.mipImage = null
  }

  /**
   * Per-tile mip pyramid (box filter, alpha-weighted) in one texture with explicit
   * levels: tile t at level L sits at ((t % columns) * (tw >> L), (t / columns) * (th >> L)).
   * Built once per atlas image, on the first minified draw. Null if the atlas can't be read.
   */
  private uploadMips(layer: TileLayerData, s: LayerGL): void {
    const { gl } = this
    s.mipImage = layer.tileset.image
    this.free(s.mipTex)
    s.mipTex = null
    s.mipLevels = 0
    const ts = layer.tileset
    const levels = buildTileMips(ts)
    if (!levels) return
    const tex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE6)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, levels.length, gl.RGBA8, levels[0].w, levels[0].h)
    for (let L = 0; L < levels.length; L++) {
      gl.texSubImage2D(gl.TEXTURE_2D, L, 0, 0, levels[L].w, levels[L].h, gl.RGBA, gl.UNSIGNED_BYTE, levels[L].data)
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.activeTexture(gl.TEXTURE0)
    this.track(
      tex,
      levels.reduce((a, l) => a + l.w * l.h * 4, 0),
    )
    s.mipTex = tex
    s.mipLevels = levels.length - 1
  }

  /** One texel per atlas tile holding its mean colour; null if the atlas can't be read. */
  private createAverageTexture(layer: TileLayerData): WebGLTexture | null {
    const ts = layer.tileset
    const img = ts.image as TexImageSource & { width: number; height: number; naturalWidth?: number }
    try {
      const iw = img.naturalWidth || img.width
      const ih = (img as { naturalHeight?: number }).naturalHeight || img.height
      const sp = ts.spacing ?? 0
      const mg = ts.margin ?? 0
      const cols = ts.columns
      const rows = Math.max(1, Math.floor((ih - 2 * mg + sp) / (ts.tileHeight + sp)))
      const c = document.createElement('canvas')
      c.width = iw
      c.height = ih
      const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null
      if (!ctx) return null
      ctx.drawImage(img as CanvasImageSource, 0, 0)
      const px = ctx.getImageData(0, 0, iw, ih).data
      if (!px || px.length < iw * ih * 4) return null
      const out = new Uint8Array(cols * rows * 4)
      for (let t = 0; t < cols * rows; t++) {
        const ox = mg + (t % cols) * (ts.tileWidth + sp)
        const oy = mg + Math.floor(t / cols) * (ts.tileHeight + sp)
        let r = 0,
          g = 0,
          b = 0,
          a = 0
        for (let y = oy; y < oy + ts.tileHeight && y < ih; y++) {
          for (let x = ox; x < ox + ts.tileWidth && x < iw; x++) {
            const o = (y * iw + x) * 4
            const al = px[o + 3]
            r += px[o] * al
            g += px[o + 1] * al
            b += px[o + 2] * al
            a += al
          }
        }
        const n = ts.tileWidth * ts.tileHeight
        out[t * 4] = a ? r / a : 0
        out[t * 4 + 1] = a ? g / a : 0
        out[t * 4 + 2] = a ? b / a : 0
        out[t * 4 + 3] = a / n
      }
      const { gl } = this
      const tex = gl.createTexture()!
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, out)
      this.track(tex, cols * rows * 4)
      this.up(cols * rows * 4)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.activeTexture(gl.TEXTURE0)
      return tex
    } catch {
      // Cross-origin atlas without CORS: keep exact sampling at every zoom.
      return null
    }
  }

  private deleteLayer(s: LayerGL): void {
    for (const pg of s.pages) {
      this.free(pg.tex)
      this.free(pg.tint)
      this.free(pg.bias)
    }
    this.free(s.lutTex)
    this.free(s.atlasTex)
    this.free(s.avgTex)
    this.free(s.mipTex)
    this.free(s.varTex)
  }
}
