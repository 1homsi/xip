/**
 * Gamepad input via the standard W3C Gamepad API mapping.
 *
 * Buttons and sticks are exposed through string codes so they flow through
 * the same plumbing as keyboard keys — `InputManager.isDown('gamepad:A')`,
 * InputMap action bindings, recorders, everything — with no special cases.
 *
 * Codes:
 * - Buttons:  'gamepad:A', 'gamepad:B', 'gamepad:X', 'gamepad:Y',
 *             'gamepad:LB', 'gamepad:RB', 'gamepad:LT', 'gamepad:RT',
 *             'gamepad:Back', 'gamepad:Start', 'gamepad:L3', 'gamepad:R3',
 *             'gamepad:Up', 'gamepad:Down', 'gamepad:Left', 'gamepad:Right',
 *             'gamepad:Home'
 * - Sticks:   'gamepad:LX+' / 'gamepad:LX-' / 'gamepad:LY+' / 'gamepad:LY-'
 *             (same for R*). Digital ±1 past the dead zone; use getStick()
 *             for analog values.
 *
 * Analog values are available directly: getStick(), getTrigger().
 */

export const GAMEPAD_PREFIX = 'gamepad:'

/** W3C standard-mapping button indices. */
export const GamepadButton = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8,
  Start: 9,
  L3: 10,
  R3: 11,
  DPadUp: 12,
  DPadDown: 13,
  DPadLeft: 14,
  DPadRight: 15,
  Home: 16,
} as const

const BUTTON_CODES = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'Back',
  'Start',
  'L3',
  'R3',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
] as const

/** Build a gamepad button code from a standard index or name. */
export function gamepadButtonCode(button: number | keyof typeof GamepadButton): string {
  const name = typeof button === 'number' ? (BUTTON_CODES[button] ?? String(button)) : button
  return GAMEPAD_PREFIX + name
}

/**
 * Synthetic indices for directional stick codes (100–107), so stick
 * directions get press/release edges exactly like buttons.
 * Order: LX+, LX-, LY+, LY-, RX+, RX-, RY+, RY-
 */
export const GAMEPAD_STICK_DIR_BASE = 100

const STICK_DIRECTION_IDS: Record<string, number> = {
  'LX+': 100,
  'LX-': 101,
  'LY+': 102,
  'LY-': 103,
  'RX+': 104,
  'RX-': 105,
  'RY+': 106,
  'RY-': 107,
}

interface PadState {
  held: Set<number>
  justPressed: Set<number>
  justReleased: Set<number>
  /** Left/right stick X/Y, dead-zone applied for digital reads. */
  axes: Float64Array // [lx, ly, rx, ry] raw −1..1
  triggers: Float64Array // [lt, rt] raw 0..1
  connected: boolean
  vibrationUntil: number
}

function createPadState(): PadState {
  return {
    held: new Set(),
    justPressed: new Set(),
    justReleased: new Set(),
    axes: new Float64Array(4),
    triggers: new Float64Array(2),
    connected: false,
    vibrationUntil: 0,
  }
}

export interface VibrationOptions {
  durationMs?: number
  strongMagnitude?: number
  weakMagnitude?: number
}

/**
 * Polls the Gamepad API once per frame (via flush()) with keyboard-style
 * edge detection. Supports up to 4 pads; all methods take an optional
 * player index (default 0).
 */
export class GamepadInput {
  private pads: PadState[] = [createPadState(), createPadState(), createPadState(), createPadState()]
  private deadZone = 0.15

  /**
   * Once attached, polling is gated: `getGamepads()` is only called after a `gamepadconnected`
   * event, when a pad is already present at attach time, or after `enablePolling()`. An idle game
   * with no pad therefore costs nothing per frame. Never attached (tests, headless): always polls.
   */
  private gated = false
  private active = false
  private forced = false
  private target: EventTarget | null = null

  private onConnect = (): void => {
    this.active = true
  }

  attach(): void {
    if (this.target || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    this.target = window
    this.gated = true
    window.addEventListener('gamepadconnected', this.onConnect)
    // A pad that was connected before the page loaded is visible straight away.
    if (typeof navigator !== 'undefined' && navigator.getGamepads) {
      for (const p of navigator.getGamepads()) if (p) this.active = true
    }
  }

  detach(): void {
    this.target?.removeEventListener('gamepadconnected', this.onConnect)
    this.target = null
    this.gated = false
    this.active = false
  }

  /** Keep polling even before a `gamepadconnected` event (for code that reads pads without the event). */
  enablePolling(enabled = true): void {
    this.forced = enabled
  }

  /**
   * Poll all connected gamepads and update edge state.
   * Must be called once at the START of each frame (InputManager.flush does this).
   */
  flush(): void {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return
    if (this.gated && !this.active && !this.forced) {
      // Asleep (no pad): the edges of the frame that put us to sleep (a disconnect) must not linger.
      for (const state of this.pads) {
        state.justPressed.clear()
        state.justReleased.clear()
      }
      return
    }
    const pads = navigator.getGamepads()
    let any = false
    for (let i = 0; i < this.pads.length; i++) {
      const state = this.pads[i]
      state.justPressed.clear()
      state.justReleased.clear()
      const gp = pads[i]
      if (!gp) {
        if (state.connected) {
          // Disconnected mid-session: clear everything so held buttons don't stick, and release them
          // (edges) so listeners see the buttons go up; zero the analog values so a stick/trigger
          // that was pushed at unplug time doesn't keep reading its last value.
          for (const id of state.held) state.justReleased.add(id)
          state.held.clear()
          state.axes.fill(0)
          state.triggers.fill(0)
          state.connected = false
        }
        continue
      }
      state.connected = true
      any = true
      for (let b = 0; b < gp.buttons.length && b < 17; b++) {
        const pressed = gp.buttons[b].pressed
        if (pressed && !state.held.has(b)) state.justPressed.add(b)
        else if (!pressed && state.held.has(b)) state.justReleased.add(b)
        if (pressed) state.held.add(b)
        else state.held.delete(b)
      }
      // Normalise sticks: browsers may report slightly off-zero at rest.
      const dz = this.deadZone
      for (let a = 0; a < 4 && a < gp.axes.length; a++) {
        const raw = gp.axes[a]
        state.axes[a] = Math.abs(raw) < dz ? 0 : raw
      }
      // Directional stick codes get button-style edges: synthetic indices
      // 100–107 track whether each half-axis is currently active.
      for (let d = 0; d < 8; d++) {
        const id = GAMEPAD_STICK_DIR_BASE + d
        const axisIdx = d >> 1 // LX± →0, LY± →1, RX± →2, RY± →3
        const positive = d % 2 === 0
        const v = state.axes[axisIdx] ?? 0
        const active = positive ? v > 0 : v < 0
        if (active && !state.held.has(id)) state.justPressed.add(id)
        else if (!active && state.held.has(id)) state.justReleased.add(id)
        if (active) state.held.add(id)
        else state.held.delete(id)
      }
      if (gp.buttons.length > 6) state.triggers[0] = gp.buttons[6].value
      if (gp.buttons.length > 7) state.triggers[1] = gp.buttons[7].value
    }
    // Every pad is gone and its state cleared: sleep until the next gamepadconnected.
    if (!any) this.active = false
  }

  /** Whether a pad is connected at this player index. */
  isConnected(playerIndex = 0): boolean {
    return this.pads[playerIndex]?.connected ?? false
  }

  /** True every frame the button is held. Accepts a code or standard index. */
  isDown(button: number | string, playerIndex = 0): boolean {
    return this.pads[playerIndex]?.held.has(this.resolve(button)) ?? false
  }

  /** True only on the first frame the button was pressed. */
  isPressed(button: number | string, playerIndex = 0): boolean {
    return this.pads[playerIndex]?.justPressed.has(this.resolve(button)) ?? false
  }

  /** True only on the frame the button was released. */
  isReleased(button: number | string, playerIndex = 0): boolean {
    return this.pads[playerIndex]?.justReleased.has(this.resolve(button)) ?? false
  }

  /** Analog trigger value 0..1 ('left' = LT, 'right' = RT). */
  getTrigger(side: 'left' | 'right', playerIndex = 0): number {
    const pad = this.pads[playerIndex]
    if (!pad) return 0
    return side === 'left' ? pad.triggers[0] : pad.triggers[1]
  }

  /**
   * Analog stick axis −1..1 with dead zone applied.
   * @param axis 'x' or 'y'. +y is DOWN (screen convention): the W3C standard mapping already reports
   * up as −1 and down as +1, so the browser value is returned as is.
   */
  getStick(stick: 'left' | 'right', axis: 'x' | 'y', playerIndex = 0): number {
    const pad = this.pads[playerIndex]
    if (!pad) return 0
    const idx = (stick === 'left' ? 0 : 2) + (axis === 'x' ? 0 : 1)
    return pad.axes[idx] ?? 0
  }

  /** Dead zone for stick reads (default 0.15). */
  setDeadZone(zone: number): void {
    this.deadZone = zone
  }

  /**
   * Fire a haptic pulse. No-op when the pad or browser lacks vibration support.
   */
  vibrate(playerIndex = 0, options: VibrationOptions = {}): void {
    const gp = typeof navigator !== 'undefined' ? navigator.getGamepads?.()[playerIndex] : undefined
    const actuator = (
      gp as { vibrationActuator?: { playEffect?(type: string, opts: object): Promise<unknown> } | null }
    )?.vibrationActuator
    if (!actuator?.playEffect) return
    void actuator.playEffect('dual-rumble', {
      startDelay: 0,
      duration: options.durationMs ?? 120,
      strongMagnitude: Math.min(1, Math.max(0, options.strongMagnitude ?? 1)),
      weakMagnitude: Math.min(1, Math.max(0, options.weakMagnitude ?? 0.5)),
    })
  }

  /** Map a button code/index to its numeric index; unknown codes → −1 (never matches). */
  private resolve(button: number | string): number {
    if (typeof button === 'number') return button
    const name = button.startsWith(GAMEPAD_PREFIX) ? button.slice(GAMEPAD_PREFIX.length) : button
    const idx = BUTTON_CODES.indexOf(name as (typeof BUTTON_CODES)[number])
    if (idx !== -1) return idx
    // Directional stick codes ('LX+', 'LY-', …) map to synthetic edge-tracked ids
    const dir = STICK_DIRECTION_IDS[name]
    if (dir !== undefined) return dir
    // Numeric strings ('gamepad:17') address raw indices; anything else is
    // not a real button — return −1 rather than NaN, which never matches.
    const n = Number(name)
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : -1
  }
}
