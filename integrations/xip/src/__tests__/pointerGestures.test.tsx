// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { ECSWorld, EventBus, AssetManager, createTransform, createEngineStats } from '@xip/core'
import { EngineContext, type EngineState } from '../context'
import { useDraggable, useDroppable } from '../hooks/useDragDrop'
import { useGestures } from '../hooks/useGestures'

function makeEngine(): EngineState {
  const canvas = document.createElement('canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 200 })
  Object.defineProperty(canvas, 'clientHeight', { value: 100 })
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect
  const stats = createEngineStats()
  return {
    ecs: new ECSWorld(),
    events: new EventBus(),
    assets: new AssetManager(),
    input: {} as never,
    physics: {} as never,
    loop: { markDirty: vi.fn() } as never,
    canvas,
    entityIds: new Map(),
    systemTimings: new Map(),
    postProcessStack: {} as never,
    stats,
    getStats: () => stats,
  }
}

const pe = (type: string, pointerId: number, clientX: number, clientY: number) =>
  new PointerEvent(type, { pointerId, clientX, clientY, bubbles: true })

describe('useDraggable with several pointers', () => {
  it('ignores moves and releases from a pointer that did not start the drag', () => {
    const engine = makeEngine()
    const id = engine.ecs.createEntity()
    engine.ecs.addComponent(id, createTransform(0, 0))
    engine.ecs.addComponent(id, { type: 'BoxCollider', width: 20, height: 20 } as never)
    const onDragEnd = vi.fn()
    function D() {
      useDraggable({ entityId: id, onDragEnd })
      return null
    }
    render(
      <EngineContext.Provider value={engine}>
        <D />
      </EngineContext.Provider>,
    )
    const t = engine.ecs.getComponent<{ type: string; x: number; y: number }>(id, 'Transform')!
    act(() => {
      engine.canvas.dispatchEvent(pe('pointerdown', 1, 100, 50))
      window.dispatchEvent(pe('pointermove', 1, 110, 50))
    })
    expect(t.x).toBe(10)
    act(() => {
      window.dispatchEvent(pe('pointermove', 2, 180, 90))
      window.dispatchEvent(pe('pointerup', 2, 180, 90))
    })
    expect(t.x).toBe(10)
    expect(onDragEnd).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(pe('pointerup', 1, 110, 50)))
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })
})

describe('pointercancel is not a release', () => {
  function world() {
    const engine = makeEngine()
    const id = engine.ecs.createEntity()
    engine.ecs.addComponent(id, createTransform(0, 0))
    engine.ecs.addComponent(id, { type: 'BoxCollider', width: 20, height: 20 } as never)
    const zone = engine.ecs.createEntity()
    engine.ecs.addComponent(zone, createTransform(50, 0))
    engine.ecs.addComponent(zone, { type: 'BoxCollider', width: 40, height: 40 } as never)
    return { engine, id, zone }
  }

  // A drop zone subscribes to the drag that is active when it mounts, so it is mounted after the press.
  function mountDrag(engine: EngineState, id: number, zone: number, cbs: Record<string, ReturnType<typeof vi.fn>>) {
    function Drag() {
      useDraggable({ entityId: id, onDragEnd: cbs.onDragEnd, onDragCancel: cbs.onDragCancel })
      return null
    }
    function Zone() {
      useDroppable({ entityId: zone, onDrop: cbs.onDrop, onLeave: cbs.onLeave })
      return null
    }
    const ui = (withZone: boolean) => (
      <EngineContext.Provider value={engine}>
        <Drag />
        {withZone && <Zone />}
      </EngineContext.Provider>
    )
    const view = render(ui(false))
    act(() => {
      engine.canvas.dispatchEvent(pe('pointerdown', 1, 100, 50))
    })
    view.rerender(ui(true))
  }

  const cbs = () => ({ onDragEnd: vi.fn(), onDragCancel: vi.fn(), onDrop: vi.fn(), onLeave: vi.fn() })

  it('a cancelled drag reverts, reports onDragCancel and fires neither onDragEnd nor onDrop', () => {
    const { engine, id, zone } = world()
    const c = cbs()
    mountDrag(engine, id, zone, c)
    const t = engine.ecs.getComponent<{ type: string; x: number; y: number }>(id, 'Transform')!
    act(() => window.dispatchEvent(pe('pointermove', 1, 150, 50))) // over the drop zone
    expect(t.x).toBe(50)
    act(() => window.dispatchEvent(pe('pointercancel', 1, 150, 50)))
    expect(c.onDragEnd).not.toHaveBeenCalled()
    expect(c.onDrop).not.toHaveBeenCalled()
    expect(c.onDragCancel).toHaveBeenCalledWith({ entityId: id, x: 0, y: 0 })
    expect(c.onLeave).toHaveBeenCalledTimes(1)
    expect(t.x).toBe(0)
    expect(c.onLeave).toHaveBeenCalledTimes(1)
    // the drag is over: a later pointerup of the same pointer does nothing
    act(() => window.dispatchEvent(pe('pointerup', 1, 150, 50)))
    expect(c.onDragEnd).not.toHaveBeenCalled()
    expect(c.onDrop).not.toHaveBeenCalled()
  })

  it('ignores the cancel of a pointer that does not own the drag', () => {
    const { engine, id, zone } = world()
    const c = cbs()
    mountDrag(engine, id, zone, c)
    const t = engine.ecs.getComponent<{ type: string; x: number; y: number }>(id, 'Transform')!
    act(() => window.dispatchEvent(pe('pointermove', 1, 150, 50)))
    act(() => window.dispatchEvent(pe('pointercancel', 2, 10, 10))) // a palm touch, not the dragging finger
    expect(c.onDragCancel).not.toHaveBeenCalled()
    expect(c.onLeave).not.toHaveBeenCalled()
    expect(t.x).toBe(50)
    act(() => window.dispatchEvent(pe('pointerup', 1, 150, 50)))
    expect(c.onDragEnd).toHaveBeenCalledWith(expect.objectContaining({ droppedOn: zone }))
  })

  it('a released drag still ends with onDragEnd (guards the cancel split)', () => {
    const { engine, id, zone } = world()
    const c = cbs()
    mountDrag(engine, id, zone, c)
    act(() => {
      window.dispatchEvent(pe('pointermove', 1, 150, 50))
      window.dispatchEvent(pe('pointerup', 1, 150, 50))
    })
    expect(c.onDragEnd).toHaveBeenCalledWith(expect.objectContaining({ droppedOn: zone }))
    expect(c.onDragCancel).not.toHaveBeenCalled()
  })
})

function touchEvent(type: string, changed: [number, number, number][], all: [number, number, number][]) {
  const mk = ([identifier, clientX, clientY]: [number, number, number]) => ({ identifier, clientX, clientY })
  const e = new Event(type) as Event & { changedTouches: unknown; touches: unknown }
  e.changedTouches = changed.map(mk)
  e.touches = all.map(mk)
  return e
}

describe('useGestures', () => {
  it('reports pinch scale and does not turn a pinch into a swipe', () => {
    const onSwipe = vi.fn()
    const onPinch = vi.fn()
    function G() {
      useGestures({ onSwipe, onPinch })
      return null
    }
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 50))
    const { unmount } = render(<G />)
    act(() => {
      window.dispatchEvent(touchEvent('touchstart', [[1, 100, 100]], [[1, 100, 100]]))
      window.dispatchEvent(
        touchEvent(
          'touchstart',
          [[2, 120, 100]],
          [
            [1, 100, 100],
            [2, 120, 100],
          ],
        ),
      )
      window.dispatchEvent(
        touchEvent(
          'touchmove',
          [
            [1, 20, 100],
            [2, 200, 100],
          ],
          [
            [1, 20, 100],
            [2, 200, 100],
          ],
        ),
      )
      window.dispatchEvent(touchEvent('touchend', [[1, 20, 100]], [[2, 200, 100]]))
      window.dispatchEvent(touchEvent('touchend', [[2, 200, 100]], []))
    })
    expect(onPinch).toHaveBeenLastCalledWith({ scale: 9, delta: 8 })
    expect(onSwipe).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(touchEvent('touchstart', [[3, 100, 100]], [[3, 100, 100]]))
      window.dispatchEvent(touchEvent('touchend', [[3, 300, 100]], []))
    })
    expect(onSwipe).toHaveBeenCalledWith(expect.objectContaining({ direction: 'right', distance: 200 }))

    const remove = vi.spyOn(window, 'removeEventListener')
    unmount()
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(['touchcancel', 'touchend', 'touchmove', 'touchstart'])
  })
})
