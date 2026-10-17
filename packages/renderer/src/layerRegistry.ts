import type { ECSWorld, RenderStats, TileLayerRenderStats } from '@xip/core'
import type { SpriteLayerRenderer } from './spriteLayerGL'
import type { TileLayerData } from './tileLayer'
import type { TextLayerRenderer } from './textLayerGL'
import type { EntityTextBatcher } from './textEntities'
import type { ShapeRenderer } from './shapeGL'

export interface TileRenderer {
  readonly stats: TileLayerRenderStats
  /** Layers with a `renderLayer`, drawn interleaved with sprites through {@link drawSorted}. */
  readonly sorted: readonly TileLayerData[]
  /**
   * Folds this frame's texture, upload and per-layer counters into the render stats.
   * `own` is the RenderSystem's own texture count; `first` is the call right after `prepare`,
   * later calls (after drawing) only add what was uploaded since.
   */
  fold(s: RenderStats, own: number, first: boolean): void
  prepare(world: ECSWorld, dt: number): boolean
  render(
    camX: number,
    camY: number,
    zoom: number,
    w: number,
    h: number,
    shakeX: number,
    shakeY: number,
    dpr?: number,
  ): void
  /**
   * Clears the `w` x `h` target and draws the base layers (no `renderLayer`) from a cached copy, when one
   * of them sets `cache`. Returns false and draws nothing otherwise: the caller then clears and calls `render()`.
   */
  renderBase(
    camX: number,
    camY: number,
    zoom: number,
    canvasW: number,
    canvasH: number,
    shakeX: number,
    shakeY: number,
    dpr: number,
    w: number,
    h: number,
    clearR: number,
    clearG: number,
    clearB: number,
  ): boolean
  /** Draw one of {@link sorted} using the camera of the last `render()`. */
  drawSorted(layer: TileLayerData): void
  contextRestored(): void
  dispose(): void
}

type Factory<T> = (gl: WebGL2RenderingContext) => T
type TileFactory = (gl: WebGL2RenderingContext, stats: TileLayerRenderStats) => TileRenderer

// Layer GL code is registered by the layer data classes, so games that never
// create a tile or sprite layer don't bundle their renderers.
let tileFactory: TileFactory | null = null
let spriteFactory: Factory<SpriteLayerRenderer> | null = null
let textFactory: Factory<TextLayerRenderer> | null = null

export function registerTileRenderer(f: TileFactory): void {
  tileFactory ??= f
}
export function registerSpriteLayerRenderer(f: Factory<SpriteLayerRenderer>): void {
  spriteFactory ??= f
}
export function tileRendererFactory(): TileFactory | null {
  return tileFactory
}
export function spriteLayerRendererFactory(): Factory<SpriteLayerRenderer> | null {
  return spriteFactory
}

export function registerTextLayerRenderer(f: Factory<TextLayerRenderer>): void {
  textFactory ??= f
}
export function textLayerRendererFactory(): Factory<TextLayerRenderer> | null {
  return textFactory
}

let textEntityFactory: (() => EntityTextBatcher) | null = null
export function registerTextEntityRenderer(f: () => EntityTextBatcher): void {
  textEntityFactory ??= f
}
export function textEntityBatcherFactory(): (() => EntityTextBatcher) | null {
  return textEntityFactory
}

let shapeFactory: Factory<ShapeRenderer> | null = null
export function registerShapeRenderer(f: Factory<ShapeRenderer>): void {
  shapeFactory ??= f
}
export function shapeRendererFactory(): Factory<ShapeRenderer> | null {
  return shapeFactory
}
