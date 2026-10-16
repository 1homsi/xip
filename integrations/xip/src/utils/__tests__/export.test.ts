// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourcePixelRatio } from '../export'

afterEach(() => vi.unstubAllGlobals())

describe('sourcePixelRatio', () => {
  it('derives the ratio from the canvas, not the window, when the backing store is capped', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const canvas = { width: 400, height: 200, clientWidth: 200 } as HTMLCanvasElement
    expect(sourcePixelRatio(canvas)).toBe(2)
  })

  it('follows devicePixelRatio when the canvas has no CSS size', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const canvas = { width: 600, height: 300, clientWidth: 0 } as HTMLCanvasElement
    expect(sourcePixelRatio(canvas)).toBe(3)
  })
})
