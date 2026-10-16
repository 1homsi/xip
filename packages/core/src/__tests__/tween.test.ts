import { describe, it, expect } from 'vitest'
import { tween, Ease } from '../tween'

describe('Ease functions', () => {
  describe('Ease.linear', () => {
    it('returns t unchanged', () => {
      expect(Ease.linear(0)).toBe(0)
      expect(Ease.linear(0.5)).toBe(0.5)
      expect(Ease.linear(1)).toBe(1)
    })
  })

  describe('Ease.easeOutQuad', () => {
    it('returns 0 at t=0 and 1 at t=1', () => {
      expect(Ease.easeOutQuad(0)).toBe(0)
      expect(Ease.easeOutQuad(1)).toBe(1)
    })

    it('returns a value between 0 and 1 for t=0.5', () => {
      const val = Ease.easeOutQuad(0.5)
      expect(val).toBeGreaterThan(0)
      expect(val).toBeLessThan(1)
      // easeOutQuad(0.5) = 0.5 * (2 - 0.5) = 0.75
      expect(val).toBeCloseTo(0.75, 5)
    })
  })

  describe('Ease.easeInQuad', () => {
    it('returns 0 at t=0 and 1 at t=1', () => {
      expect(Ease.easeInQuad(0)).toBe(0)
      expect(Ease.easeInQuad(1)).toBe(1)
    })
  })

  describe('Ease.easeInOutQuad', () => {
    it('returns 0 at t=0 and 1 at t=1', () => {
      expect(Ease.easeInOutQuad(0)).toBe(0)
      expect(Ease.easeInOutQuad(1)).toBe(1)
    })

    it('returns 0.5 at midpoint', () => {
      expect(Ease.easeInOutQuad(0.5)).toBeCloseTo(0.5, 5)
    })
  })

  describe('Ease.easeOutBack', () => {
    it('returns 0 at t=0 and 1 at t=1', () => {
      expect(Ease.easeOutBack(0)).toBeCloseTo(0, 5)
      expect(Ease.easeOutBack(1)).toBeCloseTo(1, 5)
    })
  })
})

describe('tween', () => {
  it('calls onUpdate with interpolated value at mid-point', () => {
    const values: number[] = []
    const t = tween(0, 100, 1, Ease.linear, (v) => {
      values.push(v)
    })
    t.update(0.5)
    expect(values).toHaveLength(1)
    expect(values[0]).toBeCloseTo(50, 5)
  })

  it('calls onUpdate with final value at duration boundary', () => {
    const values: number[] = []
    const t = tween(0, 100, 1, Ease.linear, (v) => {
      values.push(v)
    })
    t.update(1.0)
    expect(values[values.length - 1]).toBeCloseTo(100, 5)
  })

  it('isComplete is false before duration is reached', () => {
    const t = tween(0, 100, 1, Ease.linear, () => {})
    t.update(0.5)
    expect(t.isComplete).toBe(false)
  })

  it('isComplete is true after duration is fully elapsed', () => {
    const t = tween(0, 100, 1, Ease.linear, () => {})
    t.update(1.0)
    expect(t.isComplete).toBe(true)
  })

  it('isComplete is true when elapsed exceeds duration', () => {
    const t = tween(0, 100, 0.5, Ease.linear, () => {})
    t.update(2.0)
    expect(t.isComplete).toBe(true)
  })

  it('onComplete fires when tween finishes', () => {
    let fired = false
    const t = tween(
      0,
      100,
      1,
      Ease.linear,
      () => {},
      () => {
        fired = true
      },
    )
    t.update(1.0)
    expect(fired).toBe(true)
  })

  it('onComplete fires only once even if update is called again', () => {
    let count = 0
    const t = tween(
      0,
      100,
      1,
      Ease.linear,
      () => {},
      () => {
        count++
      },
    )
    t.update(1.0)
    t.update(0.5)
    expect(count).toBe(1)
  })

  it('stop() prevents further onUpdate calls', () => {
    const values: number[] = []
    const t = tween(0, 100, 1, Ease.linear, (v) => {
      values.push(v)
    })
    t.update(0.2)
    t.stop()
    t.update(0.2)
    t.update(0.2)
    expect(values).toHaveLength(1)
  })

  it('stop() prevents onComplete from firing', () => {
    let fired = false
    const t = tween(
      0,
      100,
      1,
      Ease.linear,
      () => {},
      () => {
        fired = true
      },
    )
    t.stop()
    t.update(1.0)
    expect(fired).toBe(false)
  })

  it('multiple update steps accumulate correctly', () => {
    const values: number[] = []
    const t = tween(0, 100, 1, Ease.linear, (v) => {
      values.push(v)
    })
    t.update(0.25)
    t.update(0.25)
    t.update(0.25)
    t.update(0.25)
    expect(t.isComplete).toBe(true)
    // The final call should produce value ~100
    expect(values[values.length - 1]).toBeCloseTo(100, 5)
  })

  it('tweens from non-zero start value', () => {
    const values: number[] = []
    const t = tween(50, 150, 1, Ease.linear, (v) => {
      values.push(v)
    })
    t.update(0.5)
    expect(values[0]).toBeCloseTo(100, 5)
  })

  it('handles negative tween direction', () => {
    const values: number[] = []
    const t = tween(100, 0, 1, Ease.linear, (v) => {
      values.push(v)
    })
    t.update(0.5)
    expect(values[0]).toBeCloseTo(50, 5)
  })

  it('zero-duration tween completes immediately at full value', () => {
    const values: number[] = []
    let fired = false
    const t = tween(
      0,
      100,
      0,
      Ease.linear,
      (v) => {
        values.push(v)
      },
      () => {
        fired = true
      },
    )
    t.update(0)
    expect(values[0]).toBeCloseTo(100, 5)
    expect(t.isComplete).toBe(true)
    expect(fired).toBe(true)
  })

  describe('delay option', () => {
    it('does not call onUpdate during the delay period', () => {
      const values: number[] = []
      const t = tween(0, 100, 1, Ease.linear, (v) => values.push(v), undefined, { delay: 0.5 })
      t.update(0.3)
      expect(values).toHaveLength(0)
    })

    it('begins tweening after the delay expires', () => {
      const values: number[] = []
      const t = tween(0, 100, 1, Ease.linear, (v) => values.push(v), undefined, { delay: 0.5 })
      t.update(0.5) // exactly consumes delay
      t.update(0.5) // half of tween
      expect(values[values.length - 1]).toBeCloseTo(50, 1)
    })

    it('carries delay overshoot into tween time', () => {
      const values: number[] = []
      const t = tween(0, 100, 1, Ease.linear, (v) => values.push(v), undefined, { delay: 0.4 })
      // Single update that covers delay + half tween
      t.update(0.9)
      expect(values.length).toBeGreaterThan(0)
      expect(values[values.length - 1]).toBeCloseTo(50, 1)
    })

    it('completes and fires onComplete after delay + duration', () => {
      let fired = false
      const t = tween(
        0,
        100,
        1,
        Ease.linear,
        () => {},
        () => {
          fired = true
        },
        { delay: 0.5 },
      )
      t.update(1.5)
      expect(t.isComplete).toBe(true)
      expect(fired).toBe(true)
    })
  })

  describe('repeat option', () => {
    it('plays twice with repeat:1', () => {
      const completions: number[] = []
      let cycleEnd = 0
      const t = tween(
        0,
        10,
        1,
        Ease.linear,
        (v) => {
          if (v >= 10) cycleEnd++
        },
        () => completions.push(1),
        { repeat: 1 },
      )
      t.update(1.0) // first pass done
      expect(t.isComplete).toBe(false)
      t.update(1.0) // second pass done
      expect(t.isComplete).toBe(true)
      expect(completions).toHaveLength(1)
    })

    it('loops indefinitely with repeat:Infinity', () => {
      let count = 0
      const t = tween(
        0,
        10,
        1,
        Ease.linear,
        (v) => {
          if (v >= 9.9) count++
        },
        undefined,
        { repeat: Infinity },
      )
      for (let i = 0; i < 5; i++) t.update(1.0)
      expect(t.isComplete).toBe(false)
      expect(count).toBeGreaterThanOrEqual(5)
    })

    it('carries a large dt overshoot into the next passes (XB-14)', () => {
      let fired = 0
      const t = tween(
        0,
        1,
        1,
        Ease.linear,
        () => {},
        () => fired++,
        { repeat: 3 },
      )
      t.update(0.5)
      t.update(10)
      expect(t.isComplete).toBe(true)
      expect(fired).toBe(1)
    })

    it('onComplete fires only once even with repeat:2', () => {
      let fired = 0
      const t = tween(
        0,
        10,
        1,
        Ease.linear,
        () => {},
        () => fired++,
        { repeat: 2 },
      )
      t.update(1.0)
      t.update(1.0)
      t.update(1.0)
      expect(fired).toBe(1)
    })
  })

  describe('yoyo option', () => {
    it('returns to start value on second pass', () => {
      const values: number[] = []
      const t = tween(0, 100, 1, Ease.linear, (v) => values.push(v), undefined, { repeat: 1, yoyo: true })
      t.update(0.5) // mid forward pass → ~50
      t.update(0.5) // end of forward pass, start reverse
      t.update(0.5) // mid reverse pass → ~50
      t.update(0.5) // end of reverse pass → 0
      expect(t.isComplete).toBe(true)
      expect(values[values.length - 1]).toBeCloseTo(0, 1)
    })

    it('reaches full value at end of forward pass', () => {
      const values: number[] = []
      const t = tween(0, 100, 1, Ease.linear, (v) => values.push(v), undefined, { repeat: 1, yoyo: true })
      t.update(1.0) // complete forward pass
      // The value produced at end of forward pass should be 100
      expect(values.some((v) => Math.abs(v - 100) < 1)).toBe(true)
    })
  })
})
