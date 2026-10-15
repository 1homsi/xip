import { describe, it, expect, beforeEach } from 'vitest'
import { Mouse } from '../mouse'

function fireMouseMove(el: HTMLElement, clientX: number, clientY: number) {
  const e = new MouseEvent('mousemove', { clientX, clientY })
  el.dispatchEvent(e)
}

function fireMouseDown(el: HTMLElement, button = 0) {
  const e = new MouseEvent('mousedown', { button })
  el.dispatchEvent(e)
}

function fireMouseUp(el: HTMLElement, button = 0) {
  const e = new MouseEvent('mouseup', { button })
  el.dispatchEvent(e)
}

describe('Mouse', () => {
  let mouse: Mouse
  let target: HTMLElement

  beforeEach(() => {
    mouse = new Mouse()
    target = document.createElement('div')
    // Mock getBoundingClientRect
    target.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    })
    mouse.attach(target)
  })

  describe('position tracking', () => {
    it('starts at (0, 0)', () => {
      expect(mouse.x).toBe(0)
      expect(mouse.y).toBe(0)
    })

    it('updates position on mousemove', () => {
      fireMouseMove(target, 100, 200)
      expect(mouse.x).toBe(100)
      expect(mouse.y).toBe(200)
    })

    it('tracks delta movement', () => {
      fireMouseMove(target, 100, 100)
      expect(mouse.dx).toBe(100)
      expect(mouse.dy).toBe(100)
      mouse.flush()
      fireMouseMove(target, 150, 120)
      expect(mouse.dx).toBe(50)
      expect(mouse.dy).toBe(20)
    })

    it('sums the deltas of every mousemove delivered within one frame', () => {
      fireMouseMove(target, 10, 10)
      mouse.flush()
      fireMouseMove(target, 14, 12)
      fireMouseMove(target, 20, 11)
      fireMouseMove(target, 18, 20)
      expect(mouse.dx).toBe(8)
      expect(mouse.dy).toBe(10)
      expect(mouse.x).toBe(18)
      expect(mouse.y).toBe(20)
      mouse.flush()
      expect(mouse.dx).toBe(0)
      expect(mouse.dy).toBe(0)
    })
  })

  describe('button state', () => {
    it('isDown returns false when no button pressed', () => {
      expect(mouse.isDown(0)).toBe(false)
    })

    it('isDown returns true after mousedown', () => {
      fireMouseDown(target, 0)
      expect(mouse.isDown(0)).toBe(true)
    })

    it('isDown returns false after mouseup', () => {
      fireMouseDown(target, 0)
      fireMouseUp(target, 0)
      expect(mouse.isDown(0)).toBe(false)
    })

    it('tracks right button independently', () => {
      fireMouseDown(target, 2)
      expect(mouse.isDown(2)).toBe(true)
      expect(mouse.isDown(0)).toBe(false)
    })

    it('tracks middle button independently', () => {
      fireMouseDown(target, 1)
      expect(mouse.isDown(1)).toBe(true)
      expect(mouse.isDown(0)).toBe(false)
    })

    it('default button is 0', () => {
      fireMouseDown(target, 0)
      expect(mouse.isDown()).toBe(true)
    })
  })

  describe('isPressed', () => {
    it('returns true on the frame the button was first pressed', () => {
      fireMouseDown(target, 0)
      expect(mouse.isPressed(0)).toBe(true)
    })

    it('returns false after flush', () => {
      fireMouseDown(target, 0)
      mouse.flush()
      expect(mouse.isPressed(0)).toBe(false)
    })

    it('does not re-trigger while held', () => {
      fireMouseDown(target, 0)
      mouse.flush()
      fireMouseDown(target, 0) // still held
      expect(mouse.isPressed(0)).toBe(false)
    })

    it('default button is 0', () => {
      fireMouseDown(target, 0)
      expect(mouse.isPressed()).toBe(true)
    })
  })

  describe('isReleased', () => {
    it('returns true on the frame the button was released', () => {
      fireMouseDown(target, 0)
      fireMouseUp(target, 0)
      expect(mouse.isReleased(0)).toBe(true)
    })

    it('returns false after flush', () => {
      fireMouseDown(target, 0)
      fireMouseUp(target, 0)
      mouse.flush()
      expect(mouse.isReleased(0)).toBe(false)
    })

    it('default button is 0', () => {
      fireMouseDown(target, 0)
      fireMouseUp(target, 0)
      expect(mouse.isReleased()).toBe(true)
    })
  })

  describe('flush', () => {
    it('clears justPressed and justReleased', () => {
      fireMouseDown(target, 0)
      mouse.flush()
      expect(mouse.isPressed(0)).toBe(false)
    })

    it('resets delta to 0', () => {
      fireMouseMove(target, 100, 100)
      mouse.flush()
      expect(mouse.dx).toBe(0)
      expect(mouse.dy).toBe(0)
    })

    it('does not clear held state', () => {
      fireMouseDown(target, 0)
      mouse.flush()
      expect(mouse.isDown(0)).toBe(true)
    })
  })

  describe('detach', () => {
    it('stops tracking events after detach', () => {
      mouse.detach()
      fireMouseDown(target, 0)
      expect(mouse.isDown(0)).toBe(false)
    })

    it('detach without attach does not throw', () => {
      const m = new Mouse()
      expect(() => m.detach()).not.toThrow()
    })
  })
})
