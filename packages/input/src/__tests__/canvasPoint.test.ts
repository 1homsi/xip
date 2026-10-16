import { describe, it, expect } from 'vitest'
import { canvasPoint } from '../canvasPoint'

function boxed(
  rect: { left: number; top: number; width: number; height: number },
  offsetWidth: number,
  offsetHeight: number,
) {
  return { getBoundingClientRect: () => rect as DOMRect, offsetWidth, offsetHeight } as unknown as HTMLElement
}

describe('canvasPoint', () => {
  it('returns layout pixels when the element is not scaled', () => {
    const el = boxed({ left: 10, top: 20, width: 800, height: 600 }, 800, 600)
    expect(canvasPoint(el, 110, 220)).toEqual({ x: 100, y: 200 })
  })

  it('undoes a CSS transform scale, as <Game scale="contain"> applies', () => {
    // 800x600 layout box drawn at half size at (10, 20)
    const el = boxed({ left: 10, top: 20, width: 400, height: 300 }, 800, 600)
    expect(canvasPoint(el, 210, 170)).toEqual({ x: 400, y: 300 })
  })

  it('falls back to unscaled points when there is no layout box', () => {
    const el = boxed({ left: 10, top: 20, width: 0, height: 0 }, 0, 0)
    expect(canvasPoint(el, 15, 25)).toEqual({ x: 5, y: 5 })
  })
})
