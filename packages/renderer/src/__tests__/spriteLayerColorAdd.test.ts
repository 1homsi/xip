import { describe, it, expect } from 'vitest'
import { SPRITE_LAYER_VERT } from '../spriteLayerGL'

// Evaluate the vertex shader's colorAdd decode with float32 arithmetic, the way the GPU sees it.
function decodeAdd(value: number): [number, number, number] {
  const m = /float ap = ([^;]+);/.exec(SPRITE_LAYER_VERT)
  expect(m).not.toBeNull()
  const f = Math.fround
  const expr = m![1]!.replace(/\b0\.5\b/g, 'f(0.5)')
  const ap = new Function('i_add', 'f', `return f(${expr})`)(f(value), f) as number
  const mod = (x: number, y: number) => x - y * Math.floor(x / y)
  return [Math.floor(ap / 65536), mod(Math.floor(ap / 256), 256), mod(Math.floor(ap), 256)]
}

describe('SpriteLayer colorAdd decode', () => {
  it.each([0xffffff, 0xff00ff, 0x808081, 0xfffffe, 0x123457, 0x000001])('decodes %i exactly', (c) => {
    expect(decodeAdd(c)).toEqual([(c >> 16) & 255, (c >> 8) & 255, c & 255])
  })
})
