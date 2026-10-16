import { describe, it, expect } from 'vitest'
import { ECSWorld } from '@xip/core'
import { updateAnimation } from '../frameSim'
import { createSprite } from '../components/sprite'
import type { AnimationStateComponent } from '../components/animationState'

function setup(overrides: Partial<AnimationStateComponent>) {
  const world = new ECSWorld()
  const id = world.createEntity()
  world.addComponent(id, createSprite({ width: 8, height: 8 }))
  const anim = {
    type: 'AnimationState',
    frames: [0, 1, 2],
    fps: 10,
    loop: false,
    playing: true,
    currentIndex: 0,
    timer: 0,
    _completed: false,
    ...overrides,
  } as AnimationStateComponent
  world.addComponent(id, anim)
  return { world, id, anim }
}

describe('animation frame events', () => {
  it('a non-looping clip fires its last-frame event once when one update spans many frames', () => {
    const hits: number[] = []
    const { world } = setup({ frameEvents: { 2: () => hits.push(2) } })
    updateAnimation(world, 1.0)
    expect(hits).toEqual([2])
  })

  it('a non-looping clip completes once, stops on its last frame and clears the timer', () => {
    let completed = 0
    const { world, id, anim } = setup({ onComplete: () => completed++ })
    updateAnimation(world, 1.0)
    expect(completed).toBe(1)
    expect(anim.playing).toBe(false)
    expect(anim.currentIndex).toBe(2)
    expect(anim.timer).toBe(0)
    expect(world.getComponent<{ frameIndex: number }>(id, 'Sprite')!.frameIndex).toBe(2)
  })

  it('a looping clip still fires its event on every wrap', () => {
    const hits: number[] = []
    const { world } = setup({ loop: true, fps: 1, frameEvents: { 0: () => hits.push(0) } })
    // fps 1, 3 s update: steps go to index 1, 2, then wrap to 0, so the index-0 event fires once
    updateAnimation(world, 3)
    expect(hits).toEqual([0])
  })
})
