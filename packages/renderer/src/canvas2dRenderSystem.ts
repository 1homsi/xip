// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  CANVAS2D GAME RENDERER — fallback for browsers without WebGL2          ║
// ║                                                                          ║
// ║  Draws the same scene as webglRenderSystem.ts (parallax, tile layers,    ║
// ║  sprites and SpriteLayers in one sorted pass, screen tint, text,         ║
// ║  particles, trails) onto a 2D canvas. <Game> loads it lazily when WebGL2 ║
// ║  is unavailable or `renderer="canvas2d"` is set; it is not part of the   ║
// ║  main bundle. Unsupported: post-process effects, idle frame skip.        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import type { System, ECSWorld, EntityId, NavGrid, RenderStats, TransformComponent } from '@xip/core'
import type { PostProcessOptions } from './webglRenderSystem'
import type { SpriteComponent, BlendMode } from './components/sprite'
import type { SquashStretchComponent } from './components/squashStretch'
import type { ParticlePoolComponent } from './components/particle'
import type { ParallaxLayerComponent } from './components/parallaxLayer'
import type { TextComponent } from './components/text'
import type { TrailComponent } from './components/trail'
import type { TileLayerComponent, TileLayerData } from './tileLayer'
import type { SpriteLayer, LayerAtlas } from './spriteLayer'
import type { TextLayer } from './textLayer'
import { createDynamicCanvasHandle, type DynamicCanvasOptions, type ManagedDynamicCanvas } from './dynamicCanvas'
import { parseCSSColor } from './colorParser'
import { createPostProcessStack, type PostProcessStack } from './postProcess'
import { createRenderLayerManager, type RenderLayerManager } from './renderLayers'
import type { Sampling } from './textureFilter'
import { StyledTileLayerCanvasRenderer } from './tileLayerCanvasStyled'
import { SpriteLayerCanvasRenderer, type LayerSource, type WorldBase } from './spriteLayerCanvas2D'
import { TextLayerCanvasRenderer } from './textLayerCanvas2D'
import { TintCache } from './canvas2dTint'
import { traceShape } from './shapePaths'
import { updateCamera, updateAnimation, updateParticlePool, updateTrail, type CameraFrame } from './frameSim'

const COMPOSITE: Record<string, GlobalCompositeOperation> = {
  additive: 'lighter',
  multiply: 'multiply',
  screen: 'screen',
}

/** Zeroed counters. Written out here so this lazy chunk shares no module with the main bundle. */
export function createCanvas2DStats(): RenderStats {
  return {
    drawCalls: 0,
    instances: 0,
    batches: 0,
    spritesConsidered: 0,
    spritesCulled: 0,
    textureUploads: 0,
    textureUploadBytes: 0,
    textureCount: 0,
    textureBytes: 0,
    textCacheHits: 0,
    textCacheMisses: 0,
    textureCacheHits: 0,
    textureCacheMisses: 0,
    frames: 0,
    gpuMs: null,
    gpuMsAvg: null,
    gpuTimerSupported: null,
    softwareRenderer: null,
    layers: [],
    tile: {
      indexUploads: 0,
      uploadedTexels: 0,
      lutUploads: 0,
      drawCalls: 0,
      textureUploads: 0,
      textureUploadBytes: 0,
      textureCount: 0,
      textureBytes: 0,
    },
  }
}

/** Whether a sampling mode magnifies with bilinear filtering (nearest otherwise). */
function smoothFor(sprite: Sampling | undefined, fallback: Sampling): boolean {
  const s = sprite ?? fallback
  return typeof s === 'string' ? s.startsWith('linear') : s.mag === 'linear'
}

const SOFT_SIZE = 64

function createSoftParticle(): HTMLCanvasElement | OffscreenCanvas {
  const c: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(SOFT_SIZE, SOFT_SIZE)
      : document.createElement('canvas')
  c.width = SOFT_SIZE
  c.height = SOFT_SIZE
  const g = c.getContext('2d') as CanvasRenderingContext2D
  const h = SOFT_SIZE / 2
  // Same falloff as the WebGL particle texture: bright core, soft halo.
  const grad = g.createRadialGradient(h, h, 0, h, h, h)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,0.9)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.2)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, SOFT_SIZE, SOFT_SIZE)
  return c
}

function rgb8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

/** Where the loaded pixels of a sprite come from. */
interface SpriteSource {
  image: CanvasImageSource
  width: number
  height: number
}

/**
 * Canvas2D render system with the same public surface the engine hooks use on
 * the WebGL one (`setScreenTint`, `addSpriteLayer`, dynamic canvases, stats).
 */
export class Canvas2DRenderSystem implements System {
  /** GPU timing needs a GL timer query; the Canvas2D renderer has none, so asking for it is a no-op that reports unsupported. */
  setGpuTiming(_enabled: boolean): Promise<boolean> {
    return Promise.resolve(false)
  }

  /** Default background used when no Camera2D component exists */
  defaultBackground = '#1a1a2e'
  readonly layers: RenderLayerManager = createRenderLayerManager()
  /** Live counters, mutated in place each frame. */
  readonly stats: RenderStats = createCanvas2DStats()
  /** Effects run on the finished frame (`usePostProcess`). */
  readonly postProcessStack: PostProcessStack = createPostProcessStack()

  private readonly ctx: CanvasRenderingContext2D
  private readonly tints = new TintCache()
  private readonly tileRenderer = new StyledTileLayerCanvasRenderer()
  private readonly spriteLayerRenderer = new SpriteLayerCanvasRenderer(this.tints)
  private readonly textLayerRenderer = new TextLayerCanvasRenderer(this.tints)
  private readonly images = new Map<string, HTMLImageElement>()
  private readonly parallaxImages = new Map<string, HTMLImageElement>()
  private readonly dynamicCanvases = new Map<string, HTMLCanvasElement | OffscreenCanvas>()
  private readonly spriteLayers: SpriteLayer[] = []
  private readonly textLayers: TextLayer[] = []
  /** Tile layers with a `renderLayer`: they take part in the shared sprite sort. */
  private readonly tileSorted: TileLayerData[] = []
  private readonly tileView = { L: 0, T: 0, R: 0, B: 0 }
  private readonly screenTint = { r: 1, g: 1, b: 1, a: 0, mode: 'multiply' as 'multiply' | 'normal' | 'additive' }
  private defaultSampling: Sampling = 'nearest'
  private readonly cam: CameraFrame = { x: 0, y: 0, zoom: 1, background: '', shakeX: 0, shakeY: 0 }
  private readonly base: WorldBase = { s: 1, tx: 0, ty: 0 }
  private softParticle: HTMLCanvasElement | OffscreenCanvas | null = null
  private time = 0
  private warnedPostProcess = false
  private frame = 0

  // Draw-state shadows so unchanged state is not re-set per sprite.
  private alpha = 1
  private op: GlobalCompositeOperation = 'source-over'
  private smooth = false

  // Sort scratch, reused across frames.
  private sortIdx: number[] = []
  private readonly sortLayer: number[] = []
  private readonly sortZ: number[] = []
  /** 0 for tile layers so they draw before sprites at equal (layer, z), as on WebGL. */
  private readonly sortKind: number[] = []

  private debugNavGrid: NavGrid | null = null
  private contactFlashPoints: { x: number; y: number; ttl: number }[] = []
  private highlightEntityId: number | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly entityIds: Map<string, EntityId>,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('[Canvas2DRenderer] Canvas 2D is not available')
    this.ctx = ctx
  }

  // ── Public surface shared with the WebGL render system ──────────────────

  getStats(): RenderStats {
    return this.stats
  }

  /** Per-frame TileLayer counters (chunk redraws stand in for uploads). */
  get tileLayerStats() {
    const s = this.tileRenderer.stats
    return { indexUploads: s.chunkRedraws, uploadedTexels: 0, lutUploads: 0, drawCalls: s.chunksDrawn }
  }

  setDefaultSampling(sampling: Sampling): void {
    this.defaultSampling = sampling
  }

  getDefaultSampling(): Sampling {
    return this.defaultSampling
  }

  /** Post-process effects need WebGL: warns once instead of silently doing nothing. */
  setPostProcessOptions(opts: PostProcessOptions): void {
    const on = Object.values(opts).some((o) => o && (o as { enabled?: boolean }).enabled)
    if (on && !this.warnedPostProcess) {
      this.warnedPostProcess = true
      console.warn('[Xip] Post-process effects are not supported by the Canvas2D renderer and are ignored.')
    }
  }

  /** Accepted for API parity; every frame is drawn (Canvas2D has no cached scene to blit). */
  setIdleFrameSkip(_enabled: boolean): void {}

  /** Tint the whole view after sprites and layers, before text. `a` is the strength (0 = off). */
  setScreenTint(
    r: number,
    g: number,
    b: number,
    a: number,
    mode: 'multiply' | 'normal' | 'additive' = 'multiply',
  ): void {
    const t = this.screenTint
    t.r = r
    t.g = g
    t.b = b
    t.a = a
    t.mode = mode
  }

  clearScreenTint(): void {
    this.setScreenTint(1, 1, 1, 0)
  }

  addSpriteLayer(layer: SpriteLayer): void {
    if (!this.spriteLayers.includes(layer)) this.spriteLayers.push(layer)
  }

  removeSpriteLayer(layer: SpriteLayer): void {
    const i = this.spriteLayers.indexOf(layer)
    if (i >= 0) this.spriteLayers.splice(i, 1)
  }

  addTextLayer(layer: TextLayer): void {
    if (!this.textLayers.includes(layer)) this.textLayers.push(layer)
  }

  removeTextLayer(layer: TextLayer): void {
    const i = this.textLayers.indexOf(layer)
    if (i >= 0) this.textLayers.splice(i, 1)
  }

  hasDynamicCanvas(id: string): boolean {
    return this.dynamicCanvases.has(id)
  }

  dynamicCanvasIds(): string[] {
    return [...this.dynamicCanvases.keys()]
  }

  /** Create a dynamic canvas by id at runtime (resizable, disposable). See {@link ManagedDynamicCanvas}. */
  createDynamicCanvas(opts: DynamicCanvasOptions): ManagedDynamicCanvas {
    return createDynamicCanvasHandle(this, opts)
  }

  /** The canvas is drawn live every frame, so there is nothing to upload. */
  registerDynamicCanvas(id: string, canvas: HTMLCanvasElement | OffscreenCanvas): void {
    this.dynamicCanvases.set(id, canvas)
  }

  markDynamicCanvasDirty(_id: string, _x?: number, _y?: number, _w?: number, _h?: number): void {}

  unregisterDynamicCanvas(id: string): void {
    this.dynamicCanvases.delete(id)
  }

  setDebugNavGrid(grid: NavGrid | null): void {
    this.debugNavGrid = grid
  }

  flashContactPoint(x: number, y: number): void {
    this.contactFlashPoints.push({ x, y, ttl: 1 })
  }

  setEntityHighlight(id: number | null): void {
    this.highlightEntityId = id
  }

  dispose(): void {
    this.tints.clear()
    this.images.clear()
    this.parallaxImages.clear()
    this.dynamicCanvases.clear()
    this.spriteLayers.length = 0
    this.textLayers.length = 0
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  update(world: ECSWorld, dt: number): void {
    const { ctx, canvas, stats } = this
    stats.drawCalls = stats.instances = stats.batches = 0
    stats.spritesConsidered = stats.spritesCulled = stats.textureUploads = stats.textureUploadBytes = 0
    stats.frames++
    this.frame++
    this.time += dt
    const W = canvas.width
    const H = canvas.height
    // World units are CSS pixels; the backing store may be larger on HiDPI screens.
    const Wl = canvas.clientWidth || W
    const Hl = canvas.clientHeight || H
    const dpr = W / Wl

    const cam = this.cam
    updateCamera(world, this.entityIds, dt, W, H, Wl, Hl, this.defaultBackground, cam)
    updateAnimation(world, dt)

    const s = cam.zoom * dpr
    const base = this.base
    base.s = s
    base.tx = W / 2 - cam.x * s + cam.shakeX * dpr
    base.ty = H / 2 - cam.y * s + cam.shakeY * dpr

    // ── Clear ──────────────────────────────────────────────────────────────
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.alpha = 1
    this.op = 'source-over'
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    const [br, bg, bb] = parseCSSColor(cam.background)
    ctx.fillStyle = `rgb(${rgb8(br)},${rgb8(bg)},${rgb8(bb)})`
    ctx.fillRect(0, 0, W, H)

    this.drawParallax(world, cam, W, H, dpr)

    // ── Tile layers (under every sprite, like the WebGL path) ──────────────
    const halfW = Wl / (2 * cam.zoom)
    const halfH = Hl / (2 * cam.zoom)
    const vcx = cam.x - cam.shakeX / cam.zoom
    const vcy = cam.y - cam.shakeY / cam.zoom
    this.drawTileLayers(world, vcx - halfW, vcy - halfH, vcx + halfW, vcy + halfH)

    // ── Sprites and SpriteLayers, sorted together ──────────────────────────
    ctx.setTransform(s, 0, 0, s, base.tx, base.ty)
    this.drawSprites(world, cam.x, cam.y, halfW, halfH, cam.zoom)

    // ── Screen tint ───────────────────────────────────────────────────────
    if (this.screenTint.a > 0) this.drawScreenTint(W, H)

    ctx.setTransform(s, 0, 0, s, base.tx, base.ty)
    this.drawText(world)
    this.drawParticles(world, dt)
    this.drawTrails(world)
    this.drawDebug(world, cam.zoom)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.setAlpha(1)
    this.setOp('source-over')
    if (this.postProcessStack.size) this.postProcessStack.apply(ctx, W, H, dt)
  }

  // ── State helpers ────────────────────────────────────────────────────────

  private setAlpha(a: number): void {
    if (a !== this.alpha) {
      this.ctx.globalAlpha = a
      this.alpha = a
    }
  }

  private setOp(op: GlobalCompositeOperation): void {
    if (op !== this.op) {
      this.ctx.globalCompositeOperation = op
      this.op = op
    }
  }

  private setSmooth(on: boolean): void {
    if (on !== this.smooth) {
      this.ctx.imageSmoothingEnabled = on
      this.smooth = on
    }
  }

  private loadImage(cache: Map<string, HTMLImageElement>, src: string): HTMLImageElement {
    let img = cache.get(src)
    if (!img) {
      img = new Image()
      const el = img
      el.onerror = () => {
        console.warn(`[Canvas2DRenderer] Failed to load image: ${src}`)
        cache.delete(src)
      }
      el.src = src
      cache.set(src, el)
    }
    return img
  }

  // ── Parallax ─────────────────────────────────────────────────────────────

  private drawParallax(world: ECSWorld, cam: CameraFrame, W: number, H: number, dpr: number): void {
    const ids = world.query('ParallaxLayer')
    if (ids.length === 0) return
    const { ctx } = this
    const layers = ids.map((id) => world.getComponent<ParallaxLayerComponent>(id, 'ParallaxLayer')!)
    layers.sort((a, b) => a.zIndex - b.zIndex)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.setSmooth(false)
    for (const layer of layers) {
      const img = this.loadImage(this.parallaxImages, layer.src)
      if (!img.complete || img.naturalWidth === 0) continue
      if (layer.imageWidth === 0) layer.imageWidth = img.naturalWidth
      if (layer.imageHeight === 0) layer.imageHeight = img.naturalHeight
      const iw = layer.imageWidth * dpr
      const ih = layer.imageHeight * dpr
      // The layer scrolls opposite to the camera, scaled by its speed.
      const ox = (layer.offsetX - cam.x * layer.speedX) * dpr
      const oy = (layer.offsetY - cam.y * layer.speedY) * dpr
      const x0 = layer.repeatX ? (((ox % iw) + iw) % iw) - iw : ox
      const y0 = layer.repeatY ? (((oy % ih) + ih) % ih) - ih : oy
      const x1 = layer.repeatX ? W : ox + iw
      const y1 = layer.repeatY ? H : oy + ih
      for (let y = y0; y < y1 && y < H; y += ih) {
        for (let x = x0; x < x1 && x < W; x += iw) {
          ctx.drawImage(img, Math.round(x), Math.round(y), Math.ceil(iw), Math.ceil(ih))
          this.stats.drawCalls++
          if (!layer.repeatX) break
        }
        if (!layer.repeatY) break
      }
    }
  }

  // ── Tile layers ──────────────────────────────────────────────────────────

  private drawTileLayers(world: ECSWorld, viewL: number, viewT: number, viewR: number, viewB: number): void {
    const tv = this.tileView
    tv.L = viewL
    tv.T = viewT
    tv.R = viewR
    tv.B = viewB
    this.tileSorted.length = 0
    const ids = world.query('TileLayer')
    if (ids.length === 0) return
    const under: TileLayerData[] = []
    for (const id of ids) {
      const c = world.getComponent<TileLayerComponent>(id, 'TileLayer')
      if (!c) continue
      // With a renderLayer the layer sorts with sprites; without one it sits beneath all of them.
      if (c.layer.renderLayer !== undefined) this.tileSorted.push(c.layer)
      else under.push(c.layer)
    }
    under.sort((a, b) => a.zIndex - b.zIndex)
    for (const layer of under) this.drawTileLayer(layer)
  }

  private drawTileLayer(layer: TileLayerData): void {
    const { ctx, base, tileView: v } = this
    ctx.setTransform(base.s, 0, 0, base.s, base.tx, base.ty)
    this.setAlpha(1)
    this.setOp('source-over')
    this.tileRenderer.draw(ctx, layer, v.L, v.T, v.R, v.B, this.time)
    this.stats.drawCalls += this.tileRenderer.stats.chunksDrawn
    // The tile renderer restores alpha and sets smoothing itself.
    this.smooth = ctx.imageSmoothingEnabled
    this.alpha = ctx.globalAlpha
  }

  // ── Sprites ──────────────────────────────────────────────────────────────

  private drawSprites(world: ECSWorld, camX: number, camY: number, halfW: number, halfH: number, zoom: number): void {
    const ids = world.query('Transform', 'Sprite')
    const n = ids.length
    const layers = this.spriteLayers
    const tiles = this.tileSorted
    const texts = this.textLayers
    // Text entities that set `layer` sort with sprites; the rest draw after the tint.
    const textIds: number[] = []
    for (const id of world.query('Transform', 'Text')) {
      if (world.getComponent<TextComponent>(id, 'Text')!.layer !== undefined) textIds.push(id)
    }
    const nSprites = n + layers.length
    const nt = nSprites + tiles.length
    const ne = nt + texts.length
    const m = ne + textIds.length
    if (m === 0) return
    const pad = 32 / zoom
    const viewL = camX - halfW - pad
    const viewR = camX + halfW + pad
    const viewT = camY - halfH - pad
    const viewB = camY + halfH + pad

    const sprites: SpriteComponent[] = []
    const { sortLayer, sortZ, sortKind } = this
    for (let r = 0; r < n; r++) {
      const sprite = world.getComponent<SpriteComponent>(ids[r], 'Sprite')!
      sprites.push(sprite)
      sortLayer[r] = this.layers.getOrder(sprite.layer)
      sortZ[r] = sprite.zIndex
      sortKind[r] = 1
    }
    for (let j = 0; j < layers.length; j++) {
      sortLayer[n + j] = this.layers.getOrder(layers[j].layer)
      sortZ[n + j] = layers[j].zIndex
      sortKind[n + j] = 1
    }
    for (let j = 0; j < tiles.length; j++) {
      sortLayer[nSprites + j] = this.layers.getOrder(tiles[j].renderLayer!)
      sortZ[nSprites + j] = tiles[j].zIndex
      sortKind[nSprites + j] = 0
    }
    for (let j = 0; j < texts.length; j++) {
      sortLayer[nt + j] = this.layers.getOrder(texts[j].layer)
      sortZ[nt + j] = texts[j].zIndex
      sortKind[nt + j] = 1
    }
    for (let j = 0; j < textIds.length; j++) {
      const text = world.getComponent<TextComponent>(textIds[j], 'Text')!
      sortLayer[ne + j] = this.layers.getOrder(text.layer!)
      sortZ[ne + j] = text.zIndex
      sortKind[ne + j] = 1
    }
    const idx = this.sortIdx
    idx.length = m
    for (let i = 0; i < m; i++) idx[i] = i
    idx.sort((a, b) => sortLayer[a] - sortLayer[b] || sortZ[a] - sortZ[b] || sortKind[a] - sortKind[b] || a - b)

    const hasSquash = world.query('SquashStretch').length > 0
    const { ctx, base, stats } = this
    for (let i = 0; i < m; i++) {
      const k = idx[i]
      if (k >= ne) {
        const id = textIds[k - ne]
        this.drawTextEntity(world, id, world.getComponent<TextComponent>(id, 'Text')!)
        continue
      }
      if (k >= nt) {
        const layer = texts[k - nt]
        this.setSmooth(true)
        this.setAlpha(1)
        this.setOp('source-over')
        this.textLayerRenderer.draw(ctx, layer, base, { viewL, viewR, viewT, viewB })
        stats.instances += this.textLayerRenderer.instances
        stats.batches++
        stats.drawCalls += this.textLayerRenderer.instances
        continue
      }
      if (k >= nSprites) {
        this.drawTileLayer(tiles[k - nSprites])
        continue
      }
      if (k >= n) {
        const layer = layers[k - n]
        this.setSmooth(smoothFor(layer.sampling, this.defaultSampling))
        this.setAlpha(1)
        this.setOp('source-over')
        this.spriteLayerRenderer.draw(ctx, layer, base, { viewL, viewR, viewT, viewB }, (atlas) =>
          this.resolveLayerAtlas(atlas),
        )
        stats.instances += this.spriteLayerRenderer.instances
        stats.batches++
        stats.drawCalls += this.spriteLayerRenderer.instances
        continue
      }
      const sprite = sprites[k]
      stats.spritesConsidered++
      if (!sprite.visible) continue
      const t = world.getComponent<TransformComponent>(ids[k], 'Transform')!
      const scx = t.x + sprite.offsetX
      const scy = t.y + sprite.offsetY
      const shw = sprite.width * t.scaleX * 0.5
      const shh = sprite.height * t.scaleY * 0.5
      const sr = Math.sqrt(shw * shw + shh * shh)
      if (scx + sr < viewL || scx - sr > viewR || scy + sr < viewT || scy - sr > viewB) {
        stats.spritesCulled++
        continue
      }
      const ss = hasSquash ? world.getComponent<SquashStretchComponent>(ids[k], 'SquashStretch') : undefined
      this.drawSprite(sprite, t, ss ? ss.currentScaleX : 1, ss ? ss.currentScaleY : 1)
    }
    ctx.setTransform(base.s, 0, 0, base.s, base.tx, base.ty)
    this.setAlpha(1)
    this.setOp('source-over')
  }

  private spriteSource(sprite: SpriteComponent): SpriteSource | null {
    if (sprite.dynamicSrc) {
      const c = this.dynamicCanvases.get(sprite.dynamicSrc)
      return c && c.width > 0 && c.height > 0
        ? { image: c as CanvasImageSource, width: c.width, height: c.height }
        : null
    }
    if (sprite.src && !sprite.image && sprite.visible) sprite.image = this.loadImage(this.images, sprite.src)
    const img = sprite.image
    if (img && img.complete && img.naturalWidth > 0)
      return { image: img, width: img.naturalWidth, height: img.naturalHeight }
    return null
  }

  private drawSprite(sprite: SpriteComponent, t: TransformComponent, sqX: number, sqY: number): void {
    const { ctx, base, stats } = this
    const w = sprite.width * t.scaleX * sqX
    const h = sprite.height * t.scaleY * sqY
    const fx = sprite.flipX ? -1 : 1
    const fy = sprite.flipY ? -1 : 1
    const cos = Math.cos(t.rotation) * base.s
    const sin = Math.sin(t.rotation) * base.s
    ctx.setTransform(cos * fx, sin * fx, -sin * fy, cos * fy, base.tx + base.s * t.x, base.ty + base.s * t.y)
    const dx = -sprite.anchorX * w + sprite.offsetX
    const dy = -sprite.anchorY * h + sprite.offsetY

    const blend: BlendMode = sprite.blendMode ?? 'normal'
    this.setOp(blend === 'normal' ? 'source-over' : (COMPOSITE[blend] ?? 'source-over'))
    let opacity = sprite.opacity ?? 1

    // Tint mixes the sprite's colour toward `tint`; the texture is multiplied by the mix.
    let tr = 1
    let tg = 1
    let tb = 1
    const tintOn = !!sprite.tint && (sprite.tintOpacity ?? 0) > 0
    if (tintOn) {
      const [r, g, b] = parseCSSColor(sprite.tint!)
      const a = sprite.tintOpacity ?? 0.3
      tr = 1 - a + r * a
      tg = 1 - a + g * a
      tb = 1 - a + b * a
    }

    if (sprite.customDraw) {
      this.setAlpha(opacity)
      ctx.save()
      ctx.translate(dx, dy)
      sprite.customDraw(ctx, w, h)
      ctx.restore()
      stats.drawCalls++
      stats.instances++
      return
    }

    const src = this.spriteSource(sprite)
    if (src) {
      this.setAlpha(opacity)
      this.setSmooth(smoothFor(sprite.sampling, this.defaultSampling))
      let sx = 0
      let sy = 0
      let sw = src.width
      let sh = src.height
      if (sprite.frameWidth && sprite.frameHeight) {
        const cols = sprite.frameColumns ?? Math.floor(src.width / sprite.frameWidth)
        sx = (sprite.frameIndex % cols) * sprite.frameWidth
        sy = Math.floor(sprite.frameIndex / cols) * sprite.frameHeight
        sw = sprite.frameWidth
        sh = sprite.frameHeight
      } else if (sprite.frame) {
        sx = sprite.frame.sx
        sy = sprite.frame.sy
        sw = sprite.frame.sw
        sh = sprite.frame.sh
      }
      let image: CanvasImageSource = src.image
      if (tintOn) {
        image = this.tints.get(src.image, sx, sy, sw, sh, rgb8(tr), rgb8(tg), rgb8(tb)) as CanvasImageSource
        sx = 0
        sy = 0
        sw = Math.ceil(sw)
        sh = Math.ceil(sh)
      }
      if ((sprite.tileX || sprite.tileY) && !sprite.frame && !sprite.frameWidth) {
        this.fillTiled(sprite, image, src, dx, dy, w, h)
      } else {
        ctx.drawImage(image, sx, sy, sw, sh, dx, dy, w, h)
      }
      stats.drawCalls++
      stats.instances++
      return
    }

    // No texture: a solid colour or a shape preset.
    const [cr, cg, cb, ca] = parseCSSColor(sprite.color)
    opacity *= ca
    this.setAlpha(opacity)
    ctx.fillStyle = `rgb(${rgb8(cr * tr)},${rgb8(cg * tg)},${rgb8(cb * tb)})`
    const shaped = (sprite.shape !== undefined && sprite.shape !== 'rect') || !!sprite.borderRadius
    const stroked = !!sprite.strokeColor && (sprite.strokeWidth ?? 0) > 0
    if (shaped || stroked) {
      traceShape(
        ctx,
        sprite.shape ?? 'rect',
        dx,
        dy,
        w,
        h,
        sprite.borderRadius ?? 0,
        sprite.starPoints ?? 5,
        sprite.starInnerRadius ?? 0.4,
      )
      ctx.fill()
      if (stroked) {
        ctx.strokeStyle = sprite.strokeColor!
        ctx.lineWidth = sprite.strokeWidth
        ctx.stroke()
      }
    } else {
      ctx.fillRect(dx, dy, w, h)
    }
    stats.drawCalls++
    stats.instances++
  }

  /** Repeat the image across the sprite rect, one repeat per `tileSize` (default: the image's size). */
  private fillTiled(
    sprite: SpriteComponent,
    image: CanvasImageSource,
    src: SpriteSource,
    dx: number,
    dy: number,
    w: number,
    h: number,
  ): void {
    const { ctx } = this
    const iw = src.width
    const ih = src.height
    const pattern = ctx.createPattern(
      image,
      sprite.tileX && sprite.tileY ? 'repeat' : sprite.tileX ? 'repeat-x' : 'repeat-y',
    )
    if (!pattern) return
    const sx = sprite.tileX ? (sprite.tileSizeX ?? iw) / iw : w / iw
    const sy = sprite.tileY ? (sprite.tileSizeY ?? ih) / ih : h / ih
    pattern.setTransform(new DOMMatrix().translate(dx, dy).scale(sx, sy))
    ctx.fillStyle = pattern
    ctx.fillRect(dx, dy, w, h)
  }

  private resolveLayerAtlas(atlas: LayerAtlas): LayerSource | null {
    if (atlas.dynamicSrc !== undefined) {
      const c = this.dynamicCanvases.get(atlas.dynamicSrc)
      return c && c.width > 0 && c.height > 0
        ? { image: c as CanvasImageSource, width: c.width, height: c.height }
        : null
    }
    if (atlas.image !== undefined) {
      const img = atlas.image
      const iw = (img as HTMLImageElement).naturalWidth ?? img.width
      const ih = (img as HTMLImageElement).naturalHeight ?? img.height
      return iw && ih ? { image: img as CanvasImageSource, width: iw, height: ih } : null
    }
    if (atlas.src !== undefined) {
      const img = this.loadImage(this.images, atlas.src)
      return img.complete && img.naturalWidth > 0
        ? { image: img, width: img.naturalWidth, height: img.naturalHeight }
        : null
    }
    return null
  }

  // ── Screen tint ──────────────────────────────────────────────────────────

  private drawScreenTint(W: number, H: number): void {
    const { ctx } = this
    const t = this.screenTint
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (t.mode === 'multiply') {
      // dst * mix(1, colour, a)
      this.setAlpha(1)
      this.setOp('multiply')
      ctx.fillStyle = `rgb(${rgb8(1 - t.a + t.a * t.r)},${rgb8(1 - t.a + t.a * t.g)},${rgb8(1 - t.a + t.a * t.b)})`
    } else {
      this.setAlpha(Math.min(1, t.a))
      this.setOp(t.mode === 'additive' ? 'lighter' : 'source-over')
      ctx.fillStyle = `rgb(${rgb8(t.r)},${rgb8(t.g)},${rgb8(t.b)})`
    }
    ctx.fillRect(0, 0, W, H)
    this.stats.drawCalls++
    this.setAlpha(1)
    this.setOp('source-over')
  }

  // ── Text ─────────────────────────────────────────────────────────────────

  /** Text entities without a `layer`: drawn after the tint, above every sprite, ordered by zIndex. */
  private drawText(world: ECSWorld): void {
    const ids = world.query('Transform', 'Text')
    if (ids.length === 0) return
    const texts: { id: number; text: TextComponent }[] = []
    for (const id of ids) {
      const text = world.getComponent<TextComponent>(id, 'Text')!
      if (text.layer === undefined) texts.push({ id, text })
    }
    texts.sort((a, b) => a.text.zIndex - b.text.zIndex)
    this.setOp('source-over')
    for (const { id, text } of texts) this.drawTextEntity(world, id, text)
    this.setAlpha(1)
  }

  private drawTextEntity(world: ECSWorld, id: number, text: TextComponent): void {
    if (!text.visible) return
    const { ctx, base } = this
    const t = world.getComponent<TransformComponent>(id, 'Transform')!
    const cos = Math.cos(t.rotation) * base.s
    const sin = Math.sin(t.rotation) * base.s
    ctx.setTransform(
      cos,
      sin,
      -sin,
      cos,
      base.tx + base.s * (t.x + text.offsetX),
      base.ty + base.s * (t.y + text.offsetY),
    )
    this.setAlpha(text.opacity ?? 1)
    this.setOp('source-over')
    const style = text.fontStyle === 'italic' ? 'italic ' : ''
    const weight = text.fontWeight !== undefined ? `${text.fontWeight} ` : ''
    ctx.font = `${style}${weight}${text.fontSize ?? 16}px ${text.fontFamily ?? 'monospace'}`
    ctx.textAlign = text.align ?? 'center'
    ctx.textBaseline = text.baseline ?? 'middle'
    const shadow = !!text.shadowColor
    if (shadow) {
      ctx.shadowColor = text.shadowColor!
      // The shadow is in device pixels, unlike everything else here.
      ctx.shadowOffsetX = (text.shadowOffsetX ?? 2) * base.s
      ctx.shadowOffsetY = (text.shadowOffsetY ?? 2) * base.s
      ctx.shadowBlur = (text.shadowBlur ?? 0) * base.s
    }
    const lines: string[] = []
    if (text.wordWrap && text.maxWidth) {
      for (const para of text.text.split('\n')) {
        let line = ''
        for (const word of para.split(' ')) {
          const test = line ? `${line} ${word}` : word
          if (ctx.measureText(test).width > text.maxWidth && line) {
            lines.push(line)
            line = word
          } else line = test
        }
        lines.push(line)
      }
    } else lines.push(...text.text.split('\n'))
    const lh = (text.fontSize ?? 16) * (text.lineHeight ?? 1.2)
    ctx.fillStyle = text.color ?? '#ffffff'
    for (let i = 0; i < lines.length; i++) {
      if (text.strokeColor && text.strokeWidth) {
        ctx.strokeStyle = text.strokeColor
        ctx.lineWidth = text.strokeWidth
        ctx.strokeText(lines[i], 0, i * lh, text.maxWidth)
      }
      ctx.fillText(lines[i], 0, i * lh, text.maxWidth)
    }
    if (shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0)'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
    }
    this.stats.drawCalls++
  }

  // ── Particles and trails ─────────────────────────────────────────────────

  private drawParticles(world: ECSWorld, dt: number): void {
    const { ctx, base } = this
    for (const id of world.query('Transform', 'ParticlePool')) {
      const t = world.getComponent<TransformComponent>(id, 'Transform')!
      const pool = world.getComponent<ParticlePoolComponent>(id, 'ParticlePool')!
      updateParticlePool(world, pool, t, dt)
      if (pool.particles.length === 0) continue
      const shape = pool.particleShape ?? 'soft'
      const blend = pool.blendMode ?? 'normal'
      this.setOp(blend === 'normal' ? 'source-over' : (COMPOSITE[blend] ?? 'source-over'))
      this.setSmooth(true)
      if (shape === 'soft') this.softParticle ??= createSoftParticle()
      const palette = pool.colorOverLife && pool.colorOverLife.length >= 2 ? pool.colorOverLife : null
      for (const p of pool.particles) {
        const lifeFrac = p.life / p.maxLife
        const size =
          p.startSize !== undefined && p.endSize !== undefined
            ? p.endSize + (p.startSize - p.endSize) * lifeFrac
            : p.size
        if (size <= 0 || lifeFrac <= 0) continue
        let r: number, g: number, b: number
        if (palette) {
          const scaled = (1 - lifeFrac) * (palette.length - 1)
          const lo = Math.floor(scaled)
          const hi = Math.min(lo + 1, palette.length - 1)
          const f = scaled - lo
          const [r0, g0, b0] = parseCSSColor(palette[lo])
          const [r1, g1, b1] = parseCSSColor(palette[hi])
          r = r0 + (r1 - r0) * f
          g = g0 + (g1 - g0) * f
          b = b0 + (b1 - b0) * f
        } else {
          ;[r, g, b] = parseCSSColor(p.color)
        }
        const rot = p.rotation ?? 0
        const cos = Math.cos(rot) * base.s
        const sin = Math.sin(rot) * base.s
        ctx.setTransform(cos, sin, -sin, cos, base.tx + base.s * p.x, base.ty + base.s * p.y)
        this.setAlpha(Math.min(1, lifeFrac))
        const half = size / 2
        if (shape === 'soft') {
          // 4 bits per channel keeps the tinted-sprite cache small; glows hide the step.
          const q = (v: number) => Math.round(Math.round(v * 15) * 17)
          const tinted = this.tints.get(
            this.softParticle as CanvasImageSource,
            0,
            0,
            SOFT_SIZE,
            SOFT_SIZE,
            q(r),
            q(g),
            q(b),
          )
          ctx.drawImage(tinted as CanvasImageSource, -half, -half, size, size)
        } else {
          ctx.fillStyle = `rgb(${rgb8(r)},${rgb8(g)},${rgb8(b)})`
          if (shape === 'circle') {
            ctx.beginPath()
            ctx.arc(0, 0, half, 0, Math.PI * 2)
            ctx.fill()
          } else ctx.fillRect(-half, -half, size, size)
        }
        this.stats.instances++
      }
      this.stats.drawCalls++
    }
    this.setAlpha(1)
    this.setOp('source-over')
  }

  private drawTrails(world: ECSWorld): void {
    const { ctx, base } = this
    for (const id of world.query('Transform', 'Trail')) {
      const t = world.getComponent<TransformComponent>(id, 'Transform')!
      const trail = world.getComponent<TrailComponent>(id, 'Trail')!
      updateTrail(trail, t)
      const pts = trail.points
      if (pts.length < 1) continue
      const baseColor = parseCSSColor(trail.color)
      const palette = trail.colorOverLife && trail.colorOverLife.length >= 2 ? trail.colorOverLife : null
      ctx.setTransform(base.s, 0, 0, base.s, base.tx, base.ty)
      for (let i = 0; i < pts.length; i++) {
        const frac = pts.length > 1 ? i / (pts.length - 1) : 0
        let r: number, g: number, b: number
        if (palette) {
          const scaled = frac * (palette.length - 1)
          const lo = Math.floor(scaled)
          const hi = Math.min(lo + 1, palette.length - 1)
          const f = scaled - lo
          const [r0, g0, b0] = parseCSSColor(palette[lo])
          const [r1, g1, b1] = parseCSSColor(palette[hi])
          r = r0 + (r1 - r0) * f
          g = g0 + (g1 - g0) * f
          b = b0 + (b1 - b0) * f
        } else {
          ;[r, g, b] = baseColor
        }
        const segW = trail.widthOverLife
          ? trail.widthOverLife.start + (trail.widthOverLife.end - trail.widthOverLife.start) * frac
          : trail.width > 0
            ? trail.width
            : 1
        this.setAlpha(1 - frac)
        ctx.fillStyle = `rgb(${rgb8(r)},${rgb8(g)},${rgb8(b)})`
        ctx.fillRect(pts[i].x - segW / 2, pts[i].y - segW / 2, segW, segW)
        this.stats.instances++
      }
      this.stats.drawCalls++
    }
    this.setAlpha(1)
  }

  // ── Debug overlays ───────────────────────────────────────────────────────

  private drawDebug(world: ECSWorld, zoom: number): void {
    const { ctx, base } = this
    ctx.setTransform(base.s, 0, 0, base.s, base.tx, base.ty)
    this.setOp('source-over')
    const g = this.debugNavGrid
    if (g) {
      for (let row = 0; row < g.rows; row++) {
        for (let col = 0; col < g.cols; col++) {
          const walkable = g.walkable[row * g.cols + col]
          this.setAlpha(walkable ? 0.08 : 0.25)
          ctx.fillStyle = walkable ? '#00ff00' : '#ff0000'
          ctx.fillRect(col * g.cellSize, row * g.cellSize, g.cellSize, g.cellSize)
        }
      }
    }
    if (this.contactFlashPoints.length > 0) {
      this.setAlpha(0.9)
      ctx.fillStyle = '#ff4d4d'
      for (const pt of this.contactFlashPoints) {
        ctx.fillRect(pt.x - 4, pt.y - 4, 8, 8)
        pt.ttl--
      }
      this.contactFlashPoints = this.contactFlashPoints.filter((p) => p.ttl > 0)
    }
    if (this.highlightEntityId !== null) {
      const ht = world.getComponent<TransformComponent>(this.highlightEntityId, 'Transform')
      if (ht) {
        const box = world.getComponent<{
          type: string
          width: number
          height: number
          offsetX?: number
          offsetY?: number
        }>(this.highlightEntityId, 'BoxCollider')
        const circ = world.getComponent<{ type: string; radius: number; offsetX?: number; offsetY?: number }>(
          this.highlightEntityId,
          'CircleCollider',
        )
        const hw = box ? box.width : circ ? circ.radius * 2 : 32
        const hh = box ? box.height : circ ? circ.radius * 2 : 32
        const hx = ht.x + (box?.offsetX ?? circ?.offsetX ?? 0)
        const hy = ht.y + (box?.offsetY ?? circ?.offsetY ?? 0)
        this.setAlpha(0.9)
        ctx.strokeStyle = '#e619e6'
        ctx.lineWidth = 2 / zoom
        ctx.strokeRect(hx - hw / 2, hy - hh / 2, hw, hh)
      }
    }
    this.setAlpha(1)
  }
}
