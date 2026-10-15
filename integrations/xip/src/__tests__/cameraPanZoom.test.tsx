import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { ECSWorld } from '@xip/core'
import { createCamera2D, type Camera2DComponent } from '@xip/renderer'
import { EngineContext, type EngineState } from '../context'
import { useCameraPanZoom, type CameraPanZoomOptions } from '../hooks/useCameraPanZoom'

function setup(options: CameraPanZoomOptions = {}) {
  const ecs = new ECSWorld()
  const id = ecs.createEntity()
  ecs.addComponent(id, createCamera2D({ x: 0, y: 0, zoom: 1 }))
  const canvas = document.createElement('canvas')
  canvas.width = 800
  canvas.height = 600
  const engine = { ecs, canvas, loop: { markDirty: vi.fn() } } as unknown as EngineState
  function Probe() {
    useCameraPanZoom(options)
    return null
  }
  const view = render(
    <EngineContext.Provider value={engine}>
      <Probe />
    </EngineContext.Provider>,
  )
  const cam = ecs.getComponent<Camera2DComponent>(id, 'Camera2D')!
  const ptr = (type: string, x: number, y: number, pointerId = 1) =>
    act(() => {
      canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId, button: 0, bubbles: true }))
    })
  const wheel = (deltaY: number, x: number, y: number, deltaMode = 0) =>
    act(() => {
      const e = new WheelEvent('wheel', { deltaY, deltaMode, cancelable: true })
      Object.defineProperty(e, 'clientX', { value: x })
      Object.defineProperty(e, 'clientY', { value: y })
      canvas.dispatchEvent(e)
    })
  return { cam, canvas, ptr, view, wheel }
}

describe('useCameraPanZoom', () => {
  it('drag pans the camera opposite to the pointer, scaled by zoom', () => {
    const { cam, ptr } = setup({ inertia: false })
    cam.zoom = 2
    ptr('pointerdown', 100, 100)
    ptr('pointermove', 140, 120)
    ptr('pointerup', 140, 120)
    expect(cam.x).toBeCloseTo(-20)
    expect(cam.y).toBeCloseTo(-10)
  })

  it('a press without movement is a tap with world coordinates, not a pan', () => {
    const onTap = vi.fn()
    const { cam, ptr } = setup({ onTap })
    cam.x = 50
    ptr('pointerdown', 500, 300)
    ptr('pointermove', 502, 301)
    ptr('pointerup', 502, 301)
    expect(cam.x).toBe(50)
    expect(onTap).toHaveBeenCalledWith(expect.objectContaining({ worldX: 50 + 102, worldY: 1 }))
  })

  it('a cancelled pointer is not a tap and does not fling', () => {
    const onTap = vi.fn()
    const { ptr } = setup({ onTap })
    ptr('pointerdown', 500, 300)
    ptr('pointercancel', 500, 300)
    expect(onTap).not.toHaveBeenCalled()
    // a fresh press-release afterwards is still a tap
    ptr('pointerdown', 500, 300)
    ptr('pointerup', 500, 300)
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('a cancelled drag keeps the pan so far but starts no inertia glide', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1)
    try {
      const { cam, ptr } = setup()
      ptr('pointerdown', 100, 100)
      ptr('pointermove', 140, 100)
      ptr('pointermove', 180, 100)
      expect(cam.x).toBeCloseTo(-80) // the drag moved the camera
      ptr('pointercancel', 180, 100)
      expect(cam.x).toBeCloseTo(-80)
      expect(raf).not.toHaveBeenCalled()
      // control: the same drag released normally does glide
      ptr('pointerdown', 100, 100)
      ptr('pointermove', 140, 100)
      ptr('pointermove', 180, 100)
      ptr('pointerup', 180, 100)
      expect(raf).toHaveBeenCalled()
    } finally {
      raf.mockRestore()
    }
  })

  it('cancelling one finger of a pinch hands over to a one-finger pan: no tap, no jump', () => {
    const onTap = vi.fn()
    const { cam, ptr } = setup({ onTap, inertia: false })
    ptr('pointerdown', 300, 300, 1)
    ptr('pointerdown', 500, 300, 2)
    ptr('pointermove', 600, 300, 2)
    ptr('pointercancel', 600, 300, 2)
    const x = cam.x
    const zoom = cam.zoom
    ptr('pointermove', 310, 300, 1) // the remaining finger pans from where it is
    expect(cam.zoom).toBe(zoom)
    expect(cam.x).toBeCloseTo(x - 10)
    ptr('pointerup', 310, 300, 1)
    expect(onTap).not.toHaveBeenCalled()
    ptr('pointercancel', 5, 5, 9) // a pointer we never saw
    expect(onTap).not.toHaveBeenCalled()
  })

  it('wheel zooms around the cursor and respects limits', () => {
    const { cam, wheel } = setup({ maxZoom: 3 })
    const worldUnder = (sx: number, sy: number) => [cam.x + (sx - 400) / cam.zoom, cam.y + (sy - 300) / cam.zoom]
    const before = worldUnder(600, 100)
    wheel(-300, 600, 100)
    expect(cam.zoom).toBeGreaterThan(1)
    const after = worldUnder(600, 100)
    expect(after[0]).toBeCloseTo(before[0], 6)
    expect(after[1]).toBeCloseTo(before[1], 6)
    for (let i = 0; i < 20; i++) wheel(-300, 600, 100)
    expect(cam.zoom).toBe(3)
  })

  it('pinch zooms by the finger distance ratio', () => {
    const { cam, ptr } = setup()
    ptr('pointerdown', 300, 300, 1)
    ptr('pointerdown', 500, 300, 2)
    ptr('pointermove', 600, 300, 2)
    expect(cam.zoom).toBeCloseTo(1.5)
    ptr('pointerup', 600, 300, 2)
    ptr('pointerup', 300, 300, 1)
  })

  it('cleans up listeners on unmount', () => {
    const { cam, ptr, view } = setup({ inertia: false })
    view.unmount()
    ptr('pointerdown', 100, 100)
    ptr('pointermove', 200, 100)
    expect(cam.x).toBe(0)
  })

  it('keeps the travel before the drag threshold: the first dragged frame catches up with the cursor', () => {
    const { cam, ptr } = setup({ inertia: false })
    ptr('pointerdown', 100, 100)
    ptr('pointermove', 103, 100) // below the 6 px threshold
    expect(cam.x).toBe(0)
    ptr('pointermove', 108, 100) // crosses it
    expect(cam.x).toBeCloseTo(-8)
    ptr('pointermove', 110, 100)
    expect(cam.x).toBeCloseTo(-10)
    ptr('pointerup', 110, 100)
  })

  it('clamps one wheel event to wheelMaxDelta (default 150 px, configurable)', () => {
    const a = setup({ maxZoom: 100 })
    a.wheel(-5000, 400, 300)
    expect(a.cam.zoom).toBeCloseTo(Math.exp(150 * 0.0015))
    a.view.unmount()
    const b = setup({ wheelMaxDelta: 40, maxZoom: 100 })
    b.wheel(-5000, 400, 300)
    expect(b.cam.zoom).toBeCloseTo(Math.exp(40 * 0.0015))
    b.view.unmount()
    const c = setup({ wheelMaxDelta: Infinity, maxZoom: 100 })
    c.wheel(-1000, 400, 300)
    expect(c.cam.zoom).toBeCloseTo(Math.exp(1000 * 0.0015))
  })

  it('converts line and page wheel deltas with lineHeight / pageHeight (page defaults to the canvas height)', () => {
    const a = setup({ wheelMaxDelta: Infinity })
    a.wheel(-2, 400, 300, 1)
    expect(a.cam.zoom).toBeCloseTo(Math.exp(2 * 16 * 0.0015))
    a.view.unmount()
    const b = setup({ wheelMaxDelta: Infinity, lineHeight: 20, pageHeight: 100 })
    b.wheel(-1, 400, 300, 1)
    expect(b.cam.zoom).toBeCloseTo(Math.exp(20 * 0.0015))
    b.view.unmount()
    const c = setup({ wheelMaxDelta: Infinity, pageHeight: 100 })
    c.wheel(-1, 400, 300, 2)
    expect(c.cam.zoom).toBeCloseTo(Math.exp(100 * 0.0015))
    c.view.unmount()
    const d = setup({ wheelMaxDelta: Infinity })
    d.wheel(-1, 400, 300, 2)
    expect(d.cam.zoom).toBeCloseTo(Math.exp(600 * 0.0015)) // canvas is 600 px high
  })

  describe('change callbacks', () => {
    const frames: (() => void)[] = []
    afterEach(() => {
      frames.length = 0
      vi.unstubAllGlobals()
    })
    const stubRaf = () => {
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        frames[id - 1] = () => {}
      })
    }
    const flush = () => act(() => frames.splice(0).forEach((f) => f()))

    it('onChange fires once per frame with the camera (position and zoom)', () => {
      stubRaf()
      const onChange = vi.fn()
      const { cam, ptr, wheel } = setup({ inertia: false, onChange })
      ptr('pointerdown', 100, 100)
      ptr('pointermove', 120, 100)
      ptr('pointermove', 140, 100)
      expect(onChange).not.toHaveBeenCalled() // deferred past the render of this frame
      flush()
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenLastCalledWith({ x: cam.x, y: cam.y, zoom: 1 })
      ptr('pointerup', 140, 100)
      wheel(-100, 400, 300)
      flush()
      expect(onChange).toHaveBeenCalledTimes(2)
      expect(onChange).toHaveBeenLastCalledWith({ x: cam.x, y: cam.y, zoom: cam.zoom })
      expect(cam.zoom).toBeGreaterThan(1)
    })

    it('does not fire after unmount', () => {
      stubRaf()
      const onChange = vi.fn()
      const { ptr, view } = setup({ inertia: false, onChange })
      ptr('pointerdown', 100, 100)
      ptr('pointermove', 140, 100)
      view.unmount()
      flush()
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  it('touchAction option sets the canvas touch-action (default none) and restores it on unmount', () => {
    const a = setup()
    expect(a.canvas.style.touchAction).toBe('none')
    a.view.unmount()
    expect(a.canvas.style.touchAction).toBe('')
    const b = setup({ touchAction: 'pan-y' })
    expect(b.canvas.style.touchAction).toBe('pan-y')
  })
})
