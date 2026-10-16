/** One drawn SpriteLayer, TextLayer or TileLayer, for the per-layer breakdown in {@link RenderStats.layers}. */
export interface LayerStats {
  kind: 'sprite' | 'tile' | 'text'
  /** `SpriteLayer`/`TileLayerData` `name` option (sprite layers default to their render layer, tile layers to `tiles<N>`). */
  name: string
  zIndex: number
  /** frame: quad instances drawn (sprite layers) or visible tile cells shaded (tile layers). */
  instances: number
  /** frame: GL draw calls for this layer. */
  drawCalls: number
  /** frame: bytes uploaded to the GPU for this layer (instance data, tile index/tint/LUT/atlas textures). */
  uploadBytes: number
}

/** TileLayer GL counters. Fields marked "frame" reset every frame. */
export interface TileLayerRenderStats {
  /** frame: index-texture sub-uploads (one per dirty chunk, or one per page on a full replace). */
  indexUploads: number
  /** frame: index texels uploaded. */
  uploadedTexels: number
  /** frame: tile-id lookup-table uploads. */
  lutUploads: number
  /** frame: tile draw calls (one per visible page of each layer). */
  drawCalls: number
  /** frame: texture uploads of any kind (index, tint, LUT, variants, atlas, average colour). */
  textureUploads: number
  /** frame: bytes of those uploads. */
  textureUploadBytes: number
  /** Live GPU textures held by tile layers (1x1 placeholders excluded). */
  textureCount: number
  /** Approximate GPU memory held by those textures, in bytes. */
  textureBytes: number
}

export function createTileLayerRenderStats(): TileLayerRenderStats {
  return {
    indexUploads: 0,
    uploadedTexels: 0,
    lutUploads: 0,
    drawCalls: 0,
    textureUploads: 0,
    textureUploadBytes: 0,
    textureCount: 0,
    textureBytes: 0,
  }
}

/**
 * Renderer counters. One instance per render system, mutated in place every
 * frame (no per-frame allocation). Fields marked "frame" reset at the start of
 * each rendered frame; the rest are running totals or current sizes.
 */
export interface RenderStats {
  /** frame: GL draw calls of any kind (instanced batches, parallax, post-process). */
  drawCalls: number
  /** frame: quad instances submitted across all instanced draws. */
  instances: number
  /** frame: instanced sprite batches flushed (subset of drawCalls). */
  batches: number
  /** frame: Transform+Sprite entities considered by the sprite pass. */
  spritesConsidered: number
  /** frame: sprites rejected by frustum culling. */
  spritesCulled: number
  /** frame: texture uploads (texImage2D / texSubImage2D), including TileLayer textures. */
  textureUploads: number
  /** frame: approximate bytes uploaded to textures (w * h * 4). */
  textureUploadBytes: number
  /** Live GPU textures created by the renderer, TileLayer textures included (1x1 placeholders excluded). */
  textureCount: number
  /** Approximate GPU memory held by those textures, in bytes (w * h * 4). */
  textureBytes: number
  /** total: text texture cache hits / misses since creation. */
  textCacheHits: number
  textCacheMisses: number
  /** total: sprite texture cache hits / misses since creation. */
  textureCacheHits: number
  textureCacheMisses: number
  /** total: rendered frames (excludes idle-skipped frames). */
  frames: number
  /**
   * GPU time of a recent frame in ms (EXT_disjoint_timer_query_webgl2), read a few
   * frames late. `null` until the timer is enabled and a result arrives, or when unsupported.
   */
  gpuMs: number | null
  /** Smoothed `gpuMs` (exponential average). */
  gpuMsAvg: number | null
  /** `null` = GPU timing not requested, `false` = requested but unsupported/lost, `true` = measuring. */
  gpuTimerSupported: boolean | null
  /**
   * `true` when the WebGL renderer string names a software rasterizer (SwiftShader, llvmpipe, ...),
   * so the frame runs on the CPU. `null` when unknown: the Canvas2D backend, or the browser hides the
   * renderer (no WEBGL_debug_renderer_info).
   */
  softwareRenderer: boolean | null
  /** frame: per-layer breakdown of the SpriteLayers / TileLayers drawn (tile layers first, then sprite layers in draw order). */
  layers: LayerStats[]
  /** TileLayer upload/draw/texture counters (the renderer's `tileLayerStats`, kept up to date every frame). */
  tile: TileLayerRenderStats
}

export function createRenderStats(): RenderStats {
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
    tile: createTileLayerRenderStats(),
  }
}

export function resetRenderFrameStats(s: RenderStats): void {
  s.drawCalls = 0
  s.instances = 0
  s.batches = 0
  s.spritesConsidered = 0
  s.spritesCulled = 0
  s.textureUploads = 0
  s.textureUploadBytes = 0
  s.layers.length = 0
}

/** Whole-engine stats for the last frame. Timings are milliseconds. */
export interface EngineStats {
  /** Total frames stepped. */
  frame: number
  /** Wall time between the last two frame starts. */
  frameIntervalMs: number
  /** Time spent in `ecs.update` (all systems, including render). */
  updateMs: number
  /** `updateMs` minus render: ECS + game systems. */
  systemsMs: number
  /** ScriptSystem time (per-entity script / React-registered update callbacks). */
  scriptMs: number
  physicsMs: number
  renderMs: number
  entityCount: number
  /** GPU time of a recent frame in ms; `null` when GPU timing is off or unsupported. Mirrors `render.gpuMs`. */
  gpuMs: number | null
  /** Smoothed GPU time in ms. Mirrors `render.gpuMsAvg`. */
  gpuMsAvg: number | null
  /** Per-layer draw/upload breakdown of the last frame. Same array as `render.layers`. */
  layers: LayerStats[]
  /** TileLayer counters. Same object as `render.tile`. */
  tileLayerStats: TileLayerRenderStats
  render: RenderStats
}

export function createEngineStats(render: RenderStats = createRenderStats()): EngineStats {
  return {
    frame: 0,
    frameIntervalMs: 0,
    updateMs: 0,
    systemsMs: 0,
    scriptMs: 0,
    physicsMs: 0,
    renderMs: 0,
    entityCount: 0,
    gpuMs: null,
    gpuMsAvg: null,
    layers: render.layers,
    tileLayerStats: render.tile,
    render,
  }
}

/** Copy `src` into `out` (allocating `out` only when omitted). */
export function copyEngineStats(src: EngineStats, out?: EngineStats): EngineStats {
  const o = out ?? createEngineStats()
  const r = o.render
  const tile = r.tile
  const layers = r.layers
  Object.assign(o, src)
  o.render = Object.assign(r, src.render)
  o.render.tile = Object.assign(tile, src.render.tile)
  o.render.layers = copyLayers(src.render.layers, layers)
  o.layers = o.render.layers
  o.tileLayerStats = o.render.tile
  return o
}

function copyLayers(src: readonly LayerStats[], out: LayerStats[]): LayerStats[] {
  out.length = src.length
  for (let i = 0; i < src.length; i++) out[i] = Object.assign(out[i] ?? ({} as LayerStats), src[i])
  return out
}
