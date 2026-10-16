import { useContext, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { ECSWorld, EntityId, TransformComponent } from '@xip/core'
import type { Camera2DComponent, SpriteComponent } from '@xip/renderer'
import type { BoxColliderComponent, CircleColliderComponent } from '@xip/physics'
import { canvasPoint } from '@xip/input'
import { EngineContext, type EngineState } from '../context'
import { useSelection } from '../hooks/useSelection'
import { useOverlayTick } from '../hooks/useOverlayTick'

export interface TransformHandlesProps {
  /** Whether to show the rotation handle above the top edge. Default true. */
  showRotationHandle?: boolean
  /** Whether corner/edge handles can resize the entity (by scaling). Default true. */
  showResizeHandles?: boolean
  /** Whether dragging the body translates the entity. Default true. */
  enableTranslate?: boolean
  /** Color of the selection outline and handles. Default '#4fc3f7'. */
  color?: string
  /** Handle size in CSS pixels. Default 10. */
  handleSize?: number
}

type HandleKind = 'body' | 'rotate' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface DragState {
  kind: HandleKind
  entityId: EntityId
  startPointerX: number
  startPointerY: number
  startTransform: { x: number; y: number; rotation: number; scaleX: number; scaleY: number }
  baseWidth: number
  baseHeight: number
}

interface EntityBounds {
  /** Base unscaled size (before the Transform scale is applied). */
  baseWidth: number
  baseHeight: number
}

/**
 * Renders interactive resize/rotate/move handles for every entity currently in the
 * {@link Selection} context. Handles are positioned via a DOM overlay on top of the
 * game canvas, so they respect CSS cursors (e.g. `nwse-resize`) and are fully
 * styleable.
 *
 * Dragging the body translates, dragging corners/edges scales, and dragging the
 * handle above the top edge rotates. In onDemand loop mode every mutation calls
 * `markDirty()` so the canvas re-renders.
 *
 * @example
 * ```tsx
 * <Stage>
 *   <Selection initial={[cardId]}>
 *     <Entity>…</Entity>
 *     <TransformHandles />
 *   </Selection>
 * </Stage>
 * ```
 */
export function TransformHandles({
  showRotationHandle = true,
  showResizeHandles = true,
  enableTranslate = true,
  color = '#4fc3f7',
  handleSize = 10,
}: TransformHandlesProps) {
  const engine = useContext(EngineContext)
  const selection = useSelection()
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  // Keep the overlay positioned over the canvas every frame. Shares a single rAF
  // with the other DOM overlays (EditableText, A11yNode, VectorPath, FocusRing)
  // so mounting many selected entities doesn't multiply rAF callbacks.
  useOverlayTick(() => {
    if (!engine) return
    const overlay = overlayRef.current
    if (!overlay) return
    const canvas = engine.canvas
    const rect = canvas.getBoundingClientRect()
    overlay.style.left = `${rect.left + window.scrollX}px`
    overlay.style.top = `${rect.top + window.scrollY}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
    for (const id of selection.selected) {
      const node = overlay.querySelector<HTMLDivElement>(`[data-selection-id="${id}"]`)
      if (!node) continue
      const bounds = getEntityBounds(engine.ecs, id)
      const t = engine.ecs.getComponent<TransformComponent>(id, 'Transform')
      if (!bounds || !t) {
        node.style.display = 'none'
        continue
      }
      const screen = worldToScreenCss(engine, t.x, t.y)
      if (!screen) {
        node.style.display = 'none'
        continue
      }
      const w = bounds.baseWidth * Math.abs(t.scaleX) * screen.zoom
      const h = bounds.baseHeight * Math.abs(t.scaleY) * screen.zoom
      node.style.display = 'block'
      node.style.left = `${screen.x}px`
      node.style.top = `${screen.y}px`
      node.style.width = `${w}px`
      node.style.height = `${h}px`
      node.style.transform = `translate(-50%, -50%) rotate(${t.rotation}rad)`
    }
  }, [engine, selection.selected])

  // Pointer drag handlers (window-level so drags continue outside the canvas)
  useEffect(() => {
    if (!engine) return

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const t = engine.ecs.getComponent<TransformComponent>(drag.entityId, 'Transform')
      if (!t) return
      const dxScreen = e.clientX - drag.startPointerX
      const dyScreen = e.clientY - drag.startPointerY
      const zoom = getCameraZoom(engine)
      const dxWorld = dxScreen / zoom
      const dyWorld = dyScreen / zoom

      switch (drag.kind) {
        case 'body': {
          t.x = drag.startTransform.x + dxWorld
          t.y = drag.startTransform.y + dyWorld
          break
        }
        case 'rotate': {
          const screen = worldToScreenCss(engine, drag.startTransform.x, drag.startTransform.y)
          if (!screen) break
          const pointer = canvasPoint(engine.canvas, e.clientX, e.clientY)
          const angle = Math.atan2(pointer.y - screen.y, pointer.x - screen.x)
          // Handle sits above the top edge, so atan2 returns a value 90° less than rotation
          t.rotation = angle + Math.PI / 2
          break
        }
        case 'e':
        case 'w':
        case 'n':
        case 's':
        case 'ne':
        case 'nw':
        case 'se':
        case 'sw': {
          const halfW = (drag.baseWidth / 2) * drag.startTransform.scaleX
          const halfH = (drag.baseHeight / 2) * drag.startTransform.scaleY
          const grabsRight = drag.kind.includes('e')
          const grabsLeft = drag.kind.includes('w')
          const grabsTop = drag.kind.includes('n')
          const grabsBottom = drag.kind.includes('s')
          let newHalfW = halfW
          let newHalfH = halfH
          if (grabsRight) newHalfW = halfW + dxWorld / 2
          if (grabsLeft) newHalfW = halfW - dxWorld / 2
          if (grabsBottom) newHalfH = halfH + dyWorld / 2
          if (grabsTop) newHalfH = halfH - dyWorld / 2
          const minHalf = 2
          newHalfW = Math.max(newHalfW, minHalf)
          newHalfH = Math.max(newHalfH, minHalf)
          const newScaleX = (newHalfW * 2) / drag.baseWidth
          const newScaleY = (newHalfH * 2) / drag.baseHeight
          if (grabsRight || grabsLeft) t.scaleX = newScaleX
          if (grabsTop || grabsBottom) t.scaleY = newScaleY
          // Translate the center so the opposite edge stays fixed
          if (grabsRight) t.x = drag.startTransform.x + (newHalfW - halfW)
          if (grabsLeft) t.x = drag.startTransform.x - (newHalfW - halfW)
          if (grabsBottom) t.y = drag.startTransform.y + (newHalfH - halfH)
          if (grabsTop) t.y = drag.startTransform.y - (newHalfH - halfH)
          break
        }
      }
      engine.loop.markDirty()
    }

    const onUp = () => {
      dragRef.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [engine])

  if (!engine) return null

  const startDrag = (kind: HandleKind, entityId: EntityId) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const t = engine.ecs.getComponent<TransformComponent>(entityId, 'Transform')
    const bounds = getEntityBounds(engine.ecs, entityId)
    if (!t || !bounds) return
    dragRef.current = {
      kind,
      entityId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startTransform: { x: t.x, y: t.y, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY },
      baseWidth: bounds.baseWidth,
      baseHeight: bounds.baseHeight,
    }
  }

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: 10000,
  }

  const handleBaseStyle = (cursor: string): CSSProperties => ({
    position: 'absolute',
    width: handleSize,
    height: handleSize,
    background: '#ffffff',
    border: `1.5px solid ${color}`,
    borderRadius: 2,
    boxSizing: 'border-box',
    pointerEvents: 'auto',
    cursor,
    transform: 'translate(-50%, -50%)',
  })

  return (
    <div ref={overlayRef} style={overlayStyle}>
      {selection.selected.map((id) => (
        <div
          key={id}
          data-selection-id={id}
          style={{
            position: 'absolute',
            border: `1.5px dashed ${color}`,
            boxSizing: 'border-box',
            pointerEvents: enableTranslate ? 'auto' : 'none',
            cursor: enableTranslate ? 'move' : 'default',
            transformOrigin: 'center center',
          }}
          onPointerDown={enableTranslate ? startDrag('body', id) : undefined}
        >
          {showResizeHandles && (
            <>
              <div style={{ ...handleBaseStyle('nwse-resize'), left: 0, top: 0 }} onPointerDown={startDrag('nw', id)} />
              <div
                style={{ ...handleBaseStyle('ns-resize'), left: '50%', top: 0 }}
                onPointerDown={startDrag('n', id)}
              />
              <div
                style={{ ...handleBaseStyle('nesw-resize'), left: '100%', top: 0 }}
                onPointerDown={startDrag('ne', id)}
              />
              <div
                style={{ ...handleBaseStyle('ew-resize'), left: 0, top: '50%' }}
                onPointerDown={startDrag('w', id)}
              />
              <div
                style={{ ...handleBaseStyle('ew-resize'), left: '100%', top: '50%' }}
                onPointerDown={startDrag('e', id)}
              />
              <div
                style={{ ...handleBaseStyle('nesw-resize'), left: 0, top: '100%' }}
                onPointerDown={startDrag('sw', id)}
              />
              <div
                style={{ ...handleBaseStyle('ns-resize'), left: '50%', top: '100%' }}
                onPointerDown={startDrag('s', id)}
              />
              <div
                style={{ ...handleBaseStyle('nwse-resize'), left: '100%', top: '100%' }}
                onPointerDown={startDrag('se', id)}
              />
            </>
          )}
          {showRotationHandle && (
            <div
              style={{
                ...handleBaseStyle('grab'),
                left: '50%',
                top: -24,
                borderRadius: '50%',
                background: color,
                border: '1.5px solid #ffffff',
              }}
              onPointerDown={startDrag('rotate', id)}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Internals ────────────────────────────────────────────────────────────────

function getEntityBounds(ecs: ECSWorld, id: EntityId): EntityBounds | null {
  const sprite = ecs.getComponent<SpriteComponent>(id, 'Sprite')
  if (sprite) return { baseWidth: sprite.width, baseHeight: sprite.height }
  const box = ecs.getComponent<BoxColliderComponent>(id, 'BoxCollider')
  if (box) return { baseWidth: box.width, baseHeight: box.height }
  const circle = ecs.getComponent<CircleColliderComponent>(id, 'CircleCollider')
  if (circle) return { baseWidth: circle.radius * 2, baseHeight: circle.radius * 2 }
  return null
}

function getCameraZoom(engine: EngineState): number {
  const camId = engine.ecs.queryOne('Camera2D')
  if (camId === undefined) return 1
  const cam = engine.ecs.getComponent<Camera2DComponent>(camId, 'Camera2D')
  return cam?.zoom ?? 1
}

/**
 * Convert a world-space position to CSS-pixel coordinates relative to the canvas
 * element's top-left corner. Unlike {@link useCoordinates}, this accounts for the
 * devicePixelRatio by using canvas.clientWidth/clientHeight rather than
 * canvas.width/height. Returns the camera zoom so callers can scale sizes.
 */
function worldToScreenCss(engine: EngineState, wx: number, wy: number): { x: number; y: number; zoom: number } | null {
  const canvas = engine.canvas
  const camId = engine.ecs.queryOne('Camera2D')
  if (camId === undefined) {
    // No camera — treat world coords as canvas-center-relative CSS pixels
    return { x: canvas.clientWidth / 2 + wx, y: canvas.clientHeight / 2 + wy, zoom: 1 }
  }
  const cam = engine.ecs.getComponent<Camera2DComponent>(camId, 'Camera2D')
  if (!cam) return null
  const zoom = cam.zoom
  const x = canvas.clientWidth / 2 + (wx - cam.x) * zoom
  const y = canvas.clientHeight / 2 + (wy - cam.y) * zoom
  return { x, y, zoom }
}
