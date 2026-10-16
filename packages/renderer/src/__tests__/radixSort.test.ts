import { describe, expect, it } from 'vitest'
import { radixSortOrder } from '../radixSort'

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** The comparator order the radix sort replaces: ascending keys, then keys2, then slot. */
function reference(slots: number[], K: Float64Array, K2: Float64Array | null): number[] {
  return [...slots].sort((a, b) => K[a] - K[b] || (K2 ? K2[a] - K2[b] : 0) || a - b)
}

/** Keys with ties, signs, zeros, infinities, subnormals and huge magnitudes. */
function randomKey(next: () => number): number {
  const r = next()
  if (r < 0.1) return Math.floor(next() * 8) // many exact ties
  if (r < 0.13) return -0
  if (r < 0.16) return 0
  if (r < 0.18) return next() < 0.5 ? Infinity : -Infinity
  if (r < 0.2) return (next() < 0.5 ? -1 : 1) * 5e-324
  if (r < 0.21) return (next() < 0.5 ? -1 : 1) * Number.MAX_VALUE
  return (next() - 0.5) * 2 ** Math.floor(next() * 60 - 30)
}

describe('radixSortOrder', () => {
  it('matches the comparator order for every size, with and without a second key', () => {
    const next = rng(7)
    for (const n of [0, 1, 2, 3, 255, 256, 257, 1000, 4000]) {
      const capacity = n + 17
      const K = new Float64Array(capacity).map(() => randomKey(next))
      const K2 = new Float64Array(capacity).map(() => randomKey(next))
      // A subset of slots, seeded in ascending slot order, as the layers do.
      const slots: number[] = []
      for (let i = 0; i < capacity; i++) if (slots.length < n && next() < 0.9) slots.push(i)
      const seeded = Int32Array.from(slots)
      const scratch = new Int32Array(capacity)
      expect(radixSortOrder(seeded, scratch, slots.length, K)).toBe(true)
      expect(Array.from(seeded.subarray(0, slots.length))).toEqual(reference(slots, K, null))

      const seeded2 = Int32Array.from(slots)
      expect(radixSortOrder(seeded2, scratch, slots.length, K, K2)).toBe(true)
      expect(Array.from(seeded2.subarray(0, slots.length))).toEqual(reference(slots, K, K2))
    }
  })

  it('treats -0 and +0 as one key and sorts infinities at the ends', () => {
    const K = Float64Array.of(0, -0, Infinity, -Infinity, 5e-324, -5e-324, 1, -1)
    const order = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    expect(radixSortOrder(order, new Int32Array(8), 8, K)).toBe(true)
    expect(Array.from(order)).toEqual(reference([0, 1, 2, 3, 4, 5, 6, 7], K, null))
    expect(Array.from(order)).toEqual([3, 7, 5, 0, 1, 4, 6, 2])
  })

  it('leaves the order untouched and returns false when a key is NaN', () => {
    const K = Float64Array.of(2, NaN, 1)
    const order = Int32Array.from([0, 1, 2])
    expect(radixSortOrder(order, new Int32Array(3), 3, K)).toBe(false)
    expect(Array.from(order)).toEqual([0, 1, 2])
    // A NaN in the second key is caught before the first key permutes the order.
    const K2 = Float64Array.of(0, 1, NaN)
    expect(radixSortOrder(order, new Int32Array(3), 3, Float64Array.of(2, 1, 0), K2)).toBe(false)
    expect(Array.from(order)).toEqual([0, 1, 2])
  })
})
