import { describe, it, expect, vi } from 'vitest'
import { createTimeline } from '../tweenTimeline'

describe('createTimeline', () => {
  it('creates a timeline that is not running initially', () => {
    const timeline = createTimeline()
    expect(timeline.isRunning).toBe(false)
  })

  it('add returns the timeline for chaining', () => {
    const timeline = createTimeline()
    const result = timeline.add({
      from: 0,
      to: 1,
      duration: 1,
      onUpdate: () => {},
    })
    expect(result).toBe(timeline)
  })

  it('allows chaining multiple adds', () => {
    const timeline = createTimeline()
    const result = timeline
      .add({ from: 0, to: 1, duration: 1, onUpdate: () => {} })
      .add({ from: 1, to: 2, duration: 1, onUpdate: () => {} })
    expect(result).toBe(timeline)
  })

  it('start sets running to true', () => {
    const timeline = createTimeline()
    timeline.add({ from: 0, to: 1, duration: 1, onUpdate: () => {} })
    timeline.start()
    expect(timeline.isRunning).toBe(true)
  })

  it('stop sets running to false', () => {
    const timeline = createTimeline()
    timeline.add({ from: 0, to: 1, duration: 1, onUpdate: () => {} })
    timeline.start()
    timeline.stop()
    expect(timeline.isRunning).toBe(false)
  })

  it('start with no entries does not throw', () => {
    const timeline = createTimeline()
    expect(() => timeline.start()).not.toThrow()
    // With no entries, it should immediately stop
    expect(timeline.isRunning).toBe(false)
  })

  it('stop without start does not throw', () => {
    const timeline = createTimeline()
    expect(() => timeline.stop()).not.toThrow()
  })

  it('a looping timeline keeps its real period when a frame overshoots the cycle end', () => {
    // 10 plays of 1 s, stepped at 0.3 s: 10 s of game time is ceil(10 / 0.3) = 34 frames
    let cycles = 0
    const timeline = createTimeline({ repeat: 9, onComplete: () => cycles++ })
    timeline.add({ from: 0, to: 1, duration: 1, onUpdate: () => {} })
    timeline.start()
    let frames = 0
    while (!timeline.isComplete && frames < 1000) {
      timeline.update(0.3)
      frames++
    }
    expect(cycles).toBe(1)
    expect(frames).toBeLessThanOrEqual(34)
  })
})
