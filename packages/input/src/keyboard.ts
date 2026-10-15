export class Keyboard {
  private held = new Set<string>()
  private justPressed = new Set<string>()
  private justReleased = new Set<string>()
  private target: EventTarget | null = null

  /**
   * `e.key` recorded when each physical key (`e.code`) went down. `e.key` changes while a key is held
   * (Shift turns `a` into `A`), so keyup must release the alias that keydown pressed, not the current one.
   */
  private keyAtPress = new Map<string, string>()

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.held.has(e.code)) {
      this.justPressed.add(e.code)
    }
    this.held.add(e.code)
    // Also track by key for convenience (e.g. 'ArrowLeft'). A repeat keydown after Shift/AltGr changed
    // e.key keeps the alias from the original press instead of adding a phantom second one.
    // Events without a code (virtual keyboards) cannot be tracked per physical key: use the key as is.
    let key = e.key
    if (e.code) {
      const pressed = this.keyAtPress.get(e.code)
      if (pressed !== undefined) key = pressed
      else this.keyAtPress.set(e.code, key)
    }
    if (!this.held.has(key)) {
      this.justPressed.add(key)
    }
    this.held.add(key)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const key = (e.code && this.keyAtPress.get(e.code)) || e.key
    this.keyAtPress.delete(e.code)
    this.held.delete(e.code)
    this.held.delete(key)
    this.justReleased.add(e.code)
    this.justReleased.add(key)
  }

  // Keyup never arrives for keys held while the window loses focus.
  private onBlur = (): void => {
    for (const k of this.held) this.justReleased.add(k)
    this.held.clear()
    this.keyAtPress.clear()
  }

  attach(target: EventTarget = window): void {
    this.target = target
    target.addEventListener('keydown', this.onKeyDown as EventListener)
    target.addEventListener('keyup', this.onKeyUp as EventListener)
    if (typeof window !== 'undefined') window.addEventListener('blur', this.onBlur)
  }

  detach(): void {
    if (!this.target) return
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener)
    this.target.removeEventListener('keyup', this.onKeyUp as EventListener)
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.onBlur)
    this.target = null
  }

  /** True every frame the key is held */
  isDown(key: string): boolean {
    return this.held.has(key)
  }

  /** True only on the first frame the key was pressed */
  isPressed(key: string): boolean {
    return this.justPressed.has(key)
  }

  /** True only on the frame the key was released */
  isReleased(key: string): boolean {
    return this.justReleased.has(key)
  }

  /** Call once per frame at the START of the frame to flush transient state */
  flush(): void {
    this.justPressed.clear()
    this.justReleased.clear()
  }
}
