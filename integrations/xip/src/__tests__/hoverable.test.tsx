// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, act } from '@testing-library/react'
import { ECSWorld, EventBus, AssetManager, createTransform, createEngineStats } from '@xip/core'
import { createSprite } from '@xip/renderer'
import { EngineContext, type EngineState } from '../context'
import { useHoverable } from '../hooks/useHoverable'

function makeEngine(): EngineState {
  const canvas = document.createElement('canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 200 })
  Object.defineProperty(canvas, 'clientHeight', { value: 100 })
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect
  const stats = createEngineStats()
  return {
    ecs: new ECSWorld(),
    events: new EventBus(),
    assets: new AssetManager(),
    input: {} as never,
    physics: {} as never,
    loop: { markDirty: vi.fn() } as never,
    canvas,
    entityIds: new Map(),
    systemTimings: new Map(),
    postProcessStack: {} as never,
    stats,
    getStats: () => stats,
  }
}

// No camera: world = css pixel - (100, 50), so (100, 50) is the world origin.
const move = (engine: EngineState, worldX: number, worldY: number) =>
  act(() => {
    engine.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 + worldX, clientY: 50 + worldY }))
  })

function entity(engine: EngineState, sprite: Record<string, unknown>) {
  const id = engine.ecs.createEntity()
  engine.ecs.addComponent(id, createTransform(0, 0))
  engine.ecs.addComponent(id, createSprite({ width: 20, height: 20, ...sprite }))
  return id
}

describe('useHoverable', () => {
  it('keeps its hovered flag across re-renders with inline options: onEnter fires once per entry', () => {
    const engine = makeEngine()
    const id = entity(engine, {})
    const onEnter = vi.fn()
    const onLeave = vi.fn()
    let renders = 0
    function Card() {
      renders++
      const [count, setCount] = useState(0)
      // inline options object + a callback that sets state: the classic re-fire loop
      useHoverable({
        entityId: id,
        onEnter: () => {
          onEnter()
          setCount(count + 1)
        },
        onLeave,
      })
      return null
    }
    render(
      <EngineContext.Provider value={engine}>
        <Card />
      </EngineContext.Provider>,
    )
    move(engine, 0, 0)
    move(engine, 1, 1)
    move(engine, 2, 2)
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(renders).toBeGreaterThan(1) // it did re-render, so the old effect had re-subscribed
    move(engine, 50, 0)
    expect(onLeave).toHaveBeenCalledTimes(1)
    move(engine, 0, 0)
    expect(onEnter).toHaveBeenCalledTimes(2)
  })

  it('hit-tests the sprite box from its anchor and offset, not as if it were centred', () => {
    const engine = makeEngine()
    // anchor top-left: the box covers world x,y in [0, 20]
    const id = entity(engine, { anchorX: 0, anchorY: 0 })
    let hovered = false
    function Card() {
      hovered = useHoverable({ entityId: id }).isHovered
      return null
    }
    render(
      <EngineContext.Provider value={engine}>
        <Card />
      </EngineContext.Provider>,
    )
    move(engine, 15, 15)
    expect(hovered).toBe(true)
    move(engine, -5, -5) // inside a centred box, outside the drawn one
    expect(hovered).toBe(false)

    // offset moves the box: centred, shifted by (30, 0) -> x in [20, 40]
    const sprite = engine.ecs.getComponent<{ anchorX: number; anchorY: number; offsetX: number }>(id, 'Sprite')!
    sprite.anchorX = 0.5
    sprite.anchorY = 0.5
    sprite.offsetX = 30
    move(engine, 30, 0)
    expect(hovered).toBe(true)
    move(engine, 0, 0)
    expect(hovered).toBe(false)
  })
})
