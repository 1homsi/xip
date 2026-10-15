import { useEffect, useContext, useRef } from 'react'
import { createSprite, type SpriteComponent, type Sampling, type BlendMode, type SpriteShape } from '@xip/renderer'
import { EngineContext, EntityContext } from '../context'
import type { SpriteAtlas } from './spriteAtlas'

interface SpriteProps {
  width: number
  height: number
  color?: string
  src?: string
  /**
   * ID returned by `useDynamicCanvas()`. When set the sprite samples from
   * the registered canvas texture and re-uploads it whenever `markDirty()`
   * is called on that handle.
   */
  dynamicSrc?: string
  offsetX?: number
  offsetY?: number
  zIndex?: number
  visible?: boolean
  flipX?: boolean
  flipY?: boolean
  anchorX?: number
  anchorY?: number
  frameIndex?: number
  frameWidth?: number
  frameHeight?: number
  frameColumns?: number
  atlas?: SpriteAtlas
  frame?: string
  tileX?: boolean
  tileY?: boolean
  tileSizeX?: number
  tileSizeY?: number
  /** Texture sampling mode — controls filtering when the sprite is scaled */
  sampling?: Sampling
  /** Blend mode used when drawing this sprite */
  blendMode?: BlendMode
  /** Render layer name — sprites are sorted by layer order first, then zIndex */
  layer?: string
  /** Color tint applied on top of the image (multiplied). e.g. '#ff0000' for red tint */
  tint?: string
  /** Tint opacity 0-1 */
  tintOpacity?: number
  /** Overall opacity 0-1 (default 1) */
  opacity?: number
  /** Shape to draw: 'rect' (default), 'circle', 'ellipse', 'roundedRect', 'triangle', 'star', 'pentagon', 'hexagon' */
  shape?: SpriteShape
  /** Border radius for 'roundedRect' shape (px) */
  borderRadius?: number
  /** Stroke outline color */
  strokeColor?: string
  /** Stroke outline width in pixels */
  strokeWidth?: number
  /** Custom draw callback */
  customDraw?: (ctx: CanvasRenderingContext2D, width: number, height: number) => void
  /** Number of points for 'star' shape (default 5) */
  starPoints?: number
  /** Inner radius ratio for 'star' shape (0-1, default 0.4) */
  starInnerRadius?: number
}

export function Sprite({
  width,
  height,
  color = '#ffffff',
  src,
  dynamicSrc,
  offsetX = 0,
  offsetY = 0,
  zIndex = 0,
  visible = true,
  flipX = false,
  flipY = false,
  anchorX = 0.5,
  anchorY = 0.5,
  frameIndex = 0,
  frameWidth,
  frameHeight,
  frameColumns,
  atlas,
  frame,
  tileX,
  tileY,
  tileSizeX,
  tileSizeY,
  sampling,
  blendMode = 'normal',
  layer = 'default',
  tint,
  tintOpacity,
  opacity = 1,
  shape = 'rect',
  borderRadius = 0,
  strokeColor,
  strokeWidth = 0,
  customDraw,
  starPoints = 5,
  starInnerRadius = 0.4,
}: SpriteProps) {
  const resolvedFrameIndex = atlas && frame != null ? (atlas[frame] ?? 0) : frameIndex
  const engine = useContext(EngineContext)!
  const entityId = useContext(EntityContext)!

  if (process.env.NODE_ENV !== 'production') {
    if (entityId === null) {
      console.warn('[Xip] <Sprite> must be inside an <Entity>. No EntityContext found.')
    }
    if ((frameWidth != null || frameHeight != null || frameColumns != null) && !src) {
      console.warn(
        '[Xip] <Sprite> has frameWidth/frameHeight/frameColumns but no `src`. Sprite-sheet props require an image source.',
      )
    }
  }

  useEffect(() => {
    const comp = createSprite({
      width,
      height,
      color,
      src,
      dynamicSrc,
      offsetX,
      offsetY,
      zIndex,
      visible,
      flipX,
      flipY,
      anchorX,
      anchorY,
      frameIndex: resolvedFrameIndex,
      frameWidth,
      frameHeight,
      frameColumns,
      tileX,
      tileY,
      tileSizeX,
      tileSizeY,
      sampling,
      blendMode,
      layer,
      tint,
      tintOpacity,
      opacity,
      shape,
      borderRadius,
      strokeColor,
      strokeWidth,
      customDraw,
      starPoints,
      starInnerRadius,
    })
    engine.ecs.addComponent(entityId, comp)
    engine.loop.markDirty()

    if (src) {
      // loadImage auto-resolves the base URL; store the resolved src on the
      // component so the WebGL renderer's texture cache key matches.
      engine.assets
        .loadImage(src)
        .then((img: HTMLImageElement) => {
          const c = engine.ecs.getComponent<SpriteComponent>(entityId, 'Sprite')
          if (c) {
            c.image = img
            c.src = img.src // use the fully resolved URL for WebGL cache matching
            engine.loop.markDirty()
          }
        })
        .catch((err: unknown) => {
          // Surface through the engine event bus so games can log, show an error
          // overlay, or fall back to a placeholder. Also log to console so devs
          // see the failure during development.
          const message = err instanceof Error ? err.message : String(err)
          engine.events.emit('asset:error', { type: 'image', src, entityId, error: err })
          // eslint-disable-next-line no-console
          console.error(`[Xip] <Sprite> failed to load image "${src}": ${message}`)
        })
    }

    return () => engine.ecs.removeComponent(entityId, 'Sprite')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reactive src: reload the image when the src prop changes after mount.
  // Skips the initial load since the mount effect above already handled it.
  const didMount = useRef(false)
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true
      return
    }
    const comp = engine.ecs.getComponent<SpriteComponent>(entityId, 'Sprite')
    if (!comp) return
    if (!src) {
      comp.image = undefined
      comp.src = undefined
      engine.loop.markDirty()
      return
    }
    let cancelled = false
    engine.assets
      .loadImage(src)
      .then((img: HTMLImageElement) => {
        if (cancelled) return
        const c = engine.ecs.getComponent<SpriteComponent>(entityId, 'Sprite')
        if (c) {
          c.image = img
          c.src = img.src
          engine.loop.markDirty()
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        engine.events.emit('asset:error', { type: 'image', src, entityId, error: err })
        // eslint-disable-next-line no-console
        console.error(`[Xip] <Sprite> failed to reload image "${src}": ${message}`)
      })
    return () => {
      cancelled = true
    }
  }, [src, engine, entityId])

  // Sync mutable props
  useEffect(() => {
    const comp = engine.ecs.getComponent<SpriteComponent>(entityId, 'Sprite')
    if (!comp) return
    comp.width = width
    comp.height = height
    comp.offsetX = offsetX
    comp.offsetY = offsetY
    comp.anchorX = anchorX
    comp.anchorY = anchorY
    comp.frameWidth = frameWidth
    comp.frameHeight = frameHeight
    comp.frameColumns = frameColumns
    comp.tileX = tileX
    comp.tileY = tileY
    comp.tileSizeX = tileSizeX
    comp.tileSizeY = tileSizeY
    comp.sampling = sampling
    comp.color = color
    comp.dynamicSrc = dynamicSrc
    comp.visible = visible
    comp.flipX = flipX
    comp.flipY = flipY
    comp.zIndex = zIndex
    comp.frameIndex = resolvedFrameIndex
    comp.blendMode = blendMode
    comp.layer = layer
    comp.tint = tint
    comp.tintOpacity = tintOpacity
    comp.opacity = opacity
    comp.shape = shape
    comp.borderRadius = borderRadius
    comp.strokeColor = strokeColor
    comp.strokeWidth = strokeWidth
    comp.customDraw = customDraw
    comp.starPoints = starPoints
    comp.starInnerRadius = starInnerRadius
    // An onDemand loop only repaints when woken; a prop change driven from outside the canvas must wake it.
    engine.loop.markDirty()
  }, [
    width,
    height,
    offsetX,
    offsetY,
    anchorX,
    anchorY,
    frameWidth,
    frameHeight,
    frameColumns,
    tileX,
    tileY,
    tileSizeX,
    tileSizeY,
    sampling,
    color,
    dynamicSrc,
    visible,
    flipX,
    flipY,
    zIndex,
    resolvedFrameIndex,
    blendMode,
    layer,
    tint,
    tintOpacity,
    opacity,
    shape,
    borderRadius,
    strokeColor,
    strokeWidth,
    customDraw,
    starPoints,
    starInnerRadius,
    engine,
    entityId,
  ])

  return null
}
