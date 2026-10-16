// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { VirtualJoystick } from '../components/VirtualJoystick'
import { setVirtualAxis, setVirtualButton, useVirtualInput } from '../hooks/useVirtualInput'

// Reset module-level store and DOM before each test
beforeEach(() => {
  cleanup()
  setVirtualAxis(0, 0)
  setVirtualButton('action', false)
  setVirtualButton('jump', false)
})

// ── useVirtualInput store ─────────────────────────────────────────────────────

describe('useVirtualInput', () => {
  it('returns axisX=0 axisY=0 by default', () => {
    const state = useVirtualInput()
    expect(state.axisX).toBe(0)
    expect(state.axisY).toBe(0)
  })

  it('reflects axis set by setVirtualAxis', () => {
    setVirtualAxis(0.5, -0.8)
    const state = useVirtualInput()
    expect(state.axisX).toBeCloseTo(0.5)
    expect(state.axisY).toBeCloseTo(-0.8)
  })

  it('returns false for an unknown button', () => {
    const state = useVirtualInput()
    expect(state.button('jump')).toBe(false)
  })

  it('reflects button set by setVirtualButton', () => {
    setVirtualButton('jump', true)
    expect(useVirtualInput().button('jump')).toBe(true)
    setVirtualButton('jump', false)
    expect(useVirtualInput().button('jump')).toBe(false)
  })

  it('supports multiple independent buttons', () => {
    setVirtualButton('attack', true)
    setVirtualButton('shield', false)
    const state = useVirtualInput()
    expect(state.button('attack')).toBe(true)
    expect(state.button('shield')).toBe(false)
  })

  it('returns a live view — re-read reflects latest axis', () => {
    const state = useVirtualInput()
    setVirtualAxis(1, 0)
    expect(state.axisX).toBe(1)
    setVirtualAxis(-1, 0)
    expect(state.axisX).toBe(-1)
  })
})

// ── VirtualJoystick rendering ─────────────────────────────────────────────────

describe('VirtualJoystick', () => {
  it('renders without crashing', () => {
    expect(() => render(<VirtualJoystick />)).not.toThrow()
  })

  it('does not render an action button by default', () => {
    const { queryByText } = render(<VirtualJoystick />)
    expect(queryByText('A')).toBeNull()
  })

  it('renders action button when actionButton=true', () => {
    const { getByText } = render(<VirtualJoystick actionButton />)
    expect(getByText('A')).toBeTruthy()
  })

  it('renders action button with custom label', () => {
    const { getByText } = render(<VirtualJoystick actionButton actionLabel="B" />)
    expect(getByText('B')).toBeTruthy()
  })

  it('applies custom size to the joystick base', () => {
    const { container } = render(<VirtualJoystick size={200} />)
    const base = container.firstElementChild as HTMLElement
    expect(base.style.width).toBe('200px')
    expect(base.style.height).toBe('200px')
  })

  it('positions left by default (left/bottom CSS)', () => {
    const { container } = render(<VirtualJoystick />)
    const base = container.firstElementChild as HTMLElement
    expect(base.style.left).toBeTruthy()
    expect(base.style.bottom).toBeTruthy()
  })

  it('positions right when position="right" (right/bottom CSS)', () => {
    const { container } = render(<VirtualJoystick position="right" />)
    const base = container.firstElementChild as HTMLElement
    expect(base.style.right).toBeTruthy()
  })
})

// ── VirtualJoystick pointer interaction ───────────────────────────────────────

function makePointerEvent(type: string, props: Partial<PointerEvent> = {}): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    bubbles: true,
    cancelable: true,
    ...props,
  })
}

describe('VirtualJoystick pointer events', () => {
  beforeEach(() => {
    // Mock getBoundingClientRect so the joystick base center is at (100, 100)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 75,
      top: 75,
      width: 50,
      height: 50,
      right: 125,
      bottom: 125,
      x: 75,
      y: 75,
      toJSON: () => ({}),
    } as DOMRect)
    // happy-dom doesn't implement setPointerCapture — define then stub it
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {}
    }
    vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {})
  })

  it('pointer down then pointer up resets axis to 0', () => {
    const { container } = render(<VirtualJoystick />)
    const base = container.firstElementChild as HTMLElement

    act(() => {
      base.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
    })
    act(() => {
      base.dispatchEvent(makePointerEvent('pointerup', { clientX: 100, clientY: 100 }))
    })

    const state = useVirtualInput()
    expect(state.axisX).toBe(0)
    expect(state.axisY).toBe(0)
  })

  it('pointer move to the right produces positive axisX', () => {
    const { container } = render(<VirtualJoystick size={120} />)
    const base = container.firstElementChild as HTMLElement

    act(() => {
      base.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
    })
    // Move right by 30px (well within the radius)
    act(() => {
      base.dispatchEvent(makePointerEvent('pointermove', { pointerId: 1, clientX: 130, clientY: 100 }))
    })

    expect(useVirtualInput().axisX).toBeGreaterThan(0)
    expect(useVirtualInput().axisY).toBeCloseTo(0, 1)
  })

  it('pointer move to the left produces negative axisX', () => {
    const { container } = render(<VirtualJoystick size={120} />)
    const base = container.firstElementChild as HTMLElement

    act(() => {
      base.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
    })
    act(() => {
      base.dispatchEvent(makePointerEvent('pointermove', { pointerId: 1, clientX: 70, clientY: 100 }))
    })

    expect(useVirtualInput().axisX).toBeLessThan(0)
  })

  it('axis is clamped to [-1, 1] even when dragged far outside', () => {
    const { container } = render(<VirtualJoystick size={120} />)
    const base = container.firstElementChild as HTMLElement

    act(() => {
      base.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
    })
    // Drag 500px to the right — should clamp to axisX=1
    act(() => {
      base.dispatchEvent(makePointerEvent('pointermove', { pointerId: 1, clientX: 600, clientY: 100 }))
    })

    expect(useVirtualInput().axisX).toBeCloseTo(1, 1)
  })

  it('pointer cancel resets axis', () => {
    const { container } = render(<VirtualJoystick />)
    const base = container.firstElementChild as HTMLElement

    act(() => {
      base.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
    })
    act(() => {
      base.dispatchEvent(makePointerEvent('pointermove', { pointerId: 1, clientX: 130, clientY: 100 }))
    })
    act(() => {
      base.dispatchEvent(makePointerEvent('pointercancel', { pointerId: 1 }))
    })

    expect(useVirtualInput().axisX).toBe(0)
    expect(useVirtualInput().axisY).toBe(0)
  })

  it('lost pointer capture resets the joystick axis', () => {
    const { container } = render(<VirtualJoystick />)
    const base = container.firstElementChild as HTMLElement

    act(() => {
      base.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
      base.dispatchEvent(makePointerEvent('pointermove', { clientX: 130, clientY: 100 }))
    })
    expect(useVirtualInput().axisX).toBeGreaterThan(0)

    act(() => {
      base.dispatchEvent(makePointerEvent('lostpointercapture', { pointerId: 1 }))
    })

    expect(useVirtualInput().axisX).toBe(0)
    expect(useVirtualInput().axisY).toBe(0)
  })

  it('unmount releases a held axis and action button', () => {
    const { container, unmount } = render(<VirtualJoystick actionButton actionName="jump" />)
    const base = container.firstElementChild as HTMLElement
    const button = container.lastElementChild as HTMLElement

    act(() => {
      base.dispatchEvent(makePointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
      base.dispatchEvent(makePointerEvent('pointermove', { clientX: 130, clientY: 100 }))
      button.dispatchEvent(makePointerEvent('pointerdown', { pointerId: 7 }))
    })
    expect(useVirtualInput().axisX).toBeGreaterThan(0)
    expect(useVirtualInput().button('jump')).toBe(true)

    unmount()

    expect(useVirtualInput().axisX).toBe(0)
    expect(useVirtualInput().axisY).toBe(0)
    expect(useVirtualInput().button('jump')).toBe(false)
  })

  it('lost pointer capture releases the action button', () => {
    const { container } = render(<VirtualJoystick actionButton actionName="jump" />)
    const button = container.lastElementChild as HTMLElement

    act(() => {
      button.dispatchEvent(makePointerEvent('pointerdown', { pointerId: 7 }))
    })
    expect(useVirtualInput().button('jump')).toBe(true)

    act(() => {
      button.dispatchEvent(makePointerEvent('lostpointercapture', { pointerId: 7 }))
    })
    expect(useVirtualInput().button('jump')).toBe(false)
  })

  it('action button sets virtual button on pointerdown', () => {
    const { container } = render(<VirtualJoystick actionButton actionName="jump" />)
    // The action button is the last div rendered (Fragment: joystick base + action button)
    const btn = container.lastElementChild as HTMLElement

    act(() => {
      btn.dispatchEvent(makePointerEvent('pointerdown'))
    })

    expect(useVirtualInput().button('jump')).toBe(true)
  })

  it('action button clears virtual button on pointerup', () => {
    const { container } = render(<VirtualJoystick actionButton actionName="jump" />)
    const btn = container.lastElementChild as HTMLElement

    act(() => {
      btn.dispatchEvent(makePointerEvent('pointerdown'))
    })
    act(() => {
      btn.dispatchEvent(makePointerEvent('pointerup'))
    })

    expect(useVirtualInput().button('jump')).toBe(false)
  })
})
