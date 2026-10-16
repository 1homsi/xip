import { useContext, useEffect, useRef, useState } from 'react'
import type { ECSWorld, EntityId, TransformComponent } from '@xip/core'
import type { Camera2DComponent, SpriteComponent } from '@xip/renderer'
import type { BoxColliderComponent, CircleColliderComponent } from '@xip/physics'
import { canvasPoint } from '@xip/input'
import { EngineContext, EntityContext, type EngineState } from '../context'
import type { SnapControls } from './useSnap'

// ── Per-engine drag state ────────────────────────────────────────────────────
//
// Each EngineState has its own active-drag slot so that multiple <Stage> or
// <Game> instances on the same page don't cross-contaminate drags. We key into
// a WeakMap so engines don't need to explicitly unregister on teardown.

interface ActiveDrag {
  entityId: EntityId
  /** The pointer that owns this drag (a cancel of any other pointer is not ours). */
  pointerId: number
  tag: string | null
  pointerX: number
  pointerY: number
  worldX: number
  worldY: number
  subscribers: Set<() => void>
}

const dragStateByEngine = new WeakMap<EngineState, ActiveDrag | null>()

function getActiveDrag(engine: EngineState): ActiveDrag | null {
  return dragStateByEngine.get(engine) ?? null
}

function setActiveDrag(engine: EngineState, drag: ActiveDrag | null): void {
  dragStateByEngine.set(engine, drag)
}

function notifyDragSubscribers(engine: EngineState) {
  const drag = dragStateByEngine.get(engine)
  if (!drag) return
  for (const cb of drag.subscribers) cb()
}

function subscribeToActiveDrag(engine: EngineState, cb: () => void): () => void {
  const drag = dragStateByEngine.get(engine)
  if (!drag) return () => undefined
  drag.subscribers.add(cb)
  return () => dragStateByEngine.get(engine)?.subscribers.delete(cb)
}

// ── useDraggable ─────────────────────────────────────────────────────────────

export interface DraggableOptions {
  /** Override the entity ID to drag. Defaults to the surrounding <Entity> context. */
  entityId?: EntityId
  /**
   * A "tag" string that droppables can filter on via their `accepts` list.
   * E.g. `tag: 'card'` + droppable `accepts: ['card', 'token']`.
   */
  tag?: string
  /** Constrain dragging to a world-space rectangle. */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number }
  /**
   * Optional snap control from {@link useSnap}. While dragging, the entity's
   * position will be passed through `snap.snap(x, y)` before being written back.
   */
  snap?: SnapControls
  /** Called when the drag begins. */
  onDragStart?: (info: { entityId: EntityId; x: number; y: number }) => void
  /** Called on every pointermove during the drag. */
  onDrag?: (info: { entityId: EntityId; x: number; y: number }) => void
  /** Called when the drag ends (pointerup). */
  onDragEnd?: (info: { entityId: EntityId; x: number; y: number; droppedOn: EntityId | null }) => void
  /**
   * Called instead of `onDragEnd` when the browser cancels the pointer mid-drag (it took over the touch
   * for a scroll or system gesture). The entity is put back where the drag started and nothing is dropped.
   */
  onDragCancel?: (info: { entityId: EntityId; x: number; y: number }) => void
  /** Disable dragging. */
  disabled?: boolean
}

export interface DraggableControls {
  /** True while a drag is in progress on this entity. */
  isDragging: boolean
  /** Current world-space position of the dragged entity. */
  position: { x: number; y: number }
}

/**
 * Pointer-driven drag for an entity. Attach to any entity with a Transform and
 * a Sprite/BoxCollider/CircleCollider (for hit-testing the initial grab).
 *
 * On pointerdown over the entity's bounds, dragging begins. Subsequent
 * pointermoves update the entity's Transform. On pointerup, the drag ends and
 * the `droppedOn` field of {@link onDragEnd} reports which {@link useDroppable}
 * (if any) is under the pointer.
 *
 * @example
 * ```tsx
 * function Card() {
 *   const snap = useSnap({ grid: 32 })
 *   const { isDragging } = useDraggable({ snap, tag: 'card' })
 *   return (
 *     <Entity>
 *       <Transform x={100} y={100} />
 *       <Sprite src="card.png" width={64} height={96} opacity={isDragging ? 0.6 : 1} />
 *     </Entity>
 *   )
 * }
 * ```
 */
export function useDraggable(options?: DraggableOptions): DraggableControls {
  const engine = useContext(EngineContext)
  const ctxEntityId = useContext(EntityContext)
  const entityId = options?.entityId ?? ctxEntityId
  const [isDragging, setIsDragging] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const optsRef = useRef(options)
  optsRef.current = options

  useEffect(() => {
    if (!engine || entityId === null || entityId === undefined || options?.disabled) return
    const canvas = engine.canvas
    let dragging = false
    let pointerId = -1
    let startEntityX = 0
    let startEntityY = 0
    let startWorldX = 0
    let startWorldY = 0

    const onPointerDown = (e: PointerEvent) => {
      const t = engine.ecs.getComponent<TransformComponent>(entityId as EntityId, 'Transform')
      if (!t) return
      const css = canvasPoint(canvas, e.clientX, e.clientY)
      const world = screenToWorld(engine, css.x, css.y)
      if (!world) return
      const bounds = deriveBounds(engine.ecs, entityId as EntityId)
      if (!bounds) return
      const halfW = (bounds.width * Math.abs(t.scaleX)) / 2
      const halfH = (bounds.height * Math.abs(t.scaleY)) / 2
      if (Math.abs(world.x - t.x) > halfW || Math.abs(world.y - t.y) > halfH) return

      e.stopPropagation()
      dragging = true
      pointerId = e.pointerId
      startEntityX = t.x
      startEntityY = t.y
      startWorldX = world.x
      startWorldY = world.y
      setActiveDrag(engine, {
        entityId: entityId as EntityId,
        pointerId: e.pointerId,
        tag: optsRef.current?.tag ?? null,
        pointerX: e.clientX,
        pointerY: e.clientY,
        worldX: world.x,
        worldY: world.y,
        subscribers: new Set(),
      })
      setIsDragging(true)
      setPosition({ x: t.x, y: t.y })
      optsRef.current?.onDragStart?.({ entityId: entityId as EntityId, x: t.x, y: t.y })
      engine.loop.markDirty()
    }

    const onPointerMove = (e: PointerEvent) => {
      const drag = getActiveDrag(engine)
      if (!dragging || !drag || e.pointerId !== pointerId) return
      const t = engine.ecs.getComponent<TransformComponent>(entityId as EntityId, 'Transform')
      if (!t) return
      const css = canvasPoint(canvas, e.clientX, e.clientY)
      const world = screenToWorld(engine, css.x, css.y)
      if (!world) return
      let nx = startEntityX + (world.x - startWorldX)
      let ny = startEntityY + (world.y - startWorldY)
      const snap = optsRef.current?.snap
      if (snap) {
        const s = snap.snap(nx, ny)
        nx = s.x
        ny = s.y
      }
      const b = optsRef.current?.bounds
      if (b) {
        nx = Math.max(b.minX, Math.min(b.maxX, nx))
        ny = Math.max(b.minY, Math.min(b.maxY, ny))
      }
      t.x = nx
      t.y = ny
      drag.pointerX = e.clientX
      drag.pointerY = e.clientY
      drag.worldX = world.x
      drag.worldY = world.y
      notifyDragSubscribers(engine)
      setPosition({ x: nx, y: ny })
      optsRef.current?.onDrag?.({ entityId: entityId as EntityId, x: nx, y: ny })
      engine.loop.markDirty()
    }

    const onPointerCancel = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return
      dragging = false
      const t = engine.ecs.getComponent<TransformComponent>(entityId as EntityId, 'Transform')
      if (t) {
        t.x = startEntityX
        t.y = startEntityY
      }
      setActiveDrag(engine, null)
      setIsDragging(false)
      setPosition({ x: startEntityX, y: startEntityY })
      optsRef.current?.onDragCancel?.({ entityId: entityId as EntityId, x: startEntityX, y: startEntityY })
      engine.loop.markDirty()
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return
      dragging = false
      const t = engine.ecs.getComponent<TransformComponent>(entityId as EntityId, 'Transform')
      const drag = getActiveDrag(engine)
      const droppedOn = findDroppableUnder(engine, drag)
      const finalX = t?.x ?? startEntityX
      const finalY = t?.y ?? startEntityY
      setActiveDrag(engine, null)
      setIsDragging(false)
      optsRef.current?.onDragEnd?.({
        entityId: entityId as EntityId,
        x: finalX,
        y: finalY,
        droppedOn,
      })
      engine.loop.markDirty()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [engine, entityId, options?.disabled])

  return { isDragging, position }
}

// ── useDroppable ─────────────────────────────────────────────────────────────

export interface DroppableOptions {
  /** Override the entity ID acting as the drop zone. Defaults to <Entity> context. */
  entityId?: EntityId
  /**
   * Tags this zone will accept. If omitted, accepts any drag. If set, only drags
   * whose `useDraggable` was configured with a matching `tag` can land here.
   */
  accepts?: string[]
  /** Override the drop-zone bounds in world units. */
  bounds?: { width: number; height: number }
  /** Called when an acceptable drag is released over this zone. */
  onDrop?: (info: { droppedEntityId: EntityId; x: number; y: number }) => void
  /** Called when an acceptable drag enters the zone. */
  onEnter?: (info: { droppedEntityId: EntityId }) => void
  /** Called when an acceptable drag leaves the zone. */
  onLeave?: (info: { droppedEntityId: EntityId }) => void
  /** Disable this drop zone. */
  disabled?: boolean
}

export interface DroppableControls {
  /** True while an acceptable drag is hovering over this zone. */
  isOver: boolean
  /** The entity ID of the drag currently hovering, or null. */
  hoveredBy: EntityId | null
}

/**
 * A drop zone for drag-and-drop. Pair with {@link useDraggable} to build
 * puzzle games, card games, inventory systems, level editors, and more.
 *
 * @example
 * ```tsx
 * function Foundation() {
 *   const { isOver } = useDroppable({
 *     accepts: ['card'],
 *     onDrop: ({ droppedEntityId }) => placeCard(droppedEntityId),
 *   })
 *   return (
 *     <Entity>
 *       <BoxCollider width={80} height={120} />
 *       <Sprite color={isOver ? '#4fc3f7' : '#333'} width={80} height={120} />
 *     </Entity>
 *   )
 * }
 * ```
 */
export function useDroppable(options?: DroppableOptions): DroppableControls {
  const engine = useContext(EngineContext)
  const ctxEntityId = useContext(EntityContext)
  const entityId = options?.entityId ?? ctxEntityId
  const [isOver, setIsOver] = useState(false)
  const [hoveredBy, setHoveredBy] = useState<EntityId | null>(null)
  const optsRef = useRef(options)
  optsRef.current = options

  useEffect(() => {
    if (!engine || entityId === null || entityId === undefined || options?.disabled) return
    let currentlyOver = false
    let hoveredId: EntityId | null = null

    const check = () => {
      const drag = getActiveDrag(engine)
      if (!drag) {
        if (currentlyOver) {
          currentlyOver = false
          setIsOver(false)
          const prev = hoveredBy
          setHoveredBy(null)
          if (prev !== null) optsRef.current?.onLeave?.({ droppedEntityId: prev })
        }
        return
      }
      const accepts = optsRef.current?.accepts
      if (accepts && (!drag.tag || !accepts.includes(drag.tag))) return

      const t = engine.ecs.getComponent<TransformComponent>(entityId as EntityId, 'Transform')
      if (!t) return
      const bounds = optsRef.current?.bounds ?? deriveBounds(engine.ecs, entityId as EntityId)
      if (!bounds) return
      const halfW = (bounds.width * Math.abs(t.scaleX)) / 2
      const halfH = (bounds.height * Math.abs(t.scaleY)) / 2
      const inside = Math.abs(drag.worldX - t.x) <= halfW && Math.abs(drag.worldY - t.y) <= halfH
      const dragId = drag.entityId

      if (inside && !currentlyOver) {
        currentlyOver = true
        hoveredId = dragId
        setIsOver(true)
        setHoveredBy(dragId)
        optsRef.current?.onEnter?.({ droppedEntityId: dragId })
      } else if (!inside && currentlyOver) {
        currentlyOver = false
        setIsOver(false)
        setHoveredBy(null)
        optsRef.current?.onLeave?.({ droppedEntityId: dragId })
      }
    }

    const unsubscribe = subscribeToActiveDrag(engine, check)

    // Also check on pointerup so onDrop fires
    const onUp = () => {
      const drag = getActiveDrag(engine)
      if (!drag || !currentlyOver) return
      const dragId = drag.entityId
      const dragX = drag.worldX
      const dragY = drag.worldY
      currentlyOver = false
      setIsOver(false)
      setHoveredBy(null)
      optsRef.current?.onDrop?.({ droppedEntityId: dragId, x: dragX, y: dragY })
    }
    // A cancelled pointer drops nothing: leave the zone without onDrop.
    const onCancel = (e: PointerEvent) => {
      if (!currentlyOver) return
      const owner = getActiveDrag(engine)
      if (owner && owner.pointerId !== e.pointerId) return
      const dragId = hoveredId ?? getActiveDrag(engine)?.entityId ?? null
      currentlyOver = false
      setIsOver(false)
      setHoveredBy(null)
      if (dragId !== null) optsRef.current?.onLeave?.({ droppedEntityId: dragId })
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)

    return () => {
      unsubscribe()
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    // hoveredBy intentionally excluded — we want stable subscribe lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, entityId, options?.disabled])

  return { isOver, hoveredBy }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function deriveBounds(ecs: ECSWorld, id: EntityId): { width: number; height: number } | null {
  const sprite = ecs.getComponent<SpriteComponent>(id, 'Sprite')
  if (sprite) return { width: sprite.width, height: sprite.height }
  const box = ecs.getComponent<BoxColliderComponent>(id, 'BoxCollider')
  if (box) return { width: box.width, height: box.height }
  const circle = ecs.getComponent<CircleColliderComponent>(id, 'CircleCollider')
  if (circle) return { width: circle.radius * 2, height: circle.radius * 2 }
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

function findDroppableUnder(engine: EngineState, drag: ActiveDrag | null): EntityId | null {
  if (!drag) return null
  // Walk all entities that have a Transform and either a Sprite or a collider,
  // skip the dragged entity itself. First match wins (top-of-stack drop target).
  const entities = engine.ecs.query('Transform')
  for (let i = entities.length - 1; i >= 0; i--) {
    const id = entities[i]
    if (id === drag.entityId) continue
    const t = engine.ecs.getComponent<TransformComponent>(id, 'Transform')
    if (!t) continue
    const bounds = deriveBounds(engine.ecs, id)
    if (!bounds) continue
    const halfW = (bounds.width * Math.abs(t.scaleX)) / 2
    const halfH = (bounds.height * Math.abs(t.scaleY)) / 2
    if (Math.abs(drag.worldX - t.x) <= halfW && Math.abs(drag.worldY - t.y) <= halfH) {
      return id
    }
  }
  return null
}
