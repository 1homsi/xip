import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GamepadInput, gamepadButtonCode, GamepadButton } from '../gamepad'
import { InputManager } from '../inputManager'
import { createInputMap } from '../inputMap'

type MockButton = { pressed: boolean; value: number }
type MockPad = { buttons: MockButton[]; axes: number[]; connected?: boolean }

let mockPads: (MockPad | null)[] = [null, null, null, null]

function makePad(overrides?: Partial<MockPad>): MockPad {
  return {
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: false, value: i === 6 || i === 7 ? 0 : 0 })),
    axes: [0, 0, 0, 0],
    ...overrides,
  }
}

beforeEach(() => {
  mockPads = [null, null, null, null]
  ;(globalThis as Record<string, unknown>).navigator = {
    getGamepads: () => mockPads as unknown as (Gamepad | null)[],
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).navigator
})

describe('GamepadInput', () => {
  let gp: GamepadInput

  beforeEach(() => {
    gp = new GamepadInput()
  })

  it('reports disconnected when no pads', () => {
    gp.flush()
    expect(gp.isConnected()).toBe(false)
    expect(gp.isDown(GamepadButton.A)).toBe(false)
  })

  it('detects press/hold/release edges', () => {
    mockPads[0] = makePad()
    mockPads[0]!.buttons[0].pressed = true
    gp.flush()
    expect(gp.isConnected()).toBe(true)
    expect(gp.isPressed(GamepadButton.A)).toBe(true)

    // held on subsequent frame
    mockPads[0]!.buttons[0].pressed = true
    gp.flush()
    expect(gp.isDown(GamepadButton.A)).toBe(true)
    expect(gp.isPressed(GamepadButton.A)).toBe(false)

    // release edge
    mockPads[0]!.buttons[0].pressed = false
    gp.flush()
    expect(gp.isReleased(GamepadButton.A)).toBe(true)
    expect(gp.isDown(GamepadButton.A)).toBe(false)
  })

  it('clears held buttons when pad disconnects mid-session', () => {
    mockPads[0] = makePad()
    mockPads[0]!.buttons[GamepadButton.Start].pressed = true
    gp.flush()
    expect(gp.isDown(GamepadButton.Start)).toBe(true)

    mockPads[0] = null
    gp.flush()
    expect(gp.isConnected()).toBe(false)
    expect(gp.isDown(GamepadButton.Start)).toBe(false)
  })

  it('applies dead zone to sticks and keeps the browser Y sign (+y is down, as on screen)', () => {
    mockPads[0] = makePad()
    mockPads[0]!.axes = [0.5, -1, 0.05, 0]
    gp.flush()
    expect(gp.getStick('left', 'x')).toBe(0.5)
    expect(gp.getStick('left', 'y')).toBe(-1) // stick pushed UP: standard mapping reports -1 = up
    expect(gp.getStick('right', 'x')).toBe(0) // inside dead zone
    mockPads[0]!.axes = [0, 1, 0, 0.8]
    gp.flush()
    expect(gp.getStick('left', 'y')).toBe(1) // pushed DOWN = +1, like ArrowDown and gamepad:LY+
    expect(gp.getStick('right', 'y')).toBe(0.8)
    expect(gp.isDown('gamepad:LY+')).toBe(true)
  })

  it('zeroes sticks and triggers and releases held buttons when the pad disappears', () => {
    mockPads[0] = makePad()
    mockPads[0]!.axes = [1, 1, 0, 0]
    mockPads[0]!.buttons[7] = { pressed: true, value: 1 }
    mockPads[0]!.buttons[GamepadButton.A].pressed = true
    gp.flush()
    expect(gp.getStick('left', 'x')).toBe(1)
    expect(gp.getTrigger('right')).toBe(1)

    mockPads[0] = null
    gp.flush()
    expect(gp.getStick('left', 'x')).toBe(0)
    expect(gp.getStick('left', 'y')).toBe(0)
    expect(gp.getTrigger('right')).toBe(0)
    expect(gp.isDown(GamepadButton.A)).toBe(false)
    expect(gp.isReleased(GamepadButton.A)).toBe(true)
    expect(gp.isReleased('gamepad:LX+')).toBe(true)
    gp.flush()
    expect(gp.isReleased(GamepadButton.A)).toBe(false)
  })

  it('reads analog trigger values', () => {
    mockPads[0] = makePad()
    mockPads[0]!.buttons[6] = { pressed: true, value: 0.75 }
    gp.flush()
    expect(gp.getTrigger('left')).toBeCloseTo(0.75)
  })

  it('accepts string codes and numeric indices interchangeably', () => {
    mockPads[0] = makePad()
    mockPads[0]!.buttons[12].pressed = true
    gp.flush()
    expect(gp.isDown('gamepad:Up')).toBe(true)
    expect(gp.isDown(gamepadButtonCode(12))).toBe(true)
    expect(gp.isDown(GamepadButton.DPadUp)).toBe(true)
    expect(gp.isDown('gamepad:A')).toBe(false)
  })

  it('isolates player indices', () => {
    mockPads[0] = makePad()
    mockPads[1] = makePad()
    mockPads[1]!.buttons[2].pressed = true
    gp.flush()
    expect(gp.isDown('gamepad:X', 1)).toBe(true)
    expect(gp.isDown('gamepad:X', 0)).toBe(false)
  })
})

describe('InputManager gamepad routing', () => {
  it('routes gamepad: codes through isDown/isPressed/isReleased', () => {
    const input = new InputManager()
    mockPads[0] = makePad()
    mockPads[0]!.buttons[GamepadButton.A].pressed = true
    input.flush()

    expect(input.isDown('gamepad:A')).toBe(true)
    expect(input.keyboard.isDown('gamepad:A')).toBe(false)
  })

  it('treats stick direction codes as digital inputs', () => {
    const input = new InputManager()
    mockPads[0] = makePad()
    mockPads[0]!.axes = [-1, 0, 0, 0]
    input.flush()

    expect(input.isDown('gamepad:LX-')).toBe(true)
    expect(input.isDown('gamepad:LX+')).toBe(false)
    expect(input.getAxis('gamepad:LX+', 'gamepad:LX-')).toBe(-1)
  })
})

describe('InputMap analog stick binding', () => {
  it('blends keyboard digital values with analog stick', () => {
    const input = new InputManager() as InputManager & { gamepad: GamepadInput }
    const map = createInputMap({
      moveX: { positive: ['ArrowRight'], negative: ['ArrowLeft'], stick: 'leftx' },
    })

    mockPads[0] = makePad()
    mockPads[0]!.axes = [0.6, 0, 0, 0]

    input.flush()
    expect(map.getAxis(input, 'moveX')).toBeCloseTo(0.6)

    // keyboard adds on top of stick, clamped to ±1
    input.keyboard.held.add('ArrowRight')
    expect(map.getAxis(input, 'moveX')).toBe(1)

    input.keyboard.held.delete('ArrowRight')
    input.keyboard.held.add('ArrowLeft')
    expect(map.getAxis(input, 'moveX')).toBeCloseTo(-0.4)
  })

  it('isActionDown fires for stick-only movement past dead zone', () => {
    const map = createInputMap({
      moveX: { positive: [], negative: [], deadZone: 0.3, stick: 'leftx' },
    })
    const input = new InputManager() as InputManager & { gamepad: GamepadInput }

    mockPads[0] = makePad()
    mockPads[0]!.axes = [0.2, 0, 0, 0]
    input.flush()
    expect(map.isActionDown(input, 'moveX')).toBe(false)

    mockPads[0]!.axes = [0.8, 0, 0, 0]
    input.flush()
    expect(map.isActionDown(input, 'moveX')).toBe(true)
  })
})

describe('GamepadInput code resolution', () => {
  it('unknown button codes never match instead of producing NaN', () => {
    const gp = new GamepadInput()
    mockPads[0] = makePad()
    mockPads[0]!.buttons[0].pressed = true
    gp.flush()

    expect(gp.isDown('gamepad:Banana')).toBe(false)
    expect(gp.isDown('gamepad:LX')).toBe(false) // stick names are not buttons
    expect(gp.isPressed('gamepad:Banana')).toBe(false)
    // raw numeric indices still work
    expect(gp.isDown('gamepad:0')).toBe(true)
  })
})

describe('Stick direction edge detection', () => {
  it('gives directional codes press/release edges like buttons', () => {
    const input = new InputManager()
    mockPads[0] = makePad()
    mockPads[0]!.axes = [0, 0, 0, 0]
    input.flush()
    expect(input.isDown('gamepad:LX+')).toBe(false)

    // push stick right
    mockPads[0]!.axes = [1, 0, 0, 0]
    input.flush()
    expect(input.isPressed('gamepad:LX+')).toBe(true)
    expect(input.isDown('gamepad:LX+')).toBe(true)

    input.flush()
    expect(input.isPressed('gamepad:LX+')).toBe(false)
    expect(input.isDown('gamepad:LX+')).toBe(true)

    // release
    mockPads[0]!.axes = [0, 0, 0, 0]
    input.flush()
    expect(input.isReleased('gamepad:LX+')).toBe(true)
    expect(input.isDown('gamepad:LX+')).toBe(false)
  })
})

describe('GamepadInput idle polling', () => {
  let calls = 0
  let win: EventTarget
  beforeEach(() => {
    calls = 0
    win = new EventTarget()
    ;(globalThis as Record<string, unknown>).window = win
    ;(globalThis as Record<string, unknown>).navigator = {
      getGamepads: () => {
        calls++
        return mockPads as unknown as (Gamepad | null)[]
      },
    }
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('does not touch navigator.getGamepads while no pad was ever connected', () => {
    const gp = new GamepadInput()
    gp.attach()
    const afterAttach = calls
    for (let i = 0; i < 60; i++) gp.flush()
    expect(calls).toBe(afterAttach)
    gp.detach()
  })

  it('starts polling on gamepadconnected and sleeps again after the pad is gone', () => {
    const gp = new GamepadInput()
    gp.attach()
    mockPads[0] = makePad()
    mockPads[0]!.buttons[0].pressed = true
    win.dispatchEvent(new Event('gamepadconnected'))
    const before = calls
    gp.flush()
    expect(calls).toBe(before + 1)
    expect(gp.isPressed(GamepadButton.A)).toBe(true)
    mockPads[0] = null
    gp.flush() // notices the disconnect and clears held state
    expect(gp.isConnected()).toBe(false)
    const slept = calls
    gp.flush()
    gp.flush()
    expect(calls).toBe(slept)
  })

  it('polls straight away when a pad is already connected at attach, or when forced', () => {
    mockPads[0] = makePad()
    const a = new GamepadInput()
    a.attach()
    a.flush()
    expect(a.isConnected()).toBe(true)
    a.detach()
    mockPads[0] = null
    const b = new GamepadInput()
    b.attach()
    b.enablePolling()
    mockPads[0] = makePad()
    b.flush()
    expect(b.isConnected()).toBe(true)
    b.detach()
  })
})
