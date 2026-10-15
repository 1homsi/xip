import { useEffect, useContext } from 'react'
import {
  createCamera2D,
  type Camera2DComponent,
  type CameraFollowPointProvider,
  type CameraFollowSprite,
} from '@xip/renderer'
import { EngineContext } from '../context'

export interface Camera2DProps {
  /** String ID of entity to follow */
  followEntity?: string
  /**
   * Follow a world-space point read every frame, e.g.
   * `followPoint={() => ({ x: layer.x[i], y: layer.y[i] })}`. Return null or
   * undefined to hold the camera where it is. Uses the same smoothing, dead
   * zone, follow offset and bounds as `followEntity`.
   *
   * Priority when several are set: `followPoint` > `followSprite` > `followEntity`.
   * Define the function once (module scope, `useCallback` or a ref read) so it is stable.
   */
  followPoint?: CameraFollowPointProvider
  /**
   * Follow one sprite of a `SpriteLayer`: `{ layer, index }` by slot, or
   * `{ layer, id }` by the id in `layer.ids` (first match, the slot is cached
   * and re-checked every frame). A hidden or removed sprite holds the camera.
   * Same smoothing, dead zone, follow offset and bounds as `followEntity`.
   * Priority: `followPoint` > `followSprite` > `followEntity`.
   */
  followSprite?: CameraFollowSprite
  /** Initial camera X position in world space (default 0 = world origin at screen center) */
  x?: number
  /** Initial camera Y position in world space (default 0 = world origin at screen center) */
  y?: number
  zoom?: number
  /** Lerp smoothing factor (0 = instant snap, 0.85 = smooth) */
  smoothing?: number
  background?: string
  bounds?: { x: number; y: number; width: number; height: number }
  deadZone?: { w: number; h: number }
  /** World-space offset applied to the follow target (look-ahead, vertical bias, etc.) */
  followOffsetX?: number
  followOffsetY?: number
  /** Snap the camera to whole device pixels (crisp pixel art at any zoom / devicePixelRatio). */
  pixelSnap?: boolean
}

export function Camera2D({
  followEntity,
  followPoint,
  followSprite,
  x = 0,
  y = 0,
  zoom = 1,
  smoothing = 0,
  background = '#1a1a2e',
  bounds,
  deadZone,
  followOffsetX = 0,
  followOffsetY = 0,
  pixelSnap = false,
}: Camera2DProps) {
  const engine = useContext(EngineContext)!

  useEffect(() => {
    const entityId = engine.ecs.createEntity()
    engine.ecs.addComponent(
      entityId,
      createCamera2D({
        followEntityId: followEntity,
        followPoint,
        followSprite,
        x,
        y,
        zoom,
        smoothing,
        background,
        bounds,
        deadZone,
        followOffsetX,
        followOffsetY,
        pixelSnap,
      }),
    )

    return () => engine.ecs.destroyEntity(entityId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Position props apply only when x / y themselves change, so a panned or followed camera is
  // not reset when an unrelated prop changes.
  useEffect(() => {
    const camId = engine.ecs.queryOne('Camera2D')
    if (camId === undefined) return
    const cam = engine.ecs.getComponent<Camera2DComponent>(camId, 'Camera2D')!
    cam.x = x
    cam.y = y
    engine.loop.markDirty()
  }, [x, y, engine])

  // Object props (bounds, deadZone) are compared by value: inline JSX creates a new object on
  // every render, which must not count as a change.
  const bx = bounds?.x
  const by = bounds?.y
  const bw = bounds?.width
  const bh = bounds?.height
  const dw = deadZone?.w
  const dh = deadZone?.h
  useEffect(() => {
    const camId = engine.ecs.queryOne('Camera2D')
    if (camId === undefined) return
    const cam = engine.ecs.getComponent<Camera2DComponent>(camId, 'Camera2D')!
    cam.followEntityId = followEntity
    cam.zoom = zoom
    cam.smoothing = smoothing
    cam.background = background
    cam.bounds = bounds
    cam.deadZone = deadZone
    cam.followOffsetX = followOffsetX
    cam.followOffsetY = followOffsetY
    cam.pixelSnap = pixelSnap
    engine.loop.markDirty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    followEntity,
    zoom,
    smoothing,
    background,
    bx,
    by,
    bw,
    bh,
    dw,
    dh,
    followOffsetX,
    followOffsetY,
    pixelSnap,
    engine,
  ])

  // Follow targets sync on their own so an inline `followPoint` arrow (new identity every
  // render) does not re-apply the position props above.
  const spriteLayer = followSprite?.layer
  const spriteIndex = followSprite?.index
  const spriteId = followSprite?.id
  useEffect(() => {
    const camId = engine.ecs.queryOne('Camera2D')
    if (camId === undefined) return
    const cam = engine.ecs.getComponent<Camera2DComponent>(camId, 'Camera2D')!
    cam.followPoint = followPoint
    cam.followSprite = spriteLayer ? { layer: spriteLayer, index: spriteIndex, id: spriteId } : undefined
    cam._followSpriteIndex = undefined
    engine.loop.markDirty()
  }, [followPoint, spriteLayer, spriteIndex, spriteId, engine])

  return null
}
