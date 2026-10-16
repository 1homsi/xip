import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TouchInput } from '../touch'

// Minimal mock element that supports addEventListener/removeEventListener
function createMockElement(rect = { left: 10, top: 20, width: 800, height: 600 }) {
  const listeners: Record<string, EventListener[]> = {}
  return {
    getBoundingClientRect: () => rect as DOMRect,
    addEventListener(type: string, handler: EventListener, _opts?: AddEventListenerOptions) {
      if (!listeners[type]) listeners[type] = []
      listeners[type].push(handler)
    },
    removeEventListener(type: string, handler: EventListener) {
      if (!listeners[type]) return
      listeners[type] = listeners[type].filter((h) => h !== handler)
    },
    dispatch(type: string, event: Partial<TouchEvent>) {
      for (const h of listeners[type] ?? []) {
        h(event as Event)
      }
    },
    _listeners: listeners,
  } as unknown as HTMLElement & {
    dispatch: (type: string, e: Partial<TouchEvent>) => void
    _listeners: Record<string, EventListener[]>
  }
}

function createTouchEvent(changedTouches: Array<{ identifier: number; clientX: number; clientY: number }>) {
  return {
    preventDefault: vi.fn(),
    changedTouches: Object.assign(changedTouches, {
      length: changedTouches.length,
      item: (i: number) => changedTouches[i],
    }),
  }
}

describe('TouchInput', () => {
  let touch: TouchInput
  let el: ReturnType<typeof createMockElement>

  beforeEach(() => {
    touch = new TouchInput()
    el = createMockElement()
  })

  describe('attach/detach lifecycle', () => {
    it('registers touch event listeners on attach', () => {
      touch.attach(el as unknown as HTMLElement)
      expect(el._listeners['touchstart']?.length).toBe(1)
      expect(el._listeners['touchmove']?.length).toBe(1)
      expect(el._listeners['touchend']?.length).toBe(1)
      expect(el._listeners['touchcancel']?.length).toBe(1)
    })

    it('removes listeners on detach', () => {
      touch.attach(el as unknown as HTMLElement)
      touch.detach()
      expect(el._listeners['touchstart']?.length).toBe(0)
      expect(el._listeners['touchmove']?.length).toBe(0)
      expect(el._listeners['touchend']?.length).toBe(0)
      expect(el._listeners['touchcancel']?.length).toBe(0)
    })

    it('clears all state on detach', () => {
      touch.attach(el as unknown as HTMLElement)
      el.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      expect(touch.count).toBe(1)
      touch.detach()
      expect(touch.count).toBe(0)
      expect(touch.justStarted.length).toBe(0)
      expect(touch.justEnded.length).toBe(0)
    })
  })

  describe('touch start/move/end tracking', () => {
    beforeEach(() => {
      touch.attach(el as unknown as HTMLElement)
    })

    it('tracks a new touch on touchstart', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 1, clientX: 110, clientY: 220 }]))
      expect(touch.count).toBe(1)
      expect(touch.isTouching).toBe(true)
      const points = touch.touches
      expect(points).toHaveLength(1)
      expect(points[0].id).toBe(1)
      // Coordinates relative to element: 110 - 10 = 100, 220 - 20 = 200
      expect(points[0].x).toBe(100)
      expect(points[0].y).toBe(200)
      expect(points[0].startX).toBe(100)
      expect(points[0].startY).toBe(200)
    })

    it('updates position on touchmove', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 1, clientX: 110, clientY: 220 }]))
      el.dispatch('touchmove', createTouchEvent([{ identifier: 1, clientX: 150, clientY: 260 }]))
      const points = touch.touches
      expect(points[0].x).toBe(140) // 150 - 10
      expect(points[0].y).toBe(240) // 260 - 20
      // startX/Y unchanged
      expect(points[0].startX).toBe(100)
      expect(points[0].startY).toBe(200)
    })

    it('removes touch on touchend', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 1, clientX: 110, clientY: 220 }]))
      el.dispatch('touchend', createTouchEvent([{ identifier: 1, clientX: 110, clientY: 220 }]))
      expect(touch.count).toBe(0)
      expect(touch.isTouching).toBe(false)
    })

    it('tracks multiple touches independently', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      el.dispatch('touchstart', createTouchEvent([{ identifier: 1, clientX: 200, clientY: 300 }]))
      expect(touch.count).toBe(2)
      el.dispatch('touchend', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      expect(touch.count).toBe(1)
      expect(touch.touches[0].id).toBe(1)
    })

    it('prevents default on touch events', () => {
      const evt = createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }])
      el.dispatch('touchstart', evt)
      expect(evt.preventDefault).toHaveBeenCalled()
    })
  })

  describe('justStarted/justEnded and flush', () => {
    beforeEach(() => {
      touch.attach(el as unknown as HTMLElement)
    })

    it('justStarted contains touches that started this frame', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      expect(touch.justStarted).toHaveLength(1)
      expect(touch.justStarted[0].id).toBe(0)
    })

    it('justEnded contains touches that ended this frame', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      el.dispatch('touchend', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      expect(touch.justEnded).toHaveLength(1)
      expect(touch.justEnded[0].id).toBe(0)
    })

    it('justStarted is cleared after flush', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      expect(touch.justStarted).toHaveLength(1)
      touch.flush()
      expect(touch.justStarted).toHaveLength(0)
    })

    it('justEnded is cleared after flush', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      el.dispatch('touchend', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      expect(touch.justEnded).toHaveLength(1)
      touch.flush()
      expect(touch.justEnded).toHaveLength(0)
    })

    it('active touches persist through flush', () => {
      el.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 50, clientY: 60 }]))
      touch.flush()
      expect(touch.count).toBe(1)
      expect(touch.isTouching).toBe(true)
    })
  })

  describe('coordinate calculation', () => {
    it('calculates coordinates relative to the element', () => {
      const customEl = createMockElement({ left: 100, top: 50, width: 400, height: 300 })
      touch.attach(customEl as unknown as HTMLElement)
      customEl.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 250, clientY: 150 }]))
      const points = touch.touches
      expect(points[0].x).toBe(150) // 250 - 100
      expect(points[0].y).toBe(100) // 150 - 50
    })

    it('maps touches through a scaled element to layout pixels', () => {
      // 800x600 layout box drawn at half size at (10, 20), as <Game scale="contain"> does
      const scaledEl = createMockElement({ left: 10, top: 20, width: 400, height: 300 })
      Object.assign(scaledEl, { offsetWidth: 800, offsetHeight: 600 })
      touch.attach(scaledEl as unknown as HTMLElement)
      scaledEl.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 210, clientY: 170 }]))
      expect(touch.touches[0].x).toBe(400)
      expect(touch.touches[0].y).toBe(300)
    })

    it('maps touchmove and touchend through a scaled element too', () => {
      // same 800x600 layout box drawn at half size at (10, 20)
      const scaledEl = createMockElement({ left: 10, top: 20, width: 400, height: 300 })
      Object.assign(scaledEl, { offsetWidth: 800, offsetHeight: 600 })
      touch.attach(scaledEl as unknown as HTMLElement)
      scaledEl.dispatch('touchstart', createTouchEvent([{ identifier: 0, clientX: 210, clientY: 170 }]))
      scaledEl.dispatch('touchmove', createTouchEvent([{ identifier: 0, clientX: 310, clientY: 220 }]))
      expect(touch.touches[0].x).toBe(600)
      expect(touch.touches[0].y).toBe(400)
      scaledEl.dispatch('touchend', createTouchEvent([{ identifier: 0, clientX: 210, clientY: 170 }]))
      expect(touch.justEnded[0].x).toBe(400)
      expect(touch.justEnded[0].y).toBe(300)
    })
  })

  describe('preventDefault option', () => {
    const run = (mode: boolean | 'move') => {
      touch.preventDefault = mode
      touch.attach(el as unknown as HTMLElement)
      const pts = [{ identifier: 0, clientX: 50, clientY: 60 }]
      const evts = {
        touchstart: createTouchEvent(pts),
        touchmove: createTouchEvent(pts),
        touchend: createTouchEvent(pts),
      }
      for (const [type, e] of Object.entries(evts)) el.dispatch(type, e)
      return Object.fromEntries(Object.entries(evts).map(([k, e]) => [k, e.preventDefault.mock.calls.length > 0]))
    }

    it('cancels start, move and end by default (unchanged behaviour)', () => {
      expect(touch.preventDefault).toBe(true)
      expect(run(true)).toEqual({ touchstart: true, touchmove: true, touchend: true })
    })

    it("'move' lets the tap through as a click but still blocks scrolling", () => {
      expect(run('move')).toEqual({ touchstart: false, touchmove: true, touchend: false })
    })

    it('false cancels nothing but still tracks touches', () => {
      expect(run(false)).toEqual({ touchstart: false, touchmove: false, touchend: false })
    })
  })
})
