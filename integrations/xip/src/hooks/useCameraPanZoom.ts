import { useEffect, useRef } from 'react'
import type { Camera2DComponent } from '@xip/renderer'
import { canvasPoint } from '@xip/input'
import { useGame } from './useGame'

export interface CameraPanZoomOptions {
  enabled?: boolean
  minZoom?: number
  maxZoom?: number
  /** Zoom factor per wheel pixel (exponential). Default 0.0015. */
  wheelSpeed?: number
  /** Keep gliding after a drag. Default true. */
  inertia?: boolean
  /** Velocity kept per 1/60 s while gliding, 0..1. Default 0.92. */
  friction?: number
  /** Mouse buttons that pan. Default [0, 1, 2]. */
  buttons?: number[]
  /** Pointer travel (CSS px) before a press becomes a drag instead of a tap. Default 6. */
  dragThreshold?: number
  /**
   * Largest wheel delta in pixels used for one event, so a fast spin or a high-resolution wheel
   * zooms a bounded step. Default 150; `Infinity` disables the clamp.
   */
  wheelMaxDelta?: number
  /** Pixels per line for line-mode wheel events (`deltaMode` 1). Default 16. */
  lineHeight?: number
  /** Pixels per page for page-mode wheel events (`deltaMode` 2). Default: the canvas height. */
  pageHeight?: number
  /** CSS `touch-action` set on the canvas while mounted. Default `'none'` (the hook handles every gesture). */
  touchAction?: string
  /**
   * Called at most once per frame after the hook moved or zoomed the camera (drag, glide, pinch,
   * wheel), after the engine rendered that frame, so camera bounds are already applied. Lets
   * apps update UI without polling the camera every frame.
   */
  onChange?: (camera: { x: number; y: number; zoom: number }) => void
  /** Press released without dragging, in canvas CSS px and world units. */
  onTap?: (e: { screenX: number; screenY: number; worldX: number; worldY: number; button: number }) => void
}

interface Ptr {
  /** Latest position. */
  x: number
  y: number
  /** Press position. */
  sx: number
  sy: number
  /** Position the camera has been panned to so far (a drag catches up from here). */
  ax: number
  ay: number
}

/**
 * Mouse + touch camera control on the game canvas: drag to pan (with inertia),
 * wheel and pinch zoom around the cursor / fingers, and tap detection for
 * selection. Works with `<Camera2D pixelSnap>` and camera bounds.
 */
export function useCameraPanZoom(options: CameraPanZoomOptions = {}): void {
  const engine = useGame()
  const opts = useRef(options)
  opts.current = options

  useEffect(() => {
    const canvas = engine.canvas
    const ptrs = new Map<number, Ptr>()
    let dragging = false
    let pinchDist = 0
    let vx = 0
    let vy = 0
    let lastMove = 0
    let glide = 0
    let notifyFrame = 0

    const cam = (): Camera2DComponent | undefined => {
      const id = engine.ecs.queryOne('Camera2D')
      return id === undefined ? undefined : engine.ecs.getComponent<Camera2DComponent>(id, 'Camera2D')
    }
    const local = (e: { clientX: number; clientY: number }) => canvasPoint(canvas, e.clientX, e.clientY)
    const size = () => ({ w: canvas.clientWidth || canvas.width, h: canvas.clientHeight || canvas.height })
    const clampZoom = (z: number) => Math.min(opts.current.maxZoom ?? 4, Math.max(opts.current.minZoom ?? 0.05, z))

    const zoomAt = (c: Camera2DComponent, sx: number, sy: number, zoom: number) => {
      const { w, h } = size()
      const z = clampZoom(zoom)
      const dx = sx - w / 2
      const dy = sy - h / 2
      c.x += dx / c.zoom - dx / z
      c.y += dy / c.zoom - dy / z
      c.zoom = z
    }
    // The camera changed: wake the loop, then report once per frame. The report is queued after
    // markDirty() so it runs behind the engine's frame and sees bounds/follow already applied.
    const changed = () => {
      engine.loop.markDirty()
      if (notifyFrame || !opts.current.onChange) return
      notifyFrame = requestAnimationFrame(() => {
        notifyFrame = 0
        const c = cam()
        if (!c) return
        opts.current.onChange?.({ x: c.x, y: c.y, zoom: c.zoom })
      })
    }
    const stopGlide = () => {
      if (glide) cancelAnimationFrame(glide)
      glide = 0
    }

    const onDown = (e: PointerEvent) => {
      if (opts.current.enabled === false) return
      if (e.pointerType === 'mouse' && !(opts.current.buttons ?? [0, 1, 2]).includes(e.button)) return
      stopGlide()
      const p = local(e)
      ptrs.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, ax: p.x, ay: p.y })
      canvas.setPointerCapture?.(e.pointerId)
      vx = vy = 0
      lastMove = performance.now()
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()]
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
        dragging = true
      }
    }

    const onMove = (e: PointerEvent) => {
      const p = ptrs.get(e.pointerId)
      if (!p) return
      const c = cam()
      const q = local(e)
      if (!dragging && Math.hypot(q.x - p.sx, q.y - p.sy) >= (opts.current.dragThreshold ?? 6)) dragging = true
      // Not dragging yet: remember the position but leave `ax/ay` at the press point, so the
      // travel before the threshold is applied on the first dragged frame.
      if (!c || !dragging) {
        p.x = q.x
        p.y = q.y
        return
      }
      if (ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()]
        const midX0 = (a.x + b.x) / 2
        const midY0 = (a.y + b.y) / 2
        p.x = q.x
        p.y = q.y
        p.ax = q.x
        p.ay = q.y
        const midX = (a.x + b.x) / 2
        const midY = (a.y + b.y) / 2
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        c.x -= (midX - midX0) / c.zoom
        c.y -= (midY - midY0) / c.zoom
        if (pinchDist > 0) zoomAt(c, midX, midY, (c.zoom * dist) / pinchDist)
        pinchDist = dist
        vx = vy = 0
      } else {
        const dx = (q.x - p.ax) / c.zoom
        const dy = (q.y - p.ay) / c.zoom
        p.x = p.ax = q.x
        p.y = p.ay = q.y
        c.x -= dx
        c.y -= dy
        const now = performance.now()
        const dt = Math.max(1, now - lastMove) / 1000
        lastMove = now
        // Smoothed release velocity in world units / s.
        vx = vx * 0.6 + (-dx / dt) * 0.4
        vy = vy * 0.6 + (-dy / dt) * 0.4
      }
      changed()
    }

    // A cancelled pointer (the browser took over the touch: scroll, system gesture, palm rejection) ends
    // the gesture without a tap and without a fling: nothing the user did was meant as a click.
    const end = (e: PointerEvent, cancelled: boolean) => {
      const p = ptrs.get(e.pointerId)
      if (!p) return
      ptrs.delete(e.pointerId)
      canvas.releasePointerCapture?.(e.pointerId)
      if (ptrs.size === 1) {
        // Continue as a one-finger pan from where the remaining finger is.
        pinchDist = 0
        vx = vy = 0
        const rest = [...ptrs.values()][0]
        rest.ax = rest.x
        rest.ay = rest.y
        return
      }
      if (ptrs.size > 0) return
      const c = cam()
      if (!cancelled && !dragging && c && opts.current.onTap) {
        const { w, h } = size()
        opts.current.onTap({
          screenX: p.x,
          screenY: p.y,
          worldX: c.x + (p.x - w / 2) / c.zoom,
          worldY: c.y + (p.y - h / 2) / c.zoom,
          button: e.button,
        })
      }
      const idle = performance.now() - lastMove > 80
      if (!cancelled && dragging && c && opts.current.inertia !== false && !idle && Math.hypot(vx, vy) > 20) {
        let last = performance.now()
        const step = () => {
          const now = performance.now()
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          const k = Math.pow(opts.current.friction ?? 0.92, dt * 60)
          vx *= k
          vy *= k
          c.x += vx * dt
          c.y += vy * dt
          changed()
          glide = Math.hypot(vx, vy) > 5 ? requestAnimationFrame(step) : 0
        }
        glide = requestAnimationFrame(step)
      }
      dragging = false
    }
    const onUp = (e: PointerEvent) => end(e, false)
    const onCancel = (e: PointerEvent) => end(e, true)

    const onWheel = (e: WheelEvent) => {
      if (opts.current.enabled === false) return
      const c = cam()
      if (!c) return
      e.preventDefault()
      stopGlide()
      const o = opts.current
      const raw =
        e.deltaMode === 1
          ? e.deltaY * (o.lineHeight ?? 16)
          : e.deltaMode === 2
            ? e.deltaY * (o.pageHeight ?? size().h)
            : e.deltaY
      const max = o.wheelMaxDelta ?? 150
      const px = Math.max(-max, Math.min(max, raw))
      const p = local(e)
      zoomAt(c, p.x, p.y, c.zoom * Math.exp(-px * (o.wheelSpeed ?? 0.0015)))
      changed()
    }

    const prevTouchAction = canvas.style.touchAction
    canvas.style.touchAction = opts.current.touchAction ?? 'none'
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stopGlide()
      if (notifyFrame) cancelAnimationFrame(notifyFrame)
      notifyFrame = 0
      canvas.style.touchAction = prevTouchAction
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [engine])
}
