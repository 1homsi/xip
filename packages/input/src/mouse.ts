import { canvasPoint } from './canvasPoint'

export interface MouseState {
  x: number
  y: number
  dx: number
  dy: number
}

export class Mouse {
  x = 0
  y = 0
  dx = 0
  dy = 0

  private held = new Set<number>()
  private justPressed = new Set<number>()
  private justReleased = new Set<number>()
  private target: HTMLElement | null = null

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.target) return
    const { x, y } = canvasPoint(this.target, e.clientX, e.clientY)
    // Several mousemoves arrive per frame: dx/dy are the sum since the last flush(), x/y the latest position.
    this.dx += x - this.x
    this.dy += y - this.y
    this.x = x
    this.y = y
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.held.has(e.button)) {
      this.justPressed.add(e.button)
    }
    this.held.add(e.button)
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (this.held.delete(e.button)) this.justReleased.add(e.button)
  }

  private onBlur = (): void => {
    for (const b of this.held) this.justReleased.add(b)
    this.held.clear()
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault()
  }

  attach(target: HTMLElement): void {
    this.target = target
    target.addEventListener('mousemove', this.onMouseMove)
    target.addEventListener('mousedown', this.onMouseDown)
    target.addEventListener('mouseup', this.onMouseUp)
    target.addEventListener('contextmenu', this.onContextMenu)
    // Releases outside the target (or after focus loss) would otherwise leave buttons stuck.
    if (typeof window !== 'undefined') {
      window.addEventListener('mouseup', this.onMouseUp)
      window.addEventListener('blur', this.onBlur)
    }
  }

  detach(): void {
    if (!this.target) return
    this.target.removeEventListener('mousemove', this.onMouseMove)
    this.target.removeEventListener('mousedown', this.onMouseDown)
    this.target.removeEventListener('mouseup', this.onMouseUp)
    this.target.removeEventListener('contextmenu', this.onContextMenu)
    if (typeof window !== 'undefined') {
      window.removeEventListener('mouseup', this.onMouseUp)
      window.removeEventListener('blur', this.onBlur)
    }
    this.target = null
  }

  isDown(button = 0): boolean {
    return this.held.has(button)
  }
  isPressed(button = 0): boolean {
    return this.justPressed.has(button)
  }
  isReleased(button = 0): boolean {
    return this.justReleased.has(button)
  }

  flush(): void {
    this.justPressed.clear()
    this.justReleased.clear()
    this.dx = 0
    this.dy = 0
  }
}
