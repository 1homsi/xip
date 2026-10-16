import { parseCSSColor } from './colorParser'
import type { LayerCamera } from './spriteLayerGL'
import type { CircleShapeComponent, LineShapeComponent, PolygonShapeComponent } from './components/shapes'
import type { GradientComponent } from './components/gradient'

/**
 * WebGL2 drawing of the vector components (Circle, Line, Polygon) and the baking of
 * Gradient textures. Circles and line segments are one instanced quad each, shaded with a
 * rounded-box signed distance field so fill, stroke and edges are antialiased analytically at
 * any zoom. Polygon fills are triangulated (ear clipping, cached per component) and drawn
 * as flat triangles; their outlines are capsule segments.
 */

const SDF_FLOATS = 15
const MAX_SDF = 8192
const TRI_FLOATS = 6 // x, y, r, g, b, a
const MAX_TRI_VERTS = 3 * 8192

const CAMERA = `
uniform vec2 u_camPos;
uniform float u_zoom;
uniform vec2 u_canvasSize;
uniform vec2 u_shake;
vec4 toClip(vec2 world) {
  return vec4(
    2.0 * u_zoom / u_canvasSize.x * (world.x - u_camPos.x) + 2.0 * u_shake.x / u_canvasSize.x,
    -2.0 * u_zoom / u_canvasSize.y * (world.y - u_camPos.y) - 2.0 * u_shake.y / u_canvasSize.y,
    0.0, 1.0);
}
`

const SDF_VERT = `#version 300 es
layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec2 i_pos;
layout(location = 2) in float i_ang;
layout(location = 3) in vec2 i_half;
layout(location = 4) in float i_rr;
layout(location = 5) in float i_sw;
layout(location = 6) in vec4 i_fill;
layout(location = 7) in vec4 i_stroke;
${CAMERA}
uniform float u_px;
out vec2 v_p;
flat out vec2 v_half;
flat out float v_rr;
flat out float v_sw;
flat out vec4 v_fill;
flat out vec4 v_stroke;
void main() {
  float margin = i_sw * 0.5 + 1.5 / u_px;
  vec2 local = a_quad * 2.0 * (i_half + margin);
  float c = cos(i_ang);
  float s = sin(i_ang);
  vec2 world = i_pos + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  gl_Position = toClip(world);
  v_p = local;
  v_half = i_half;
  v_rr = i_rr;
  v_sw = i_sw;
  v_fill = i_fill;
  v_stroke = i_stroke;
}
`

const SDF_FRAG = `#version 300 es
precision highp float;
in vec2 v_p;
flat in vec2 v_half;
flat in float v_rr;
flat in float v_sw;
flat in vec4 v_fill;
flat in vec4 v_stroke;
uniform float u_px;
out vec4 fragColor;
void main() {
  vec2 q = abs(v_p) - (v_half - v_rr);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - v_rr;
  float fa = v_fill.a * clamp(0.5 - d * u_px, 0.0, 1.0);
  float sa = v_sw > 0.0 ? v_stroke.a * clamp(0.5 - (abs(d) - v_sw * 0.5) * u_px, 0.0, 1.0) : 0.0;
  float a = sa + fa * (1.0 - sa);
  if (a <= 0.0) discard;
  vec3 rgb = (v_stroke.rgb * sa + v_fill.rgb * fa * (1.0 - sa)) / a;
  fragColor = vec4(rgb, a);
}
`

const TRI_VERT = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_color;
${CAMERA}
out vec4 v_color;
void main() {
  gl_Position = toClip(a_pos);
  v_color = a_color;
}
`

const TRI_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }
`

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`[Shapes] ${gl.getShaderInfoLog(sh)}`)
    gl.attachShader(p, sh)
  }
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[Shapes] ${gl.getProgramInfoLog(p)}`)
  return p
}

interface CamUniforms {
  cam: WebGLUniformLocation | null
  zoom: WebGLUniformLocation | null
  size: WebGLUniformLocation | null
  shake: WebGLUniformLocation | null
  px: WebGLUniformLocation | null
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): CamUniforms {
  return {
    cam: gl.getUniformLocation(p, 'u_camPos'),
    zoom: gl.getUniformLocation(p, 'u_zoom'),
    size: gl.getUniformLocation(p, 'u_canvasSize'),
    shake: gl.getUniformLocation(p, 'u_shake'),
    px: gl.getUniformLocation(p, 'u_px'),
  }
}

/** Ear-clipping triangulation of a simple polygon: indices into `pts` (x, y pairs). */
export function triangulate(pts: ArrayLike<{ x: number; y: number }>): number[] {
  const n = pts.length
  const out: number[] = []
  if (n < 3) return out
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  const idx: number[] = []
  for (let i = 0; i < n; i++) idx.push(area >= 0 ? i : n - 1 - i)
  const cross = (a: number, b: number, c: number) =>
    (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x)
  let guard = 0
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length]
      const b = idx[i]
      const c = idx[(i + 1) % idx.length]
      if (cross(a, b, c) <= 0) continue // reflex or degenerate corner
      let inside = false
      for (const j of idx) {
        if (j === a || j === b || j === c) continue
        if (cross(a, b, j) >= 0 && cross(b, c, j) >= 0 && cross(c, a, j) >= 0) {
          inside = true
          break
        }
      }
      if (inside) continue
      out.push(a, b, c)
      idx.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) {
      // Self-intersecting or fully degenerate input: fall back to a fan so something is drawn.
      for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1])
      return out
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2])
  return out
}

function pointsKey(pts: ArrayLike<{ x: number; y: number }>): number {
  let h = 2166136261 ^ pts.length
  for (let i = 0; i < pts.length; i++) {
    h = Math.imul(h ^ ((pts[i].x * 64) | 0), 16777619)
    h = Math.imul(h ^ ((pts[i].y * 64) | 0), 16777619)
  }
  return h >>> 0
}

export class ShapeRenderer {
  private sdfProg: WebGLProgram | null = null
  private triProg: WebGLProgram | null = null
  private sdfVao: WebGLVertexArrayObject | null = null
  private triVao: WebGLVertexArrayObject | null = null
  private sdfBuf: WebGLBuffer | null = null
  private triBuf: WebGLBuffer | null = null
  private sdfU!: CamUniforms
  private triU!: CamUniforms
  private readonly sdf = new Float32Array(MAX_SDF * SDF_FLOATS)
  private readonly tri = new Float32Array(MAX_TRI_VERTS * TRI_FLOATS)
  private sdfN = 0
  private triN = 0
  private cam: LayerCamera | null = null
  private px = 1
  private readonly triCache = new WeakMap<PolygonShapeComponent, { key: number; idx: number[] }>()
  drawCalls = 0
  instances = 0

  constructor(private readonly gl: WebGL2RenderingContext) {}

  private init(): void {
    const { gl } = this
    this.sdfProg = program(gl, SDF_VERT, SDF_FRAG)
    this.triProg = program(gl, TRI_VERT, TRI_FRAG)
    this.sdfU = uniforms(gl, this.sdfProg)
    this.triU = uniforms(gl, this.triProg)

    this.sdfVao = gl.createVertexArray()!
    gl.bindVertexArray(this.sdfVao)
    const quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
    this.sdfBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sdfBuf)
    gl.bufferData(gl.ARRAY_BUFFER, this.sdf.byteLength, gl.DYNAMIC_DRAW)
    let off = 0
    const attr = (loc: number, size: number) => {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, SDF_FLOATS * 4, off)
      gl.vertexAttribDivisor(loc, 1)
      off += size * 4
    }
    attr(1, 2)
    attr(2, 1)
    attr(3, 2)
    attr(4, 1)
    attr(5, 1)
    attr(6, 4)
    attr(7, 4)

    this.triVao = gl.createVertexArray()!
    gl.bindVertexArray(this.triVao)
    this.triBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf)
    gl.bufferData(gl.ARRAY_BUFFER, this.tri.byteLength, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, TRI_FLOATS * 4, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, TRI_FLOATS * 4, 8)
    gl.bindVertexArray(null)
  }

  /** GL objects died with the context; rebuild on next draw. */
  contextRestored(): void {
    this.sdfProg = this.triProg = null
    this.sdfN = this.triN = 0
  }

  dispose(): void {
    const { gl } = this
    if (this.sdfProg) gl.deleteProgram(this.sdfProg)
    if (this.triProg) gl.deleteProgram(this.triProg)
    if (this.sdfVao) gl.deleteVertexArray(this.sdfVao)
    if (this.triVao) gl.deleteVertexArray(this.triVao)
    if (this.sdfBuf) gl.deleteBuffer(this.sdfBuf)
    if (this.triBuf) gl.deleteBuffer(this.triBuf)
    this.sdfProg = this.triProg = null
  }

  /** Start a frame: camera of the world pass and device pixels per world unit. */
  begin(cam: LayerCamera, pxPerUnit: number): void {
    this.cam = cam
    this.px = pxPerUnit
    this.drawCalls = 0
    this.instances = 0
    this.sdfN = this.triN = 0
  }

  /** True while geometry waits for `flush()`. */
  get pending(): boolean {
    return this.sdfN > 0 || this.triN > 0
  }

  private pushSdf(
    x: number,
    y: number,
    ang: number,
    hx: number,
    hy: number,
    rr: number,
    sw: number,
    fill: readonly number[],
    fillAlpha: number,
    stroke: readonly number[] | null,
    strokeAlpha: number,
  ): void {
    // Strictly ordered with triangles: a switch of primitive kind is a flush.
    if (this.triN > 0) this.flush()
    if (this.sdfN === MAX_SDF) this.flush()
    const d = this.sdf
    const o = this.sdfN++ * SDF_FLOATS
    d[o] = x
    d[o + 1] = y
    d[o + 2] = ang
    d[o + 3] = hx
    d[o + 4] = hy
    d[o + 5] = rr
    d[o + 6] = sw
    d[o + 7] = fill[0]
    d[o + 8] = fill[1]
    d[o + 9] = fill[2]
    d[o + 10] = fill[3] * fillAlpha
    d[o + 11] = stroke ? stroke[0] : 0
    d[o + 12] = stroke ? stroke[1] : 0
    d[o + 13] = stroke ? stroke[2] : 0
    d[o + 14] = stroke ? stroke[3] * strokeAlpha : 0
  }

  /** World-space bounding radius test against the view (with `pad` margin). */
  static visible(cam: LayerCamera, x: number, y: number, radius: number): boolean {
    return !(x + radius < cam.viewL || x - radius > cam.viewR || y + radius < cam.viewT || y - radius > cam.viewB)
  }

  circle(x: number, y: number, c: CircleShapeComponent): boolean {
    const sw = c.strokeColor && c.strokeWidth ? c.strokeWidth : 0
    const r = c.radius
    if (!(r > 0) || !this.cam || !ShapeRenderer.visible(this.cam, x, y, r + sw)) return false
    this.pushSdf(
      x,
      y,
      0,
      r,
      r,
      r,
      sw,
      parseCSSColor(c.color),
      c.opacity,
      sw ? parseCSSColor(c.strokeColor!) : null,
      c.opacity,
    )
    return true
  }

  private segment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    color: readonly number[],
    opacity: number,
    cap: CanvasLineCap,
  ): void {
    const dx = x1 - x0
    const dy = y1 - y0
    const len = Math.hypot(dx, dy)
    const w = width > 0 ? width : 1
    const ext = cap === 'butt' ? 0 : w / 2
    // A zero-length segment draws a dot with round/square caps and nothing with butt.
    if (len === 0 && cap === 'butt') return
    this.pushSdf(
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      Math.atan2(dy, dx),
      len / 2 + ext,
      w / 2,
      cap === 'round' ? w / 2 : 0,
      0,
      color,
      opacity,
      null,
      0,
    )
  }

  line(x: number, y: number, rot: number, l: LineShapeComponent): boolean {
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const ex = x + cos * l.endX - sin * l.endY
    const ey = y + sin * l.endX + cos * l.endY
    const pad = l.lineWidth + Math.hypot(l.endX, l.endY)
    if (!this.cam || !ShapeRenderer.visible(this.cam, x, y, pad)) return false
    this.segment(x, y, ex, ey, l.lineWidth, parseCSSColor(l.color), l.opacity, l.lineCap)
    return true
  }

  polygon(x: number, y: number, rot: number, p: PolygonShapeComponent): boolean {
    const pts = p.points
    const n = pts.length
    if (n < 2 || !this.cam) return false
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    let radius = 0
    for (let i = 0; i < n; i++) radius = Math.max(radius, Math.abs(pts[i].x) + Math.abs(pts[i].y))
    const sw = p.strokeColor && p.strokeWidth ? p.strokeWidth : 0
    if (!ShapeRenderer.visible(this.cam, x, y, radius + sw)) return false
    if (n >= 3) {
      const key = pointsKey(pts)
      let cached = this.triCache.get(p)
      if (!cached || cached.key !== key) this.triCache.set(p, (cached = { key, idx: triangulate(pts) }))
      const fill = parseCSSColor(p.color)
      const a = fill[3] * p.opacity
      const idx = cached.idx
      if (idx.length > 0 && a > 0) {
        if (this.sdfN > 0) this.flush()
        for (let k = 0; k < idx.length; k++) {
          if (this.triN === MAX_TRI_VERTS) this.flush()
          const pt = pts[idx[k]]
          const o = this.triN++ * TRI_FLOATS
          this.tri[o] = x + cos * pt.x - sin * pt.y
          this.tri[o + 1] = y + sin * pt.x + cos * pt.y
          this.tri[o + 2] = fill[0]
          this.tri[o + 3] = fill[1]
          this.tri[o + 4] = fill[2]
          this.tri[o + 5] = a
        }
      }
    }
    if (sw) {
      const color = parseCSSColor(p.strokeColor!)
      const edges = p.closed ? n : n - 1
      for (let i = 0; i < edges; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % n]
        // Round caps double as round joins.
        this.segment(
          x + cos * a.x - sin * a.y,
          y + sin * a.x + cos * a.y,
          x + cos * b.x - sin * b.y,
          y + sin * b.x + cos * b.y,
          sw,
          color,
          p.opacity,
          'round',
        )
      }
    }
    return true
  }

  gradientKey(g: GradientComponent): string {
    return gradientKey(g)
  }

  bakeGradient(g: GradientComponent): HTMLCanvasElement | null {
    return bakeGradient(g)
  }

  /** Draw everything queued since the last flush. */
  flush(): void {
    const { gl } = this
    if (this.sdfN === 0 && this.triN === 0) return
    if (!this.sdfProg) this.init()
    const cam = this.cam!
    if (this.triN > 0) {
      const u = this.triU
      gl.useProgram(this.triProg)
      gl.uniform2f(u.cam, cam.x, cam.y)
      gl.uniform1f(u.zoom, cam.zoom)
      gl.uniform2f(u.size, cam.width, cam.height)
      gl.uniform2f(u.shake, cam.shakeX, cam.shakeY)
      gl.bindVertexArray(this.triVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.tri, 0, this.triN * TRI_FLOATS)
      gl.drawArrays(gl.TRIANGLES, 0, this.triN)
      this.drawCalls++
      this.instances += this.triN / 3
      this.triN = 0
    }
    if (this.sdfN > 0) {
      const u = this.sdfU
      gl.useProgram(this.sdfProg)
      gl.uniform2f(u.cam, cam.x, cam.y)
      gl.uniform1f(u.zoom, cam.zoom)
      gl.uniform2f(u.size, cam.width, cam.height)
      gl.uniform2f(u.shake, cam.shakeX, cam.shakeY)
      gl.uniform1f(u.px, this.px)
      gl.bindVertexArray(this.sdfVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sdfBuf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sdf, 0, this.sdfN * SDF_FLOATS)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.sdfN)
      this.drawCalls++
      this.instances += this.sdfN
      this.sdfN = 0
    }
    gl.bindVertexArray(null)
  }
}

/** Signature of everything that changes a gradient's pixels (not its placement). */
export function gradientKey(g: GradientComponent): string {
  let s = `${g.gradientType}|${g.angle}|${g.innerRadius}|${g.width}x${g.height}`
  for (const st of g.stops) s += `|${st.offset}:${st.color}`
  return s
}

/** Paint a gradient into a small canvas (at most 256 px on the long side) to use as a texture. */
export function bakeGradient(g: GradientComponent): HTMLCanvasElement | null {
  const w0 = Math.max(1, g.width)
  const h0 = Math.max(1, g.height)
  const s = Math.min(1, 256 / Math.max(w0, h0))
  const w = Math.max(1, Math.round(w0 * s))
  const h = Math.max(1, Math.round(h0 * s))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  let grad: CanvasGradient
  if (g.gradientType === 'radial') {
    const r = Math.min(w, h) / 2
    grad = ctx.createRadialGradient(w / 2, h / 2, g.innerRadius * r, w / 2, h / 2, r)
  } else {
    const cos = Math.cos(g.angle)
    const sin = Math.sin(g.angle)
    grad = ctx.createLinearGradient(
      w / 2 - (cos * w) / 2,
      h / 2 - (sin * h) / 2,
      w / 2 + (cos * w) / 2,
      h / 2 + (sin * h) / 2,
    )
  }
  for (const st of g.stops) grad.addColorStop(st.offset, st.color)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  return canvas
}
