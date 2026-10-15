import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GameLoop } from '../loop/gameLoop'

// Mock browser globals required by GameLoop
let rafCallback: ((time: number) => void) | null = null
let rafId = 0
const mockRaf = (cb: (time: number) => void): number => {
  rafCallback = cb
  return ++rafId
}
const mockCaf = (): void => {
  rafCallback = null
}

// @ts-ignore
globalThis.requestAnimationFrame = mockRaf
// @ts-ignore
globalThis.cancelAnimationFrame = mockCaf

let _now = 0
// @ts-ignore
globalThis.performance = { now: () => _now }

// Mock document.visibilitychange plumbing for the auto-pause lifecycle
type VisListener = (ev: unknown) => void
let visListeners: VisListener[] = []
let hidden = false
// @ts-ignore
globalThis.document = {
  get hidden() {
    return hidden
  },
  addEventListener(_: string, cb: VisListener) {
    visListeners.push(cb)
  },
  removeEventListener(_: string, cb: VisListener) {
    visListeners = visListeners.filter((l) => l !== cb)
  },
}

/** Simulate the tab being hidden or shown */
function setTabHidden(value: boolean): void {
  hidden = value
  for (const l of [...visListeners]) l({})
}

/** Simulate one rAF frame at the given timestamp */
function fireFrame(time: number): void {
  const cb = rafCallback
  rafCallback = null
  cb?.(time)
}

describe('GameLoop', () => {
  let ticks: number[]
  let loop: GameLoop

  beforeEach(() => {
    ticks = []
    rafCallback = null
    _now = 0
    loop = new GameLoop((dt) => {
      ticks.push(dt)
    })
  })

  describe('start / stop', () => {
    it('isRunning is false before start', () => {
      expect(loop.isRunning).toBe(false)
    })

    it('start() sets isRunning to true', () => {
      loop.start()
      expect(loop.isRunning).toBe(true)
      loop.stop()
    })

    it('stop() sets isRunning to false', () => {
      loop.start()
      loop.stop()
      expect(loop.isRunning).toBe(false)
    })

    it('calling start() twice does not double-run', () => {
      loop.start()
      const idBefore = rafId
      loop.start() // should be a no-op
      expect(rafId).toBe(idBefore)
      loop.stop()
    })
  })

  describe('pause / resume', () => {
    it('isPaused is false initially', () => {
      expect(loop.isPaused).toBe(false)
    })

    it('pause() sets isPaused to true and isRunning to false', () => {
      loop.start()
      loop.pause()
      expect(loop.isPaused).toBe(true)
      expect(loop.isRunning).toBe(false)
    })

    it('resume() clears isPaused and sets isRunning back to true', () => {
      loop.start()
      loop.pause()
      loop.resume()
      expect(loop.isPaused).toBe(false)
      expect(loop.isRunning).toBe(true)
      loop.stop()
    })

    it('resume() does nothing if not paused', () => {
      loop.resume() // not paused, should be no-op
      expect(loop.isRunning).toBe(false)
    })

    it('pause() does nothing if not running', () => {
      loop.pause() // not running
      expect(loop.isPaused).toBe(false)
    })
  })

  describe('fixedDt', () => {
    it('uses fixed dt instead of real elapsed time when fixedDt is set', () => {
      const fixedTicks: number[] = []
      const fixedLoop = new GameLoop(
        (dt) => {
          fixedTicks.push(dt)
        },
        { fixedDt: 1 / 60 },
      )
      _now = 0
      fixedLoop.start()
      // Fire a frame with a large gap — should still get fixedDt
      fireFrame(100)
      expect(fixedTicks).toHaveLength(1)
      expect(fixedTicks[0]).toBeCloseTo(1 / 60, 6)
      // Fire another frame with different gap
      fireFrame(150)
      expect(fixedTicks[1]).toBeCloseTo(1 / 60, 6)
      fixedLoop.stop()
    })
  })

  describe('onTick', () => {
    it('keeps the realtime loop scheduled when onTick throws', () => {
      let attempts = 0
      const failingLoop = new GameLoop(() => {
        attempts++
        throw new Error('tick failed')
      })
      failingLoop.start()

      expect(() => fireFrame(16)).toThrow('tick failed')
      expect(rafCallback).not.toBeNull()
      expect(() => fireFrame(32)).toThrow('tick failed')
      expect(attempts).toBe(2)
      failingLoop.stop()
    })

    it('onTick is called with correct dt when rAF fires', () => {
      _now = 0
      loop.start()
      // first frame at t=16ms
      fireFrame(16)
      expect(ticks).toHaveLength(1)
      expect(ticks[0]).toBeCloseTo(0.016, 3)
      loop.stop()
    })

    it('dt is capped at 0.1 seconds', () => {
      _now = 0
      loop.start()
      // Simulate a very large gap (e.g. tab was hidden for 5 seconds)
      fireFrame(5000)
      expect(ticks[0]).toBe(0.1)
      loop.stop()
    })

    it('multiple frames accumulate correctly', () => {
      _now = 0
      loop.start()
      fireFrame(16)
      fireFrame(32)
      fireFrame(48)
      expect(ticks).toHaveLength(3)
      expect(ticks[0]).toBeCloseTo(0.016, 3)
      expect(ticks[1]).toBeCloseTo(0.016, 3)
      expect(ticks[2]).toBeCloseTo(0.016, 3)
      loop.stop()
    })

    it('onTick is NOT called after stop()', () => {
      _now = 0
      loop.start()
      loop.stop()
      fireFrame(16)
      expect(ticks).toHaveLength(0)
    })

    it('onTick is NOT called while paused', () => {
      _now = 0
      loop.start()
      loop.pause()
      fireFrame(16)
      expect(ticks).toHaveLength(0)
    })
  })

  describe('onDemand mode', () => {
    it('isOnDemand is false for default (realtime) mode', () => {
      expect(loop.isOnDemand).toBe(false)
    })

    it('isOnDemand is true when mode is onDemand', () => {
      const ondemand = new GameLoop(() => {}, { mode: 'onDemand' })
      expect(ondemand.isOnDemand).toBe(true)
    })

    it('start() renders one initial frame in onDemand mode', () => {
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop((dt) => onDemandTicks.push(dt), {
        mode: 'onDemand',
        fixedDt: 1 / 60,
      })
      _now = 0
      ondemand.start()
      fireFrame(16)
      expect(onDemandTicks).toHaveLength(1)
      ondemand.stop()
    })

    it('does not auto-schedule subsequent frames after initial tick', () => {
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop((dt) => onDemandTicks.push(dt), {
        mode: 'onDemand',
        fixedDt: 1 / 60,
      })
      _now = 0
      ondemand.start()
      fireFrame(16) // initial frame
      // After the initial frame, no further rAF should be scheduled
      expect(rafCallback).toBeNull()
      ondemand.stop()
    })

    it('markDirty() schedules exactly one frame', () => {
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop((dt) => onDemandTicks.push(dt), {
        mode: 'onDemand',
        fixedDt: 1 / 60,
      })
      _now = 0
      ondemand.start()
      fireFrame(16) // initial
      expect(onDemandTicks).toHaveLength(1)
      ondemand.markDirty()
      expect(rafCallback).not.toBeNull()
      fireFrame(32)
      expect(onDemandTicks).toHaveLength(2)
      ondemand.stop()
    })

    it('markDirty() calls within a single frame coalesce to one', () => {
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop((dt) => onDemandTicks.push(dt), {
        mode: 'onDemand',
        fixedDt: 1 / 60,
      })
      _now = 0
      ondemand.start()
      fireFrame(16) // initial
      ondemand.markDirty()
      ondemand.markDirty()
      ondemand.markDirty()
      fireFrame(32)
      expect(onDemandTicks).toHaveLength(2) // initial + one coalesced
      expect(rafCallback).toBeNull()
      ondemand.stop()
    })

    it('markDirty() during onTick schedules the next frame', () => {
      let remaining = 3
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop(
        (dt) => {
          onDemandTicks.push(dt)
          if (remaining > 0) {
            remaining--
            ondemand.markDirty()
          }
        },
        { mode: 'onDemand', fixedDt: 1 / 60 },
      )
      _now = 0
      ondemand.start()
      fireFrame(16)
      fireFrame(32)
      fireFrame(48)
      fireFrame(64)
      // initial + 3 dirty-triggered ticks
      expect(onDemandTicks).toHaveLength(4)
      ondemand.stop()
    })

    it('markDirty() is a no-op in realtime mode', () => {
      const realtime = new GameLoop(() => {}, { fixedDt: 1 / 60 })
      realtime.start()
      // Should not throw or double-schedule
      realtime.markDirty()
      realtime.markDirty()
      realtime.stop()
    })

    it('markDirty() is a no-op when loop is not running', () => {
      const ondemand = new GameLoop(() => {}, { mode: 'onDemand' })
      ondemand.markDirty()
      expect(rafCallback).toBeNull()
    })

    it('a markDirty() issued before start() is not lost: the first frame still renders it', () => {
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop((dt) => onDemandTicks.push(dt), { mode: 'onDemand', fixedDt: 1 / 60 })
      ondemand.markDirty()
      _now = 0
      ondemand.start()
      fireFrame(16)
      expect(onDemandTicks).toHaveLength(1)
      ondemand.stop()
    })

    it('every write is rendered: a markDirty() coalesced into a pending wake is drawn by that wake, and one after it wakes again', () => {
      // The frame reads the data when it runs, so a write made before the pending frame is
      // covered by it; a write after the frame has run (flag reset) schedules a new one.
      const seen: number[] = []
      let data = 0
      const ondemand = new GameLoop(() => seen.push(data), { mode: 'onDemand', fixedDt: 1 / 60 })
      _now = 0
      ondemand.start()
      fireFrame(16)
      data = 1
      ondemand.markDirty()
      data = 2
      ondemand.markDirty() // coalesced into the pending wake
      fireFrame(32)
      data = 3
      ondemand.markDirty() // after the frame ran: wakes again
      fireFrame(48)
      expect(seen).toEqual([0, 2, 3])
      ondemand.stop()
    })

    it('pause() cancels pending dirty frames in onDemand mode', () => {
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop((dt) => onDemandTicks.push(dt), {
        mode: 'onDemand',
        fixedDt: 1 / 60,
      })
      _now = 0
      ondemand.start()
      fireFrame(16) // initial
      ondemand.markDirty()
      ondemand.pause()
      fireFrame(32)
      expect(onDemandTicks).toHaveLength(1) // only the initial frame
    })

    it('resume() in onDemand mode renders one frame', () => {
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop((dt) => onDemandTicks.push(dt), {
        mode: 'onDemand',
        fixedDt: 1 / 60,
      })
      _now = 0
      ondemand.start()
      fireFrame(16)
      ondemand.pause()
      ondemand.resume()
      expect(rafCallback).not.toBeNull()
      fireFrame(32)
      expect(onDemandTicks).toHaveLength(2)
      ondemand.stop()
    })

    it('hitPause keeps onDemand loop awake until freeze expires', () => {
      const renderCalls: number[] = []
      const onDemandTicks: number[] = []
      const ondemand = new GameLoop((dt) => onDemandTicks.push(dt), {
        mode: 'onDemand',
        fixedDt: 1 / 60,
        onRender: (dt) => renderCalls.push(dt),
      })
      _now = 0
      ondemand.start()
      fireFrame(0) // initial
      ondemand.hitPause(0.05) // 50ms freeze
      _now = 16
      fireFrame(16) // freeze still active — should call onRender, not onTick
      _now = 32
      fireFrame(32) // still frozen
      _now = 80
      fireFrame(80) // freeze now over — next frame should tick normally
      // onRender was called during the frozen frames
      expect(renderCalls.length).toBeGreaterThan(0)
      ondemand.stop()
    })
  })

  describe('visibility lifecycle', () => {
    it('auto-pauses when the tab is hidden and resumes when visible', () => {
      const loop = new GameLoop(vi.fn())
      loop.start()
      expect(loop.isPaused).toBe(false)

      setTabHidden(true)
      expect(loop.isPaused).toBe(true)
      expect(loop.isAutoPaused).toBe(true)

      setTabHidden(false)
      expect(loop.isPaused).toBe(false)
      expect(loop.isAutoPaused).toBe(false)

      loop.stop()
    })

    it('fires onVisibilityChange before pausing', () => {
      const calls: boolean[] = []
      const loop = new GameLoop(vi.fn(), { onVisibilityChange: (v) => calls.push(v), autoPauseOnHidden: false })
      loop.start()

      setTabHidden(true)
      setTabHidden(false)

      expect(calls).toEqual([false, true])
      expect(loop.isPaused).toBe(false) // auto-pause disabled

      loop.stop()
    })

    it('respects manual pause across visibility changes', () => {
      const loop = new GameLoop(vi.fn())
      loop.start()
      loop.pause()

      // Hidden while manually paused → no auto-pause marker
      setTabHidden(true)
      expect(loop.isAutoPaused).toBe(false)

      // Shown again → stays paused (user paused intentionally)
      setTabHidden(false)
      expect(loop.isPaused).toBe(true)

      loop.stop()
    })

    it('does not double-resume after stop', () => {
      const loop = new GameLoop(vi.fn())
      loop.start()
      setTabHidden(true)
      loop.stop()
      setTabHidden(false)
      expect(loop.isRunning).toBe(false)
      expect(loop.isAutoPaused).toBe(false)
    })
  })
})
