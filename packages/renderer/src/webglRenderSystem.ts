// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PRIMARY GAME RENDERER — WebGL2 instanced renderer                      ║
// ║                                                                          ║
// ║  This is the production rendering system. All visual game features       ║
// ║  (sprites, text, particles, post-processing, etc.) belong here or in    ║
// ║  shaders.ts.                                                             ║
// ║                                                                          ║
// ║  Exported as `RenderSystem` from @xip/renderer.                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import type { System, ECSWorld, EntityId, NavGrid } from '@xip/core'
import type { TransformComponent, LayerStats } from '@xip/core'
import { createRenderStats, resetRenderFrameStats, type RenderStats } from '@xip/core'
import {
  VERT_SRC,
  FRAG_SRC,
  PARALLAX_VERT_SRC,
  PARALLAX_FRAG_SRC,
  BLOOM_EXTRACT_FRAG_SRC,
  BLUR_FRAG_SRC,
  COMPOSITE_FRAG_SRC,
} from './shaders'
import { parseCSSColor } from './colorParser'
import { createPostProcessStack, type PostProcessStack } from './postProcess'
import { clampCameraToBounds } from './components/camera2d'
import type { SpriteLayer, LayerAtlas, PickSource } from './spriteLayer'
import type { SpriteLayerRenderer, LayerCamera, ResolvedAtlas } from './spriteLayerGL'
import { createDynamicCanvasHandle, type DynamicCanvasOptions, type ManagedDynamicCanvas } from './dynamicCanvas'
import {
  spriteLayerRendererFactory,
  textEntityBatcherFactory,
  shapeRendererFactory,
  textLayerRendererFactory,
  tileRendererFactory,
  type TileRenderer,
} from './layerRegistry'
import type { TextLayer } from './textLayer'
import type { TextLayerRenderer } from './textLayerGL'
import type { ShapeRenderer } from './shapeGL'
import type { CircleShapeComponent, LineShapeComponent, PolygonShapeComponent } from './components/shapes'
import type { GradientComponent } from './components/gradient'
import type { EntityTextBatcher } from './textEntities'
import {
  type Sampling,
  resolveSampling,
  toGLMinFilter,
  toGLMagFilter,
  needsMipmap,
  DEFAULT_SAMPLING,
} from './textureFilter'
import { createRenderLayerManager, type RenderLayerManager } from './renderLayers'
import {
  hasPointOrSpriteFollow,
  resolveCameraFollowTarget,
  type CameraFollowPoint,
  type CameraFollowPointProvider,
  type CameraFollowSprite,
} from './cameraFollow'
import type { TileLayerRenderStats } from '@xip/core'
import type { TileLayerData } from './tileLayer'
import type { GpuTiming } from './gpuTimer'

// ── Component shapes (duck-typed — no hard dependency on renderer/physics) ───

interface SpriteComponent {
  type: 'Sprite'
  width: number
  height: number
  color: string
  src?: string
  image?: HTMLImageElement
  dynamicSrc?: string
  offsetX: number
  offsetY: number
  zIndex: number
  visible: boolean
  flipX: boolean
  flipY: boolean
  anchorX: number
  anchorY: number
  frameIndex: number
  frameWidth?: number
  frameHeight?: number
  frameColumns?: number
  frame?: { sx: number; sy: number; sw: number; sh: number }
  tileX?: boolean
  tileY?: boolean
  tileSizeX?: number
  tileSizeY?: number
  sampling?: Sampling
  blendMode?: 'normal' | 'additive' | 'multiply' | 'screen'
  layer: string
  shape?: string
  borderRadius?: number
  strokeColor?: string
  strokeWidth?: number
  starPoints?: number
  starInnerRadius?: number
  opacity?: number
  tint?: string
  tintOpacity?: number
  customDraw?: unknown
}

interface Camera2DComponent {
  type: 'Camera2D'
  x: number
  y: number
  zoom: number
  followEntityId?: string
  followPoint?: CameraFollowPointProvider
  followSprite?: CameraFollowSprite
  _followSpriteIndex?: number
  smoothing: number
  background: string
  bounds?: { x: number; y: number; width: number; height: number }
  deadZone?: { w: number; h: number }
  shakeIntensity: number
  shakeDuration: number
  shakeTimer: number
  pixelSnap?: boolean
  followOffsetX?: number
  followOffsetY?: number
}

interface AnimationClipDefinition {
  frames: number[]
  fps?: number
  loop?: boolean
  next?: string
  onComplete?: () => void
  frameEvents?: Record<number, () => void>
}

interface AnimationStateComponent {
  type: 'AnimationState'
  playing: boolean
  frames: number[]
  fps: number
  timer: number
  currentIndex: number
  loop: boolean
  clips?: Record<string, AnimationClipDefinition>
  currentClip?: string
  _resolvedClip?: string
  _completed: boolean
  onComplete?: () => void
  frameEvents?: Record<number, () => void>
}

interface AnimatorCondition {
  param: string
  op: string
  value: unknown
}

interface AnimatorTransition {
  to: string
  when: AnimatorCondition[]
  priority?: number
  exitTime?: number
  blendDuration?: number
}

interface AnimatorComponent {
  type: 'Animator'
  initialState: string
  currentState: string
  states: Record<
    string,
    {
      clip: string
      transitions?: {
        to: string
        when: AnimatorCondition[]
        priority?: number
        exitTime?: number
        blendDuration?: number
      }[]
      onEnter?: () => void
      onExit?: () => void
    }
  >
  params: Record<string, unknown>
  playing: boolean
  _entered: boolean
  _blendTimer?: number
  _blendToState?: string
}

interface SquashStretchComponent {
  type: 'SquashStretch'
  intensity: number
  recovery: number
  currentScaleX: number
  currentScaleY: number
  _manualTargetX?: number
  _manualTargetY?: number
}

interface RigidBodyShape {
  type: 'RigidBody'
  vx: number
  vy: number
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  color: string
  gravity: number
  rotation?: number
  rotationSpeed?: number
  startSize?: number
  endSize?: number
  targetX?: number
  targetY?: number
}

interface ParticlePoolComponent {
  type: 'ParticlePool'
  particles: Particle[]
  active: boolean
  maxParticles: number
  timer: number
  rate: number
  angle: number
  spread: number
  speed: number
  particleLife: number
  particleSize: number
  color: string
  gravity: number
  burstCount?: number
  emitShape?: 'point' | 'circle' | 'box'
  emitRadius?: number
  emitWidth?: number
  emitHeight?: number
  enableRotation?: boolean
  rotationSpeedRange?: [number, number]
  sizeOverLife?: { start: number; end: number }
  colorOverLife?: string[]
  attractors?: Array<{ x: number; y: number; strength: number; radius: number }>
  blendMode?: 'normal' | 'additive' | 'multiply' | 'screen'
  particleShape?: 'soft' | 'circle' | 'square'
  mode?: 'standard' | 'formation'
  formationPoints?: { x: number; y: number }[]
  seekStrength?: number
  targetColor?: string
  colorTransitionDuration?: number
  _colorTransitionFrom?: string
  _colorTransitionElapsed?: number
}

interface ParallaxLayerComponent {
  type: 'ParallaxLayer'
  src: string
  speedX: number
  speedY: number
  repeatX: boolean
  repeatY: boolean
  zIndex: number
  offsetX: number
  offsetY: number
  imageWidth: number
  imageHeight: number
}

interface TintSlot {
  name: string
  r: number
  g: number
  b: number
  a: number
  mode: 'multiply' | 'normal' | 'additive' | 'screen'
  layer?: string
  zIndex?: number
}

interface TextComponent {
  type: 'Text'
  text: string
  fontSize: number
  fontFamily: string
  fontWeight?: string | number
  fontStyle?: 'normal' | 'italic'
  layer?: string
  color: string
  align: CanvasTextAlign
  baseline: CanvasTextBaseline
  zIndex: number
  visible: boolean
  maxWidth?: number
  offsetX: number
  offsetY: number
  strokeColor?: string
  strokeWidth?: number
  shadowColor?: string
  shadowOffsetX?: number
  shadowOffsetY?: number
  shadowBlur?: number
  wordWrap?: boolean
  lineHeight?: number
  opacity?: number
}

interface TrailComponent {
  type: 'Trail'
  length: number
  color: string
  width: number
  points: { x: number; y: number }[]
  colorOverLife?: string[]
  widthOverLife?: { start: number; end: number }
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Number of floats per instance in the GPU buffer. */
const FLOATS_PER_INSTANCE = 19
/** Maximum sprites batched in a single draw call. */
const MAX_INSTANCES = 16384
const NO_TILE_LAYERS: readonly TileLayerData[] = []
/** Maximum sprite texture cache entries before evicting least-recently-used. */
const MAX_SPRITE_TEXTURES = 1024
/** Maximum text texture cache entries before evicting oldest. */
const MAX_TEXT_CACHE = 4096
/** A failed image load is not re-requested for this long (ms), so a 404 does not cost a request per frame. */
const IMAGE_RETRY_MS = 5000

// ── GL helpers ────────────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`[WebGLRenderer] Shader compile error:\n${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  const prog = gl.createProgram()!
  gl.attachShader(prog, vert)
  gl.attachShader(prog, frag)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`[WebGLRenderer] Program link error:\n${gl.getProgramInfoLog(prog)}`)
  }
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  return prog
}

function createWhiteTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  return tex
}

// ── Shape texture helpers ─────────────────────────────────────────────────────

/** Pick a texture resolution that fits the sprite size - powers of 2, capped at 512. */
function shapeTexSize(spriteW: number, spriteH: number): number {
  const maxDim = Math.max(spriteW, spriteH)
  if (maxDim <= 32) return 32
  if (maxDim <= 64) return 64
  if (maxDim <= 128) return 128
  if (maxDim <= 256) return 256
  return 512
}

function drawShapeOnCanvas(
  ctx: CanvasRenderingContext2D,
  shape: string,
  w: number,
  h: number,
  borderRadius: number,
  starPoints: number,
  starInnerRadius: number,
): void {
  const cx = w / 2
  const cy = h / 2
  switch (shape) {
    case 'circle': {
      const r = Math.min(w, h) / 2
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      break
    }
    case 'ellipse': {
      ctx.beginPath()
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2)
      break
    }
    case 'roundedRect': {
      const r = Math.min(borderRadius, w / 2, h / 2)
      ctx.beginPath()
      ctx.roundRect(0, 0, w, h, r)
      break
    }
    case 'triangle': {
      ctx.beginPath()
      ctx.moveTo(cx, 0)
      ctx.lineTo(w, h)
      ctx.lineTo(0, h)
      ctx.closePath()
      break
    }
    case 'pentagon': {
      drawRegularPolygonPath(ctx, cx, cy, Math.min(w, h) / 2, 5)
      break
    }
    case 'hexagon': {
      drawRegularPolygonPath(ctx, cx, cy, Math.min(w, h) / 2, 6)
      break
    }
    case 'star': {
      drawStarPath(ctx, cx, cy, Math.min(w, h) / 2, starPoints, starInnerRadius)
      break
    }
    default: {
      ctx.beginPath()
      ctx.rect(0, 0, w, h)
      break
    }
  }
}

function drawRegularPolygonPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, sides: number): void {
  ctx.beginPath()
  for (let i = 0; i < sides; i++) {
    const angle = (i * 2 * Math.PI) / sides - Math.PI / 2
    const px = cx + r * Math.cos(angle)
    const py = cy + r * Math.sin(angle)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

function drawStarPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  points: number,
  innerRatio: number,
): void {
  const inner = r * innerRatio
  ctx.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const angle = (i * Math.PI) / points - Math.PI / 2
    const radius = i % 2 === 0 ? r : inner
    const px = cx + radius * Math.cos(angle)
    const py = cy + radius * Math.sin(angle)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

/** Cache key for a shape texture */
function getShapeKey(sprite: SpriteComponent): string {
  const shape = sprite.shape ?? 'rect'
  if (shape === 'rect' && !sprite.borderRadius && !sprite.strokeColor) return ''
  const br = shape === 'roundedRect' ? (sprite.borderRadius ?? 0) : 0
  const sp = shape === 'star' ? (sprite.starPoints ?? 5) : 0
  const sir = shape === 'star' ? (sprite.starInnerRadius ?? 0.4) : 0
  const stroke =
    sprite.strokeColor && (sprite.strokeWidth ?? 0) > 0 ? `|s:${sprite.strokeColor}:${sprite.strokeWidth}` : ''
  const res = shapeTexSize(sprite.width, sprite.height)
  return `__shape__:${shape}:${br}:${sp}:${sir}${stroke}:r${res}`
}

// ── Sprite helpers ────────────────────────────────────────────────────────────

function getSamplingKey(sampling?: Sampling): string {
  if (!sampling) return ''
  if (typeof sampling === 'string') return sampling
  return `${sampling.min}|${sampling.mag}`
}

function getTextureKey(sprite: SpriteComponent): string {
  // Dynamic canvas textures are registered by ID — no sampling suffix needed
  if (sprite.dynamicSrc) return sprite.dynamicSrc
  const src = sprite.image?.src || sprite.src
  const samplingKey = getSamplingKey(sprite.sampling)
  const suffix = samplingKey ? `:s=${samplingKey}` : ''
  if (src) return sprite.tileX || sprite.tileY ? `${src}:repeat${suffix}` : `${src}${suffix}`
  // Non-rect shapes get their own texture key
  const shapeKey = getShapeKey(sprite)
  if (shapeKey) return shapeKey
  return `__color__:${sprite.color}${suffix}`
}

// Scratch buffer for UV rects — avoids allocating a 4-tuple per sprite per
// frame. Consumed immediately by writeInstance at the only call site.
const uvScratch: [number, number, number, number] = [0, 0, 1, 1]
/** Scratch follow target, reused every frame (no per-frame allocation). */
const followTarget: CameraFollowPoint = { x: 0, y: 0 }

// Per-sprite cache of everything derived from its texture inputs, so the hot
// loop skips string building and DOM getters (img.src/complete/naturalWidth).
interface SpriteTexInfo {
  image: HTMLImageElement | undefined
  src: string | undefined
  dyn: string | undefined
  sampling: Sampling | undefined
  tiled: boolean
  color: string
  key: string
  rank: number
  epoch: number
  iw: number
  ih: number
  glKey: string | null
  r: number
  g: number
  b: number
  a: number
}

interface DynamicCanvasEntry {
  canvas: HTMLCanvasElement | OffscreenCanvas
  tex: WebGLTexture
  dirty: boolean
  version: number
  texW: number
  texH: number
  // Pending dirty region; x1 < 0 means the whole canvas.
  x0: number
  y0: number
  x1: number
  y1: number
  /** Free the canvas' pixels after each upload (the GPU texture is the only copy). */
  release?: boolean
  onRestore?: () => void
}

type SpriteWithInfo = SpriteComponent & { _rinfo?: SpriteTexInfo }

function hasCustomShape(sprite: SpriteComponent): boolean {
  return (sprite.shape !== undefined && sprite.shape !== 'rect') || !!sprite.borderRadius || !!sprite.strokeColor
}

function writeUV(sprite: SpriteComponent, iw: number, ih: number): void {
  if (iw === 0) {
    uvScratch[0] = 0
    uvScratch[1] = 0
    uvScratch[2] = 1
    uvScratch[3] = 1
  } else if (sprite.frameWidth && sprite.frameHeight) {
    const cols = sprite.frameColumns ?? Math.floor(iw / sprite.frameWidth)
    const col = sprite.frameIndex % cols
    const row = Math.floor(sprite.frameIndex / cols)
    uvScratch[0] = (col * sprite.frameWidth) / iw
    uvScratch[1] = (row * sprite.frameHeight) / ih
    uvScratch[2] = sprite.frameWidth / iw
    uvScratch[3] = sprite.frameHeight / ih
  } else if (sprite.frame) {
    const { sx, sy, sw, sh } = sprite.frame
    uvScratch[0] = sx / iw
    uvScratch[1] = sy / ih
    uvScratch[2] = sw / iw
    uvScratch[3] = sh / ih
  } else {
    uvScratch[0] = 0
    uvScratch[1] = 0
    uvScratch[2] = sprite.tileX ? sprite.width / (sprite.tileSizeX ?? iw) : 1
    uvScratch[3] = sprite.tileY ? sprite.height / (sprite.tileSizeY ?? ih) : 1
  }
}

// ── Post-process options ──────────────────────────────────────────────────────

export interface PostProcessOptions {
  bloom?: {
    enabled?: boolean
    /** Luminance cutoff 0–1 above which a pixel contributes to bloom. Default 0.65. */
    threshold?: number
    /** Additive blend strength 0–1. Default 0.6. */
    intensity?: number
  }
  vignette?: {
    enabled?: boolean
    /** Darkness at edges 0–1. Default 0.4. */
    intensity?: number
  }
  chromaticAberration?: {
    enabled?: boolean
    /** Pixel shift for R/B channels. Default 2. */
    offset?: number
  }
  scanlines?: {
    enabled?: boolean
    /** Pixel rows between scanlines. Default 3. */
    gap?: number
    /** Darkness of each scanline 0–1. Default 0.15. */
    opacity?: number
  }
}

type SceneHashWorld = Pick<ECSWorld, 'query' | 'getComponent'>

interface DynamicCanvasHashEntry {
  version: number
}

interface WebGLSceneHashState {
  world: SceneHashWorld
  camX: number
  camY: number
  zoom: number
  shakeX: number
  shakeY: number
  background: string
  postProcessOptions: PostProcessOptions
  textureRevision: number
  overlayRevision: number
  dynamicCanvases: Iterable<[string, DynamicCanvasHashEntry]>
}

/** Internal helper used by idle-frame skipping. Exported for regression tests. */
export function computeWebGLSceneHash({
  world,
  camX,
  camY,
  zoom,
  shakeX,
  shakeY,
  background,
  postProcessOptions,
  textureRevision,
  overlayRevision,
  dynamicCanvases,
}: WebGLSceneHashState): number {
  // FNV-1a 32-bit hash — fast, good avalanche, and cheap enough for static scenes.
  let h = 2166136261
  const mix = (n: number) => {
    const i = Number.isFinite(n) ? n | 0 : 0
    h = Math.imul(h ^ (i & 0xff), 16777619)
    h = Math.imul(h ^ ((i >> 8) & 0xff), 16777619)
    h = Math.imul(h ^ ((i >> 16) & 0xff), 16777619)
    h = Math.imul(h ^ ((i >> 24) & 0xff), 16777619)
  }
  const mixBool = (value: unknown) => mix(value ? 1 : 0)
  const mixString = (value: unknown) => {
    const str = value == null ? '' : String(value)
    mix(str.length)
    for (let i = 0; i < str.length; i++) mix(str.charCodeAt(i))
  }
  const mixSampling = (sampling: Sampling | undefined) => {
    if (typeof sampling === 'string') {
      mixString(sampling)
    } else if (sampling) {
      mixString(sampling.min)
      mixString(sampling.mag)
    } else {
      mixString(DEFAULT_SAMPLING)
    }
  }
  const mixTransform = (id: EntityId) => {
    const t = world.getComponent<TransformComponent>(id, 'Transform')!
    mix(t.x * 100)
    mix(t.y * 100)
    mix(t.rotation * 1000)
    mix(t.scaleX * 1000)
    mix(t.scaleY * 1000)
  }

  mix(camX * 100)
  mix(camY * 100)
  mix(zoom * 1000)
  mix(shakeX * 1000)
  mix(shakeY * 1000)
  mixString(background)
  mix(textureRevision)
  mix(overlayRevision)

  const bloom = postProcessOptions.bloom
  mixBool(bloom?.enabled)
  mix((bloom?.threshold ?? 0.65) * 1000)
  mix((bloom?.intensity ?? 0.6) * 1000)
  const vignette = postProcessOptions.vignette
  mixBool(vignette?.enabled)
  mix((vignette?.intensity ?? 0.4) * 1000)
  const chromaticAberration = postProcessOptions.chromaticAberration
  mixBool(chromaticAberration?.enabled)
  mix((chromaticAberration?.offset ?? 2) * 1000)
  const scanlines = postProcessOptions.scanlines
  mixBool(scanlines?.enabled)
  mix((scanlines?.gap ?? 3) * 1000)
  mix((scanlines?.opacity ?? 0.15) * 1000)

  for (const [id, entry] of dynamicCanvases) {
    mixString(id)
    mix(entry.version)
  }

  // Vector shapes and gradients are not hashed: never skip a frame that contains them.
  for (const kind of ['CircleShape', 'LineShape', 'PolygonShape', 'Gradient']) {
    if (world.query('Transform', kind).length > 0) return -1
  }

  for (const id of world.query('Transform', 'Sprite')) {
    const s = world.getComponent<SpriteComponent>(id, 'Sprite')!
    if (s.customDraw) return -1
    mix(id)
    mixTransform(id)
    mix(s.width * 100)
    mix(s.height * 100)
    mixString(s.color)
    mixString(s.src)
    mixString(s.dynamicSrc)
    mix(s.offsetX * 100)
    mix(s.offsetY * 100)
    mix(s.zIndex)
    mixBool(s.visible)
    mixBool(s.flipX)
    mixBool(s.flipY)
    mix(s.anchorX * 1000)
    mix(s.anchorY * 1000)
    mix(s.frameIndex)
    mix((s.frameWidth ?? 0) * 100)
    mix((s.frameHeight ?? 0) * 100)
    mix(s.frameColumns ?? 0)
    mix(s.frame?.sx ?? 0)
    mix(s.frame?.sy ?? 0)
    mix(s.frame?.sw ?? 0)
    mix(s.frame?.sh ?? 0)
    mixBool(s.tileX)
    mixBool(s.tileY)
    mix((s.tileSizeX ?? 0) * 100)
    mix((s.tileSizeY ?? 0) * 100)
    mixSampling(s.sampling)
    mixString(s.blendMode)
    mixString(s.layer)
    mixString(s.shape)
    mix((s.borderRadius ?? 0) * 100)
    mixString(s.strokeColor)
    mix((s.strokeWidth ?? 0) * 100)
    mix(s.starPoints ?? 0)
    mix((s.starInnerRadius ?? 0) * 1000)
    mix((s.opacity ?? 1) * 255)
    mixString(s.tint)
    mix((s.tintOpacity ?? 0) * 255)
  }

  for (const id of world.query('Transform', 'Text')) {
    const text = world.getComponent<TextComponent>(id, 'Text')!
    mix(id)
    mixTransform(id)
    mixString(text.text)
    mix((text.fontSize ?? 16) * 100)
    mixString(text.fontFamily ?? 'monospace')
    mixString(text.color ?? '#ffffff')
    mixString(String(text.fontWeight ?? ''))
    mixString(text.fontStyle ?? '')
    mixString(text.layer ?? '')
    mixString(text.align)
    mixString(text.baseline)
    mix(text.zIndex)
    mixBool(text.visible)
    mix((text.maxWidth ?? 0) * 100)
    mix(text.offsetX * 100)
    mix(text.offsetY * 100)
    mixString(text.strokeColor)
    mix((text.strokeWidth ?? 0) * 100)
    mixString(text.shadowColor)
    mix((text.shadowOffsetX ?? 0) * 100)
    mix((text.shadowOffsetY ?? 0) * 100)
    mix((text.shadowBlur ?? 0) * 100)
    mixBool(text.wordWrap)
    mix((text.lineHeight ?? 1.2) * 1000)
    mix((text.opacity ?? 1) * 255)
  }

  for (const id of world.query('ParallaxLayer')) {
    const layer = world.getComponent<ParallaxLayerComponent>(id, 'ParallaxLayer')!
    mix(id)
    mixString(layer.src)
    mix(layer.speedX * 1000)
    mix(layer.speedY * 1000)
    mixBool(layer.repeatX)
    mixBool(layer.repeatY)
    mix(layer.zIndex)
    mix(layer.offsetX * 100)
    mix(layer.offsetY * 100)
    mix(layer.imageWidth)
    mix(layer.imageHeight)
  }

  for (const id of world.query('Transform', 'Trail')) {
    const trail = world.getComponent<TrailComponent>(id, 'Trail')!
    mix(id)
    mixTransform(id)
    mix(trail.length)
    mixString(trail.color)
    mix(trail.width * 100)
    mix(trail.points.length)
    for (const point of trail.points) {
      mix(point.x * 100)
      mix(point.y * 100)
    }
    for (const color of trail.colorOverLife ?? []) mixString(color)
    mix((trail.widthOverLife?.start ?? 0) * 100)
    mix((trail.widthOverLife?.end ?? 0) * 100)
  }

  // Any playing animation or live particle system = force dirty.
  for (const id of world.query('AnimationState')) {
    const anim = world.getComponent<AnimationStateComponent>(id, 'AnimationState')!
    if (anim.playing) return -1
  }
  for (const id of world.query('ParticlePool')) {
    const pool = world.getComponent<ParticlePoolComponent>(id, 'ParticlePool')!
    if (pool.active || pool.particles.length > 0) return -1
  }

  for (const id of world.query('SquashStretch')) {
    const ss = world.getComponent<SquashStretchComponent>(id, 'SquashStretch')!
    mix(ss.currentScaleX * 1000)
    mix(ss.currentScaleY * 1000)
  }

  return h
}

// ── RenderSystem (WebGL2) ─────────────────────────────────────────────────────

/**
 * WebGL2-based instanced render system.
 *
 * Uses instanced rendering: sprites sharing the same texture source are
 * drawn in a single `drawArraysInstanced` call.
 */
export class RenderSystem implements System {
  private _tileLayers: TileRenderer | null = null
  /** Per-frame TileLayer upload/draw counters. */
  get tileLayerStats(): TileLayerRenderStats {
    return this.stats.tile
  }
  /** Default background used when no Camera2D component exists */
  defaultBackground = '#1a1a2e'

  private readonly gl: WebGL2RenderingContext
  private program!: WebGLProgram
  private quadVAO!: WebGLVertexArrayObject
  private instanceBuffer!: WebGLBuffer
  private readonly instanceData = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE)
  private whiteTexture!: WebGLTexture
  private particleTextureSoft!: WebGLTexture
  private particleTextureCircle!: WebGLTexture
  private readonly textures = new Map<string, WebGLTexture>()
  /**
   * Tracks texture access order for LRU eviction (most recent at end).
   * A Map preserves insertion order, so re-inserting on touch moves the
   * key to the end and evicting the oldest is the first iteration step —
   * both O(1), avoiding the array indexOf/splice that scaled with cache size.
   */
  // key -> frame last used; Map order is recency order.
  private readonly textureLRU = new Map<string, number>()
  private _frame = 0
  private readonly imageCache = new Map<string, HTMLImageElement>()
  /** image URL -> performance.now() of its last failed load; not re-requested until IMAGE_RETRY_MS has passed. */
  private readonly failedImages = new Map<string, number>()

  // Cached uniform locations — sprite program
  private uCamPos!: WebGLUniformLocation
  private uZoom!: WebGLUniformLocation
  private uCanvasSize!: WebGLUniformLocation
  private uShake!: WebGLUniformLocation
  private uTexture!: WebGLUniformLocation
  private uUseTexture!: WebGLUniformLocation
  private uPremul!: WebGLUniformLocation | null
  /** The blend applyBlendMode last set is 'multiply' (sprite shader must premultiply colour). */
  private mulBlend = false

  // ── Parallax program ──────────────────────────────────────────────────────
  private parallaxProgram!: WebGLProgram
  private parallaxVAO!: WebGLVertexArrayObject
  private readonly parallaxTextures = new Map<string, WebGLTexture>()
  private readonly parallaxImageCache = new Map<string, HTMLImageElement>()

  // Cached uniform locations — parallax program
  private pUTexture!: WebGLUniformLocation
  private pUUvOffset!: WebGLUniformLocation
  private pUTexSize!: WebGLUniformLocation
  private pUCanvasSize!: WebGLUniformLocation

  // ── Text texture cache ────────────────────────────────────────────────────
  private readonly textureCache = new Map<
    string,
    { tex: WebGLTexture; w: number; h: number; ax: number; ay: number; frame: number }
  >()

  // ── Shape texture cache ─────────────────────────────────────────────────
  private readonly shapeTextures = new Map<string, WebGLTexture>()

  /**
   * Caches the parsed RGB endpoints of an in-progress particle-pool color
   * transition, keyed by pool instance. `from`/`to` are invariant for the
   * whole transition, so re-parsing the CSS color strings every frame (as
   * opposed to once when the transition starts or its endpoints change)
   * was pure wasted work.
   */
  private readonly colorTransitionCache = new WeakMap<
    ParticlePoolComponent,
    { from: string; to: string; r0: number; g0: number; b0: number; r1: number; g1: number; b1: number }
  >()

  // ── Render layer manager ────────────────────────────────────────────────
  readonly layers: RenderLayerManager = createRenderLayerManager()

  // ── Texture sampling ────────────────────────────────────────────────────
  private _defaultSampling: Sampling = DEFAULT_SAMPLING

  /** Set the global default texture sampling mode for all sprites that don't specify their own. */
  setDefaultSampling(sampling: Sampling): void {
    this._defaultSampling = sampling
  }

  /** Get the current global default texture sampling mode. */
  getDefaultSampling(): Sampling {
    return this._defaultSampling
  }

  // ── Sprite texture LRU helpers ──────────────────────────────────────────

  /** Record a texture key as recently used; evict LRU entries if over limit. */
  private touchTexture(key: string): void {
    const lru = this.textureLRU
    if (lru.has(key)) lru.delete(key)
    lru.set(key, this._frame)
    while (lru.size > MAX_SPRITE_TEXTURES) {
      const [evict, usedIn] = lru.entries().next().value as [string, number]
      // Everything left was drawn this frame; allow a temporary overshoot.
      if (usedIn === this._frame) break
      lru.delete(evict)
      if (this._dynamicCanvases.has(evict)) continue
      const tex = this.textures.get(evict)
      if (tex) {
        this.gl.deleteTexture(tex)
        this._statTexFree(tex)
        this.textures.delete(evict)
      }
    }
  }

  // ── Debug overlays ──────────────────────────────────────────────────────
  private debugNavGrid: NavGrid | null = null
  /** Set when the GL context is lost — rendering suspends until restore. */
  private _contextLostWarned = false
  private contactFlashPoints: { x: number; y: number; ttl: number }[] = []
  private _highlightEntityId: number | null = null

  /** Live counters, mutated in place each frame. See {@link RenderStats}. */
  readonly stats: RenderStats = createRenderStats()

  /** Same object as {@link stats} (kept for existing callers). */
  getStats(): RenderStats {
    return this.stats
  }
  private readonly _texBytes = new Map<WebGLTexture, number>()
  private _gpu: GpuTiming | null = null
  private _gpuWanted = false
  private _gpuLoad: Promise<GpuTiming> | null = null

  /**
   * Turn GPU frame timing on or off (`stats.gpuMs` / `gpuMsAvg`). Off by default
   * and free while off. Needs EXT_disjoint_timer_query_webgl2; resolves to false
   * (and `stats.gpuTimerSupported` becomes false) when it is unavailable. Results
   * are read a few frames late and never stall the pipeline.
   */
  setGpuTiming(enabled: boolean): Promise<boolean> {
    this._gpuWanted = enabled
    if (!enabled) return Promise.resolve(this._gpu?.set(false) ?? false)
    return (this._gpuLoad ??= import('./gpuTimer').then(
      (m) => (this._gpu = new m.GpuTiming(this.gl, this.stats)),
    )).then(
      (g) => g.set(this._gpuWanted),
      () => ((this.stats.gpuTimerSupported = false), false),
    )
  }

  /** Count an upload of a new or re-specified texture. */
  private _statTex(tex: WebGLTexture, w: number, h: number): void {
    this._statTexSize(tex, w, h)
    this.stats.textureUploads++
    this.stats.textureUploadBytes += w * h * 4
  }

  /** Update the live-memory counters for `tex` at `w` x `h` (no upload counting). Handles resizes. */
  private _statTexSize(tex: WebGLTexture, w: number, h: number): void {
    const b = w * h * 4
    const s = this.stats
    s.textureBytes += b - (this._texBytes.get(tex) ?? 0)
    this._texBytes.set(tex, b)
    const st = this._texSampling.get(tex)
    if (st) st.mipBytes = false // re-specified: the mip chain (and its bytes) is gone
    s.textureCount = this._texBytes.size + (this._tileLayers?.stats.textureCount ?? 0)
  }

  private _statTexFree(tex: WebGLTexture | null): void {
    if (!tex) return
    const b = this._texBytes.get(tex)
    if (b === undefined) return
    this._texBytes.delete(tex)
    this.stats.textureBytes -= b
    this.stats.textureCount = this._texBytes.size + (this._tileLayers?.stats.textureCount ?? 0)
  }

  // FPS tracking
  private frameTimes: number[] = []
  private lastTimestamp = 0

  // ── Sprite sort scratch buffers ─────────────────────────────────────────
  // Reused across frames (grow/shrink via .length, never reallocated) to
  // avoid allocating one wrapper object per visible sprite just to sort by
  // (layer, z, texture) — this runs every render frame.
  private _sortOrder = new Int32Array(1024)
  private _sortKeys = new Float64Array(1024)
  private _sortOrderLen = -1
  private readonly _sortLayers: number[] = []
  private readonly _sortZs: number[] = []
  private readonly _sortTexRanks: number[] = []
  /** texture key → small integer rank, so the frame sort compares numbers not strings */
  private readonly _texRankCache = new Map<string, number>()
  // Rank 0 is reserved for tile layers so they draw before sprites at equal (layer, z).
  private _texNextRank = 1
  private _texRankEpoch = 0
  private readonly _spriteLayers: SpriteLayer[] = []
  private readonly _textLayers: TextLayer[] = []
  private _textLayerRenderer: TextLayerRenderer | null = null
  private readonly _textRows: LayerStats[] = []
  private _textLayerVersion = 0
  /** Seconds of simulated time rendered so far (drives GPU sway). */
  private _time = 0
  private _entityText: EntityTextBatcher | null = null
  private _shapes: ShapeRenderer | null = null
  private readonly _vecComps: (
    | CircleShapeComponent
    | LineShapeComponent
    | PolygonShapeComponent
    | GradientComponent
  )[] = []
  private readonly _vecIds: EntityId[] = []
  private _gradientTex = new Map<GradientComponent, { key: string; tex: WebGLTexture }>()
  private _textWarned = false
  private readonly _sortTextLayers: TextLayer[] = []
  private _texSampling = new WeakMap<WebGLTexture, { min: string; mag: string; mips: boolean; mipBytes: boolean }>()
  private readonly _tints = new Map<string, TintSlot>()
  /** Active (strength > 0) tints drawn after all sprites, before text. */
  private readonly _flatTints: TintSlot[] = []
  /** Active tints that take part in the sprite sort via `layer` / `zIndex`. */
  private readonly _sortedTints: TintSlot[] = []
  private _layerImageTextures = new WeakMap<object, { tex: WebGLTexture; ver: number; w: number; h: number }>()
  /** Weak index of the entries above, so dispose() can free textures a WeakMap cannot enumerate. */
  private _layerImageEntries = new Set<WeakRef<{ tex: WebGLTexture }>>()
  /** Set by dispose(): late image loads must not allocate GL objects nobody will free. */
  private _disposed = false
  private quadBuf: WebGLBuffer | null = null
  private fullscreenBuf: WebGLBuffer | null = null
  private readonly _resolvedAtlas: ResolvedAtlas = { tex: null as unknown as WebGLTexture, width: 0, height: 0 }
  private readonly _layerCam: LayerCamera = {
    x: 0,
    y: 0,
    zoom: 1,
    width: 1,
    height: 1,
    shakeX: 0,
    shakeY: 0,
    viewL: 0,
    viewR: 0,
    viewT: 0,
    viewB: 0,
  }
  private _spriteLayerRenderer: SpriteLayerRenderer | null = null
  private _spriteLayerVersion = 0
  private readonly _visSprites: SpriteComponent[] = []
  private readonly _visInfo: SpriteTexInfo[] = []
  private readonly _visIds: EntityId[] = []

  // ── Dynamic canvas textures (texSubImage2D optimization) ─────────────────
  private readonly _dynamicCanvases = new Map<string, DynamicCanvasEntry>()
  private _textureRevision = 0
  private _overlayRevision = 0

  // ── Idle frame skip ──────────────────────────────────────────────────────
  private _idleSkip = false
  private _prevSceneHash = -1
  private _idleFBO: WebGLFramebuffer | null = null
  private _idleTex: WebGLTexture | null = null
  private _idleFBOW = 0
  private _idleFBOH = 0

  // ── Post-process ─────────────────────────────────────────────────────────
  private _ppOptions: PostProcessOptions = {}

  // Lazily created programs (null until first PP use)
  private _ppBloomExtractProg: WebGLProgram | null = null
  private _ppBlurProg: WebGLProgram | null = null
  private _ppCompositeProg: WebGLProgram | null = null

  // Bloom-extract uniforms
  private _ppBeScene: WebGLUniformLocation | null = null
  private _ppBeThreshold: WebGLUniformLocation | null = null
  // Blur uniforms
  private _ppBlurTex: WebGLUniformLocation | null = null
  private _ppBlurDir: WebGLUniformLocation | null = null
  private _ppBlurTexel: WebGLUniformLocation | null = null
  // Composite uniforms
  private _ppCmpScene: WebGLUniformLocation | null = null
  private _ppCmpBloom: WebGLUniformLocation | null = null
  private _ppCmpBloomIntensity: WebGLUniformLocation | null = null
  private _ppCmpVignette: WebGLUniformLocation | null = null
  private _ppCmpCaOffset: WebGLUniformLocation | null = null
  private _ppCmpCaEnabled: WebGLUniformLocation | null = null
  private _ppCmpTexelSize: WebGLUniformLocation | null = null
  private _ppCmpScanlineGap: WebGLUniformLocation | null = null
  private _ppCmpScanlineOpacity: WebGLUniformLocation | null = null
  private _ppCmpCanvasSize: WebGLUniformLocation | null = null

  // FBOs + textures (recreated on canvas resize)
  /**
   * Canvas2D-style effects (`usePostProcess`). After the frame (and any GPU post-process) is
   * drawn, the screen is copied to a 2D canvas, the effects run on it, and the result is drawn
   * back. Costs a canvas copy and a texture upload per frame while non-empty.
   */
  readonly postProcessStack: PostProcessStack = createPostProcessStack()
  private _stackCanvas: HTMLCanvasElement | null = null
  private _stackCtx: CanvasRenderingContext2D | null = null
  private _stackTex: WebGLTexture | null = null
  private _stackTexW = 0
  private _stackTexH = 0
  private _ppSceneFBO: WebGLFramebuffer | null = null
  private _ppSceneTex: WebGLTexture | null = null
  private _ppBloomExtractFBO: WebGLFramebuffer | null = null
  private _ppBloomExtractTex: WebGLTexture | null = null
  private _ppBlurFBO1: WebGLFramebuffer | null = null
  private _ppBlurTex1: WebGLTexture | null = null
  private _ppBlurFBO2: WebGLFramebuffer | null = null
  private _ppBlurTex2: WebGLTexture | null = null
  private _ppFBOW = 0
  private _ppFBOH = 0

  /** Overlay a nav grid: green = walkable, red = blocked. Pass null to clear. */
  setDebugNavGrid(grid: NavGrid | null): void {
    this.debugNavGrid = grid
    this._overlayRevision++
  }

  /** Reusable empty transition list — avoids allocating per entity per frame. */
  private static readonly _emptyTransitions: AnimatorTransition[] = []

  /** Cache of priority-sorted transition lists, keyed by the original array identity. */
  private _sortedTransitionsMap = new WeakMap<AnimatorTransition[], AnimatorTransition[]>()

  /**
   * Returns the transitions of a state definition sorted by priority
   * descending (stable). The sorted copy is cached per array identity, so the
   * sort runs once per state definition instead of once per entity per frame.
   */
  private _sortedTransitions(stateDef: { transitions?: AnimatorTransition[] }): AnimatorTransition[] {
    const list = stateDef.transitions
    if (!list || list.length === 0) return RenderSystem._emptyTransitions
    let sorted = this._sortedTransitionsMap.get(list)
    if (!sorted) {
      sorted = [...list].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      this._sortedTransitionsMap.set(list, sorted)
    }
    return sorted
  }

  /** Flash a point on the canvas for one frame (world-space coords). */
  flashContactPoint(x: number, y: number): void {
    this.contactFlashPoints.push({ x, y, ttl: 1 })
    this._overlayRevision++
  }

  /** Highlight an entity's collider bounds for one or more frames (DevTools inspector). Pass null to clear. */
  setEntityHighlight(id: number | null): void {
    this._highlightEntityId = id
    this._overlayRevision++
  }

  /** Configure native WebGL post-process effects for this render system. */
  setPostProcessOptions(opts: PostProcessOptions): void {
    this._ppOptions = opts
    this._prevSceneHash = -1
  }

  /**
   * Enable idle frame skip. When enabled the renderer computes a hash of all
   * visible entity positions, frame indices, and camera state each frame. If
   * the hash matches the previous frame the GPU draw calls are skipped entirely
   * and the cached scene is blitted to screen instead.
   *
   * Best for scenes that are frequently static (pause menus, cutscenes, HUDs).
   * Animations and active particles automatically disable the skip for that frame.
   */
  setIdleFrameSkip(enabled: boolean): void {
    this._idleSkip = enabled
    this._prevSceneHash = -1
  }

  /**
   * Register an HTMLCanvasElement as a GPU texture that the renderer can sample.
   * The canvas is uploaded once on registration. Call {@link markDynamicCanvasDirty}
   * to schedule a re-upload before the next frame.
   *
   * Use the returned `id` as the `dynamicSrc` on a `<Sprite>` component.
   */
  /**
   * Tint the whole view after world sprites and layers, before text, e.g. a
   * day/night cycle ('multiply') or fog/flash ('normal'/'additive'). `a` is
   * the strength (0 = off). Cheap enough to change every frame.
   */
  setScreenTint(
    r: number,
    g: number,
    b: number,
    a: number,
    mode: 'multiply' | 'normal' | 'additive' | 'screen' = 'multiply',
  ): void {
    this.setTint('screen', r, g, b, a, { mode })
  }

  clearScreenTint(): void {
    this.setScreenTint(1, 1, 1, 0)
  }

  /**
   * A named tint over the view. Several can be active at once (e.g. 'night'
   * and 'weather'). With `layer` and/or `zIndex` the tint takes part in the
   * sprite sort and only covers what is drawn before that point (sprites and
   * layers with a lower or equal order, tile layers beneath all sprites), so
   * UI, text and effects drawn later stay bright. Without them it covers the
   * whole world after all sprites, before text. `a` is the strength (0 = off).
   */
  setTint(
    name: string,
    r: number,
    g: number,
    b: number,
    a: number,
    opts: { mode?: 'multiply' | 'normal' | 'additive' | 'screen'; layer?: string; zIndex?: number } = {},
  ): void {
    const mode = opts.mode ?? 'multiply'
    let t = this._tints.get(name)
    if (
      t &&
      t.r === r &&
      t.g === g &&
      t.b === b &&
      t.a === a &&
      t.mode === mode &&
      t.layer === opts.layer &&
      t.zIndex === opts.zIndex
    )
      return
    if (!t) {
      t = { name, r, g, b, a, mode, layer: opts.layer, zIndex: opts.zIndex }
      this._tints.set(name, t)
    } else {
      t.r = r
      t.g = g
      t.b = b
      t.a = a
      t.mode = mode
      t.layer = opts.layer
      t.zIndex = opts.zIndex
    }
    this._flatTints.length = 0
    this._sortedTints.length = 0
    for (const x of this._tints.values()) {
      if (x.a <= 0) continue
      if (x.layer !== undefined || x.zIndex !== undefined) this._sortedTints.push(x)
      else this._flatTints.push(x)
    }
    this._overlayRevision++
  }

  /** Remove a named tint. */
  clearTint(name: string): void {
    const t = this._tints.get(name)
    if (!t) return
    this.setTint(name, 1, 1, 1, 0)
    this._tints.delete(name)
  }

  addSpriteLayer(layer: SpriteLayer): void {
    if (!this._spriteLayers.includes(layer)) this._spriteLayers.push(layer)
    // Alpha-tested / opaque-bounds picking reads the atlas pixels the renderer already holds.
    layer.pixelSource ??= (atlas) =>
      (atlas.dynamicSrc !== undefined
        ? this._dynamicCanvases.get(atlas.dynamicSrc)?.canvas
        : atlas.src !== undefined
          ? this.imageCache.get(atlas.src)
          : undefined) as PickSource | undefined
    this._overlayRevision++
  }

  removeSpriteLayer(layer: SpriteLayer): void {
    const i = this._spriteLayers.indexOf(layer)
    if (i >= 0) this._spriteLayers.splice(i, 1)
    this._spriteLayerRenderer?.release(layer)
    this._overlayRevision++
  }

  /** Whether a dynamic canvas with this id is registered. */
  hasDynamicCanvas(id: string): boolean {
    return this._dynamicCanvases.has(id)
  }

  /** Create a dynamic canvas by id at runtime (resizable, disposable). See {@link ManagedDynamicCanvas}. */
  createDynamicCanvas(opts: DynamicCanvasOptions): ManagedDynamicCanvas {
    return createDynamicCanvasHandle(this, opts)
  }

  /** Ids of all registered dynamic canvases. */
  dynamicCanvasIds(): string[] {
    return [...this._dynamicCanvases.keys()]
  }

  /** Add a {@link TextLayer}; it sorts with sprites by `layer` + `zIndex`. */
  addTextLayer(layer: TextLayer): void {
    if (!this._textLayers.includes(layer)) this._textLayers.push(layer)
    this._overlayRevision++
  }

  removeTextLayer(layer: TextLayer): void {
    const i = this._textLayers.indexOf(layer)
    if (i >= 0) this._textLayers.splice(i, 1)
    this._overlayRevision++
  }

  setDynamicCanvasRelease(id: string, release: boolean, onRestore?: () => void): void {
    const entry = this._dynamicCanvases.get(id)
    if (!entry) return
    entry.release = release
    entry.onRestore = onRestore
  }

  registerDynamicCanvas(id: string, canvas: HTMLCanvasElement | OffscreenCanvas): void {
    const { gl } = this
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    this._statTex(tex, canvas.width, canvas.height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this._dynamicCanvases.set(id, {
      canvas,
      tex,
      dirty: false,
      version: ++this._textureRevision,
      texW: canvas.width,
      texH: canvas.height,
      x0: 0,
      y0: 0,
      x1: 0,
      y1: 0,
    })
    this.textures.set(id, tex)
    this.touchTexture(id)
  }

  /**
   * Mark a dynamic canvas as modified so it is re-uploaded before the next
   * frame. Pass a rect to upload only that region; rects accumulate as a union.
   */
  markDynamicCanvasDirty(id: string, x?: number, y?: number, w?: number, h?: number): void {
    const entry = this._dynamicCanvases.get(id)
    if (!entry) return
    if (x === undefined || y === undefined || w === undefined || h === undefined) {
      entry.x1 = -1
    } else if (!entry.dirty) {
      entry.x0 = x
      entry.y0 = y
      entry.x1 = x + w
      entry.y1 = y + h
    } else if (entry.x1 >= 0) {
      entry.x0 = Math.min(entry.x0, x)
      entry.y0 = Math.min(entry.y0, y)
      entry.x1 = Math.max(entry.x1, x + w)
      entry.y1 = Math.max(entry.y1, y + h)
    }
    entry.dirty = true
    entry.version = ++this._textureRevision
  }

  private uploadDynamicCanvas(entry: DynamicCanvasEntry): void {
    const { gl } = this
    const c = entry.canvas
    gl.bindTexture(gl.TEXTURE_2D, entry.tex)
    entry.dirty = false
    this.markTextureStale(entry.tex)
    this.stats.textureUploads++
    if (c.width !== entry.texW || c.height !== entry.texH) {
      this.stats.textureUploadBytes += c.width * c.height * 4
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
      entry.texW = c.width
      entry.texH = c.height
      this._statTexSize(entry.tex, c.width, c.height)
      return
    }
    const x0 = Math.max(0, Math.floor(entry.x0))
    const y0 = Math.max(0, Math.floor(entry.y0))
    const x1 = Math.min(c.width, Math.ceil(entry.x1))
    const y1 = Math.min(c.height, Math.ceil(entry.y1))
    if (entry.x1 < 0 || (x0 === 0 && y0 === 0 && x1 === c.width && y1 === c.height)) {
      this.stats.textureUploadBytes += c.width * c.height * 4
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, c)
      return
    }
    if (x1 <= x0 || y1 <= y0) return
    this.stats.textureUploadBytes += (x1 - x0) * (y1 - y0) * 4
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, c.width)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, c)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
  }

  /** Remove a registered dynamic canvas and free its GPU texture. */
  unregisterDynamicCanvas(id: string): void {
    const entry = this._dynamicCanvases.get(id)
    if (!entry) return
    this.gl.deleteTexture(entry.tex)
    this._statTexFree(entry.tex)
    this._dynamicCanvases.delete(id)
    this.textures.delete(id)
    this._textureRevision++
  }

  private get _anyPPEnabled(): boolean {
    const o = this._ppOptions
    return (
      (o.bloom?.enabled ?? false) ||
      (o.vignette?.enabled ?? false) ||
      (o.chromaticAberration?.enabled ?? false) ||
      (o.scanlines?.enabled ?? false)
    )
  }

  /** Lazily compile post-process shader programs. */
  private _ensurePPPrograms(): void {
    if (this._ppBloomExtractProg) return
    const { gl } = this

    this._ppBloomExtractProg = createProgram(gl, PARALLAX_VERT_SRC, BLOOM_EXTRACT_FRAG_SRC)
    gl.useProgram(this._ppBloomExtractProg)
    this._ppBeScene = gl.getUniformLocation(this._ppBloomExtractProg, 'u_scene')
    this._ppBeThreshold = gl.getUniformLocation(this._ppBloomExtractProg, 'u_threshold')

    this._ppBlurProg = createProgram(gl, PARALLAX_VERT_SRC, BLUR_FRAG_SRC)
    gl.useProgram(this._ppBlurProg)
    this._ppBlurTex = gl.getUniformLocation(this._ppBlurProg, 'u_tex')
    this._ppBlurDir = gl.getUniformLocation(this._ppBlurProg, 'u_direction')
    this._ppBlurTexel = gl.getUniformLocation(this._ppBlurProg, 'u_texelSize')

    this._ppCompositeProg = createProgram(gl, PARALLAX_VERT_SRC, COMPOSITE_FRAG_SRC)
    gl.useProgram(this._ppCompositeProg)
    this._ppCmpScene = gl.getUniformLocation(this._ppCompositeProg, 'u_scene')
    this._ppCmpBloom = gl.getUniformLocation(this._ppCompositeProg, 'u_bloom')
    this._ppCmpBloomIntensity = gl.getUniformLocation(this._ppCompositeProg, 'u_bloomIntensity')
    this._ppCmpVignette = gl.getUniformLocation(this._ppCompositeProg, 'u_vignetteIntensity')
    this._ppCmpCaOffset = gl.getUniformLocation(this._ppCompositeProg, 'u_caOffset')
    this._ppCmpCaEnabled = gl.getUniformLocation(this._ppCompositeProg, 'u_caEnabled')
    this._ppCmpTexelSize = gl.getUniformLocation(this._ppCompositeProg, 'u_texelSize')
    this._ppCmpScanlineGap = gl.getUniformLocation(this._ppCompositeProg, 'u_scanlineGap')
    this._ppCmpScanlineOpacity = gl.getUniformLocation(this._ppCompositeProg, 'u_scanlineOpacity')
    this._ppCmpCanvasSize = gl.getUniformLocation(this._ppCompositeProg, 'u_canvasSize')
  }

  /** Create or resize scene + bloom FBOs to match canvas dimensions. */
  private _ensurePPFBOs(w: number, h: number): void {
    if (this._ppFBOW === w && this._ppFBOH === h) return
    const { gl } = this

    const makeFBO = (
      prevFBO: WebGLFramebuffer | null,
      prevTex: WebGLTexture | null,
    ): [WebGLFramebuffer, WebGLTexture] => {
      if (prevFBO) gl.deleteFramebuffer(prevFBO)
      if (prevTex) gl.deleteTexture(prevTex)
      this._statTexFree(prevTex)
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      this._statTex(tex, w, h)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      return [fbo, tex]
    }

    ;[this._ppSceneFBO, this._ppSceneTex] = makeFBO(this._ppSceneFBO, this._ppSceneTex)
    ;[this._ppBloomExtractFBO, this._ppBloomExtractTex] = makeFBO(this._ppBloomExtractFBO, this._ppBloomExtractTex)
    ;[this._ppBlurFBO1, this._ppBlurTex1] = makeFBO(this._ppBlurFBO1, this._ppBlurTex1)
    ;[this._ppBlurFBO2, this._ppBlurTex2] = makeFBO(this._ppBlurFBO2, this._ppBlurTex2)

    this._ppFBOW = w
    this._ppFBOH = h
  }

  /** Run post-process passes (extract → blur → composite) and blit to screen. */
  private _applyPostProcess(
    W: number,
    H: number,
    sceneTex: WebGLTexture = this._ppSceneTex!,
    opts: PostProcessOptions = this._ppOptions,
  ): void {
    const { gl } = this
    const texelW = 1 / W
    const texelH = 1 / H

    gl.bindVertexArray(this.parallaxVAO)
    gl.disable(gl.BLEND)

    let bloomTex: WebGLTexture = this.whiteTexture // black if bloom disabled

    if (opts.bloom?.enabled) {
      const threshold = opts.bloom.threshold ?? 0.65

      // Pass 1: Extract bright pixels → bloomExtractFBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._ppBloomExtractFBO)
      gl.useProgram(this._ppBloomExtractProg!)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, sceneTex)
      gl.uniform1i(this._ppBeScene!, 0)
      gl.uniform1f(this._ppBeThreshold!, threshold)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // Pass 2: Horizontal blur → blurFBO1
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._ppBlurFBO1)
      gl.useProgram(this._ppBlurProg!)
      gl.bindTexture(gl.TEXTURE_2D, this._ppBloomExtractTex!)
      gl.uniform1i(this._ppBlurTex!, 0)
      gl.uniform2f(this._ppBlurDir!, 1.0, 0.0)
      gl.uniform2f(this._ppBlurTexel!, texelW, texelH)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // Pass 3: Vertical blur → blurFBO2
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._ppBlurFBO2)
      gl.bindTexture(gl.TEXTURE_2D, this._ppBlurTex1!)
      gl.uniform2f(this._ppBlurDir!, 0.0, 1.0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      this.stats.drawCalls += 3

      bloomTex = this._ppBlurTex2!
    }

    // Final composite → screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this._ppCompositeProg!)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sceneTex)
    gl.uniform1i(this._ppCmpScene!, 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, bloomTex)
    gl.uniform1i(this._ppCmpBloom!, 1)

    gl.uniform1f(this._ppCmpBloomIntensity!, opts.bloom?.enabled ? (opts.bloom.intensity ?? 0.6) : 0.0)
    gl.uniform1f(this._ppCmpVignette!, opts.vignette?.enabled ? (opts.vignette.intensity ?? 0.4) : 0.0)
    gl.uniform1f(this._ppCmpCaEnabled!, opts.chromaticAberration?.enabled ? 1.0 : 0.0)
    gl.uniform1f(this._ppCmpCaOffset!, opts.chromaticAberration?.offset ?? 2.0)
    gl.uniform2f(this._ppCmpTexelSize!, texelW, texelH)
    gl.uniform1f(this._ppCmpScanlineGap!, opts.scanlines?.enabled ? (opts.scanlines.gap ?? 3) : 0.0)
    gl.uniform1f(this._ppCmpScanlineOpacity!, opts.scanlines?.opacity ?? 0.15)
    gl.uniform2f(this._ppCmpCanvasSize!, W, H)

    gl.drawArrays(gl.TRIANGLES, 0, 6)
    this.stats.drawCalls++

    // Restore GL state for next frame's regular rendering
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.activeTexture(gl.TEXTURE0)
  }

  /** Run `postProcessStack` on a 2D copy of the finished frame and draw the result back. */
  private _applyEffectStack(W: number, H: number, dt: number): void {
    const { gl } = this
    if (!this._stackCanvas) {
      this._stackCanvas = document.createElement('canvas')
      this._stackCtx = this._stackCanvas.getContext('2d', { willReadFrequently: true })
    }
    const c = this._stackCanvas
    const ctx = this._stackCtx
    if (!ctx) return
    if (c.width !== W || c.height !== H) {
      c.width = W
      c.height = H
    }
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(this.canvas, 0, 0)
    this.postProcessStack.apply(ctx, W, H, dt)
    this._ensurePPPrograms()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.activeTexture(gl.TEXTURE0)
    if (!this._stackTex) {
      this._stackTex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, this._stackTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    gl.bindTexture(gl.TEXTURE_2D, this._stackTex)
    // The composite pass samples framebuffer-oriented textures; a canvas is top-down.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    if (this._stackTexW !== W || this._stackTexH !== H) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
      this._stackTexW = W
      this._stackTexH = H
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, c)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    this.stats.textureUploads++
    this.stats.textureUploadBytes += W * H * 4
    this._applyPostProcess(W, H, this._stackTex, {})
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly entityIds: Map<string, EntityId>,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      // The renderer never enables depth testing or stencil; clear is COLOR_BUFFER_BIT only.
      depth: false,
      stencil: false,
    })
    if (!gl) throw new Error('[WebGLRenderer] WebGL2 is not supported in this browser')
    this.gl = gl
    this.initGL()
    canvas.addEventListener?.('webglcontextlost', this.onContextLost)
    canvas.addEventListener?.('webglcontextrestored', this.onContextRestored)
  }

  // Without preventDefault the browser never restores a lost context.
  private onContextLost = (e: Event): void => e.preventDefault()

  // Every GL object died with the old context: rebuild programs and buffers,
  // drop texture caches (images are kept, so textures re-upload on demand).
  private onContextRestored = (): void => {
    this.initGL()
    this.textures.clear()
    this.textureLRU.clear()
    this.textureCache.clear()
    this.shapeTextures.clear()
    this.parallaxTextures.clear()
    this._layerImageTextures = new WeakMap()
    this._layerImageEntries.clear()
    // Post-process objects died with the context; they are rebuilt on the next post-process frame.
    this._ppBloomExtractProg = this._ppBlurProg = this._ppCompositeProg = null
    this._ppSceneFBO = this._ppBloomExtractFBO = this._ppBlurFBO1 = this._ppBlurFBO2 = null
    this._ppSceneTex = this._ppBloomExtractTex = this._ppBlurTex1 = this._ppBlurTex2 = null
    this._ppFBOW = this._ppFBOH = 0
    this._stackTex = null
    this._stackTexW = this._stackTexH = 0
    this._gradientTex.clear()
    this._shapes?.contextRestored()
    this._idleFBO = null
    this._idleTex = null
    this._idleFBOW = this._idleFBOH = 0
    this._prevSceneHash = -1
    const { gl } = this
    const restoreCallbacks: (() => void)[] = []
    for (const [id, entry] of this._dynamicCanvases) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      if (entry.canvas.width === 0 && entry.texW > 0) {
        // Released backing: the pixels are gone with the context; start blank and ask the app to repaint.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, entry.texW, entry.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        if (entry.onRestore) restoreCallbacks.push(entry.onRestore)
      } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, entry.canvas)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry.tex = tex
      if (entry.canvas.width > 0) {
        entry.texW = entry.canvas.width
        entry.texH = entry.canvas.height
      }
      entry.dirty = false
      this.textures.set(id, tex)
    }
    for (const cb of restoreCallbacks) cb()
    this._tileLayers?.contextRestored()
    this._spriteLayerRenderer?.contextRestored()
    this._textLayerRenderer?.contextRestored()
    this._textureRevision++
  }

  /** Free every GL resource and listener. The canvas can be reused afterwards. */
  dispose(): void {
    const { gl, canvas } = this
    canvas.removeEventListener?.('webglcontextlost', this.onContextLost)
    canvas.removeEventListener?.('webglcontextrestored', this.onContextRestored)
    this._disposed = true
    if (gl.isContextLost()) return
    for (const tex of this.textures.values()) gl.deleteTexture(tex)
    for (const tex of this.shapeTextures.values()) gl.deleteTexture(tex)
    for (const tex of this.parallaxTextures.values()) gl.deleteTexture(tex)
    for (const e of this.textureCache.values()) gl.deleteTexture(e.tex)
    for (const e of this._dynamicCanvases.values()) gl.deleteTexture(e.tex)
    gl.deleteTexture(this.whiteTexture)
    gl.deleteTexture(this.particleTextureSoft)
    gl.deleteTexture(this.particleTextureCircle)
    gl.deleteProgram(this.program)
    gl.deleteProgram(this.parallaxProgram)
    gl.deleteVertexArray(this.quadVAO)
    gl.deleteVertexArray(this.parallaxVAO)
    gl.deleteBuffer(this.instanceBuffer)
    if (this.quadBuf) gl.deleteBuffer(this.quadBuf)
    if (this.fullscreenBuf) gl.deleteBuffer(this.fullscreenBuf)
    for (const ref of this._layerImageEntries) {
      const t = ref.deref()
      if (t) gl.deleteTexture(t.tex)
    }
    this._layerImageEntries.clear()
    this._layerImageTextures = new WeakMap()
    for (const p of [this._ppBloomExtractProg, this._ppBlurProg, this._ppCompositeProg]) if (p) gl.deleteProgram(p)
    for (const fbo of [this._ppSceneFBO, this._ppBloomExtractFBO, this._ppBlurFBO1, this._ppBlurFBO2]) {
      if (fbo) gl.deleteFramebuffer(fbo)
    }
    for (const tex of [this._ppSceneTex, this._ppBloomExtractTex, this._ppBlurTex1, this._ppBlurTex2]) {
      if (tex) gl.deleteTexture(tex)
    }
    this._ppBloomExtractProg = this._ppBlurProg = this._ppCompositeProg = null
    this._ppSceneFBO = this._ppBloomExtractFBO = this._ppBlurFBO1 = this._ppBlurFBO2 = null
    this._ppSceneTex = this._ppBloomExtractTex = this._ppBlurTex1 = this._ppBlurTex2 = null
    this._ppFBOW = this._ppFBOH = 0
    if (this._idleFBO) gl.deleteFramebuffer(this._idleFBO)
    if (this._idleTex) gl.deleteTexture(this._idleTex)
    if (this._stackTex) gl.deleteTexture(this._stackTex)
    this._stackTex = null
    this._tileLayers?.dispose()
    this._spriteLayerRenderer?.dispose()
    this._textLayerRenderer?.dispose()
    this._shapes?.dispose()
    for (const e of this._gradientTex.values()) gl.deleteTexture(e.tex)
    this._gradientTex.clear()
    this._gpu?.dispose()
    this._gpuWanted = false
    this.textures.clear()
    this.shapeTextures.clear()
    this.parallaxTextures.clear()
    this.textureCache.clear()
    this._dynamicCanvases.clear()
    this.failedImages.clear()
  }

  private initGL(): void {
    const { gl } = this
    this.program = createProgram(gl, VERT_SRC, FRAG_SRC)

    // ── Unit quad geometry (6 vertices, 2 triangles) ──────────────────────────
    // Corners at (-0.5, -0.5) to (0.5, 0.5), UVs at (0,0) to (1,1)
    const quadVerts = new Float32Array([
      -0.5, -0.5, 0, 0, 0.5, -0.5, 1, 0, -0.5, 0.5, 0, 1, 0.5, -0.5, 1, 0, 0.5, 0.5, 1, 1, -0.5, 0.5, 0, 1,
    ])

    this.quadVAO = gl.createVertexArray()!
    gl.bindVertexArray(this.quadVAO)

    // Per-vertex buffer
    const quadBuf = (this.quadBuf = gl.createBuffer()!)
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW)

    const qStride = 4 * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, qStride, 0) // a_quadPos
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, qStride, 2 * 4) // a_uv

    // Per-instance buffer
    this.instanceBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW)

    const iStride = FLOATS_PER_INSTANCE * 4
    let byteOffset = 0
    const addAttr = (loc: number, size: number) => {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, iStride, byteOffset)
      gl.vertexAttribDivisor(loc, 1)
      byteOffset += size * 4
    }
    addAttr(2, 2) // i_pos
    addAttr(3, 2) // i_size
    addAttr(4, 1) // i_rot
    addAttr(5, 2) // i_anchor
    addAttr(6, 2) // i_offset
    addAttr(7, 1) // i_flipX
    addAttr(8, 1) // i_flipY
    addAttr(9, 4) // i_color
    addAttr(10, 4) // i_uvRect

    gl.bindVertexArray(null)

    // Cache uniform locations — sprite program
    gl.useProgram(this.program)
    this.uCamPos = gl.getUniformLocation(this.program, 'u_camPos')!
    this.uZoom = gl.getUniformLocation(this.program, 'u_zoom')!
    this.uCanvasSize = gl.getUniformLocation(this.program, 'u_canvasSize')!
    this.uShake = gl.getUniformLocation(this.program, 'u_shake')!
    this.uTexture = gl.getUniformLocation(this.program, 'u_texture')!
    this.uUseTexture = gl.getUniformLocation(this.program, 'u_useTexture')!
    this.uPremul = gl.getUniformLocation(this.program, 'u_premul')

    this.whiteTexture = createWhiteTexture(gl)
    this.particleTextureSoft = this._createParticleTexture('soft')
    this.particleTextureCircle = this._createParticleTexture('circle')

    // ── Parallax fullscreen quad ──────────────────────────────────────────────
    this.parallaxProgram = createProgram(gl, PARALLAX_VERT_SRC, PARALLAX_FRAG_SRC)

    // Fullscreen NDC quad (-1 to 1)
    const fsVerts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])

    this.parallaxVAO = gl.createVertexArray()!
    gl.bindVertexArray(this.parallaxVAO)

    const fsBuf = (this.fullscreenBuf = gl.createBuffer()!)
    gl.bindBuffer(gl.ARRAY_BUFFER, fsBuf)
    gl.bufferData(gl.ARRAY_BUFFER, fsVerts, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)

    gl.bindVertexArray(null)

    // Cache uniform locations — parallax program
    gl.useProgram(this.parallaxProgram)
    this.pUTexture = gl.getUniformLocation(this.parallaxProgram, 'u_texture')!
    this.pUUvOffset = gl.getUniformLocation(this.parallaxProgram, 'u_uvOffset')!
    this.pUTexSize = gl.getUniformLocation(this.parallaxProgram, 'u_texSize')!
    this.pUCanvasSize = gl.getUniformLocation(this.parallaxProgram, 'u_canvasSize')!

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  /** Pre-baked particle shape textures: white alpha mask, tinted by instance color at render time. */
  private _createParticleTexture(shape: 'soft' | 'circle'): WebGLTexture {
    const { gl } = this
    const SIZE = 64
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')!
    const cx = SIZE / 2

    if (shape === 'soft') {
      // Radial gradient: bright tight core fading to transparent — produces a glow halo with additive blending
      const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx)
      g.addColorStop(0, 'rgba(255,255,255,1)') // bright core
      g.addColorStop(0.25, 'rgba(255,255,255,0.9)') // tight solid region
      g.addColorStop(0.5, 'rgba(255,255,255,0.2)') // subtle halo
      g.addColorStop(1, 'rgba(255,255,255,0)') // transparent edge
      ctx.fillStyle = g
      ctx.fillRect(0, 0, SIZE, SIZE)
    } else {
      // Hard circle with 1px anti-aliased edge — no glow, just a clean disc
      ctx.fillStyle = 'white'
      ctx.beginPath()
      ctx.arc(cx, cx, cx - 1, 0, Math.PI * 2)
      ctx.fill()
    }

    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    this._statTex(tex, SIZE, SIZE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  // ── Texture management (sprite textures — CLAMP_TO_EDGE) ──────────────────

  private imageRecentlyFailed(imgSrc: string): boolean {
    const at = this.failedImages.get(imgSrc)
    if (at === undefined) return false
    if (performance.now() - at < IMAGE_RETRY_MS) return true
    this.failedImages.delete(imgSrc)
    return false
  }

  private loadTexture(src: string): WebGLTexture {
    const cached = this.textures.get(src)
    if (cached) {
      this.stats.textureCacheHits++
      this.touchTexture(src)
      return cached
    }
    this.stats.textureCacheMisses++

    // Strip :s=... sampling and :repeat suffixes used for cache keys — not part of the actual URL
    let imgSrc = src
    const sampIdx = imgSrc.indexOf(':s=')
    if (sampIdx !== -1) imgSrc = imgSrc.slice(0, sampIdx)
    if (imgSrc.endsWith(':repeat')) imgSrc = imgSrc.slice(0, -7)

    // A load that failed recently draws white and is not re-requested until the retry window passes.
    if (this.imageRecentlyFailed(imgSrc)) return this.whiteTexture

    // Check if this src is already loaded in imageCache (e.g. from fallback path)
    const existing = this.imageCache.get(imgSrc)
    if (existing && existing.complete && existing.naturalWidth > 0) {
      const gl = this.gl
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, existing)
      this._statTex(tex, existing.naturalWidth, existing.naturalHeight)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.textures.set(src, tex)
      this.touchTexture(src)
      this._textureRevision++
      return tex
    }

    // Return white while image loads; swap in real texture on load
    if (!existing) {
      const img = new Image()
      img.src = imgSrc
      const tiled = src.includes(':repeat')
      img.onload = () => {
        if (this._disposed) return
        const gl = this.gl
        const tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
        this._statTex(tex, img.naturalWidth, img.naturalHeight)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        const wrap = tiled ? gl.REPEAT : gl.CLAMP_TO_EDGE
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
        this.textures.set(src, tex)
        this.touchTexture(src)
        this._textureRevision++
      }
      img.onerror = () => {
        console.warn(`[WebGLRenderSystem] Failed to load image: ${imgSrc}`)
        this.imageCache.delete(imgSrc)
        this.failedImages.set(imgSrc, performance.now())
      }
      this.imageCache.set(imgSrc, img)
    }

    return this.whiteTexture
  }

  // ── Parallax texture management (REPEAT wrap mode) ────────────────────────

  private loadParallaxTexture(src: string): WebGLTexture | null {
    const cached = this.parallaxTextures.get(src)
    if (cached) return cached

    let img = this.parallaxImageCache.get(src)
    if (!img) {
      img = new Image()
      img.src = src
      img.onload = () => {
        if (this._disposed) return
        const gl = this.gl
        const tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img!)
        this._statTex(tex, img!.naturalWidth, img!.naturalHeight)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
        this.parallaxTextures.set(src, tex)
        this._textureRevision++
      }
      this.parallaxImageCache.set(src, img)
    }

    return null // not ready yet
  }

  // ── Text texture management ───────────────────────────────────────────────

  /** Raster scale (1, 2 or 4 texels per world px) for per-entity text, so zoomed text stays sharp. */
  private _textRasterScale(zoomDpr: number): number {
    return zoomDpr <= 1 ? 1 : zoomDpr <= 2 ? 2 : 4
  }

  private getOrCreateTextTexture(
    batcher: EntityTextBatcher,
    text: TextComponent,
    scale: number,
  ): { tex: WebGLTexture; w: number; h: number; ax: number; ay: number } | null {
    const key = batcher.rasterKey(text as never, scale)
    const cache = this.textureCache
    const cached = cache.get(key)
    if (cached) {
      this.stats.textCacheHits++
      cache.delete(key)
      cache.set(key, cached)
      cached.frame = this._frame
      return cached
    }
    this.stats.textCacheMisses++

    // Evict least-recently-used entries, never ones drawn this frame.
    if (cache.size >= MAX_TEXT_CACHE) {
      for (const [k, old] of cache) {
        if (cache.size < MAX_TEXT_CACHE) break
        if (old.frame === this._frame) break
        this.gl.deleteTexture(old.tex)
        this._statTexFree(old.tex)
        cache.delete(k)
      }
    }

    const r = batcher.raster(text as never, scale)
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, r.canvas)
    this._statTex(tex, r.w, r.h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const entry = { tex, w: r.w, h: r.h, ax: r.ax, ay: r.ay, frame: this._frame }
    this.textureCache.set(key, entry)
    return entry
  }

  // ── Shape texture generation ──────────────────────────────────────────────

  private getOrCreateShapeTexture(sprite: SpriteComponent): WebGLTexture {
    const key = getShapeKey(sprite)
    const cached = this.shapeTextures.get(key)
    if (cached) return cached

    const size = shapeTexSize(sprite.width, sprite.height)
    const offscreen = document.createElement('canvas')
    offscreen.width = size
    offscreen.height = size
    const ctx2d = offscreen.getContext('2d')!

    // Draw white shape — color tinting is handled by the instance color in the shader
    drawShapeOnCanvas(
      ctx2d,
      sprite.shape ?? 'rect',
      size,
      size,
      ((sprite.borderRadius ?? 0) / Math.max(sprite.width, sprite.height)) * size,
      sprite.starPoints ?? 5,
      sprite.starInnerRadius ?? 0.4,
    )
    ctx2d.fillStyle = '#ffffff'
    ctx2d.fill()

    if (sprite.strokeColor && (sprite.strokeWidth ?? 0) > 0) {
      ctx2d.strokeStyle = '#ffffff'
      ctx2d.lineWidth = ((sprite.strokeWidth ?? 0) / Math.max(sprite.width, sprite.height)) * size
      ctx2d.stroke()
    }

    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreen)
    this._statTex(tex, size, size)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    this.shapeTextures.set(key, tex)
    return tex
  }

  // ── Texture sampling helper ────────────────────────────────────────────────

  /** Apply min/mag filter params to the currently bound texture. */
  private applySampling(tex: WebGLTexture, spriteSampling?: Sampling): void {
    const { gl } = this
    const { min, mag } = resolveSampling(spriteSampling, this._defaultSampling)
    let st = this._texSampling.get(tex)
    if (!st) this._texSampling.set(tex, (st = { min: '', mag: '', mips: false, mipBytes: false }))
    // Mip chains are built once per texture content; parameters are set only when they change.
    if (needsMipmap(min) && !st.mips) {
      gl.generateMipmap(gl.TEXTURE_2D)
      st.mips = true
      // A full mip chain adds about a third on top of level 0.
      const base = this._texBytes.get(tex)
      if (base !== undefined && !st.mipBytes) {
        const extra = Math.floor(base / 3)
        this._texBytes.set(tex, base + extra)
        this.stats.textureBytes += extra
        st.mipBytes = true
      }
    }
    if (st.min !== min) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, toGLMinFilter(gl, min))
      st.min = min
    }
    if (st.mag !== mag) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, toGLMagFilter(gl, mag))
      st.mag = mag
    }
  }

  /** The pixels of `tex` changed: its mip chain (if any) is stale. */
  private markTextureStale(tex: WebGLTexture): void {
    const st = this._texSampling.get(tex)
    if (st) st.mips = false
  }

  // ── Blend mode helper ────────────────────────────────────────────────────

  private applyBlendMode(mode: string): void {
    const { gl } = this
    this.mulBlend = mode === 'multiply'
    switch (mode) {
      case 'additive':
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
        break
      case 'multiply':
        gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA)
        break
      case 'screen':
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR)
        break
      default: // 'normal'
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        break
    }
  }

  // ── Scene hash for idle frame skip ───────────────────────────────────────

  private _computeSceneHash(
    world: ECSWorld,
    camX: number,
    camY: number,
    zoom: number,
    shakeX: number,
    shakeY: number,
    background: string,
  ): number {
    return computeWebGLSceneHash({
      world,
      camX,
      camY,
      zoom,
      shakeX,
      shakeY,
      background,
      postProcessOptions: this._ppOptions,
      textureRevision: this._textureRevision,
      overlayRevision: this._overlayRevision,
      dynamicCanvases: this._dynamicCanvases,
    })
  }

  private _ensureIdleFBO(w: number, h: number): void {
    if (this._idleFBOW === w && this._idleFBOH === h && this._idleFBO) return
    const { gl } = this
    if (this._idleFBO) gl.deleteFramebuffer(this._idleFBO)
    if (this._idleTex) gl.deleteTexture(this._idleTex)
    this._statTexFree(this._idleTex)
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    this._statTex(tex, w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    this._idleFBO = fbo
    this._idleTex = tex
    this._idleFBOW = w
    this._idleFBOH = h
    this._prevSceneHash = -1
  }

  // ── Instanced draw call ────────────────────────────────────────────────────

  private flush(
    count: number,
    textureKey: string,
    sampling?: Sampling,
    blendMode?: string,
    shapeSpriteRef?: SpriteComponent,
  ): void {
    if (count === 0) return
    const { gl } = this
    if (blendMode && blendMode !== 'normal') this.applyBlendMode(blendMode)
    const isColor = textureKey.startsWith('__color__')
    const isShape = textureKey.startsWith('__shape__')
    let tex: WebGLTexture
    if (isShape && shapeSpriteRef) {
      tex = this.getOrCreateShapeTexture(shapeSpriteRef)
    } else if (isColor) {
      tex = this.whiteTexture
    } else {
      tex = this.loadTexture(textureKey)
    }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    this.applySampling(tex, sampling)
    // Shape textures need useTexture=1 so the alpha mask is applied via texture * color
    gl.uniform1i(this.uUseTexture, isColor ? 0 : 1)
    gl.uniform1f(this.uPremul, this.mulBlend ? 1 : 0)
    gl.bindVertexArray(this.quadVAO)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, count * FLOATS_PER_INSTANCE)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count)
    this.stats.drawCalls++
    this.stats.batches++
    this.stats.instances += count
    if (blendMode && blendMode !== 'normal') this.applyBlendMode('normal')
  }

  private flushWithTex(count: number, tex: WebGLTexture, useTexture: boolean): void {
    if (count === 0) return
    const { gl } = this
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(this.uUseTexture, useTexture ? 1 : 0)
    gl.uniform1f(this.uPremul, this.mulBlend ? 1 : 0)
    gl.bindVertexArray(this.quadVAO)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, count * FLOATS_PER_INSTANCE)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count)
    this.stats.drawCalls++
    this.stats.instances += count
  }

  // ── Write one sprite instance into instanceData ───────────────────────────

  private writeInstance(
    base: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rot: number,
    anchorX: number,
    anchorY: number,
    offsetX: number,
    offsetY: number,
    flipX: boolean,
    flipY: boolean,
    r: number,
    g: number,
    b: number,
    a: number,
    u: number,
    v: number,
    uw: number,
    vh: number,
  ): void {
    const d = this.instanceData
    d[base + 0] = x
    d[base + 1] = y
    d[base + 2] = w
    d[base + 3] = h
    d[base + 4] = rot
    d[base + 5] = anchorX
    d[base + 6] = anchorY
    d[base + 7] = offsetX
    d[base + 8] = offsetY
    d[base + 9] = flipX ? 1 : 0
    d[base + 10] = flipY ? 1 : 0
    d[base + 11] = r
    d[base + 12] = g
    d[base + 13] = b
    d[base + 14] = a
    d[base + 15] = u
    d[base + 16] = v
    d[base + 17] = uw
    d[base + 18] = vh
  }

  private startSpriteImageLoad(sprite: SpriteComponent): void {
    const src = sprite.src!
    let img = this.imageCache.get(src)
    if (!img) {
      // Sprites spawned after a failure (bullets, particles) must not each re-request the same 404.
      if (this.imageRecentlyFailed(src)) return
      const el = new Image()
      img = el
      el.src = src
      this.imageCache.set(src, el)
      el.onload = () => {
        if (this._disposed) return
        const gl = this.gl
        const tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el)
        this._statTex(tex, el.naturalWidth, el.naturalHeight)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        this.textures.set(el.src, tex)
        this.touchTexture(el.src)
      }
      el.onerror = () => {
        console.warn(`[WebGLRenderSystem] Failed to load image: ${src}`)
        this.imageCache.delete(src)
        this.failedImages.set(src, performance.now())
      }
    }
    sprite.image = img
  }

  private spriteTexInfo(sprite: SpriteComponent): SpriteTexInfo {
    let info = (sprite as SpriteWithInfo)._rinfo
    const tiled = !!(sprite.tileX || sprite.tileY)
    if (
      info === undefined ||
      info.image !== sprite.image ||
      info.src !== sprite.src ||
      info.dyn !== sprite.dynamicSrc ||
      info.sampling !== sprite.sampling ||
      info.tiled !== tiled ||
      (info.iw === 0 && info.color !== sprite.color) ||
      hasCustomShape(sprite)
    ) {
      info = {
        image: sprite.image,
        src: sprite.src,
        dyn: sprite.dynamicSrc,
        sampling: sprite.sampling,
        tiled,
        color: '',
        key: getTextureKey(sprite),
        rank: 0,
        epoch: -1,
        iw: 0,
        ih: 0,
        glKey: null,
        r: 1,
        g: 1,
        b: 1,
        a: 1,
      }
      this.refreshSpriteColor(info, sprite.color)
      if ((sprite as SpriteWithInfo)._rinfo === undefined)
        Object.defineProperty(sprite, '_rinfo', { value: info, writable: true, enumerable: false })
      else (sprite as SpriteWithInfo)._rinfo = info
    }
    if (info.iw === 0 && info.image && info.image.complete && info.image.naturalWidth > 0) {
      info.iw = info.image.naturalWidth
      info.ih = info.image.naturalHeight
      const src = info.image.src
      info.glKey = src ? (tiled ? `${src}:repeat` : src) : null
    }
    if (info.epoch !== this._texRankEpoch) {
      info.rank = this.textureRank(info.key)
      info.epoch = this._texRankEpoch
    }
    return info
  }

  private textureRank(key: string): number {
    let rank = this._texRankCache.get(key)
    if (rank === undefined) {
      if (this._texRankCache.size > 4096) {
        this._texRankCache.clear()
        this._texNextRank = 1
        this._texRankEpoch++
      }
      rank = this._texNextRank++
      this._texRankCache.set(key, rank)
    }
    return rank
  }

  /** One Circle / Line / Polygon (queued for the shape batch) or Gradient (drawn now) in sort order. */
  private drawVectorItem(
    shapes: ShapeRenderer,
    comp: CircleShapeComponent | LineShapeComponent | PolygonShapeComponent | GradientComponent,
    world: ECSWorld,
    id: EntityId,
    camX: number,
    camY: number,
    zoom: number,
    Wl: number,
    Hl: number,
  ): void {
    const t = world.getComponent<TransformComponent>(id, 'Transform')!
    switch (comp.type) {
      case 'CircleShape':
        shapes.circle(t.x, t.y, comp)
        return
      case 'LineShape':
        shapes.line(t.x, t.y, t.rotation, comp)
        return
      case 'PolygonShape':
        shapes.polygon(t.x, t.y, t.rotation, comp)
        return
    }
    // Gradient: baked once into a small texture, drawn as one quad.
    const g = comp as GradientComponent
    const reach = Math.hypot(g.width, g.height)
    if (
      t.x + reach < camX - Wl / (2 * zoom) ||
      t.x - reach > camX + Wl / (2 * zoom) ||
      t.y + reach < camY - Hl / (2 * zoom) ||
      t.y - reach > camY + Hl / (2 * zoom)
    )
      return
    shapes.flush()
    const key = shapes.gradientKey(g)
    let entry = this._gradientTex.get(g)
    if (!entry || entry.key !== key) {
      const canvas = shapes.bakeGradient(g)
      if (!canvas) return
      const { gl } = this
      let tex = entry?.tex
      if (!tex) {
        tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        this._statTex(tex, canvas.width, canvas.height)
      } else gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
      this._gradientTex.set(g, (entry = { key, tex }))
    }
    this.gl.useProgram(this.program)
    this.writeInstance(
      0,
      t.x,
      t.y,
      g.width,
      g.height,
      t.rotation,
      g.anchorX,
      g.anchorY,
      0,
      0,
      false,
      false,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
    )
    this.flushWithTex(1, entry.tex, true)
  }

  private drawSpriteLayer(layer: SpriteLayer, viewL: number, viewR: number, viewT: number, viewB: number): void {
    const cam = this._layerCam
    cam.viewL = viewL
    cam.viewR = viewR
    cam.viewT = viewT
    cam.viewB = viewB
    const r = (this._spriteLayerRenderer ??= spriteLayerRendererFactory()?.(this.gl) ?? null)
    if (!r) return
    r.drawCalls = 0
    r.instances = 0
    r.uploadBytes = 0
    r.draw(
      layer,
      cam,
      (i) => this.resolveLayerAtlas(layer.atlases[i]),
      this.whiteTexture,
      (i, tex) => this.applySampling(tex, layer.atlases[i].sampling ?? layer.sampling),
    )
    this.stats.drawCalls += r.drawCalls
    this.stats.batches += r.drawCalls
    this.stats.instances += r.instances
    r.record(this.stats.layers, layer)
    this.gl.useProgram(this.program)
  }

  private drawSortedTileLayer(layer: TileLayerData): void {
    const t = this._tileLayers!
    const before = t.stats.drawCalls
    t.drawSorted(layer)
    this.stats.drawCalls += t.stats.drawCalls - before
    t.fold(this.stats, this._texBytes.size, false)
    this.gl.useProgram(this.program)
  }

  private drawTextLayer(layer: TextLayer, viewL: number, viewR: number, viewT: number, viewB: number): void {
    const cam = this._layerCam
    cam.viewL = viewL
    cam.viewR = viewR
    cam.viewT = viewT
    cam.viewB = viewB
    if (!this._textLayerRenderer) {
      const r = textLayerRendererFactory()?.(this.gl) ?? null
      if (!r) return
      r.sink = {
        texture: (tex, w, h) => this._statTex(tex, w, h),
        free: (tex) => this._statTexFree(tex),
        upload: (bytes) => {
          this.stats.textureUploads++
          this.stats.textureUploadBytes += bytes
        },
      }
      this._textLayerRenderer = r
    }
    const r = this._textLayerRenderer
    r.drawCalls = 0
    r.instances = 0
    r.uploadBytes = 0
    r.draw(layer, cam)
    this.stats.drawCalls += r.drawCalls
    this.stats.batches += r.drawCalls
    this.stats.instances += r.instances
    if (r.drawCalls > 0) {
      const out = this.stats.layers
      const e = (this._textRows[out.length] ??= {
        kind: 'text',
        name: '',
        zIndex: 0,
        instances: 0,
        drawCalls: 0,
        uploadBytes: 0,
      })
      e.name = layer.layer
      e.zIndex = layer.zIndex
      e.instances = r.instances
      e.drawCalls = r.drawCalls
      e.uploadBytes = r.uploadBytes
      out.push(e)
    }
    this.gl.useProgram(this.program)
  }

  private drawTint(t: TintSlot, camX: number, camY: number, zoom: number, w: number, h: number): void {
    const { gl } = this
    gl.useProgram(this.program) // a vector-shape or layer draw may have left another program bound
    let r = t.r,
      g = t.g,
      b = t.b,
      a = t.a
    if (t.mode === 'multiply') {
      // dst * mix(1, color, a): fold strength into the colour, then DST_COLOR x ZERO.
      r = 1 - a + a * r
      g = 1 - a + a * g
      b = 1 - a + a * b
      a = 1
      gl.blendFunc(gl.DST_COLOR, gl.ZERO)
    } else if (t.mode === 'screen') {
      // src + dst * (1 - src) with the strength folded into the colour.
      r *= a
      g *= a
      b *= a
      a = 1
      this.applyBlendMode('screen')
    } else this.applyBlendMode(t.mode)
    // Oversized so shake never exposes an edge.
    this.writeInstance(
      0,
      camX,
      camY,
      (w / zoom) * 1.5,
      (h / zoom) * 1.5,
      0,
      0.5,
      0.5,
      0,
      0,
      false,
      false,
      r,
      g,
      b,
      a,
      0,
      0,
      1,
      1,
    )
    this.flushWithTex(1, this.whiteTexture, false)
    this.applyBlendMode('normal')
  }

  private resolveLayerAtlas(atlas: LayerAtlas): ResolvedAtlas | null {
    const out = this._resolvedAtlas
    if (atlas.dynamicSrc !== undefined) {
      const entry = this._dynamicCanvases.get(atlas.dynamicSrc)
      if (!entry) return null
      out.tex = entry.tex
      out.width = entry.texW
      out.height = entry.texH
      return out
    }
    if (atlas.image !== undefined) {
      const img = atlas.image
      const iw = (img as HTMLImageElement).naturalWidth ?? img.width
      const ih = (img as HTMLImageElement).naturalHeight ?? img.height
      if (!iw || !ih) return null
      const { gl } = this
      const ver = atlas.imageVersion ?? 0
      let t = this._layerImageTextures.get(img)
      if (!t) {
        const tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
        this._statTex(tex, iw, ih)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        t = { tex, ver, w: iw, h: ih }
        this._layerImageTextures.set(img, t)
        this._layerImageEntries.add(new WeakRef(t))
      } else if (t.ver !== ver || t.w !== iw || t.h !== ih) {
        // The source changed (markAtlasDirty) or was resized: upload it again.
        gl.bindTexture(gl.TEXTURE_2D, t.tex)
        this.markTextureStale(t.tex)
        if (t.w !== iw || t.h !== ih) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img)
        this.stats.textureUploads++
        this.stats.textureUploadBytes += iw * ih * 4
        this._statTexSize(t.tex, iw, ih)
        t.ver = ver
        t.w = iw
        t.h = ih
      }
      out.tex = t.tex
      out.width = iw
      out.height = ih
      return out
    }
    if (atlas.src !== undefined) {
      const tex = this.loadTexture(atlas.src)
      if (tex === this.whiteTexture) return null
      const img = this.imageCache.get(atlas.src)
      if (!img || !img.naturalWidth) return null
      out.tex = tex
      out.width = img.naturalWidth
      out.height = img.naturalHeight
      return out
    }
    return null
  }

  private refreshSpriteColor(info: SpriteTexInfo, color: string): void {
    const c = parseCSSColor(color)
    info.color = color
    info.r = c[0]
    info.g = c[1]
    info.b = c[2]
    info.a = c[3]
  }

  private ensureSpriteTexture(info: SpriteTexInfo, image: HTMLImageElement): void {
    const cacheKey = info.glKey!
    if (!this.textures.has(cacheKey)) {
      const gl = this.gl
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
      this._statTex(tex, info.iw, info.ih)
      this.stats.textureCacheMisses++
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      const wrap = info.tiled ? gl.REPEAT : gl.CLAMP_TO_EDGE
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
      this.textures.set(cacheKey, tex)
    } else this.stats.textureCacheHits++
    this.touchTexture(cacheKey)
  }

  // Returns renderable indices ordered by (layer, z, texture rank, index).
  // Reuses last frame's order when still valid; otherwise packs the key into
  // one float and uses the native typed-array sort.
  private sortVisible(m: number): Int32Array {
    const L = this._sortLayers
    const Z = this._sortZs
    const R = this._sortTexRanks
    let idx = this._sortOrder
    if (this._sortOrderLen === m) {
      let ok = true
      for (let i = 1; i < m; i++) {
        const a = idx[i - 1]
        const b = idx[i]
        const d = L[a] - L[b] || Z[a] - Z[b] || R[a] - R[b] || a - b
        if (d > 0) {
          ok = false
          break
        }
      }
      if (ok) return idx
    }
    if (idx.length < m) {
      idx = this._sortOrder = new Int32Array(Math.max(m, idx.length * 2))
      this._sortKeys = new Float64Array(idx.length)
    }
    this._sortOrderLen = m
    let lMin = Infinity,
      lMax = -Infinity,
      zMin = Infinity,
      zMax = -Infinity,
      rMax = 0,
      ints = true
    for (let i = 0; i < m; i++) {
      const l = L[i],
        z = Z[i]
      if (l < lMin) lMin = l
      if (l > lMax) lMax = l
      if (z < zMin) zMin = z
      if (z > zMax) zMax = z
      if (R[i] > rMax) rMax = R[i]
      if ((l | 0) !== l || (z | 0) !== z) ints = false
    }
    const lSpan = lMax - lMin + 1
    const zSpan = zMax - zMin + 1
    const rSpan = rMax + 1
    if (m > 0 && ints && lSpan * zSpan * rSpan * m < 2 ** 52) {
      const keys = this._sortKeys.subarray(0, m)
      for (let i = 0; i < m; i++) keys[i] = (((L[i] - lMin) * zSpan + (Z[i] - zMin)) * rSpan + R[i]) * m + i
      keys.sort()
      for (let i = 0; i < m; i++) idx[i] = keys[i] % m
    } else {
      const tmp = Array.from({ length: m }, (_, i) => i)
      tmp.sort((a, b) => L[a] - L[b] || Z[a] - Z[b] || R[a] - R[b] || a - b)
      for (let i = 0; i < m; i++) idx[i] = tmp[i]
    }
    return idx
  }

  // ── Main update loop ───────────────────────────────────────────────────────

  update(world: ECSWorld, dt: number): void {
    // Context loss (GPU reset, memory pressure, driver crash): browsers keep
    // the GL calls no-op'ing but spam warnings; without this guard the game
    // burns CPU rendering into a dead context every frame.
    if (this.gl.isContextLost()) {
      if (!this._contextLostWarned) {
        this._contextLostWarned = true
        console.error('[Xip] WebGL context lost. Rendering suspended until the context is restored.')
      }
      return
    }
    if (this._contextLostWarned) {
      this._contextLostWarned = false
      console.info('[Xip] WebGL context restored — resuming rendering.')
      this._tileLayers?.contextRestored()
      this._gpu?.contextRestored()
    }
    resetRenderFrameStats(this.stats)
    this._frame++
    this._time += dt
    // Intern component types once per frame — numeric IDs skip the string
    // hash on every per-entity getComponent below.
    const TID_Transform = world.typeId('Transform')
    const TID_Sprite = world.typeId('Sprite')
    const TID_Text = world.typeId('Text')
    const TID_Animator = world.typeId('Animator')
    const TID_AnimState = world.typeId('AnimationState')
    const TID_Squash = world.typeId('SquashStretch')
    const TID_ParticlePool = world.typeId('ParticlePool')
    const TID_Trail = world.typeId('Trail')
    const { gl, canvas } = this
    const W = canvas.width
    const H = canvas.height
    // Logical (CSS) dimensions — world coordinates are in CSS pixels, not physical pixels
    const Wl = canvas.clientWidth || W
    const Hl = canvas.clientHeight || H

    // ── Camera ──────────────────────────────────────────────────────────────
    let camX = 0,
      camY = 0,
      zoom = 1
    let background = this.defaultBackground
    let shakeX = 0,
      shakeY = 0

    const camId = world.queryOne('Camera2D')
    if (camId !== undefined) {
      const cam = world.getComponent<Camera2DComponent>(camId, 'Camera2D')!
      background = cam.background

      // A NaN/Infinity camera (set by hand, or poisoned earlier) would stay NaN for good: reset it.
      if (!Number.isFinite(cam.x)) cam.x = 0
      if (!Number.isFinite(cam.y)) cam.y = 0
      if (!(cam.zoom > 0) || !Number.isFinite(cam.zoom)) cam.zoom = 1
      let hasTarget = false
      let tx = 0
      let ty = 0
      if (hasPointOrSpriteFollow(cam)) {
        // followPoint > followSprite > followEntity; a missing target holds the camera
        if (resolveCameraFollowTarget(cam, followTarget)) {
          hasTarget = true
          tx = followTarget.x
          ty = followTarget.y
        }
      } else if (cam.followEntityId) {
        const targetId = this.entityIds.get(cam.followEntityId)
        const t = targetId !== undefined ? world.getComponent<TransformComponent>(targetId, 'Transform') : undefined
        if (t) {
          hasTarget = true
          tx = t.x
          ty = t.y
        }
      }
      if (hasTarget) {
        tx += cam.followOffsetX ?? 0
        ty += cam.followOffsetY ?? 0
        // A non-finite target (blown-up transform, bad offset) holds the camera instead of poisoning it.
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) hasTarget = false
      }
      if (hasTarget) {
        if (cam.deadZone) {
          const halfW = cam.deadZone.w / 2
          const halfH = cam.deadZone.h / 2
          const dx = tx - cam.x,
            dy = ty - cam.y
          if (dx > halfW) cam.x = tx - halfW
          else if (dx < -halfW) cam.x = tx + halfW
          if (dy > halfH) cam.y = ty - halfH
          else if (dy < -halfH) cam.y = ty + halfH
        } else if (cam.smoothing > 0) {
          const distSq = (tx - cam.x) ** 2 + (ty - cam.y) ** 2
          // Snap instantly when target teleports (>400px jump)
          if (distSq > 160000) {
            cam.x = tx
            cam.y = ty
          } else {
            // Same response as a per-frame lerp at 60 fps, at any frame rate.
            const k = 1 - Math.pow(cam.smoothing, dt * 60)
            cam.x += (tx - cam.x) * k
            cam.y += (ty - cam.y) * k
          }
        } else {
          cam.x = tx
          cam.y = ty
        }
      }

      if (cam.bounds) clampCameraToBounds(cam, Wl / (2 * cam.zoom), Hl / (2 * cam.zoom))

      if (cam.shakeTimer > 0) {
        cam.shakeTimer -= dt
        if (cam.shakeTimer < 0) cam.shakeTimer = 0
        const progress = cam.shakeDuration > 0 ? cam.shakeTimer / cam.shakeDuration : 0
        shakeX = (world.rng() * 2 - 1) * cam.shakeIntensity * progress
        shakeY = (world.rng() * 2 - 1) * cam.shakeIntensity * progress
      }

      camX = cam.x
      camY = cam.y
      zoom = cam.zoom
      if (cam.pixelSnap) {
        // Whole device pixels so pixel art does not shimmer while panning.
        const s = zoom * (W / Wl)
        camX = (W / 2 - Math.round(W / 2 - camX * s)) / s
        camY = (H / 2 - Math.round(H / 2 - camY * s)) / s
        const dpr = W / Wl
        shakeX = Math.round(shakeX * dpr) / dpr
        shakeY = Math.round(shakeY * dpr) / dpr
      }
    }

    // ── Animator evaluation pass (runs before animation so clips are resolved) ──
    for (const id of world.query('Animator', 'AnimationState')) {
      const animator = world.getComponent<AnimatorComponent>(id, TID_Animator)!
      const anim = world.getComponent<AnimationStateComponent>(id, TID_AnimState)!
      if (!animator.playing) continue

      // Ensure valid state
      if (!animator.states[animator.currentState]) {
        animator.currentState = animator.initialState
        animator._entered = false
      }

      const stateDef = animator.states[animator.currentState]
      if (!stateDef) continue

      // Enter state: set clip and fire onEnter
      if (!animator._entered) {
        anim.currentClip = stateDef.clip
        animator._entered = true
        stateDef.onEnter?.()
      }

      // Blend timer: count down and complete deferred state transition
      if (animator._blendTimer != null && animator._blendTimer > 0) {
        animator._blendTimer -= dt
        if (animator._blendTimer <= 0 && animator._blendToState) {
          stateDef.onExit?.()
          animator.currentState = animator._blendToState
          animator._entered = false
          animator._blendTimer = undefined
          animator._blendToState = undefined
        }
        // Skip evaluating new transitions while blending
      } else {
        // Evaluate transitions
        if (stateDef.transitions && stateDef.transitions.length > 0) {
          // Sorted by priority descending (cached per state definition —
          // re-sorting a fresh copy every frame per entity dominated animator cost).
          const sorted = this._sortedTransitions(stateDef)
          for (const trans of sorted) {
            // exitTime check
            if (trans.exitTime != null && anim.frames.length > 0) {
              const progress = anim.currentIndex / anim.frames.length
              if (progress < trans.exitTime) continue
            }
            // Evaluate all conditions (AND)
            if (evaluateConditions(trans.when, animator.params)) {
              if (trans.blendDuration && trans.blendDuration > 0) {
                // Deferred transition: old clip keeps playing during blend
                animator._blendTimer = trans.blendDuration
                animator._blendToState = trans.to
              } else {
                // Instant transition
                stateDef.onExit?.()
                animator.currentState = trans.to
                animator._entered = false
              }
              break
            }
          }
        }
      }
    }

    // ── Animation clip resolution + playback pass ─────────────────────────────
    for (const id of world.query('AnimationState', 'Sprite')) {
      const anim = world.getComponent<AnimationStateComponent>(id, TID_AnimState)!
      const sprite = world.getComponent<SpriteComponent>(id, TID_Sprite)!

      // Resolve named clip if changed
      if (anim.clips && anim.currentClip && anim._resolvedClip !== anim.currentClip) {
        const clip = anim.clips[anim.currentClip]
        if (clip) {
          resolveClip(anim, clip)
          anim._resolvedClip = anim.currentClip
        }
      }

      if (!anim.playing || anim.frames.length === 0) continue
      anim.timer += dt
      const frameDuration = 1 / anim.fps
      while (anim.timer >= frameDuration) {
        anim.timer -= frameDuration
        anim.currentIndex++
        if (anim.currentIndex >= anim.frames.length) {
          if (anim.loop) {
            anim.currentIndex = 0
          } else {
            anim.currentIndex = anim.frames.length - 1
            anim.playing = false
            if (anim.onComplete && !anim._completed) {
              anim._completed = true
              anim.onComplete()
            }
            // Auto-transition to next clip
            if (anim.clips && anim.currentClip) {
              const currentClipDef = anim.clips[anim.currentClip]
              if (currentClipDef?.next && anim.clips[currentClipDef.next]) {
                anim.currentClip = currentClipDef.next
                // Will be resolved next frame (or this frame via _resolvedClip check above)
              }
            }
          }
        }
        // Fire frame event for the new frame index (0-based position in frames array)
        anim.frameEvents?.[anim.currentIndex]?.()
      }
      sprite.frameIndex = anim.frames[anim.currentIndex]
    }

    // ── SquashStretch update ─────────────────────────────────────────────────
    for (const id of world.query('SquashStretch')) {
      const ss = world.getComponent<SquashStretchComponent>(id, TID_Squash)!
      let tScX: number
      let tScY: number

      if (ss._manualTargetX !== undefined && ss._manualTargetY !== undefined) {
        // Manual trigger takes priority; clear after reading so it only applies once
        tScX = ss._manualTargetX
        tScY = ss._manualTargetY
        ss._manualTargetX = undefined
        ss._manualTargetY = undefined
      } else {
        const rb = world.getComponent<RigidBodyShape>(id, 'RigidBody')
        const spd = rb ? Math.sqrt(rb.vx * rb.vx + rb.vy * rb.vy) : 0
        tScX = rb && rb.vy < -100 ? 1 + ss.intensity * 0.4 : spd > 50 ? 1 - ss.intensity * 0.3 : 1
        tScY = rb && rb.vy < -100 ? 1 - ss.intensity * 0.4 : spd > 50 ? 1 + ss.intensity * 0.3 : 1
      }

      ss.currentScaleX += (tScX - ss.currentScaleX) * ss.recovery * dt
      ss.currentScaleY += (tScY - ss.currentScaleY) * ss.recovery * dt
    }

    // ── Dynamic canvas re-uploads (texSubImage2D) ────────────────────────────
    // Only re-uploads canvases that have been marked dirty since the last frame.
    for (const entry of this._dynamicCanvases.values()) {
      if (!entry.dirty) continue
      // Released backing (0 x 0): nothing to upload until the app acquires and repaints it.
      if (entry.canvas.width === 0 || entry.canvas.height === 0) {
        entry.dirty = false
        continue
      }
      this.uploadDynamicCanvas(entry)
      if (entry.release) {
        entry.canvas.width = 0
        entry.canvas.height = 0
      }
    }

    if (!this._tileLayers) {
      const make = tileRendererFactory()
      if (make) this._tileLayers = make(gl, this.stats.tile)
    }
    if (this._tileLayers) {
      if (this._tileLayers.prepare(world, dt)) this._prevSceneHash = -1
      this._tileLayers.fold(this.stats, this._texBytes.size, true)
    }

    // ── Idle frame skip ───────────────────────────────────────────────────────
    // When enabled, hash visible entity state. If unchanged from last frame,
    // blit the cached scene FBO to screen and skip all GPU draw calls.
    if (this._spriteLayers.length > 0) {
      let v = 0
      for (const layer of this._spriteLayers)
        v += layer.version + (layer.visible ? 1 : 0) + layer.atlases.length + (layer.wind ? this._frame : 0)
      if (v !== this._spriteLayerVersion) {
        this._spriteLayerVersion = v
        this._overlayRevision++
      }
    }
    if (this._textLayers.length > 0) {
      let v = 0
      for (const layer of this._textLayers) v += layer.version + (layer.visible ? 1 : 0) + layer.opacity
      if (v !== this._textLayerVersion) {
        this._textLayerVersion = v
        this._overlayRevision++
      }
    }
    // Effects may animate, so a non-empty stack never takes the idle shortcut.
    if (this._idleSkip && !this.postProcessStack.size) {
      this._ensureIdleFBO(W, H)
      const hash = this._computeSceneHash(world, camX, camY, zoom, shakeX, shakeY, background)
      if (hash !== -1 && hash === this._prevSceneHash) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._idleFBO)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
        gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return
      }
      this._prevSceneHash = hash
    }

    // ── Post-process: redirect scene to off-screen FBO ────────────────────────
    this.stats.frames++
    this._gpu?.begin()
    const ppEnabled = this._anyPPEnabled
    if (ppEnabled) {
      this._ensurePPPrograms()
      this._ensurePPFBOs(W, H)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._ppSceneFBO)
    }

    // ── Clear ────────────────────────────────────────────────────────────────
    const [br, bg, bb] = parseCSSColor(background)
    gl.viewport(0, 0, W, H)
    gl.clearColor(br, bg, bb, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // ── Parallax pre-pass ─────────────────────────────────────────────────────
    const parallaxEntities = world.query('ParallaxLayer')
    if (parallaxEntities.length > 0) {
      parallaxEntities.sort((a: EntityId, b: EntityId) => {
        const za = world.getComponent<ParallaxLayerComponent>(a, 'ParallaxLayer')!.zIndex
        const zb = world.getComponent<ParallaxLayerComponent>(b, 'ParallaxLayer')!.zIndex
        return za - zb
      })

      gl.useProgram(this.parallaxProgram)
      gl.uniform2f(this.pUCanvasSize, W, H)
      gl.uniform1i(this.pUTexture, 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindVertexArray(this.parallaxVAO)

      for (const id of parallaxEntities) {
        const layer = world.getComponent<ParallaxLayerComponent>(id, 'ParallaxLayer')!

        // Keep imageWidth/imageHeight in sync with loaded image
        let img = this.parallaxImageCache.get(layer.src)
        if (!img) {
          this.loadParallaxTexture(layer.src)
          continue // not ready
        }
        if (!img.complete || img.naturalWidth === 0) continue
        if (layer.imageWidth === 0) layer.imageWidth = img.naturalWidth
        if (layer.imageHeight === 0) layer.imageHeight = img.naturalHeight

        const tex = this.parallaxTextures.get(layer.src)
        if (!tex) continue

        const imgW = layer.imageWidth
        const imgH = layer.imageHeight

        // Compute UV offset: how much to scroll the texture based on camera and layer settings
        const drawX = layer.offsetX - camX * layer.speedX
        const drawY = layer.offsetY - camY * layer.speedY
        const uvOffsetX = (((drawX / imgW) % 1) + 1) % 1
        const uvOffsetY = (((drawY / imgH) % 1) + 1) % 1

        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform2f(this.pUUvOffset, uvOffsetX, uvOffsetY)
        gl.uniform2f(this.pUTexSize, imgW, imgH)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        this.stats.drawCalls++
      }
    }

    if (this._tileLayers) {
      this._tileLayers.render(camX, camY, zoom, Wl, Hl, shakeX, shakeY, W / Wl)
      this.stats.drawCalls += this._tileLayers.stats.drawCalls
      this._tileLayers.fold(this.stats, this._texBytes.size, false)
    }

    // ── Upload camera uniforms for sprite program ──────────────────────────────
    gl.useProgram(this.program)
    gl.uniform2f(this.uCamPos, camX, camY)
    gl.uniform1f(this.uZoom, zoom)
    gl.uniform2f(this.uCanvasSize, Wl, Hl)
    gl.uniform2f(this.uShake, shakeX, shakeY)
    gl.uniform1i(this.uTexture, 0)
    {
      const lc = this._layerCam
      lc.x = camX
      lc.y = camY
      lc.zoom = zoom
      lc.width = Wl
      lc.height = Hl
      lc.shakeX = shakeX
      lc.shakeY = shakeY
      lc.time = this._time
      lc.dpr = W / Wl
    }
    gl.activeTexture(gl.TEXTURE0)

    // ── Sprites ───────────────────────────────────────────────────────────────
    // Frustum culling: pre-compute view bounds in world space (with 32px padding)
    const halfVW = (Wl * 0.5) / zoom
    const halfVH = (Hl * 0.5) / zoom
    const viewL = camX - halfVW - 32 / zoom
    const viewR = camX + halfVW + 32 / zoom
    const viewT = camY - halfVH - 32 / zoom
    const viewB = camY + halfVH + 32 / zoom

    // Text entities: batch plain text through the glyph atlas (layers join the sort below).
    let entityText = this._entityText
    if (!entityText && world.query('Transform', 'Text').length > 0) {
      const make = textEntityBatcherFactory()
      if (make) entityText = this._entityText = make()
    }
    entityText?.sync(world, zoom * (W / Wl))

    const renderableIds = world.query('Transform', 'Sprite')
    const n = renderableIds.length
    const visSprites = this._visSprites
    const visInfo = this._visInfo
    const sortLayers = this._sortLayers
    const sortZs = this._sortZs
    const sortTexRanks = this._sortTexRanks
    const layers = this._spriteLayers
    const tileSorted = this._tileLayers?.sorted ?? NO_TILE_LAYERS
    const nSprites = n + layers.length
    const nt = nSprites + tileSorted.length
    const textLayers = this._sortTextLayers
    textLayers.length = 0
    for (const l of this._textLayers) textLayers.push(l)
    if (entityText) for (const l of entityText.sortedLayers) textLayers.push(l)
    const ntt = nt + textLayers.length
    const sortedTints = this._sortedTints
    const nts = ntt + sortedTints.length // sorted tints sit between text layers and vector shapes
    // Vector shapes (Circle, Line, Polygon, Gradient) join the sort as one item each.
    const vecComps = this._vecComps
    const vecIds = this._vecIds
    vecComps.length = 0
    vecIds.length = 0
    for (const kind of ['CircleShape', 'LineShape', 'PolygonShape', 'Gradient']) {
      for (const id of world.query('Transform', kind)) {
        const c = world.getComponent<CircleShapeComponent>(id, kind)!
        if (!c.visible) continue
        if (kind === 'Gradient' && (c as unknown as GradientComponent).stops.length === 0) continue
        vecComps.push(c)
        vecIds.push(id)
      }
    }
    const nVec = vecComps.length
    let shapes: ShapeRenderer | null = null
    if (nVec > 0) {
      shapes = this._shapes ??= shapeRendererFactory()?.(gl) ?? null
      if (shapes) {
        const lc = this._layerCam
        lc.viewL = viewL
        lc.viewR = viewR
        lc.viewT = viewT
        lc.viewB = viewB
        shapes.begin(lc, zoom * (W / Wl))
      }
    }
    const m = nts + (shapes ? nVec : 0)
    for (let r = 0; r < n; r++) {
      const id = renderableIds[r]
      const sprite = world.getComponent<SpriteComponent>(id, TID_Sprite)!
      if (sprite.src && !sprite.image && sprite.visible) this.startSpriteImageLoad(sprite)
      const info = this.spriteTexInfo(sprite)
      visSprites[r] = sprite
      visInfo[r] = info
      this._visIds[r] = id
      sortLayers[r] = this.layers.getOrder(sprite.layer)
      sortZs[r] = sprite.zIndex
      sortTexRanks[r] = info.rank
    }

    for (let j = 0; j < layers.length; j++) {
      const layer = layers[j]
      const r = n + j
      sortLayers[r] = this.layers.getOrder(layer.layer)
      sortZs[r] = layer.zIndex
      sortTexRanks[r] = this.textureRank('__layer__')
    }
    for (let j = 0; j < tileSorted.length; j++) {
      const r = nSprites + j
      sortLayers[r] = this.layers.getOrder(tileSorted[j].renderLayer!)
      sortZs[r] = tileSorted[j].zIndex
      sortTexRanks[r] = 0
    }
    for (let j = 0; j < textLayers.length; j++) {
      const layer = textLayers[j]
      const r = nt + j
      sortLayers[r] = this.layers.getOrder(layer.layer)
      sortZs[r] = layer.zIndex
      sortTexRanks[r] = this.textureRank('__textlayer__')
    }
    // A tint sorts after everything at equal (layer, zIndex): rank above every texture rank this frame.
    for (let j = 0; j < sortedTints.length; j++) {
      const r = ntt + j
      sortLayers[r] = this.layers.getOrder(sortedTints[j].layer ?? 'default')
      sortZs[r] = sortedTints[j].zIndex ?? 0
      sortTexRanks[r] = this._texNextRank
    }
    if (shapes) {
      const vecRank = this.textureRank('__vector__')
      const defaultOrder = this.layers.getOrder('default')
      for (let j = 0; j < nVec; j++) {
        const r = nts + j
        sortLayers[r] = defaultOrder
        sortZs[r] = vecComps[j].zIndex
        sortTexRanks[r] = vecRank
      }
    }
    const sortIndices = this.sortVisible(m)

    const hasSquash = world.query('SquashStretch').length > 0
    let batchCount = 0
    let batchKey = ''
    let batchSampling: Sampling | undefined
    let batchBlendMode: string = 'normal'
    let batchShapeRef: SpriteComponent | undefined
    let ensuredKey: string | null = null

    for (let i = 0; i < m; i++) {
      const k = sortIndices[i]
      if (k >= n) {
        this.flush(batchCount, batchKey, batchSampling, batchBlendMode, batchShapeRef)
        batchCount = 0
        batchKey = ''
        ensuredKey = null
        if (k >= nts) {
          this.drawVectorItem(shapes!, vecComps[k - nts], world, vecIds[k - nts], camX, camY, zoom, Wl, Hl)
          continue
        }
        if (shapes !== null && shapes.pending) shapes.flush()
        if (k < nSprites) this.drawSpriteLayer(layers[k - n], viewL, viewR, viewT, viewB)
        else if (k < nt) this.drawSortedTileLayer(tileSorted[k - nSprites])
        else if (k < ntt) this.drawTextLayer(textLayers[k - nt], viewL, viewR, viewT, viewB)
        else this.drawTint(sortedTints[k - ntt], camX, camY, zoom, Wl, Hl)
        continue
      }
      if (shapes !== null && shapes.pending) {
        shapes.flush()
        gl.useProgram(this.program)
      }
      const sprite = visSprites[k]
      this.stats.spritesConsidered++
      if (!sprite.visible) continue
      const transform = world.getComponent<TransformComponent>(this._visIds[k], TID_Transform)!
      const scx = transform.x + sprite.offsetX
      const scy = transform.y + sprite.offsetY
      const shw = sprite.width * transform.scaleX * 0.5
      const shh = sprite.height * transform.scaleY * 0.5
      const sr = Math.sqrt(shw * shw + shh * shh)
      if (scx + sr < viewL || scx - sr > viewR || scy + sr < viewT || scy - sr > viewB) {
        this.stats.spritesCulled++
        continue
      }
      const info = visInfo[k]

      if (info.glKey !== null && info.glKey !== ensuredKey) {
        this.ensureSpriteTexture(info, sprite.image!)
        ensuredKey = info.glKey
      }

      const key = info.key
      const spriteBlend = sprite.blendMode ?? 'normal'
      if (((key !== batchKey || spriteBlend !== batchBlendMode) && batchCount > 0) || batchCount >= MAX_INSTANCES) {
        this.flush(batchCount, batchKey, batchSampling, batchBlendMode, batchShapeRef)
        batchCount = 0
      }
      batchKey = key
      batchSampling = sprite.sampling
      batchBlendMode = spriteBlend
      batchShapeRef = key.startsWith('__shape__') ? sprite : undefined

      let scaleXMod = 1
      let scaleYMod = 1
      if (hasSquash) {
        const ss = world.getComponent<SquashStretchComponent>(this._visIds[k], TID_Squash)
        if (ss) {
          scaleXMod = ss.currentScaleX
          scaleYMod = ss.currentScaleY
        }
      }
      const hasTexture = info.iw > 0 || (info.dyn !== undefined && this._dynamicCanvases.has(info.dyn))
      let r: number, g: number, b: number, a: number
      if (hasTexture) {
        r = g = b = a = 1
      } else {
        if (info.color !== sprite.color) this.refreshSpriteColor(info, sprite.color)
        r = info.r
        g = info.g
        b = info.b
        a = info.a
      }
      a *= sprite.opacity ?? 1
      if (sprite.tint && (sprite.tintOpacity ?? 0) > 0) {
        const [tr, tg, tb] = parseCSSColor(sprite.tint)
        const t = sprite.tintOpacity ?? 0.3
        r = r * (1 - t) + tr * t
        g = g * (1 - t) + tg * t
        b = b * (1 - t) + tb * t
      }
      writeUV(sprite, info.iw, info.ih)

      const d = this.instanceData
      const base = batchCount * FLOATS_PER_INSTANCE
      d[base] = transform.x
      d[base + 1] = transform.y
      d[base + 2] = sprite.width * transform.scaleX * scaleXMod
      d[base + 3] = sprite.height * transform.scaleY * scaleYMod
      d[base + 4] = transform.rotation
      d[base + 5] = sprite.anchorX
      d[base + 6] = sprite.anchorY
      d[base + 7] = sprite.offsetX
      d[base + 8] = sprite.offsetY
      d[base + 9] = sprite.flipX ? 1 : 0
      d[base + 10] = sprite.flipY ? 1 : 0
      d[base + 11] = r
      d[base + 12] = g
      d[base + 13] = b
      d[base + 14] = a
      d[base + 15] = uvScratch[0]
      d[base + 16] = uvScratch[1]
      d[base + 17] = uvScratch[2]
      d[base + 18] = uvScratch[3]
      batchCount++
    }
    this.flush(batchCount, batchKey, batchSampling, batchBlendMode, batchShapeRef)
    batchCount = 0
    if (shapes !== null) {
      shapes.flush()
      gl.useProgram(this.program)
      this.stats.drawCalls += shapes.drawCalls
      this.stats.batches += shapes.drawCalls
      this.stats.instances += shapes.instances
    }

    for (let ti = 0; ti < this._flatTints.length; ti++) this.drawTint(this._flatTints[ti], camX, camY, zoom, Wl, Hl)

    // ── Text rendering pass ───────────────────────────────────────────────────
    // Plain text was batched into glyph-atlas runs (one draw per page). Text the
    // atlas cannot lay out (complex scripts, maxWidth squeeze), or every Text
    // when the batcher is not bundled, goes through per-entity canvas textures.
    if (entityText) this.drawTextLayer(entityText.tail, viewL, viewR, viewT, viewB)
    const textEntities: EntityId[] = entityText ? entityText.fallback : []
    if (!entityText && !this._textWarned && world.query('Transform', 'Text').length > 0) {
      this._textWarned = true
      console.warn('[Xip] Text entities need createText() (or the <Text> component) to be drawn.')
    }
    const textScale = this._textRasterScale(zoom * (W / Wl))

    for (const id of textEntities) {
      const transform = world.getComponent<TransformComponent>(id, TID_Transform)!
      const text = world.getComponent<TextComponent>(id, TID_Text)!
      if (!text.visible) continue

      const entry = this.getOrCreateTextTexture(entityText!, text, textScale)
      if (!entry) continue

      // Flush any pending sprite batch first, then draw the text quad
      this.flush(batchCount, batchKey, batchSampling, batchBlendMode, batchShapeRef)
      batchCount = 0
      batchKey = ''
      batchSampling = undefined
      batchBlendMode = 'normal'
      batchShapeRef = undefined

      // One textured instance anchored at the text origin; colour is baked into the
      // texture, opacity is the vertex alpha so it never splits the cache.
      this.writeInstance(
        0,
        transform.x + text.offsetX,
        transform.y + text.offsetY,
        entry.w / textScale,
        entry.h / textScale,
        transform.rotation,
        entry.ax / entry.w,
        entry.ay / entry.h,
        0,
        0,
        false, // flipX
        false, // flipY
        1,
        1,
        1,
        text.opacity ?? 1,
        0,
        0,
        1,
        1,
      )
      this.flushWithTex(1, entry.tex, true)
    }

    // ── Particles ────────────────────────────────────────────────────────────
    for (const id of world.query('Transform', 'ParticlePool')) {
      const t = world.getComponent<TransformComponent>(id, TID_Transform)!
      const pool = world.getComponent<ParticlePoolComponent>(id, TID_ParticlePool)!

      // Global color transition
      if (pool.targetColor && pool._colorTransitionFrom !== undefined) {
        pool._colorTransitionElapsed = (pool._colorTransitionElapsed ?? 0) + dt
        const dur = pool.colorTransitionDuration ?? 0.5
        const ct = Math.min((pool._colorTransitionElapsed ?? 0) / dur, 1)
        const ease = ct * ct * (3 - 2 * ct)
        let parsed = this.colorTransitionCache.get(pool)
        if (!parsed || parsed.from !== pool._colorTransitionFrom || parsed.to !== pool.targetColor) {
          const [r0, g0, b0] = parseCSSColor(pool._colorTransitionFrom)
          const [r1, g1, b1] = parseCSSColor(pool.targetColor)
          parsed = { from: pool._colorTransitionFrom, to: pool.targetColor, r0, g0, b0, r1, g1, b1 }
          this.colorTransitionCache.set(pool, parsed)
        }
        const { r0: cr0, g0: cg0, b0: cb0, r1: cr1, g1: cg1, b1: cb1 } = parsed
        const ri = Math.round((cr0 + (cr1 - cr0) * ease) * 255)
        const gi = Math.round((cg0 + (cg1 - cg0) * ease) * 255)
        const bi = Math.round((cb0 + (cb1 - cb0) * ease) * 255)
        pool.color = `rgb(${ri},${gi},${bi})`
        if (ct >= 1) {
          pool._colorTransitionFrom = undefined
          pool._colorTransitionElapsed = undefined
        }
      }

      const isFormation = pool.mode === 'formation'

      // Update a single particle in place; returns whether it survives.
      // Defined once per pool per frame (not per particle) and applied via
      // an in-place compaction pass below — avoids both a per-particle
      // closure allocation and the fresh array `filter()` would allocate
      // every frame for every pool even when nothing expired.
      const updateParticle = (p: Particle): boolean => {
        if (isFormation) {
          // Seek toward formation target
          if (p.targetX !== undefined && p.targetY !== undefined) {
            const seek = pool.seekStrength ?? 0.055
            p.x += (p.targetX - p.x) * seek
            p.y += (p.targetY - p.y) * seek
          }
          // Attractor/repulsion: direct positional push applied after seek
          // so it visibly overrides the pull. strength < 0 = repulsion.
          if (pool.attractors) {
            for (const attr of pool.attractors) {
              const adx = p.x - attr.x
              const ady = p.y - attr.y
              const dist = Math.sqrt(adx * adx + ady * ady)
              if (dist < attr.radius && dist > 0) {
                const magnitude = -attr.strength * (1 - dist / attr.radius) * dt
                p.x += (adx / dist) * magnitude
                p.y += (ady / dist) * magnitude
              }
            }
          }
          return true // formation particles never expire
        }

        p.life -= dt
        // Attractor forces (supports negative strength = repulsion)
        if (pool.attractors) {
          for (const attr of pool.attractors) {
            const adx = attr.x - p.x
            const ady = attr.y - p.y
            const dist = Math.sqrt(adx * adx + ady * ady)
            if (dist < attr.radius && dist > 0) {
              const force = attr.strength * (1 - dist / attr.radius)
              p.vx += (adx / dist) * force * dt
              p.vy += (ady / dist) * force * dt
            }
          }
        }
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.vy += p.gravity * dt
        if (p.rotationSpeed !== undefined) p.rotation = (p.rotation ?? 0) + p.rotationSpeed * dt
        return p.life > 0
      }

      const particles = pool.particles
      let writeIdx = 0
      for (let readIdx = 0; readIdx < particles.length; readIdx++) {
        const p = particles[readIdx]
        if (updateParticle(p)) particles[writeIdx++] = p
      }
      particles.length = writeIdx

      // Emit new particles
      if (isFormation) {
        // Formation mode: spawn one persistent particle per formation point
        const fp = pool.formationPoints ?? []
        while (pool.particles.length < fp.length) {
          const idx = pool.particles.length
          const startSize = pool.sizeOverLife?.start ?? pool.particleSize
          const endSize = pool.sizeOverLife?.end ?? pool.particleSize
          pool.particles.push({
            x: t.x + (world.rng() - 0.5) * 20,
            y: t.y + (world.rng() - 0.5) * 20,
            vx: 0,
            vy: 0,
            life: 1,
            maxLife: 1,
            size: startSize,
            startSize,
            endSize,
            color: pool.color,
            gravity: 0,
            rotation: 0,
            targetX: fp[idx].x,
            targetY: fp[idx].y,
          })
        }
      } else if (pool.active && pool.particles.length < pool.maxParticles) {
        let spawnCount: number
        if (pool.burstCount != null && pool.burstCount > 0) {
          spawnCount = pool.burstCount
          pool.active = false
        } else {
          pool.timer += dt
          spawnCount = Math.floor(pool.timer * pool.rate)
          pool.timer -= spawnCount / pool.rate
        }
        for (let i = 0; i < spawnCount && pool.particles.length < pool.maxParticles; i++) {
          const angle = pool.angle + (world.rng() - 0.5) * pool.spread
          const speed = pool.speed * (0.5 + world.rng() * 0.5)
          let ox = 0
          let oy = 0
          const shape = pool.emitShape ?? 'point'
          if (shape === 'circle') {
            const r = (pool.emitRadius ?? 0) * Math.sqrt(world.rng())
            const a = world.rng() * Math.PI * 2
            ox = Math.cos(a) * r
            oy = Math.sin(a) * r
          } else if (shape === 'box') {
            ox = (world.rng() - 0.5) * (pool.emitWidth ?? 0)
            oy = (world.rng() - 0.5) * (pool.emitHeight ?? 0)
          }
          const startSize = pool.sizeOverLife?.start ?? pool.particleSize
          const endSize = pool.sizeOverLife?.end ?? pool.particleSize
          let rotSpeed: number | undefined
          if (pool.enableRotation && pool.rotationSpeedRange) {
            const [mn, mx] = pool.rotationSpeedRange
            rotSpeed = mn + world.rng() * (mx - mn)
          }
          pool.particles.push({
            x: t.x + ox,
            y: t.y + oy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: pool.particleLife,
            maxLife: pool.particleLife,
            size: startSize,
            startSize,
            endSize,
            color: pool.color,
            gravity: pool.gravity,
            rotation: pool.enableRotation ? world.rng() * Math.PI * 2 : 0,
            rotationSpeed: rotSpeed,
          })
        }
      }

      // Render particles — shape determined by pool.particleShape
      let pCount = 0
      const pShape = pool.particleShape ?? 'soft'
      const pBlend = pool.blendMode ?? 'normal'
      const flushParticles = (n: number) => {
        if (n === 0) return
        if (pBlend !== 'normal') this.applyBlendMode(pBlend)
        if (pShape === 'square') {
          this.flush(n, '__color__')
        } else {
          const tex = pShape === 'circle' ? this.particleTextureCircle : this.particleTextureSoft
          this.flushWithTex(n, tex, true)
        }
        if (pBlend !== 'normal') this.applyBlendMode('normal')
      }
      for (const p of pool.particles) {
        if (pCount >= MAX_INSTANCES) {
          flushParticles(pCount)
          pCount = 0
        }

        // Life fraction: 1 at spawn, 0 at death
        const lifeFrac = p.life / p.maxLife
        const alpha = lifeFrac

        // Size over life
        const sz =
          p.startSize !== undefined && p.endSize !== undefined
            ? p.endSize + (p.startSize - p.endSize) * lifeFrac
            : p.size

        // Color over life
        let r: number, g: number, b: number
        if (pool.colorOverLife && pool.colorOverLife.length >= 2) {
          const palette = pool.colorOverLife
          // lifeFrac goes 1→0, so index 0 = spawn color, last = death color
          const frac = 1 - lifeFrac
          const scaled = frac * (palette.length - 1)
          const lo = Math.floor(scaled)
          const hi = Math.min(lo + 1, palette.length - 1)
          const lf = scaled - lo
          const [r0, g0, b0] = parseCSSColor(palette[lo])
          const [r1, g1, b1] = parseCSSColor(palette[hi])
          r = r0 + (r1 - r0) * lf
          g = g0 + (g1 - g0) * lf
          b = b0 + (b1 - b0) * lf
        } else {
          ;[r, g, b] = parseCSSColor(p.color)
        }

        this.writeInstance(
          pCount * FLOATS_PER_INSTANCE,
          p.x,
          p.y,
          sz,
          sz,
          p.rotation ?? 0,
          0.5,
          0.5,
          0,
          0,
          false,
          false,
          r,
          g,
          b,
          alpha,
          0,
          0,
          1,
          1,
        )
        pCount++
      }
      if (pCount > 0) flushParticles(pCount)
    }

    // ── Trail update + render pass ────────────────────────────────────────────
    // All trails share one colour-only batch (same texture and blend), flushed once.
    let tCount = 0
    for (const id of world.query('Transform', 'Trail')) {
      const t = world.getComponent<TransformComponent>(id, TID_Transform)!
      const trail = world.getComponent<TrailComponent>(id, TID_Trail)!

      // Prepend current position
      trail.points.unshift({ x: t.x, y: t.y })
      // Trim to max length
      if (trail.points.length > trail.length) trail.points.length = trail.length

      if (trail.points.length < 1) continue

      const baseColor = parseCSSColor(trail.color)

      for (let i = 0; i < trail.points.length; i++) {
        if (tCount >= MAX_INSTANCES) {
          this.flush(tCount, '__color__')
          tCount = 0
        }

        // t=0 = newest (head), t=1 = oldest (tail)
        const frac = trail.points.length > 1 ? i / (trail.points.length - 1) : 0

        // Color: interpolate through colorOverLife palette or use base color
        let tr: number, tg: number, tb: number
        if (trail.colorOverLife && trail.colorOverLife.length >= 2) {
          const palette = trail.colorOverLife
          const scaled = frac * (palette.length - 1)
          const lo = Math.floor(scaled)
          const hi = Math.min(lo + 1, palette.length - 1)
          const lf = scaled - lo
          const [r0, g0, b0] = parseCSSColor(palette[lo])
          const [r1, g1, b1] = parseCSSColor(palette[hi])
          tr = r0 + (r1 - r0) * lf
          tg = g0 + (g1 - g0) * lf
          tb = b0 + (b1 - b0) * lf
        } else {
          ;[tr, tg, tb] = baseColor
        }

        // Width: interpolate widthOverLife or use flat width
        const segW = trail.widthOverLife
          ? trail.widthOverLife.start + (trail.widthOverLife.end - trail.widthOverLife.start) * frac
          : trail.width > 0
            ? trail.width
            : 1

        // Alpha fades from 1 (newest) to 0 (oldest)
        const alpha = 1 - frac

        this.writeInstance(
          tCount * FLOATS_PER_INSTANCE,
          trail.points[i].x,
          trail.points[i].y,
          segW,
          segW,
          0,
          0.5,
          0.5,
          0,
          0,
          false,
          false,
          tr,
          tg,
          tb,
          alpha,
          0,
          0,
          1,
          1,
        )
        tCount++
      }
    }
    if (tCount > 0) this.flush(tCount, '__color__')

    // ── Debug: nav grid overlay ──────────────────────────────────────────────
    if (this.debugNavGrid) {
      const g = this.debugNavGrid
      let ngCount = 0
      for (let row = 0; row < g.rows; row++) {
        for (let col = 0; col < g.cols; col++) {
          if (ngCount >= MAX_INSTANCES) {
            this.flush(ngCount, '__color__')
            ngCount = 0
          }
          const walkable = g.walkable[row * g.cols + col]
          const cx = col * g.cellSize + g.cellSize / 2
          const cy = row * g.cellSize + g.cellSize / 2
          this.writeInstance(
            ngCount * FLOATS_PER_INSTANCE,
            cx,
            cy,
            g.cellSize,
            g.cellSize,
            0,
            0.5,
            0.5,
            0,
            0,
            false,
            false,
            walkable ? 0 : 1,
            walkable ? 1 : 0,
            0,
            walkable ? 0.08 : 0.25,
            0,
            0,
            1,
            1,
          )
          ngCount++
        }
      }
      if (ngCount > 0) this.flush(ngCount, '__color__')
    }

    // ── Debug: contact flash points ──────────────────────────────────────────
    if (this.contactFlashPoints.length > 0) {
      let cfCount = 0
      for (const pt of this.contactFlashPoints) {
        if (cfCount >= MAX_INSTANCES) {
          this.flush(cfCount, '__color__')
          cfCount = 0
        }
        this.writeInstance(
          cfCount * FLOATS_PER_INSTANCE,
          pt.x,
          pt.y,
          8,
          8,
          0,
          0.5,
          0.5,
          0,
          0,
          false,
          false,
          1,
          0.3,
          0.3,
          0.9,
          0,
          0,
          1,
          1,
        )
        cfCount++
        pt.ttl--
      }
      if (cfCount > 0) this.flush(cfCount, '__color__')
      this.contactFlashPoints = this.contactFlashPoints.filter((p) => p.ttl > 0)
    }

    // ── Entity highlight (DevTools inspector selection) ──────────────────────
    if (this._highlightEntityId !== null) {
      const ht = world.getComponent<TransformComponent>(this._highlightEntityId, 'Transform')
      if (ht) {
        const hBox = world.getComponent<{
          type: string
          width: number
          height: number
          offsetX?: number
          offsetY?: number
        }>(this._highlightEntityId, 'BoxCollider')
        const hCirc = world.getComponent<{ type: string; radius: number; offsetX?: number; offsetY?: number }>(
          this._highlightEntityId,
          'CircleCollider',
        )
        const hCap = world.getComponent<{
          type: string
          width: number
          height: number
          offsetX?: number
          offsetY?: number
        }>(this._highlightEntityId, 'CapsuleCollider')
        const col = hBox ?? hCap
        const hox = col?.offsetX ?? hCirc?.offsetX ?? 0
        const hoy = col?.offsetY ?? hCirc?.offsetY ?? 0
        const hx = ht.x + hox
        const hy = ht.y + hoy
        const hw = col ? col.width : hCirc ? hCirc.radius * 2 : 32
        const hh = col ? col.height : hCirc ? hCirc.radius * 2 : 32
        const rot = ht.rotation
        const lw = 2 / zoom // 2 screen-pixels in world units

        // Draw 4 thin rects forming an outline box
        const outlines: [number, number, number, number][] = [
          [hx, hy - hh / 2 - lw / 2, hw + lw * 2, lw], // top
          [hx, hy + hh / 2 + lw / 2, hw + lw * 2, lw], // bottom
          [hx - hw / 2 - lw / 2, hy, lw, hh], // left
          [hx + hw / 2 + lw / 2, hy, lw, hh], // right
        ]
        for (let oi = 0; oi < outlines.length; oi++) {
          const [ox, oy, ow, oh] = outlines[oi]
          this.writeInstance(
            oi * FLOATS_PER_INSTANCE,
            ox,
            oy,
            ow,
            oh,
            rot,
            0.5,
            0.5,
            0,
            0,
            false,
            false,
            1,
            0.9,
            0.1,
            0.9,
            0,
            0,
            1,
            1,
          )
        }
        this.flush(4, '__color__')
      }
    }

    // ── Post-process: apply effects on top of scene FBO ─────────────────────
    if (ppEnabled) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      this._applyPostProcess(W, H)
    }

    // ── Canvas2D-style effect stack (usePostProcess) ──────────────────────────
    if (this.postProcessStack.size) this._applyEffectStack(W, H, dt)

    // ── Idle frame skip: copy final composited frame to idle cache FBO ────────
    // Stored post-PP so idle frames can blit the correct final image.
    if (this._idleSkip && this._idleFBO) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._idleFBO)
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }

    this._gpu?.end()

    // ── FPS tracking ─────────────────────────────────────────────────────────
    const now = performance.now()
    if (this.lastTimestamp > 0) {
      this.frameTimes.push(now - this.lastTimestamp)
      if (this.frameTimes.length > 60) this.frameTimes.shift()
    }
    this.lastTimestamp = now
  }
}

// ── Animation helpers ──────────────────────────────────────────────────────

function resolveClip(anim: AnimationStateComponent, clip: AnimationClipDefinition): void {
  anim.frames = clip.frames
  anim.fps = clip.fps ?? 12
  anim.loop = clip.loop ?? true
  anim.onComplete = clip.onComplete
  anim.frameEvents = clip.frameEvents
  anim.currentIndex = 0
  anim.timer = 0
  anim._completed = false
  anim.playing = true
}

function evaluateConditions(conditions: AnimatorCondition[], params: Record<string, unknown>): boolean {
  for (const cond of conditions) {
    const val = params[cond.param]
    if (val === undefined) return false
    switch (cond.op) {
      case '==':
        if (val !== cond.value) return false
        break
      case '!=':
        if (val === cond.value) return false
        break
      case '>':
        if ((val as number) <= (cond.value as number)) return false
        break
      case '>=':
        if ((val as number) < (cond.value as number)) return false
        break
      case '<':
        if ((val as number) >= (cond.value as number)) return false
        break
      case '<=':
        if ((val as number) > (cond.value as number)) return false
        break
    }
  }
  return true
}
