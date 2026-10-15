import { describe, expect, it, vi } from 'vitest'
import { SpriteLayer, SPRITE_HIDDEN } from '../spriteLayer'

const order = (l: SpriteLayer) => Array.from(l.drawOrder().subarray(0, l.orderCount))

/** Reference: visible slots by (key, key2, slot). */
function reference(l: SpriteLayer) {
  const out: number[] = []
  for (let i = 0; i < l.count; i++) if (!(l.flags[i] & SPRITE_HIDDEN)) out.push(i)
  return out.sort((a, b) => l.sortKey[a] - l.sortKey[b] || (l.sortKey2 ? l.sortKey2[a] - l.sortKey2[b] : 0) || a - b)
}

function make(n: number, keys: (i: number) => number) {
  const l = new SpriteLayer({ sortByKey: true, capacity: 4 })
  for (let i = 0; i < n; i++) {
    l.add(i, 0, 1, 1)
    l.sortKey[i] = keys(i)
  }
  return l
}

describe('SpriteLayer depth sort', () => {
  it('keeps depths 0.00005 apart distinct at y = 4000 (float64 key)', () => {
    const l = make(3, (i) => 4000 + (2 - i) * 0.00005)
    expect(l.sortKey).toBeInstanceOf(Float64Array)
    expect(order(l)).toEqual([2, 1, 0])
    // a float32 key cannot tell these three apart
    expect(new Set([4000, 4000.00005, 4000.0001].map(Math.fround)).size).toBe(1)
  })

  it('breaks ties with the secondary key, then slot order', () => {
    const l = make(5, () => 10)
    const k2 = l.enableSortKey2()
    ;[3, 1, 2, 1, 0].forEach((v, i) => (k2[i] = v))
    expect(order(l)).toEqual([4, 1, 3, 2, 0])
    // the secondary key survives growth, swap-remove and reset of new slots
    for (let i = 0; i < 20; i++) l.add(0, 0, 1, 1)
    expect(l.sortKey2!.length).toBe(l.capacity)
    expect(l.sortKey2![5]).toBe(0)
    l.removeAt(0)
    expect(order(l)).toEqual(reference(l))
  })

  it('leaves hidden sprites out of the order and puts them back sorted', () => {
    const l = make(6, (i) => 6 - i)
    l.flags[1] |= SPRITE_HIDDEN
    l.flags[4] |= SPRITE_HIDDEN
    l.touchRange(1, 4)
    expect(order(l)).toEqual([5, 3, 2, 0])
    expect(l.orderCount).toBe(4)
    l.flags[4] &= ~SPRITE_HIDDEN
    l.touchRange(4)
    expect(order(l)).toEqual([5, 4, 3, 2, 0])
    l.flags[1] &= ~SPRITE_HIDDEN
    l.touchRange(1)
    expect(order(l)).toEqual([5, 4, 3, 2, 1, 0])
  })

  it('picks follow the order and skip hidden sprites', () => {
    const l = make(2, (i) => i)
    l.x[0] = l.x[1] = 0
    l.y[0] = l.y[1] = 0
    l.ids[0] = 100
    l.ids[1] = 101
    expect(l.pick(0, 0)).toBe(101)
    l.sortKey[1] = -1
    l.touchRange(1)
    expect(l.pick(0, 0)).toBe(100)
    l.flags[0] |= SPRITE_HIDDEN
    l.touchRange(0)
    expect(l.pick(0, 0)).toBe(101)
  })

  it('clear() + add() rebuilds with similar keys reuse the previous order (no full sort)', () => {
    const sort = vi.spyOn(Int32Array.prototype, 'sort')
    const keys = Array.from({ length: 2000 }, (_, i) => ((i * 7919) % 2000) + 0.5)
    const l = make(2000, (i) => keys[i])
    order(l)
    sort.mockClear()
    for (let frame = 0; frame < 5; frame++) {
      l.clear()
      for (let i = 0; i < 2000; i++) {
        l.add(i, 0, 1, 1)
        l.sortKey[i] = keys[i] + frame * 0.25 // drift
      }
      expect(order(l)).toEqual(reference(l))
    }
    expect(sort).not.toHaveBeenCalled()
    sort.mockRestore()
  })

  it('falls back to a full sort for a very different order and stays correct', () => {
    const sort = vi.spyOn(Int32Array.prototype, 'sort')
    const l = make(3000, (i) => i)
    order(l)
    sort.mockClear()
    for (let i = 0; i < 3000; i++) l.sortKey[i] = 3000 - i // fully reversed
    l.touchRange(0, l.count - 1)
    expect(order(l)).toEqual(reference(l))
    expect(sort).toHaveBeenCalledTimes(1)
    sort.mockRestore()
  })

  it('matches a reference sort through random adds, removes, hides and key changes', () => {
    let seed = 12345
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) as number
    const l = make(50, () => rnd() * 100)
    l.enableSortKey2()
    for (let step = 0; step < 300; step++) {
      const op = (rnd() * 6) | 0
      if (op === 0) {
        const i = l.add(0, 0, 1, 1)
        l.sortKey[i] = Math.floor(rnd() * 10)
        l.sortKey2![i] = Math.floor(rnd() * 3)
      } else if (op === 1 && l.count > 5) l.removeAt((rnd() * l.count) | 0)
      else if (op === 2 && l.count > 0) {
        const i = (rnd() * l.count) | 0
        l.flags[i] ^= SPRITE_HIDDEN
        l.touchRange(i)
      } else if (op === 3 && l.count > 0) {
        for (let k = 0; k < 5; k++) l.sortKey[(rnd() * l.count) | 0] = Math.floor(rnd() * 10)
        l.touchRange(0, l.count - 1)
      } else if (op === 4 && rnd() < 0.2) {
        l.clear()
        for (let i = 0; i < 20; i++) {
          l.add(0, 0, 1, 1)
          l.sortKey[i] = Math.floor(rnd() * 10)
          l.sortKey2![i] = Math.floor(rnd() * 3)
        }
      }
      expect(order(l)).toEqual(reference(l))
    }
  })

  it('matches a reference sort under random touched key changes (ties, geometry-only touches, hides, swap-removes)', () => {
    for (const seed0 of [1, 7, 99, 2024]) {
      let seed = seed0
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) as number
      const l = make(80, () => Math.floor(rnd() * 12))
      l.enableSortKey2()
      for (let step = 0; step < 400; step++) {
        const op = (rnd() * 8) | 0
        const lo = (rnd() * l.count) | 0
        const hi = Math.min(l.count - 1, lo + ((rnd() * 6) | 0))
        if (op <= 2) {
          // a few keys inside a narrow range change (often to a tie), the range is touched
          for (let i = lo; i <= hi; i++) if (rnd() < 0.6) l.sortKey[i] = Math.floor(rnd() * 12)
          if (rnd() < 0.3) for (let i = lo; i <= hi; i++) l.sortKey2![i] = Math.floor(rnd() * 3)
          l.touchRange(lo, hi)
        } else if (op === 3) {
          // geometry only: the key is untouched
          for (let i = lo; i <= hi; i++) l.x[i] += 1
          l.touchRange(lo, hi)
        } else if (op === 4) {
          l.flags[lo] ^= SPRITE_HIDDEN
          l.touchRange(lo)
        } else if (op === 5 && l.count > 10) {
          l.removeAt(lo)
        } else if (op === 6) {
          const i = l.add(0, 0, 1, 1)
          l.sortKey[i] = Math.floor(rnd() * 12)
        } else if (op === 7 && rnd() < 0.05) l.touch()
        // sometimes nobody asks for the order this step, so touches accumulate
        if (rnd() < 0.7) expect(order(l)).toEqual(reference(l))
      }
      expect(order(l)).toEqual(reference(l))
    }
  })

  it('bumps orderVersion only when the order itself changes', () => {
    const l = make(20, (i) => i)
    order(l)
    const v = l.orderVersion
    l.x[3] = 9
    l.touchRange(3)
    order(l)
    expect(l.orderVersion).toBe(v)
    l.sortKey[3] = 50
    l.touchRange(3)
    order(l)
    expect(l.orderVersion).toBe(v + 1)
    order(l)
    expect(l.orderVersion).toBe(v + 1)
  })

  it('reuses the sorted order until a touched key changes and fixes up only touched slots', () => {
    const sort = vi.spyOn(Int32Array.prototype, 'sort')
    const l = make(1000, (i) => i)
    const cached = l.drawOrder()
    sort.mockClear()
    expect(l.drawOrder()).toBe(cached)
    expect(sort).not.toHaveBeenCalled()
    l.sortKey[700] = 12.5
    l.touchRange(700)
    expect(order(l)).toEqual(reference(l))
    expect(sort).not.toHaveBeenCalled()
    sort.mockRestore()
  })

  it('without sortByKey the order is slot order', () => {
    const l = new SpriteLayer()
    for (let i = 0; i < 4; i++) l.add(i, 0, 1, 1)
    l.sortKey[0] = 9
    expect(order(l)).toEqual([0, 1, 2, 3])
  })
})
