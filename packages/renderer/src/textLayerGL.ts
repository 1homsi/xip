import type { GlyphAtlas, AtlasPage } from './glyphAtlas'
import { LAYOUT_GLYPH_FLOATS, TEXT_HIDDEN, type TextLayer } from './textLayer'
import type { LayerCamera } from './spriteLayerGL'
import { setBlendFunc } from './blendModes'

/** Floats per glyph instance: x, y, w, h, cos, sin, u0, v0, u1, v1, r, g, b, a. */
const FLOATS = 14
const MAX_BATCH = 16384

const VERT = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 i_rect;
layout(location = 2) in vec2 i_rot;
layout(location = 3) in vec4 i_uv;
layout(location = 4) in vec4 i_color;
uniform vec2 u_camPos;
uniform float u_zoom;
uniform vec2 u_canvasSize;
uniform vec2 u_shake;
out vec2 v_uv;
out vec4 v_color;
void main() {
  vec2 local = a_corner * i_rect.zw;
  vec2 world = i_rect.xy + vec2(i_rot.x * local.x - i_rot.y * local.y, i_rot.y * local.x + i_rot.x * local.y);
  gl_Position = vec4(
    2.0 * u_zoom / u_canvasSize.x * (world.x - u_camPos.x) + 2.0 * u_shake.x / u_canvasSize.x,
    -2.0 * u_zoom / u_canvasSize.y * (world.y - u_camPos.y) - 2.0 * u_shake.y / u_canvasSize.y,
    0.0, 1.0);
  v_uv = mix(i_uv.xy, i_uv.zw, a_corner);
  v_color = i_color;
}
`

// The atlas is uploaded premultiplied (no dark fringes under linear filtering).
const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() {
  vec4 t = texture(u_tex, v_uv);
  fragColor = vec4(t.rgb * v_color.rgb, t.a) * v_color.a;
}
`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`[TextLayer] ${gl.getShaderInfoLog(sh)}`)
  return sh
}

interface PageTex {
  tex: WebGLTexture
  rev: number
  bytes: number
}

export interface TextLayerStatsSink {
  texture(tex: WebGLTexture, w: number, h: number): void
  free(tex: WebGLTexture): void
  upload(bytes: number): void
}

/** Draws TextLayers: every glyph of every visible run in one instanced call per atlas page. */
export class TextLayerRenderer {
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null
  private uCam: WebGLUniformLocation | null = null
  private uZoom: WebGLUniformLocation | null = null
  private uSize: WebGLUniformLocation | null = null
  private uShake: WebGLUniformLocation | null = null
  // Grows to the glyph count of the frame (reserve); MAX_BATCH is the ceiling.
  private data = new Float32Array(0)
  private readonly pageTex = new Map<AtlasPage, PageTex>()
  /** Set by the render system so atlas textures count in its stats. */
  sink: TextLayerStatsSink | null = null
  drawCalls = 0
  instances = 0
  uploadBytes = 0

  constructor(private readonly gl: WebGL2RenderingContext) {}

  private init(): void {
    const { gl } = this
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[TextLayer] ${gl.getProgramInfoLog(p)}`)
    this.program = p
    this.data = new Float32Array(0)
    this.uCam = gl.getUniformLocation(p, 'u_camPos')
    this.uZoom = gl.getUniformLocation(p, 'u_zoom')
    this.uSize = gl.getUniformLocation(p, 'u_canvasSize')
    this.uShake = gl.getUniformLocation(p, 'u_shake')
    gl.useProgram(p)
    gl.uniform1i(gl.getUniformLocation(p, 'u_tex'), 0)
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    const quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
    this.buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW)
    let off = 0
    const attr = (loc: number, size: number) => {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, FLOATS * 4, off)
      gl.vertexAttribDivisor(loc, 1)
      off += size * 4
    }
    attr(1, 4)
    attr(2, 2)
    attr(3, 4)
    attr(4, 4)
    gl.bindVertexArray(null)
  }

  /** GL objects died with the context; rebuild on next draw. */
  contextRestored(): void {
    this.program = null
    this.pageTex.clear()
  }

  dispose(): void {
    const { gl } = this
    if (this.program) gl.deleteProgram(this.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.buffer) gl.deleteBuffer(this.buffer)
    for (const t of this.pageTex.values()) {
      gl.deleteTexture(t.tex)
      this.sink?.free(t.tex)
    }
    this.pageTex.clear()
    this.program = null
  }

  /** Upload (or refresh the dirty rect of) an atlas page and return its texture. */
  private pageTexture(page: AtlasPage): WebGLTexture {
    const { gl } = this
    let t = this.pageTex.get(page)
    gl.activeTexture(gl.TEXTURE0)
    if (!t) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, page.canvas)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const bytes = page.size * page.size * 4
      t = { tex, rev: page.rev, bytes }
      this.pageTex.set(page, t)
      page.dirty = null
      this.sink?.texture(tex, page.size, page.size)
      this.uploadBytes += bytes
      return tex
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    if (t.rev !== page.rev && page.dirty) {
      const { x0, y0, x1, y1 } = page.dirty
      const w = Math.min(page.size, x1) - x0
      const h = Math.min(page.size, y1) - y0
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, page.size)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, page.canvas)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      page.dirty = null
      const bytes = w * h * 4
      this.uploadBytes += bytes
      this.sink?.upload(bytes)
    }
    t.rev = page.rev
    return t.tex
  }

  draw(layer: TextLayer, cam: LayerCamera): void {
    const count = layer.count
    if (!layer.visible || count === 0) return
    const { gl } = this
    const atlas: GlyphAtlas = layer.atlas
    layer.updateDensity(cam.zoom * (cam.dpr ?? 1))
    // Lay every candidate run out first: rasterising can reset the atlas, which
    // invalidates earlier layouts, so retry once from a clean atlas.
    const { viewL, viewR, viewT, viewB } = cam
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = atlas.generation
      for (let i = 0; i < count; i++) {
        if (layer.flags[i] & TEXT_HIDDEN) continue
        if (this.far(layer, i, viewL, viewR, viewT, viewB)) continue
        layer.layout(i)
      }
      if (atlas.generation === gen) break
    }
    if (!this.program) this.init()
    gl.useProgram(this.program)
    gl.uniform2f(this.uCam, cam.x, cam.y)
    gl.uniform1f(this.uZoom, cam.zoom)
    gl.uniform2f(this.uSize, cam.width, cam.height)
    gl.uniform2f(this.uShake, cam.shakeX, cam.shakeY)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    setBlendFunc(gl, layer.blend, true)
    const tint = layer.tintColor
    const tr = (tint >>> 24) / 255
    const tg = ((tint >>> 16) & 255) / 255
    const tb = ((tint >>> 8) & 255) / 255
    const ta = (tint & 255) / 255
    let glyphs = 0
    for (let i = 0; i < count; i++) glyphs += layer.layoutIfCached(i)?.n ?? 0
    this.reserve(glyphs)
    const d = this.data
    const order = layer.sortByKey ? layer.drawOrder() : null
    for (let p = 0; p < atlas.pages.length; p++) {
      const page = atlas.pages[p]
      let batch = 0
      let bound = false
      for (let k0 = 0; k0 < count; k0++) {
        const i = order ? order[k0] : k0
        const flags = layer.flags[i]
        if (flags & TEXT_HIDDEN) continue
        const lay = layer.layoutIfCached(i)
        if (!lay || lay.n === 0 || lay.gen !== atlas.generation || lay.ref !== layer.atlasStyle(layer.style[i]))
          continue
        const size = layer.size[i]
        const sc = size / layer.atlasStyle(layer.style[i]).rasterSize
        const w = lay.width * sc
        const h = lay.height * sc
        const rot = layer.rotation[i]
        const c = rot === 0 ? 1 : Math.cos(rot)
        const s = rot === 0 ? 0 : Math.sin(rot)
        const ox = -layer.anchorX[i] * w
        const oy = -layer.anchorY[i] * h
        const px = layer.x[i]
        const py = layer.y[i]
        // Cull on the rotated block's bounding circle.
        const rad = Math.abs(ox) + Math.abs(oy) + w + h
        if (px + rad < viewL || px - rad > viewR || py + rad < viewT || py - rad > viewB) continue
        const col = layer.color[i]
        const a = ((col & 255) / 255) * layer.alpha[i] * layer.opacity * ta
        if (a <= 0) continue
        const r = ((col >>> 24) / 255) * tr
        const g = (((col >>> 16) & 255) / 255) * tg
        const bl = (((col >>> 8) & 255) / 255) * tb
        const G = lay.glyphs
        for (let k = 0, o = 0; k < lay.n; k++, o += LAYOUT_GLYPH_FLOATS) {
          if (G[o + 8] !== p) continue
          const lx = ox + G[o] * sc
          const ly = oy + G[o + 1] * sc
          const b = batch * FLOATS
          d[b] = px + c * lx - s * ly
          d[b + 1] = py + s * lx + c * ly
          d[b + 2] = G[o + 2] * sc
          d[b + 3] = G[o + 3] * sc
          d[b + 4] = c
          d[b + 5] = s
          d[b + 6] = G[o + 4]
          d[b + 7] = G[o + 5]
          d[b + 8] = G[o + 6]
          d[b + 9] = G[o + 7]
          d[b + 10] = r
          d[b + 11] = g
          d[b + 12] = bl
          d[b + 13] = a
          if (++batch === MAX_BATCH) {
            if (!bound) (this.pageTexture(page), (bound = true))
            this.flush(batch)
            batch = 0
          }
        }
      }
      if (batch > 0) {
        if (!bound) this.pageTexture(page)
        this.flush(batch)
      }
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(null)
  }

  /** True when run `i` is certainly off screen, judged without laying it out. */
  private far(layer: TextLayer, i: number, l: number, r: number, t: number, b: number): boolean {
    const style = layer.atlasStyle(layer.style[i])
    const lc = layer.layoutIfCached(i)
    const cur = lc && lc.ref === style ? lc : undefined
    const size = layer.size[i]
    let extent: number
    if (cur) extent = (cur.width + cur.height) * (size / layer.atlasStyle(layer.style[i]).rasterSize)
    else extent = layer.texts[i].length * size * 1.2 + size * 4
    extent *= 1.5
    const x = layer.x[i]
    const y = layer.y[i]
    return x + extent < l || x - extent > r || y + extent < t || y - extent > b
  }

  /** Grows the batch (power-of-two steps from 256 glyphs, at most MAX_BATCH) to hold `n` glyphs. */
  private reserve(n: number): void {
    const want = Math.min(n, MAX_BATCH)
    if (this.data.length >= want * FLOATS) return
    let cap = 256
    while (cap < want) cap *= 2
    cap = Math.min(cap, MAX_BATCH)
    this.data = new Float32Array(cap * FLOATS)
    const { gl } = this
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW)
  }

  private flush(n: number): void {
    const { gl } = this
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, n * FLOATS)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n)
    this.drawCalls++
    this.instances += n
  }
}
