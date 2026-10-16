/**
 * Headless WebGL2 stand-in for tests and benchmarks. Implements the subset of
 * WebGL2 the RenderSystem uses as no-ops, while recording draw calls, bound
 * textures and (optionally) the per-instance data of every instanced draw.
 *
 *   const canvas = createRecordingCanvas(800, 600, { captureInstances: true })
 *   const rs = new RenderSystem(canvas, new Map())
 *   rs.update(world, 1 / 60)
 *   canvas.gl.draws  // draws of the last frame (reset on gl.clear)
 */

export const INSTANCE_FLOATS = 19

export interface RecordedTexture {
  id: number
  width: number
  height: number
  uploads: number
  deleted: boolean
}

export interface RecordedDraw {
  kind: 'instanced' | 'arrays'
  mode: number
  vertices: number
  /** Instance count for instanced draws, vertex count otherwise. */
  count: number
  texture: RecordedTexture | null
  /** Copy of instance floats (count * 19) when `captureInstances` is on. */
  instances: Float32Array | null
  /** `[src, dst]` factors of the blend function active for this draw. */
  blend: [number, number]
  /** Value of the `u_premul` float uniform when the draw was issued (0 if never set). */
  premul: number
}

export interface RecordedInstance {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  anchorX: number
  anchorY: number
  offsetX: number
  offsetY: number
  flipX: boolean
  flipY: boolean
  r: number
  g: number
  b: number
  a: number
  u: number
  v: number
  uw: number
  vh: number
}

export interface RecordingGLOptions {
  captureInstances?: boolean
  /**
   * Fake EXT_disjoint_timer_query_webgl2: `getExtension` returns the extension and
   * timer queries work. Results arrive `latency` rendered frames after the query ends (default 2)
   * and measure `ns` nanoseconds (default 2e6, adjustable later via `gl.timerNs`).
   */
  timerQuery?: boolean | { latency?: number; ns?: number }
}

export interface RecordedQuery {
  id: number
  state: 'idle' | 'active' | 'ended'
  ns: number
  /** Frame count (`gl.frames`) from which the result is available. */
  readyFrame: number
  deleted: boolean
}

let nextObjId = 1
const noop = (): void => {}

/** Decode the instance floats of a recorded draw into objects (test helper; allocates). */
export function decodeInstances(draw: RecordedDraw): RecordedInstance[] {
  const d = draw.instances
  if (!d) throw new Error('decodeInstances: draw has no instance data (enable captureInstances)')
  const out: RecordedInstance[] = []
  for (let o = 0; o < draw.count * INSTANCE_FLOATS; o += INSTANCE_FLOATS) {
    out.push({
      x: d[o],
      y: d[o + 1],
      width: d[o + 2],
      height: d[o + 3],
      rotation: d[o + 4],
      anchorX: d[o + 5],
      anchorY: d[o + 6],
      offsetX: d[o + 7],
      offsetY: d[o + 8],
      flipX: d[o + 9] === 1,
      flipY: d[o + 10] === 1,
      r: d[o + 11],
      g: d[o + 12],
      b: d[o + 13],
      a: d[o + 14],
      u: d[o + 15],
      v: d[o + 16],
      uw: d[o + 17],
      vh: d[o + 18],
    })
  }
  return out
}

function sourceSize(src: unknown): [number, number] {
  const s = src as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number } | null
  if (!s) return [0, 0]
  return [s.naturalWidth || s.width || 0, s.naturalHeight || s.height || 0]
}

/**
 * Recording WebGL2 context. Draw state for the current frame lives in `draws`
 * (cleared by each `clear()` call, which the renderer issues once per frame);
 * `totalDraws` and `totalInstances` accumulate across frames.
 */
export class RecordingGL {
  // Constants (values match WebGL2 where it matters for debugging).
  readonly ARRAY_BUFFER = 0x8892
  readonly STATIC_DRAW = 0x88e4
  readonly DYNAMIC_DRAW = 0x88e8
  readonly FLOAT = 0x1406
  readonly UNSIGNED_BYTE = 0x1401
  readonly TRIANGLES = 0x0004
  readonly TRIANGLE_STRIP = 0x0005
  readonly TEXTURE_2D = 0x0de1
  readonly TEXTURE0 = 0x84c0
  readonly TEXTURE1 = 0x84c1
  readonly RGBA = 0x1908
  readonly RGBA8 = 0x8058
  readonly TEXTURE_MIN_FILTER = 0x2801
  readonly TEXTURE_MAG_FILTER = 0x2800
  readonly TEXTURE_WRAP_S = 0x2802
  readonly TEXTURE_WRAP_T = 0x2803
  readonly NEAREST = 0x2600
  readonly LINEAR = 0x2601
  readonly NEAREST_MIPMAP_NEAREST = 0x2700
  readonly LINEAR_MIPMAP_NEAREST = 0x2701
  readonly NEAREST_MIPMAP_LINEAR = 0x2702
  readonly LINEAR_MIPMAP_LINEAR = 0x2703
  readonly CLAMP_TO_EDGE = 0x812f
  readonly REPEAT = 0x2901
  readonly BLEND = 0x0be2
  readonly SRC_ALPHA = 0x0302
  readonly ONE_MINUS_SRC_ALPHA = 0x0303
  readonly ONE_MINUS_SRC_COLOR = 0x0301
  readonly DST_COLOR = 0x0306
  readonly ONE = 1
  readonly ZERO = 0
  readonly COLOR_BUFFER_BIT = 0x4000
  readonly FRAMEBUFFER = 0x8d40
  readonly READ_FRAMEBUFFER = 0x8ca8
  readonly DRAW_FRAMEBUFFER = 0x8ca9
  readonly COLOR_ATTACHMENT0 = 0x8ce0
  readonly VERTEX_SHADER = 0x8b31
  readonly FRAGMENT_SHADER = 0x8b30
  readonly COMPILE_STATUS = 0x8b81
  readonly LINK_STATUS = 0x8b82

  readonly draws: RecordedDraw[] = []
  readonly staticBuffers: Float32Array[] = []
  readonly textures = new Map<number, RecordedTexture>()
  totalDraws = 0
  totalInstances = 0
  frames = 0
  contextLost = false
  captureInstances: boolean

  // Timer query fake (see RecordingGLOptions.timerQuery).
  readonly TIME_ELAPSED_EXT = 0x88bf
  readonly GPU_DISJOINT_EXT = 0x8fbb
  readonly QUERY_RESULT = 0x8866
  readonly QUERY_RESULT_AVAILABLE = 0x8867
  readonly timerSupported: boolean
  timerLatency: number
  /** Nanoseconds the next ended query reports. */
  timerNs: number
  /** Report a GPU_DISJOINT_EXT event on the next read (it clears itself, like the real flag). */
  disjoint = false
  /** Every timer-query call (getExtension, createQuery, beginQuery, endQuery, getQueryParameter, deleteQuery). */
  queryOps = 0
  readonly queries: RecordedQuery[] = []
  private activeQuery: RecordedQuery | null = null

  private boundTexture: RecordedTexture | null = null
  private blendFactors: [number, number] = [0x0302, 0x0303]
  private premul = 0
  private lastInstanceSrc: ArrayBufferView | null = null

  constructor(
    readonly canvas: unknown,
    opts: RecordingGLOptions = {},
  ) {
    this.captureInstances = opts.captureInstances ?? false
    const tq = opts.timerQuery
    this.timerSupported = !!tq
    this.timerLatency = (typeof tq === 'object' ? tq.latency : undefined) ?? 2
    this.timerNs = (typeof tq === 'object' ? tq.ns : undefined) ?? 2e6
  }

  getExtension(name: string): object | null {
    if (name !== 'EXT_disjoint_timer_query_webgl2') return null
    this.queryOps++
    return this.timerSupported
      ? { TIME_ELAPSED_EXT: this.TIME_ELAPSED_EXT, GPU_DISJOINT_EXT: this.GPU_DISJOINT_EXT }
      : null
  }
  createQuery(): RecordedQuery {
    this.queryOps++
    const q: RecordedQuery = { id: nextObjId++, state: 'idle', ns: 0, readyFrame: 0, deleted: false }
    this.queries.push(q)
    return q
  }
  deleteQuery(q: RecordedQuery | null): void {
    this.queryOps++
    if (q) q.deleted = true
  }
  beginQuery(_target: number, q: RecordedQuery): void {
    this.queryOps++
    // Real WebGL raises INVALID_OPERATION when a query is already active or reused while pending.
    if (this.activeQuery) throw new Error('beginQuery: a query is already active')
    q.state = 'active'
    this.activeQuery = q
  }
  endQuery(): void {
    this.queryOps++
    const q = this.activeQuery
    if (!q) throw new Error('endQuery: no active query')
    q.state = 'ended'
    q.ns = this.timerNs
    q.readyFrame = this.frames + this.timerLatency
    this.activeQuery = null
  }
  getQueryParameter(q: RecordedQuery, pname: number): number | boolean {
    this.queryOps++
    if (pname === this.QUERY_RESULT_AVAILABLE) return q.state === 'ended' && this.frames >= q.readyFrame
    q.state = 'idle'
    return q.ns
  }

  isContextLost(): boolean {
    return this.contextLost
  }

  clear(): void {
    this.draws.length = 0
    this.frames++
  }

  createTexture(): object {
    const t: RecordedTexture = { id: nextObjId++, width: 0, height: 0, uploads: 0, deleted: false }
    this.textures.set(t.id, t)
    return t
  }
  deleteTexture(t: RecordedTexture | null): void {
    if (t) t.deleted = true
  }
  bindTexture(_target: number, t: RecordedTexture | null): void {
    this.boundTexture = t
  }
  texImage2D(...args: unknown[]): void {
    const t = this.boundTexture
    if (!t) return
    // (target, level, internal, w, h, border, format, type, pixels) or (target, level, internal, format, type, source)
    if (args.length >= 8) {
      t.width = args[3] as number
      t.height = args[4] as number
    } else {
      ;[t.width, t.height] = sourceSize(args[5])
    }
    t.uploads++
  }
  texSubImage2D(): void {
    if (this.boundTexture) this.boundTexture.uploads++
  }

  bufferData(_target: number, data: number | ArrayBufferView, usage: number): void {
    if (usage === this.STATIC_DRAW && data instanceof Float32Array) this.staticBuffers.push(data.slice())
  }

  blendFunc(src: number, dst: number): void {
    this.blendFactors = [src, dst]
  }

  bufferSubData(_target: number, _dst: number, src: ArrayBufferView): void {
    this.lastInstanceSrc = src
  }

  drawArraysInstanced(mode: number, _first: number, vertices: number, instanceCount: number): void {
    let instances: Float32Array | null = null
    if (this.captureInstances && this.lastInstanceSrc instanceof Float32Array) {
      instances = this.lastInstanceSrc.slice(0, instanceCount * INSTANCE_FLOATS)
    }
    this.draws.push({
      kind: 'instanced',
      mode,
      vertices,
      count: instanceCount,
      texture: this.boundTexture,
      instances,
      blend: this.blendFactors,
      premul: this.premul,
    })
    this.totalDraws++
    this.totalInstances += instanceCount
  }
  drawArrays(mode: number, _first: number, count: number): void {
    this.draws.push({
      kind: 'arrays',
      mode,
      vertices: count,
      count,
      texture: this.boundTexture,
      instances: null,
      blend: this.blendFactors,
      premul: this.premul,
    })
    this.totalDraws++
  }

  /** All instances drawn this frame, decoded, in draw order. Requires `captureInstances`. */
  frameInstances(): RecordedInstance[] {
    const out: RecordedInstance[] = []
    for (const d of this.draws) if (d.kind === 'instanced') out.push(...decodeInstances(d))
    return out
  }

  createBuffer(): object {
    return { id: nextObjId++ }
  }
  createVertexArray(): object {
    return { id: nextObjId++ }
  }
  createFramebuffer(): object {
    return { id: nextObjId++ }
  }
  createProgram(): object {
    return { id: nextObjId++ }
  }
  createShader(): object {
    return { id: nextObjId++ }
  }
  getUniformLocation(_program?: unknown, name?: string): object {
    return { id: nextObjId++, name }
  }
  uniform1f(loc: { name?: string } | null, v: number): void {
    if (loc?.name === 'u_premul') this.premul = v
  }
  getShaderParameter(): boolean {
    return true
  }
  getProgramParameter(): boolean {
    return true
  }
  getParameter(pname?: number): number | boolean {
    if (pname === this.GPU_DISJOINT_EXT) {
      this.queryOps++
      const d = this.disjoint
      this.disjoint = false
      return d
    }
    return 4096
  }
  getShaderInfoLog(): string {
    return ''
  }
  getProgramInfoLog(): string {
    return ''
  }
}

// Every other WebGL2 method the renderer calls is a no-op.
for (const name of [
  'activeTexture',
  'attachShader',
  'bindBuffer',
  'bindFramebuffer',
  'bindVertexArray',
  'blitFramebuffer',
  'clearColor',
  'compileShader',
  'deleteFramebuffer',
  'deleteBuffer',
  'deleteProgram',
  'deleteShader',
  'deleteVertexArray',
  'pixelStorei',
  'texStorage2D',
  'uniform1ui',
  'uniform2i',
  'uniform4f',
  'uniform4i',
  'disable',
  'enable',
  'enableVertexAttribArray',
  'framebufferTexture2D',
  'generateMipmap',
  'linkProgram',
  'shaderSource',
  'texParameteri',
  'uniform1i',
  'uniform2f',
  'useProgram',
  'vertexAttribDivisor',
  'vertexAttribPointer',
  'viewport',
]) {
  ;(RecordingGL.prototype as unknown as Record<string, unknown>)[name] = noop
}

/** No-op 2D context: enough for the renderer's offscreen text/shape/particle canvases. */
function createNoop2D(canvas: { width: number; height: number }): CanvasRenderingContext2D {
  const gradient = { addColorStop: noop }
  const target: Record<string, unknown> = {
    canvas,
    measureText: (s: string) => ({ width: s.length * 8 }),
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
  }
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k as string] : noop),
    set: (t, k, v) => {
      t[k as string] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

export interface RecordingCanvas extends HTMLCanvasElement {
  readonly gl: RecordingGL
}

/**
 * A canvas-like object whose `getContext('webgl2')` returns a {@link RecordingGL}
 * and `getContext('2d')` a no-op 2D context. Works without a DOM.
 */
export function createRecordingCanvas(width = 800, height = 600, opts: RecordingGLOptions = {}): RecordingCanvas {
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }),
  } as unknown as { gl: RecordingGL; getContext(kind: string): unknown; width: number; height: number }
  canvas.gl = new RecordingGL(canvas, opts)
  let ctx2d: CanvasRenderingContext2D | null = null
  canvas.getContext = (kind: string) => {
    if (kind === 'webgl2') return canvas.gl
    if (kind === '2d') return (ctx2d ??= createNoop2D(canvas))
    return null
  }
  return canvas as unknown as RecordingCanvas
}

export interface HeadlessCanvasOptions {
  /**
   * Replace an existing `HTMLCanvasElement.getContext` (jsdom's stub) so every
   * canvas, including the one `<Game>` renders, gets a {@link RecordingGL}.
   * Without it an existing `getContext` is left alone.
   */
  force?: boolean
  /** Options for the {@link RecordingGL} each canvas receives. */
  recording?: RecordingGLOptions
  /** Called once per canvas when its WebGL2 context is first requested. */
  onContext?: (canvas: HTMLCanvasElement, gl: RecordingGL) => void
}

/**
 * Makes the renderer's offscreen canvases (text, shapes, particles) work without
 * a real canvas implementation. In plain Node it installs a minimal `document`;
 * under happy-dom/jsdom it gives `HTMLCanvasElement` a no-op `getContext` when
 * the environment has none (or always, with `force`). A canvas keeps one
 * RecordingGL across `getContext('webgl2')` calls, like a real one. Returns a
 * function that undoes the change.
 */
export function installHeadlessCanvasDOM(options: HeadlessCanvasOptions = {}): () => void {
  const g = globalThis as unknown as {
    document?: unknown
    HTMLCanvasElement?: { prototype: { getContext?: unknown } }
  }
  if (!g.document) {
    g.document = {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`headless DOM: createElement('${tag}') not supported`)
        return createRecordingCanvas(1, 1)
      },
    }
    return () => {
      delete g.document
    }
  }
  const proto = g.HTMLCanvasElement?.prototype
  if (!proto || (typeof proto.getContext === 'function' && !options.force)) return noop
  const previous = Object.getOwnPropertyDescriptor(proto, 'getContext')
  const ctxs = new WeakMap<object, unknown>()
  const gls = new WeakMap<object, RecordingGL>()
  proto.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind === '2d') {
      let c = ctxs.get(this)
      if (!c) ctxs.set(this, (c = createNoop2D(this)))
      return c
    }
    if (kind === 'webgl2') {
      let gl = gls.get(this)
      if (!gl) {
        gls.set(this, (gl = new RecordingGL(this, options.recording)))
        options.onContext?.(this, gl)
      }
      return gl
    }
    return null
  }
  return () => {
    if (previous) Object.defineProperty(proto, 'getContext', previous)
    else delete proto.getContext
  }
}
