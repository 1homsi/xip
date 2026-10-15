import { describe, it, expect, beforeEach } from 'vitest'
import { Keyboard } from '../keyboard'

// Helper: dispatch a synthetic keydown on an EventTarget
function fireKeyDown(target: EventTarget, code: string, key: string): void {
  const e = Object.assign(new Event('keydown'), { code, key }) as KeyboardEvent
  target.dispatchEvent(e)
}

// Helper: dispatch a synthetic keyup on an EventTarget
function fireKeyUp(target: EventTarget, code: string, key: string): void {
  const e = Object.assign(new Event('keyup'), { code, key }) as KeyboardEvent
  target.dispatchEvent(e)
}

describe('Keyboard', () => {
  let keyboard: Keyboard
  let target: EventTarget

  beforeEach(() => {
    keyboard = new Keyboard()
    // Use a plain EventTarget instead of window (safe in Node / Bun)
    target = new EventTarget()
    keyboard.attach(target)
  })

  describe('isDown', () => {
    it('returns false before any key press', () => {
      expect(keyboard.isDown('Space')).toBe(false)
      expect(keyboard.isDown(' ')).toBe(false)
    })

    it('returns true after keydown event', () => {
      fireKeyDown(target, 'Space', ' ')
      expect(keyboard.isDown('Space')).toBe(true)
      expect(keyboard.isDown(' ')).toBe(true)
    })

    it('returns false after corresponding keyup event', () => {
      fireKeyDown(target, 'Space', ' ')
      fireKeyUp(target, 'Space', ' ')
      expect(keyboard.isDown('Space')).toBe(false)
      expect(keyboard.isDown(' ')).toBe(false)
    })

    it('tracks multiple keys independently', () => {
      fireKeyDown(target, 'ArrowLeft', 'ArrowLeft')
      fireKeyDown(target, 'ArrowRight', 'ArrowRight')
      expect(keyboard.isDown('ArrowLeft')).toBe(true)
      expect(keyboard.isDown('ArrowRight')).toBe(true)
      fireKeyUp(target, 'ArrowLeft', 'ArrowLeft')
      expect(keyboard.isDown('ArrowLeft')).toBe(false)
      expect(keyboard.isDown('ArrowRight')).toBe(true)
    })
  })

  describe('isPressed (justPressed)', () => {
    it('returns false before any key press', () => {
      expect(keyboard.isPressed('KeyA')).toBe(false)
    })

    it('returns true immediately after keydown', () => {
      fireKeyDown(target, 'KeyA', 'a')
      expect(keyboard.isPressed('KeyA')).toBe(true)
      expect(keyboard.isPressed('a')).toBe(true)
    })

    it('returns false after flush()', () => {
      fireKeyDown(target, 'KeyA', 'a')
      keyboard.flush()
      expect(keyboard.isPressed('KeyA')).toBe(false)
    })

    it('repeated keydown events (key held) do not re-trigger justPressed after flush', () => {
      fireKeyDown(target, 'KeyA', 'a')
      keyboard.flush()
      // Key is still held — another keydown (browser repeat)
      fireKeyDown(target, 'KeyA', 'a')
      // Since it was already held (isDown was true before the second keydown),
      // justPressed should NOT be set again
      expect(keyboard.isPressed('KeyA')).toBe(false)
    })
  })

  describe('isReleased (justReleased)', () => {
    it('returns false before any key event', () => {
      expect(keyboard.isReleased('Space')).toBe(false)
    })

    it('returns true after keyup', () => {
      fireKeyDown(target, 'Space', ' ')
      fireKeyUp(target, 'Space', ' ')
      expect(keyboard.isReleased('Space')).toBe(true)
      expect(keyboard.isReleased(' ')).toBe(true)
    })

    it('returns false after flush()', () => {
      fireKeyDown(target, 'Space', ' ')
      fireKeyUp(target, 'Space', ' ')
      keyboard.flush()
      expect(keyboard.isReleased('Space')).toBe(false)
    })
  })

  describe('flush', () => {
    it('clears both justPressed and justReleased', () => {
      fireKeyDown(target, 'Enter', 'Enter')
      fireKeyUp(target, 'Enter', 'Enter')
      keyboard.flush()
      expect(keyboard.isPressed('Enter')).toBe(false)
      expect(keyboard.isReleased('Enter')).toBe(false)
    })

    it('does not clear held (isDown) state', () => {
      fireKeyDown(target, 'ShiftLeft', 'Shift')
      keyboard.flush()
      expect(keyboard.isDown('ShiftLeft')).toBe(true)
    })
  })

  describe('code vs key tracking', () => {
    it('tracks by e.code (physical key)', () => {
      fireKeyDown(target, 'KeyZ', 'z')
      expect(keyboard.isDown('KeyZ')).toBe(true)
    })

    it('tracks by e.key (logical character)', () => {
      fireKeyDown(target, 'KeyZ', 'z')
      expect(keyboard.isDown('z')).toBe(true)
    })

    it('detach() stops listening for events', () => {
      keyboard.detach()
      fireKeyDown(target, 'KeyA', 'a')
      expect(keyboard.isDown('KeyA')).toBe(false)
    })
  })

  describe('e.key aliases while modifiers change during a hold', () => {
    it('releases the alias that was pressed when Shift went down mid-hold', () => {
      fireKeyDown(target, 'KeyA', 'a')
      keyboard.flush()
      fireKeyDown(target, 'ShiftLeft', 'Shift')
      fireKeyDown(target, 'KeyA', 'A') // auto-repeat with Shift: must not add a phantom 'A'
      expect(keyboard.isPressed('A')).toBe(false)
      expect(keyboard.isDown('A')).toBe(false)
      fireKeyUp(target, 'KeyA', 'A') // released while Shift is still down
      expect(keyboard.isDown('a')).toBe(false)
      expect(keyboard.isDown('KeyA')).toBe(false)
      expect(keyboard.isReleased('a')).toBe(true)
    })

    it('releases the alias when Shift is let go before the key', () => {
      fireKeyDown(target, 'ShiftLeft', 'Shift')
      fireKeyDown(target, 'KeyA', 'A')
      fireKeyUp(target, 'ShiftLeft', 'Shift')
      fireKeyUp(target, 'KeyA', 'a')
      expect(keyboard.isDown('A')).toBe(false)
      expect(keyboard.isDown('a')).toBe(false)
      expect(keyboard.isReleased('A')).toBe(true)
    })

    it('forgets the recorded alias on release so the next press uses the new key', () => {
      fireKeyDown(target, 'KeyA', 'a')
      fireKeyUp(target, 'KeyA', 'a')
      keyboard.flush()
      fireKeyDown(target, 'KeyA', 'A')
      expect(keyboard.isDown('A')).toBe(true)
      expect(keyboard.isPressed('A')).toBe(true)
      expect(keyboard.isDown('a')).toBe(false)
    })
  })
})
