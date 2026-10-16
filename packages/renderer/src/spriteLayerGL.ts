import {
  ATLASES_PER_DRAW,
  MAX_LAYER_ATLASES,
  SPRITE_FLIP_X,
  SPRITE_FLIP_Y,
  SPRITE_HIDDEN,
  SPRITE_SWAY,
  SPRITE_UNTEXTURED,
  SPRITE_ADDITIVE,
} from './spriteLayerFlags'
import type { SpriteLayer, AtlasFrame } from './spriteLayer'
import { setBlendFunc, unpackRGBA } from './blendModes'
import type { LayerStats } from '@xip/core'

const FLOATS = 21

/** Per-layer packed instances kept between frames (see SpriteLayerRenderer.gather). */
interface Retained {
  cap: number
  /** 0 = unknown, 1 = packed at slotPos, 2 = not drawable (atlas loading / unknown frame). */
  valid: Uint8Array
  /** Snapshot of the source fields the packed instance was built from. */
  sFrame: Uint32Array
  sMeta: Uint16Array
  sColor: Uint32Array
  sAdd: Uint32Array
  /** Instances in draw order: the packed data, retained between frames, and what the GPU buffer holds. */
  pos: Float32Array
  /** Slot at each position / position of each slot (-1 none); kept consistent. */
  posSlot: Int32Array
  slotPos: Int32Array
  /** drawnEpoch[i] === epoch: slot i was drawn by the last full gather. */
  drawnEpoch: Uint32Array
  epoch: number
  gpu: WebGLBuffer | null
  gpuCap: number
  /** Draw segments: start, end, atlas group (-1 none), additive (0/1). */
  segs: number[]
  segCount: number
  /** Changed position runs awaiting upload: start, end pairs (ascending). */
  runs: number[]
  runEnd: number
  uploadAll: boolean
  /** Retained bookkeeping is switched off while (nearly) every sprite changes every frame. */
  blind: boolean
  /** Consecutive full-dirty frames in which most sprites had changed. */
  hot: number
  /** Sprites repacked by the last full gather. */
  changed: number
  sig: Float64Array
  sigLen: number
  tables: (unknown | undefined)[]
  vL: number
  vR: number
  vT: number
  vB: number
  count: number
  /** `SpriteLayer.orderVersion` the packed instances were gathered under. */
  orderVersion: number
  n: number
  endsAdditive: boolean
}

/** @internal exported for tests */
export const SPRITE_LAYER_VERT = `#version 300 es
layout(location = 0) in vec2 a_quadPos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec2  i_pos;
layout(location = 3) in vec2  i_size;
layout(location = 4) in float i_rot;
layout(location = 5) in vec2  i_anchor;
layout(location = 6) in vec2  i_flip;
layout(location = 7) in vec4  i_color;
layout(location = 8) in vec4  i_uvRect;
layout(location = 9) in float i_atlas;
layout(location = 10) in vec2 i_sway;
uniform float u_time;
uniform vec2 u_wind;
uniform vec2 u_windShape; // (snap step in world px or 0, fromY)
layout(location = 11) in float i_add;
uniform vec2 u_camPos;
uniform float u_zoom;
uniform vec2 u_canvasSize;
uniform vec2 u_shake;
out vec2 v_uv;
out vec4 v_color;
flat out int v_atlas;
flat out vec3 v_add;
out float v_h;
flat out vec4 v_rect;
flat out vec2 v_shift;
void main() {
  vec2 local = (a_quadPos - (i_anchor - 0.5)) * i_size;
  float top = 0.5 - a_quadPos.y;
  if (i_flip.y > 0.5) top = 1.0 - top;
  v_h = top;
  v_shift = vec2(0.0, -1.0);
  vec2 uvq = a_uv;
  float wave = 0.0;
  if (i_sway.x != 0.0) {
    wave = sin(6.2831853 * u_wind.x * u_time + u_wind.y * i_pos.x + i_sway.y);
    if (u_windShape.x > 0.0) {
      // Whole-pixel sway: the quad grows sideways and the fragment shader shifts the
      // canopy texels by a snapped step, so pixel art stays on the pixel grid.
      float step_ = u_windShape.x;
      float dx = floor(i_sway.x * abs(i_size.y) * wave / step_ + 0.5) * step_;
      float pad = abs(i_sway.x) * abs(i_size.y) + step_;
      float sgn = a_quadPos.x > 0.0 ? 1.0 : -1.0;
      local.x += sgn * pad;
      uvq.x += sgn * pad / abs(i_size.x);
      v_shift = vec2(dx / abs(i_size.x) * i_uvRect.z * (i_flip.x > 0.5 ? -1.0 : 1.0), u_windShape.y);
    }
  }
  if (i_flip.x > 0.5) local.x = -local.x;
  if (i_flip.y > 0.5) local.y = -local.y;
  float c = cos(i_rot);
  float s = sin(i_rot);
  vec2 world = i_pos + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  if (i_sway.x != 0.0 && u_windShape.x <= 0.0) {
    // Smooth sway: 1 at the top of the quad, 0 at and below fromY; squared so the trunk stays stiff.
    float ramp = clamp((top - u_windShape.y) / (1.0 - u_windShape.y), 0.0, 1.0);
    world.x += i_sway.x * abs(i_size.y) * ramp * ramp * wave;
  }
  gl_Position = vec4(
    2.0 * u_zoom / u_canvasSize.x * (world.x - u_camPos.x) + 2.0 * u_shake.x / u_canvasSize.x,
    -2.0 * u_zoom / u_canvasSize.y * (world.y - u_camPos.y) - 2.0 * u_shake.y / u_canvasSize.y,
    0.0, 1.0);
  v_uv = i_uvRect.xy + uvq * i_uvRect.zw;
  v_rect = i_uvRect;
  v_color = i_color;
  v_atlas = i_atlas < -0.5 ? -1 : int(i_atlas + 0.5);
  // i_add is an exact integer < 2^24; adding 0.5 would tie-round in float32 above 2^23.
  float ap = i_add;
  v_add = vec3(floor(ap / 65536.0), mod(floor(ap / 256.0), 256.0), mod(floor(ap), 256.0)) / 255.0;
}
`

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_color;
flat in int v_atlas;
flat in vec3 v_add;
in float v_h;
flat in vec4 v_rect;
flat in vec2 v_shift;
uniform sampler2D u_tex[${ATLASES_PER_DRAW}];
uniform vec4 u_layerTint;
// 1 for the 'multiply' layer blend: premultiply so DST_COLOR x ONE_MINUS_SRC_ALPHA is dst * (1 - a + a * rgb).
uniform float u_premul;
out vec4 fragColor;
void main() {
  vec4 t = vec4(1.0);
  vec2 uv = v_uv;
  if (v_shift.y >= 0.0) {
    if (v_h >= v_shift.y) uv.x -= v_shift.x;
    if (uv.x < v_rect.x || uv.x > v_rect.x + v_rect.z) discard;
  }
  switch (v_atlas) {
${Array.from({ length: ATLASES_PER_DRAW }, (_, i) => `    case ${i}: t = texture(u_tex[${i}], uv); break;`).join('\n')}
    default: break;
  }
  fragColor = t * v_color * u_layerTint;
  fragColor.rgb += v_add * fragColor.a;
  fragColor.rgb *= mix(1.0, fragColor.a, u_premul);
}
`

/** A resolved atlas texture, or null while it is still loading. */
export interface ResolvedAtlas {
  tex: WebGLTexture
  width: number
  height: number
}

export interface LayerCamera {
  x: number
  y: number
  zoom: number
  width: number
  height: number
  shakeX: number
  shakeY: number
  viewL: number
  viewR: number
  viewT: number
  viewB: number
  /** Seconds since the render system started: drives GPU sway. */
  time?: number
  /** Device pixels per CSS pixel. */
  dpr?: number
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`[SpriteLayer] ${gl.getShaderInfoLog(sh)}`)
  return sh
}

/** Draws SpriteLayers; atlases are bound in groups of 8 (one draw call per run of sprites in a group). */
export class SpriteLayerRenderer {
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private uCam: WebGLUniformLocation | null = null
  private uZoom: WebGLUniformLocation | null = null
  private uSize: WebGLUniformLocation | null = null
  private uShake: WebGLUniformLocation | null = null
  private uTime: WebGLUniformLocation | null = null
  private uWind: WebGLUniformLocation | null = null
  private uWindShape: WebGLUniformLocation | null = null
  private uTint: WebGLUniformLocation | null = null
  private uPremul: WebGLUniformLocation | null = null
  private readonly tintScratch = new Float32Array(4)
  private readonly retained = new Map<SpriteLayer, Retained>()
  // Per-atlas state for the layer being drawn (rebuilt every draw).
  private readonly texs: (WebGLTexture | null)[] = new Array(MAX_LAYER_ATLASES).fill(null)
  private readonly invW = new Float32Array(MAX_LAYER_ATLASES)
  private readonly invH = new Float32Array(MAX_LAYER_ATLASES)
  private readonly uw = new Float32Array(MAX_LAYER_ATLASES)
  private readonly vh = new Float32Array(MAX_LAYER_ATLASES)
  private readonly stepU = new Float32Array(MAX_LAYER_ATLASES)
  private readonly stepV = new Float32Array(MAX_LAYER_ATLASES)
  private readonly originU = new Float32Array(MAX_LAYER_ATLASES)
  private readonly originV = new Float32Array(MAX_LAYER_ATLASES)
  private readonly insetU = new Float32Array(MAX_LAYER_ATLASES)
  private readonly insetV = new Float32Array(MAX_LAYER_ATLASES)
  private readonly cols = new Int32Array(MAX_LAYER_ATLASES)
  private readonly ready = new Uint8Array(MAX_LAYER_ATLASES)
  drawCalls = 0
  instances = 0
  /** Instance-buffer bytes uploaded by the last `draw`. */
  uploadBytes = 0
  private readonly rows: LayerStats[] = []

  constructor(private readonly gl: WebGL2RenderingContext) {}

  private init(): void {
    const { gl } = this
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, SPRITE_LAYER_VERT))
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[SpriteLayer] ${gl.getProgramInfoLog(p)}`)
    this.program = p
    this.uCam = gl.getUniformLocation(p, 'u_camPos')
    this.uZoom = gl.getUniformLocation(p, 'u_zoom')
    this.uSize = gl.getUniformLocation(p, 'u_canvasSize')
    this.uShake = gl.getUniformLocation(p, 'u_shake')
    this.uTime = gl.getUniformLocation(p, 'u_time')
    this.uWind = gl.getUniformLocation(p, 'u_wind')
    this.uWindShape = gl.getUniformLocation(p, 'u_windShape')
    this.uTint = gl.getUniformLocation(p, 'u_layerTint')
    this.uPremul = gl.getUniformLocation(p, 'u_premul')
    gl.useProgram(p)
    for (let i = 0; i < ATLASES_PER_DRAW; i++) gl.uniform1i(gl.getUniformLocation(p, `u_tex[${i}]`), i)

    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    const quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -0.5, -0.5, 0, 0, 0.5, -0.5, 1, 0, -0.5, 0.5, 0, 1, 0.5, -0.5, 1, 0, 0.5, 0.5, 1, 1, -0.5, 0.5, 0, 1,
      ]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)
    // Instance attributes 2..11 read from each layer's own buffer (pointed per draw).
    for (let loc = 2; loc <= 11; loc++) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
  }

  /** Appends the last `draw`'s counters for `layer` to the per-layer stats `out`. */
  record(out: LayerStats[], layer: SpriteLayer): void {
    const e = (this.rows[out.length] ??= {
      kind: 'sprite',
      name: '',
      zIndex: 0,
      instances: 0,
      drawCalls: 0,
      uploadBytes: 0,
    })
    e.name = layer.name
    e.zIndex = layer.zIndex
    e.instances = this.instances
    e.drawCalls = this.drawCalls
    e.uploadBytes = this.uploadBytes
    out.push(e)
  }

  /** GL objects died with the context; rebuild on next draw. */
  contextRestored(): void {
    this.program = null
    this.retained.clear()
  }

  /** Free the retained buffers of a layer that left the scene. */
  release(layer: SpriteLayer): void {
    const R = this.retained.get(layer)
    if (R?.gpu) this.gl.deleteBuffer(R.gpu)
    this.retained.delete(layer)
  }

  dispose(): void {
    const { gl } = this
    if (this.program) gl.deleteProgram(this.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    for (const R of this.retained.values()) if (R.gpu) gl.deleteBuffer(R.gpu)
    this.retained.clear()
    this.program = null
  }

  /**
   * `resolve(i)` returns atlas i's texture or null while loading; `white` is
   * bound to unused units; `applySampling(i)` sets the filter of the texture
   * currently bound for atlas i. Sprites whose atlas isn't ready are skipped.
   */
  draw(
    layer: SpriteLayer,
    cam: LayerCamera,
    resolve: (i: number) => ResolvedAtlas | null,
    white: WebGLTexture,
    applySampling: (atlasIndex: number, tex: WebGLTexture) => void,
  ): void {
    const count = layer.count
    if (!layer.visible || count === 0) return
    const { gl } = this
    if (!this.program) this.init()
    gl.useProgram(this.program)
    gl.uniform2f(this.uCam, cam.x, cam.y)
    gl.uniform1f(this.uZoom, cam.zoom)
    gl.uniform2f(this.uSize, cam.width, cam.height)
    gl.uniform2f(this.uShake, cam.shakeX, cam.shakeY)
    const wind = layer.wind
    const swayAmp = wind ? (wind.amplitude ?? 0.04) : 0
    gl.uniform1f(this.uTime, cam.time ?? 0)
    gl.uniform2f(this.uWind, wind?.speed ?? 0.5, wind?.frequency ?? 0.01)
    const snap = wind ? (wind.snap === true ? 1 : wind.snap || 0) : 0
    // Rigid whole-pixel sway needs a fixed base: default the fixed fraction to 0.5 there.
    const fromY = Math.min(0.99, Math.max(0, wind?.fromY ?? (snap > 0 ? 0.5 : 0)))
    gl.uniform2f(this.uWindShape, snap, fromY)
    const tc = this.tintScratch
    unpackRGBA(layer.tintColor, tc)
    gl.uniform4f(this.uTint, tc[0], tc[1], tc[2], tc[3] * layer.opacity)
    if (layer.blend !== 'normal') setBlendFunc(gl, layer.blend)
    gl.uniform1f(this.uPremul, layer.blend === 'multiply' ? 1 : 0)

    const atlases = layer.atlases
    const na = Math.min(atlases.length, MAX_LAYER_ATLASES)
    const frameTables: (AtlasFrame[] | undefined)[] = this.frameTables
    for (let a = 0; a < na; a++) {
      const r = resolve(a)
      const at = atlases[a]
      this.texs[a] = r ? r.tex : null
      // 2 = atlas without a source: its sprites draw as solid rects.
      this.ready[a] = at.src === undefined && at.image === undefined && at.dynamicSrc === undefined ? 2 : r ? 1 : 0
      frameTables[a] = at.frames
      if (!r) continue
      const W = r.width
      const H = r.height
      this.invW[a] = 1 / W
      this.invH[a] = 1 / H
      const inset = at.inset ?? 0
      this.insetU[a] = inset / W
      this.insetV[a] = inset / H
      const fw = at.frameWidth ?? 0
      const fh = at.frameHeight ?? 0
      if (fw > 0 && fh > 0) {
        const sp = at.frameSpacing ?? 0
        const mg = at.frameMargin ?? 0
        this.cols[a] = at.frameColumns ?? Math.max(1, Math.floor((W - 2 * mg + sp) / (fw + sp)))
        this.uw[a] = fw / W
        this.vh[a] = fh / H
        this.stepU[a] = (fw + sp) / W
        this.stepV[a] = (fh + sp) / H
        this.originU[a] = mg / W
        this.originV[a] = mg / H
      } else {
        this.cols[a] = 1
        this.uw[a] = 1
        this.vh[a] = 1
        this.stepU[a] = 0
        this.stepV[a] = 0
        this.originU[a] = 0
        this.originV[a] = 0
      }
    }
    // Every unit holds a valid texture before the first draw (solid sprites bind none).
    for (let u = 0; u < ATLASES_PER_DRAW; u++) {
      gl.activeTexture(gl.TEXTURE0 + u)
      gl.bindTexture(gl.TEXTURE_2D, white)
    }
    gl.bindVertexArray(this.vao)

    const R = this.retain(layer)
    const usePivots = layer.hasPivots()
    const perSprite = usePivots || layer.anchor !== null
    // Anything that changes how a sprite packs: when it differs from last frame, repack everything.
    const sig = this.sigScratch
    let sn = 0
    sig[sn++] = layer.anchorX
    sig[sn++] = layer.anchorY
    sig[sn++] = perSprite ? 1 : 0
    sig[sn++] = swayAmp
    sig[sn++] = na
    for (let a = 0; a < na; a++) {
      sig[sn++] = this.ready[a]
      sig[sn++] = this.invW[a]
      sig[sn++] = this.invH[a]
      sig[sn++] = this.insetU[a]
      sig[sn++] = this.cols[a]
      sig[sn++] = this.uw[a]
      sig[sn++] = this.vh[a]
      sig[sn++] = this.stepU[a]
      sig[sn++] = this.originU[a]
      sig[sn++] = this.originV[a]
      const t = frameTables[a]
      sig[sn++] = t ? t.length : -1
    }
    let sigChanged = R.sigLen !== sn || layer._repack
    for (let q = 0; !sigChanged && q < sn; q++) if (sig[q] !== R.sig[q]) sigChanged = true
    for (let a = 0; !sigChanged && a < na; a++) if (R.tables[a] !== frameTables[a]) sigChanged = true
    if (sigChanged) {
      R.sig.set(sig.subarray(0, sn))
      R.sigLen = sn
      for (let a = 0; a < na; a++) R.tables[a] = frameTables[a]
      R.valid.fill(0)
      layer._repack = false
      layer._dAll = true
    }
    const dirtyAll = layer._dAll
    const dLo = layer._dLo
    const dHi = layer._dHi
    const anyDirty = dirtyAll || dHi >= 0
    layer._dAll = false
    layer._dLo = 0x7fffffff
    layer._dHi = -1

    const { viewL, viewR, viewT, viewB } = cam
    const sameView = R.vL === viewL && R.vR === viewR && R.vT === viewT && R.vB === viewB
    if (anyDirty || !sameView || R.count !== count || R.segCount < 0) {
      R.vL = viewL
      R.vR = viewR
      R.vT = viewT
      R.vB = viewB
      const hotFrame = dirtyAll || dHi - dLo >= count >> 1
      if (R.blind && !hotFrame) {
        // updates became sparse again: rebuild the retained state from scratch
        R.blind = false
        R.hot = 0
        R.valid.fill(0)
        R.posSlot.fill(-1)
        R.slotPos.fill(-1)
        R.drawnEpoch.fill(0)
      }
      if (R.blind) {
        this.gatherBlind(layer, R, na, usePivots, perSprite, swayAmp)
        R.uploadAll = true
      } else {
        let orderKept = true
        if (layer.sortByKey) {
          layer.drawOrder()
          // other callers (pick) may have consumed the change already: compare against what was packed
          orderKept = R.orderVersion === layer.orderVersion
          R.orderVersion = layer.orderVersion
        }
        const sparse =
          !dirtyAll &&
          sameView &&
          orderKept &&
          R.count === count &&
          R.segCount >= 0 &&
          dHi >= 0 &&
          dHi - dLo < count >> 3
        const incremental = sparse && this.gatherRange(layer, R, na, usePivots, perSprite, swayAmp, dLo, dHi)
        if (!incremental) {
          // a gatherRange that gave up may already have repacked slots in place: re-upload them all
          if (
            sparse ||
            (R.count === count && !dirtyAll && sameView && dHi >= 0 && dHi - dLo < count >> 3 && !layer.sortByKey)
          )
            R.uploadAll = true
          this.gather(layer, R, na, usePivots, perSprite, swayAmp, dirtyAll, dLo, dHi, anyDirty)
          // Nearly everything changed, repeatedly: the compare and bookkeeping cannot pay off.
          if (hotFrame && R.changed * 10 > R.n * 7) {
            if (++R.hot >= 3) R.blind = true
          } else R.hot = 0
        }
      }
    }
    R.count = count
    this.submit(layer, R, na, white, applySampling)
    if (R.endsAdditive || layer.blend !== 'normal') setBlendFunc(gl, 'normal')
    gl.bindVertexArray(null)
    gl.activeTexture(gl.TEXTURE0)
  }

  private readonly sigScratch = new Float64Array(5 + MAX_LAYER_ATLASES * 11)

  private retain(layer: SpriteLayer): Retained {
    let R = this.retained.get(layer)
    if (!R) {
      R = {
        cap: 0,
        valid: new Uint8Array(0),
        sFrame: new Uint32Array(0),
        sMeta: new Uint16Array(0),
        sColor: new Uint32Array(0),
        sAdd: new Uint32Array(0),
        pos: new Float32Array(0),
        posSlot: new Int32Array(0),
        slotPos: new Int32Array(0),
        drawnEpoch: new Uint32Array(0),
        epoch: 1,
        gpu: null,
        gpuCap: 0,
        segs: [],
        segCount: -1,
        runs: [],
        runEnd: -1000,
        uploadAll: false,
        blind: false,
        hot: 0,
        changed: 0,
        sig: new Float64Array(5 + MAX_LAYER_ATLASES * 11),
        sigLen: -1,
        tables: new Array(MAX_LAYER_ATLASES),
        vL: NaN,
        vR: NaN,
        vT: NaN,
        vB: NaN,
        count: -1,
        orderVersion: -1,
        n: 0,
        endsAdditive: false,
      }
      this.retained.set(layer, R)
    }
    if (R.cap < layer.capacity) {
      const cap = layer.capacity
      // Per-slot state restarts empty: everything repacks once (growth is rare).
      R.valid = new Uint8Array(cap)
      R.sFrame = new Uint32Array(cap)
      R.sMeta = new Uint16Array(cap)
      R.sColor = new Uint32Array(cap)
      R.sAdd = new Uint32Array(cap)
      R.pos = new Float32Array(cap * FLOATS)
      R.posSlot = new Int32Array(cap).fill(-1)
      R.slotPos = new Int32Array(cap).fill(-1)
      R.drawnEpoch = new Uint32Array(cap)
      R.cap = cap
      R.segCount = -1
      R.gpuCap = 0 // the GPU buffer is re-created at the new size on submit
    }
    return R
  }

  private markRun(R: Retained, n: number): void {
    const runs = R.runs
    // sorted layers visit positions out of order: never shrink a run that already reaches past `n`
    if (runs.length > 0 && n >= runs[runs.length - 2] && n <= R.runEnd + 8) {
      if (n + 1 > runs[runs.length - 1]) runs[runs.length - 1] = n + 1
    } else runs.push(n, n + 1)
    R.runEnd = runs[runs.length - 1]
  }

  /** Write sprite `i`'s instance at position `n`; false (and valid = 2) when it cannot be drawn. */
  private repack(
    layer: SpriteLayer,
    R: Retained,
    i: number,
    n: number,
    na: number,
    usePivots: boolean,
    perSprite: boolean,
    swayAmp: number,
  ): boolean {
    const flags = layer.flags[i]
    let a = layer.atlas[i]
    const c = layer.color[i]
    const f = layer.frame[i]
    const CA = layer.colorAdd
    const add = CA ? CA[i] : 0
    const untextured = (flags & SPRITE_UNTEXTURED) !== 0 || a >= na || this.ready[a] === 2
    let u0 = 0,
      v0 = 0,
      uw = 1,
      vh = 1
    if (!untextured) {
      if (this.ready[a] === 0) {
        R.valid[i] = 2
        return false
      }
      const table = this.frameTables[a]
      if (table !== undefined) {
        const fr = table[f]
        if (fr === undefined) {
          R.valid[i] = 2
          return false
        }
        const iu = this.insetU[a]
        const iv = this.insetV[a]
        u0 = fr.x * this.invW[a] + iu
        v0 = fr.y * this.invH[a] + iv
        uw = fr.w * this.invW[a] - 2 * iu
        vh = fr.h * this.invH[a] - 2 * iv
      } else {
        const cols = this.cols[a]
        const iu = this.insetU[a]
        const iv = this.insetV[a]
        u0 = this.originU[a] + (f % cols) * this.stepU[a] + iu
        v0 = this.originV[a] + Math.floor(f / cols) * this.stepV[a] + iv
        uw = this.uw[a] - 2 * iu
        vh = this.vh[a] - 2 * iv
      }
    }
    const meta = (a << 8) | flags
    R.sMeta[i] = meta
    R.sFrame[i] = f
    R.sColor[i] = c
    R.sAdd[i] = add
    const d = R.pos
    const b = n * FLOATS
    d[b] = layer.x[i]
    d[b + 1] = layer.y[i]
    d[b + 2] = layer.w[i]
    d[b + 3] = layer.h[i]
    d[b + 4] = layer.rotation[i]
    if (perSprite) {
      layer.resolveAnchor(i, usePivots)
      d[b + 5] = layer._ax
      d[b + 6] = layer._ay
    } else {
      d[b + 5] = layer.anchorX
      d[b + 6] = layer.anchorY
    }
    d[b + 7] = flags & SPRITE_FLIP_X
    d[b + 8] = (flags & SPRITE_FLIP_Y) >> 1
    d[b + 9] = (c >>> 24) / 255
    d[b + 10] = ((c >>> 16) & 255) / 255
    d[b + 11] = ((c >>> 8) & 255) / 255
    d[b + 12] = (c & 255) / 255
    d[b + 13] = u0
    d[b + 14] = v0
    d[b + 15] = uw
    d[b + 16] = vh
    if (untextured) a = -1
    d[b + 17] = a < 0 ? -1 : a & 7
    d[b + 18] = swayAmp !== 0 && flags & SPRITE_SWAY ? swayAmp * (layer.swayScale ? layer.swayScale[i] : 1) : 0
    d[b + 19] = 0
    d[b + 20] = add
    R.valid[i] = 1
    // ownership: slot i now lives at position n
    const ps = R.posSlot
    if (ps[n] !== i) {
      const o = ps[n]
      if (o >= 0) R.slotPos[o] = -1
      const q = R.slotPos[i]
      if (q >= 0) ps[q] = -1
      ps[n] = i
      R.slotPos[i] = n
    }
    return true
  }

  /** Does position `n` still hold exactly sprite `i`'s current data? */
  private same(layer: SpriteLayer, R: Retained, i: number, n: number, swayAmp: number): boolean {
    const d = R.pos
    const b = n * FLOATS
    const flags = layer.flags[i]
    const CA = layer.colorAdd
    return (
      d[b] === layer.x[i] &&
      d[b + 1] === layer.y[i] &&
      d[b + 2] === layer.w[i] &&
      d[b + 3] === layer.h[i] &&
      d[b + 4] === layer.rotation[i] &&
      R.sMeta[i] === ((layer.atlas[i] << 8) | flags) &&
      R.sFrame[i] === layer.frame[i] &&
      R.sColor[i] === layer.color[i] &&
      R.sAdd[i] === (CA ? CA[i] : 0) &&
      d[b + 18] === (swayAmp !== 0 && flags & SPRITE_SWAY ? swayAmp * (layer.swayScale ? layer.swayScale[i] : 1) : 0)
    )
  }

  /**
   * Only slots `lo..hi` changed, nothing was sorted or culled differently: rewrite just those in place.
   * False when something moved in or out of the drawn set or changed draw segment (needs a full gather).
   */
  private gatherRange(
    layer: SpriteLayer,
    R: Retained,
    na: number,
    usePivots: boolean,
    perSprite: boolean,
    swayAmp: number,
    lo: number,
    hi: number,
  ): boolean {
    const { vL, vR, vT, vB } = R
    const last = Math.min(hi, layer.count - 1)
    for (let i = Math.max(0, lo); i <= last; i++) {
      const flags = layer.flags[i]
      const w = layer.w[i]
      const h = layer.h[i]
      const x = layer.x[i]
      const y = layer.y[i]
      const rad = (w < 0 ? -w : w) + (h < 0 ? -h : h)
      const visible = (flags & SPRITE_HIDDEN) === 0 && !(x + rad < vL || x - rad > vR || y + rad < vT || y - rad > vB)
      const wasDrawn = R.drawnEpoch[i] === R.epoch
      if (!visible) {
        if (wasDrawn) return false
        R.valid[i] = 0
        continue
      }
      if (!wasDrawn) return false
      const n = R.slotPos[i]
      if (R.valid[i] !== 1 || n < 0 || R.posSlot[n] !== i) return false
      if (perSprite || !this.same(layer, R, i, n, swayAmp)) {
        if (!this.repack(layer, R, i, n, na, usePivots, perSprite, swayAmp)) return false
        this.markRun(R, n)
      }
      // still inside a draw segment with the same texture group and blend?
      const segs = R.segs
      let lo = 0
      let hi = (segs.length >> 2) - 1
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (segs[mid * 4 + 1] <= n) lo = mid + 1
        else hi = mid
      }
      const q = lo * 4
      const sg = segs[q + 2]
      const g = R.pos[n * FLOATS + 17] >= 0 ? layer.atlas[i] >> 3 : -1
      if ((g >= 0 && g !== sg) || (segs[q + 3] === 1) !== ((flags & SPRITE_ADDITIVE) !== 0)) return false
    }
    return true
  }

  /**
   * Walk the draw order, cull, and keep instances in draw-order position. A position whose sprite is
   * unchanged is left alone (not repacked, not uploaded); only changed ones are rewritten and marked.
   */
  private gather(
    layer: SpriteLayer,
    R: Retained,
    na: number,
    usePivots: boolean,
    perSprite: boolean,
    swayAmp: number,
    dirtyAll: boolean,
    dLo: number,
    dHi: number,
    anyDirty: boolean,
  ): void {
    const order = layer.sortByKey ? layer.drawOrder() : null
    const total = order ? layer.orderCount : layer.count
    const { vL, vR, vT, vB } = R
    const X = layer.x,
      Y = layer.y,
      Wd = layer.w,
      Ht = layer.h,
      A = layer.atlas,
      FL = layer.flags
    const { valid, pos, posSlot, slotPos, drawnEpoch, sMeta, sFrame, sColor, sAdd } = R
    const Rot = layer.rotation,
      F = layer.frame,
      C = layer.color,
      CA = layer.colorAdd
    const swayScale = layer.swayScale
    const ax = layer.anchorX
    const ay = layer.anchorY
    const frameTables = this.frameTables
    const { ready, invW, invH, insetU, insetV, cols: colsA, uw: uwA, vh: vhA, stepU, stepV, originU, originV } = this
    const epoch = ++R.epoch
    let changed = 0
    const segs = R.segs
    segs.length = 0
    let n = 0
    let segStart = 0
    let segGroup = -1
    let segAdd = false
    for (let k = 0; k < total; k++) {
      const i = order ? order[k] : k
      const flags = FL[i]
      if (flags & SPRITE_HIDDEN) {
        if (anyDirty) valid[i] = 0
        continue
      }
      const x = X[i],
        y = Y[i],
        w = Wd[i],
        h = Ht[i]
      const rad = (w < 0 ? -w : w) + (h < 0 ? -h : h)
      if (x + rad < vL || x - rad > vR || y + rad < vT || y - rad > vB) {
        if (anyDirty) valid[i] = 0
        continue
      }
      const v = valid[i]
      const inRange = dirtyAll || (i >= dLo && i <= dHi)
      if (v === 2 && !inRange) continue
      if (v !== 1 || inRange || posSlot[n] !== i) {
        let a = A[i]
        const c = C[i]
        const f = F[i]
        const add = CA ? CA[i] : 0
        const sway = swayAmp !== 0 && flags & SPRITE_SWAY ? swayAmp * (swayScale ? swayScale[i] : 1) : 0
        const meta = (a << 8) | flags
        const b = n * FLOATS
        if (
          v === 1 &&
          posSlot[n] === i &&
          !perSprite &&
          pos[b] === x &&
          pos[b + 1] === y &&
          pos[b + 2] === w &&
          pos[b + 3] === h &&
          pos[b + 4] === Rot[i] &&
          sMeta[i] === meta &&
          sFrame[i] === f &&
          sColor[i] === c &&
          sAdd[i] === add &&
          pos[b + 18] === sway
        ) {
          // verified unchanged: nothing to write or upload
        } else {
          const untextured = (flags & SPRITE_UNTEXTURED) !== 0 || a >= na || ready[a] === 2
          let u0 = 0,
            v0 = 0,
            uw = 1,
            vh = 1
          if (!untextured) {
            if (ready[a] === 0) {
              valid[i] = 2
              continue
            }
            const table = frameTables[a]
            if (table !== undefined) {
              const fr = table[f]
              if (fr === undefined) {
                valid[i] = 2
                continue
              }
              const iu = insetU[a]
              const iv = insetV[a]
              u0 = fr.x * invW[a] + iu
              v0 = fr.y * invH[a] + iv
              uw = fr.w * invW[a] - 2 * iu
              vh = fr.h * invH[a] - 2 * iv
            } else {
              const cols = colsA[a]
              const iu = insetU[a]
              const iv = insetV[a]
              u0 = originU[a] + (f % cols) * stepU[a] + iu
              v0 = originV[a] + Math.floor(f / cols) * stepV[a] + iv
              uw = uwA[a] - 2 * iu
              vh = vhA[a] - 2 * iv
            }
          }
          sMeta[i] = meta
          sFrame[i] = f
          sColor[i] = c
          sAdd[i] = add
          pos[b] = x
          pos[b + 1] = y
          pos[b + 2] = w
          pos[b + 3] = h
          pos[b + 4] = Rot[i]
          if (perSprite) {
            layer.resolveAnchor(i, usePivots)
            pos[b + 5] = layer._ax
            pos[b + 6] = layer._ay
          } else {
            pos[b + 5] = ax
            pos[b + 6] = ay
          }
          pos[b + 7] = flags & SPRITE_FLIP_X
          pos[b + 8] = (flags & SPRITE_FLIP_Y) >> 1
          pos[b + 9] = (c >>> 24) / 255
          pos[b + 10] = ((c >>> 16) & 255) / 255
          pos[b + 11] = ((c >>> 8) & 255) / 255
          pos[b + 12] = (c & 255) / 255
          pos[b + 13] = u0
          pos[b + 14] = v0
          pos[b + 15] = uw
          pos[b + 16] = vh
          if (untextured) a = -1
          pos[b + 17] = a < 0 ? -1 : a & 7
          pos[b + 18] = sway
          pos[b + 19] = 0
          pos[b + 20] = add
          valid[i] = 1
          changed++
          if (posSlot[n] !== i) {
            const o = posSlot[n]
            if (o >= 0) slotPos[o] = -1
            const q = slotPos[i]
            if (q >= 0) posSlot[q] = -1
            posSlot[n] = i
            slotPos[i] = n
          }
          if (n === R.runEnd && R.runs.length > 0) R.runs[R.runs.length - 1] = ++R.runEnd
          else this.markRun(R, n)
        }
      }
      // a texture-group change or an additive change starts a new draw (untextured sprites join any)
      const add = (flags & SPRITE_ADDITIVE) !== 0
      const g = pos[n * FLOATS + 17] >= 0 ? A[i] >> 3 : -1
      if (n > segStart && (add !== segAdd || (g >= 0 && segGroup >= 0 && g !== segGroup))) {
        segs.push(segStart, n, segGroup, segAdd ? 1 : 0)
        segStart = n
        segGroup = -1
      }
      if (n === segStart) segAdd = add
      if (g >= 0 && segGroup < 0) segGroup = g
      drawnEpoch[i] = epoch
      n++
    }
    if (n > segStart) segs.push(segStart, n, segGroup, segAdd ? 1 : 0)
    R.n = n
    R.changed = changed
    R.segCount = segs.length / 4
    R.endsAdditive = segs.length >= 4 && segs[segs.length - 1] === 1
  }

  /**
   * The legacy pack: every drawn sprite is written in draw order with no compare or bookkeeping.
   * Used while the whole layer changes every frame (a retained instance would never be reused).
   */
  private gatherBlind(
    layer: SpriteLayer,
    R: Retained,
    na: number,
    usePivots: boolean,
    perSprite: boolean,
    swayAmp: number,
  ): void {
    const order = layer.sortByKey ? layer.drawOrder() : null
    const total = order ? layer.orderCount : layer.count
    const { vL, vR, vT, vB } = R
    const X = layer.x,
      Y = layer.y,
      Wd = layer.w,
      Ht = layer.h,
      Rot = layer.rotation,
      F = layer.frame,
      A = layer.atlas,
      C = layer.color,
      FL = layer.flags,
      CA = layer.colorAdd
    const swayScale = layer.swayScale
    const ax = layer.anchorX
    const ay = layer.anchorY
    const frameTables = this.frameTables
    const { ready, invW, invH, insetU, insetV, cols: colsA, uw: uwA, vh: vhA, stepU, stepV, originU, originV } = this
    const d = R.pos
    const segs = R.segs
    segs.length = 0
    let n = 0
    let segStart = 0
    let segGroup = -1
    let segAdd = false
    for (let k = 0; k < total; k++) {
      const i = order ? order[k] : k
      const flags = FL[i]
      if (flags & SPRITE_HIDDEN) continue
      const x = X[i],
        y = Y[i],
        w = Wd[i],
        h = Ht[i]
      const rad = (w < 0 ? -w : w) + (h < 0 ? -h : h)
      if (x + rad < vL || x - rad > vR || y + rad < vT || y - rad > vB) continue
      let a = A[i]
      const untextured = (flags & SPRITE_UNTEXTURED) !== 0 || a >= na || ready[a] === 2
      let u0 = 0,
        v0 = 0,
        uw = 1,
        vh = 1
      if (!untextured) {
        if (ready[a] === 0) continue
        const f = F[i]
        const table = frameTables[a]
        if (table !== undefined) {
          const fr = table[f]
          if (fr === undefined) continue
          const iu = insetU[a]
          const iv = insetV[a]
          u0 = fr.x * invW[a] + iu
          v0 = fr.y * invH[a] + iv
          uw = fr.w * invW[a] - 2 * iu
          vh = fr.h * invH[a] - 2 * iv
        } else {
          const f2 = F[i]
          const cols = colsA[a]
          const iu = insetU[a]
          const iv = insetV[a]
          u0 = originU[a] + (f2 % cols) * stepU[a] + iu
          v0 = originV[a] + Math.floor(f2 / cols) * stepV[a] + iv
          uw = uwA[a] - 2 * iu
          vh = vhA[a] - 2 * iv
        }
      }
      const add = (flags & SPRITE_ADDITIVE) !== 0
      const g = untextured ? -1 : a >> 3
      if (n > segStart && (add !== segAdd || (g >= 0 && segGroup >= 0 && g !== segGroup))) {
        segs.push(segStart, n, segGroup, segAdd ? 1 : 0)
        segStart = n
        segGroup = -1
      }
      if (n === segStart) segAdd = add
      if (g >= 0 && segGroup < 0) segGroup = g
      const c = C[i]
      const b = n * FLOATS
      d[b] = x
      d[b + 1] = y
      d[b + 2] = w
      d[b + 3] = h
      d[b + 4] = Rot[i]
      if (perSprite) {
        layer.resolveAnchor(i, usePivots)
        d[b + 5] = layer._ax
        d[b + 6] = layer._ay
      } else {
        d[b + 5] = ax
        d[b + 6] = ay
      }
      d[b + 7] = flags & SPRITE_FLIP_X
      d[b + 8] = (flags & SPRITE_FLIP_Y) >> 1
      d[b + 9] = (c >>> 24) / 255
      d[b + 10] = ((c >>> 16) & 255) / 255
      d[b + 11] = ((c >>> 8) & 255) / 255
      d[b + 12] = (c & 255) / 255
      d[b + 13] = u0
      d[b + 14] = v0
      d[b + 15] = uw
      d[b + 16] = vh
      if (untextured) a = -1
      d[b + 17] = a < 0 ? -1 : a & 7
      d[b + 18] = swayAmp !== 0 && flags & SPRITE_SWAY ? swayAmp * (swayScale ? swayScale[i] : 1) : 0
      d[b + 19] = 0
      d[b + 20] = CA ? CA[i] : 0
      n++
    }
    if (n > segStart) segs.push(segStart, n, segGroup, segAdd ? 1 : 0)
    R.n = n
    R.segCount = segs.length / 4
    R.endsAdditive = segs.length >= 4 && segs[segs.length - 1] === 1
  }

  /** Upload the changed runs of the position buffer and issue one draw per segment. */
  private submit(
    layer: SpriteLayer,
    R: Retained,
    na: number,
    white: WebGLTexture,
    applySampling: (atlasIndex: number, tex: WebGLTexture) => void,
  ): void {
    const { gl } = this
    const n = R.n
    if (n === 0) {
      R.runs.length = 0
      R.runEnd = -1000
      R.uploadAll = false
      return
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, R.gpu ?? (R.gpu = gl.createBuffer()!))
    let full = false
    if (R.gpuCap < R.cap) {
      gl.bufferData(gl.ARRAY_BUFFER, R.cap * FLOATS * 4, gl.DYNAMIC_DRAW)
      R.gpuCap = R.cap
      full = true
    }
    const runs = R.runs
    if (full || R.uploadAll) {
      // fresh buffer: everything in [0, n) must be sent (positions not marked dirty included)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, R.pos, 0, n * FLOATS)
      this.uploadBytes += n * FLOATS * 4
    } else if (runs.length > 64) {
      let lo = runs[0]
      let hi = runs[1]
      for (let q = 2; q < runs.length; q += 2) {
        if (runs[q] < lo) lo = runs[q]
        if (runs[q + 1] > hi) hi = runs[q + 1]
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, lo * FLOATS * 4, R.pos, lo * FLOATS, (hi - lo) * FLOATS)
      this.uploadBytes += (hi - lo) * FLOATS * 4
    } else {
      for (let q = 0; q < runs.length; q += 2) {
        const s = runs[q]
        const e = runs[q + 1]
        gl.bufferSubData(gl.ARRAY_BUFFER, s * FLOATS * 4, R.pos, s * FLOATS, (e - s) * FLOATS)
        this.uploadBytes += (e - s) * FLOATS * 4
      }
    }
    runs.length = 0
    R.runEnd = -1000
    R.uploadAll = false
    const segs = R.segs
    let curAdd = false
    let group = -1
    let lastStart = -1
    for (let q = 0; q < segs.length; q += 4) {
      const start = segs[q]
      const end = segs[q + 1]
      const g = segs[q + 2]
      const add = segs[q + 3] === 1
      if (g >= 0 && g !== group) {
        this.bindGroup(g, na, white, applySampling)
        group = g
      }
      if (add !== curAdd) {
        setBlendFunc(gl, add ? 'additive' : layer.blend)
        gl.uniform1f(this.uPremul, !add && layer.blend === 'multiply' ? 1 : 0)
        curAdd = add
      }
      if (start !== lastStart) {
        this.pointInstances(start)
        lastStart = start
      }
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, end - start)
      this.drawCalls++
      this.instances += end - start
    }
  }

  /** Point the per-instance attributes at instance `start` of the bound buffer. */
  private pointInstances(start: number): void {
    const { gl } = this
    let off = start * FLOATS * 4
    const attr = (loc: number, size: number) => {
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, FLOATS * 4, off)
      off += size * 4
    }
    attr(2, 2)
    attr(3, 2)
    attr(4, 1)
    attr(5, 2)
    attr(6, 2)
    attr(7, 4)
    attr(8, 4)
    attr(9, 1)
    attr(10, 2)
    attr(11, 1)
  }

  private readonly frameTables: (AtlasFrame[] | undefined)[] = new Array(MAX_LAYER_ATLASES)

  /** Bind atlases [8g, 8g + 8) to the texture units and set their filters. */
  private bindGroup(
    g: number,
    na: number,
    white: WebGLTexture,
    applySampling: (atlasIndex: number, tex: WebGLTexture) => void,
  ): void {
    const { gl } = this
    for (let u = 0; u < ATLASES_PER_DRAW; u++) {
      const idx = g * ATLASES_PER_DRAW + u
      const real = idx < na && this.ready[idx] === 1
      gl.activeTexture(gl.TEXTURE0 + u)
      gl.bindTexture(gl.TEXTURE_2D, real ? this.texs[idx]! : white)
      if (real) applySampling(idx, this.texs[idx]!)
    }
  }
}
