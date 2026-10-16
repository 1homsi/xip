/**
 * LSD radix sort for the draw-order fallbacks (`SpriteLayer.drawOrder` and
 * `TextLayer.drawOrder`). The incremental insertion sorts these layers use stay
 * near-linear while the order is roughly kept; this is the fallback they hand a
 * freshly built or badly shuffled order to, where a comparator sort costs
 * `n log n` compares with a JavaScript callback each.
 *
 * Keys are IEEE-754 doubles. The 64-bit pattern is mapped to an unsigned 64-bit
 * value whose numeric order matches the double order (flip the sign bit for
 * positives, flip every bit for negatives), then sorted with eight 8-bit passes.
 * The caller seeds `order` in ascending slot order, so equal keys keep slot order
 * — the same tie-break the comparator sorts this replaces used.
 */

const BUCKETS = 256

let _count = new Uint32Array(BUCKETS)
/** Transformed 64-bit keys, two 32-bit words per slot, indexed by slot. */
let _keys = new Uint32Array(0)

function ensureKeys(slots: number): void {
  if (_keys.length < slots * 2) _keys = new Uint32Array(slots * 2)
}

/** Fill `_keys` for the slots in `order[0..n)`. Returns false if any key is NaN. */
function transform(order: Int32Array, n: number, keys: Float64Array): boolean {
  // Little-endian word order: the low word of slot s is at 2s, the high word at 2s + 1.
  const bits = new Uint32Array(keys.buffer, keys.byteOffset, keys.length * 2)
  for (let k = 0; k < n; k++) {
    const s = order[k]
    const v = keys[s]
    if (v !== v) return false
    let lo = bits[s * 2]
    let hi = bits[s * 2 + 1]
    // -0 and +0 compare equal, so they must sort as the same key.
    if (v === 0) {
      lo = 0
      hi = 0
    }
    if (hi & 0x80000000) {
      lo = ~lo >>> 0
      hi = ~hi >>> 0
    } else {
      hi = (hi ^ 0x80000000) >>> 0
    }
    _keys[s * 2] = lo
    _keys[s * 2 + 1] = hi
  }
  return true
}

/** One 8-bit pass: `src` -> `dst`, stable. `byte` is 0..7 of the transformed key. */
function pass(src: Int32Array, dst: Int32Array, n: number, byte: number): void {
  const word = byte >> 2
  const shift = (byte & 3) * 8
  const count = _count
  count.fill(0)
  for (let j = 0; j < n; j++) count[(_keys[src[j] * 2 + word] >>> shift) & 0xff]++
  let sum = 0
  for (let b = 0; b < BUCKETS; b++) {
    const c = count[b]
    count[b] = sum
    sum += c
  }
  for (let j = 0; j < n; j++) {
    const s = src[j]
    dst[count[(_keys[s * 2 + word] >>> shift) & 0xff]++] = s
  }
}

/** Eight passes over the current `_keys`, leaving the result back in `order`. */
function radix(order: Int32Array, scratch: Int32Array, n: number): void {
  let src: Int32Array = order
  let dst: Int32Array = scratch
  for (let byte = 0; byte < 8; byte++) {
    pass(src, dst, n, byte)
    const t = src
    src = dst
    dst = t
  }
  // Eight (even) passes leave the sorted slots in `order`.
}

/**
 * Stable sort of `order[0..n)` by ascending `keys`, then `keys2` when given.
 * `scratch` must hold at least `n` ints. Returns false, leaving `order` untouched,
 * when a key is NaN: the comparator sorts NaN as a tie and a bit-pattern total
 * order cannot reproduce that, so the caller falls back to the comparator.
 */
export function radixSortOrder(
  order: Int32Array,
  scratch: Int32Array,
  n: number,
  keys: Float64Array,
  keys2: Float64Array | null = null,
): boolean {
  ensureKeys(keys.length)
  if (keys2 !== null) {
    if (!transform(order, n, keys2)) return false
    radix(order, scratch, n)
    if (!transform(order, n, keys)) return false
    radix(order, scratch, n)
    return true
  }
  if (!transform(order, n, keys)) return false
  radix(order, scratch, n)
  return true
}
