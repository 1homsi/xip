import { useContext, useEffect, useRef, useState } from 'react'
import type { ECSWorld, EntityId, TransformComponent } from '@xip/core'
import type { Camera2DComponent, SpriteComponent } from '@xip/renderer'
import type { BoxColliderComponent, CircleColliderComponent } from '@xip/physics'
import { canvasPoint } from '@xip/input'
import { EngineContext, EntityContext, type EngineState } from '../context'

export interface HoverableOptions {
  /** Override the entity ID to hit-test. Defaults to the surrounding <Entity> context. */
  entityId?: EntityId
  /**
   * Custom bounds in world units. If omitted, derived from Sprite → BoxCollider →
   * CircleCollider on the target entity.
   */
  bounds?: { width: number; height: number }
  /** Called once when the pointer enters the entity. */
  onEnter?: (id: EntityId) => void
  /** Called once when the pointer leaves the entity. */
  onLeave?: (id: EntityId) => void
  /** Disable hover tracking entirely. */
  disabled?: boolean
}

export interface HoverableControls {
  /** True while the pointer is over the entity's bounding box. */
  isHovered: boolean
}

/**
 * Reactive "is the pointer over this entity?" state. Hit-tests against the
 * entity's Sprite / BoxCollider / CircleCollider bounds every pointermove,
 * respecting the active Camera2D zoom and pan.
 *
 * Calls `engine.loop.markDirty()` on state change, so in onDemand mode the
 * canvas re-renders automatically (useful for "highlight under cursor" effects).
 *
 * @example
 * ```tsx
 * function Card() {
 *   const { isHovered } = useHoverable({
 *     onEnter: (id) => console.log('enter', id),
 *   })
 *   return (
 *     <Entity>
 *       <Transform x={100} y={100} />
 *       <Sprite src="card.png" width={80} height={120} opacity={isHovered ? 1 : 0.8} />
 *     </Entity>
 *   )
 * }
 * ```
 */
export function useHoverable(options?: HoverableOptions): HoverableControls {
  const engine = useContext(EngineContext)
  const ctxEntityId = useContext(EntityContext)
  const entityId = options?.entityId ?? ctxEntityId
  const [isHovered, setIsHovered] = useState(false)
  // Callers pass inline option objects: read them through a ref so the listeners (and the `hovered`
  // flag they close over) survive re-renders, including the one setIsHovered itself causes.
  const optsRef = useRef(options)
  optsRef.current = options

  useEffect(() => {
    if (!engine || entityId === null || entityId === undefined || options?.disabled) return
    const canvas = engine.canvas
    let hovered = false

    const onMove = (e: PointerEvent) => {
      const t = engine.ecs.getComponent<TransformComponent>(entityId as EntityId, 'Transform')
      if (!t) return
      // Pointer in CSS pixels relative to canvas top-left
      const css = canvasPoint(canvas, e.clientX, e.clientY)
      // Convert to world using camera
      const world = screenToWorld(engine, css.x, css.y)
      if (!world) return
      const custom = optsRef.current?.bounds
      const bounds = custom
        ? { ...custom, ax: 0.5, ay: 0.5, ox: 0, oy: 0, fx: 1, fy: 1 }
        : deriveBounds(engine.ecs, entityId as EntityId)
      if (!bounds) return
      const w = bounds.width * t.scaleX
      const h = bounds.height * t.scaleY
      // Invert the entity's rotation and sprite flips to get renderer-local coordinates.
      const dx = world.x - t.x
      const dy = world.y - t.y
      const cos = Math.cos(-t.rotation)
      const sin = Math.sin(-t.rotation)
      const localX = (dx * cos - dy * sin) * bounds.fx
      const localY = (dx * sin + dy * cos) * bounds.fy
      // The box spans [-anchor * size + offset, (1 - anchor) * size + offset], as the renderer draws it
      const left = -bounds.ax * w + bounds.ox
      const top = -bounds.ay * h + bounds.oy
      const inside =
        localX >= Math.min(left, left + w) &&
        localX <= Math.max(left, left + w) &&
        localY >= Math.min(top, top + h) &&
        localY <= Math.max(top, top + h)

      if (inside && !hovered) {
        hovered = true
        setIsHovered(true)
        optsRef.current?.onEnter?.(entityId as EntityId)
        engine.loop.markDirty()
      } else if (!inside && hovered) {
        hovered = false
        setIsHovered(false)
        optsRef.current?.onLeave?.(entityId as EntityId)
        engine.loop.markDirty()
      }
    }

    const onLeaveCanvas = () => {
      if (hovered) {
        hovered = false
        setIsHovered(false)
        optsRef.current?.onLeave?.(entityId as EntityId)
        engine.loop.markDirty()
      }
    }

    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeaveCanvas)
    return () => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeaveCanvas)
      if (hovered) setIsHovered(false)
    }
  }, [engine, entityId, options?.disabled])

  return { isHovered }
}

// ── Internals ────────────────────────────────────────────────────────────────

interface HitBox {
  width: number
  height: number
  /** Anchor (0 = left/top .. 1 = right/bottom) and draw offset of the box, in the entity's local frame. */
  ax: number
  ay: number
  ox: number
  oy: number
  fx: number
  fy: number
}

function deriveBounds(ecs: ECSWorld, id: EntityId): HitBox | null {
  const sprite = ecs.getComponent<SpriteComponent>(id, 'Sprite')
  if (sprite)
    return {
      width: sprite.width,
      height: sprite.height,
      ax: sprite.anchorX ?? 0.5,
      ay: sprite.anchorY ?? 0.5,
      ox: sprite.offsetX ?? 0,
      oy: sprite.offsetY ?? 0,
      fx: sprite.flipX ? -1 : 1,
      fy: sprite.flipY ? -1 : 1,
    }
  const box = ecs.getComponent<BoxColliderComponent>(id, 'BoxCollider')
  if (box) return { width: box.width, height: box.height, ax: 0.5, ay: 0.5, ox: 0, oy: 0, fx: 1, fy: 1 }
  const circle = ecs.getComponent<CircleColliderComponent>(id, 'CircleCollider')
  if (circle)
    return { width: circle.radius * 2, height: circle.radius * 2, ax: 0.5, ay: 0.5, ox: 0, oy: 0, fx: 1, fy: 1 }
  return null
}

function screenToWorld(engine: EngineState, cssX: number, cssY: number): { x: number; y: number } | null {
  const canvas = engine.canvas
  const camId = engine.ecs.queryOne('Camera2D')
  if (camId === undefined) {
    return { x: cssX - canvas.clientWidth / 2, y: cssY - canvas.clientHeight / 2 }
  }
  const cam = engine.ecs.getComponent<Camera2DComponent>(camId, 'Camera2D')
  if (!cam) return null
  const zoom = cam.zoom
  return {
    x: cam.x + (cssX - canvas.clientWidth / 2) / zoom,
    y: cam.y + (cssY - canvas.clientHeight / 2) / zoom,
  }
}
