// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { ECSWorld, EventBus, AssetManager, createTransform, createEngineStats } from '@xip/core'
import { EngineContext, EntityContext } from '../context'
import type { EngineState } from '../context'
import { Sprite } from '../components/Sprite'

function makeEngine(): EngineState {
  const ecs = new ECSWorld()
  const events = new EventBus()
  const stats = createEngineStats()
  return {
    ecs,
    events,
    assets: new AssetManager(),
    input: {} as never,
    physics: { setGravity: vi.fn() } as never,
    loop: { start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), markDirty: vi.fn() } as never,
    canvas: document.createElement('canvas'),
    entityIds: new Map(),
    systemTimings: new Map(),
    postProcessStack: { add: vi.fn(), remove: vi.fn(), apply: vi.fn(), clear: vi.fn() },
    stats,
    getStats: () => stats,
  }
}

describe('Sprite component', () => {
  let engine: EngineState
  let entityId: number

  beforeEach(() => {
    engine = makeEngine()
    entityId = engine.ecs.createEntity()
    engine.ecs.addComponent(entityId, createTransform(100, 200))
  })

  function renderSprite(props: Record<string, unknown> = {}) {
    return render(
      <EngineContext.Provider value={engine}>
        <EntityContext.Provider value={entityId}>
          <Sprite width={32} height={48} {...props} />
        </EntityContext.Provider>
      </EngineContext.Provider>,
    )
  }

  function getSprite<T extends object = { type: string }>(): T {
    return engine.ecs.getComponent(entityId, 'Sprite') as unknown as T
  }

  it('registers a Sprite component on the entity', async () => {
    await act(async () => {
      renderSprite()
    })
    const sprite = getSprite()
    expect(sprite).toBeDefined()
    expect(sprite.type).toBe('Sprite')
  })

  it('sets correct width and height', async () => {
    await act(async () => {
      renderSprite({ width: 64, height: 96 })
    })
    const sprite = getSprite<{ width: number; height: number }>()
    expect(sprite.width).toBe(64)
    expect(sprite.height).toBe(96)
  })

  it('sets color prop', async () => {
    await act(async () => {
      renderSprite({ color: '#ff0000' })
    })
    const sprite = getSprite<{ color: string }>()
    expect(sprite.color).toBe('#ff0000')
  })

  it('sets shape prop', async () => {
    await act(async () => {
      renderSprite({ shape: 'circle' })
    })
    const sprite = getSprite<{ shape: string }>()
    expect(sprite.shape).toBe('circle')
  })

  it('sets opacity prop', async () => {
    await act(async () => {
      renderSprite({ opacity: 0.5 })
    })
    const sprite = getSprite<{ opacity: number }>()
    expect(sprite.opacity).toBe(0.5)
  })

  it('removes Sprite component on unmount', async () => {
    let unmount: () => void
    await act(async () => {
      const result = renderSprite()
      unmount = result.unmount
    })
    expect(engine.ecs.getComponent(entityId, 'Sprite')).toBeDefined()
    await act(async () => {
      unmount()
    })
    expect(engine.ecs.getComponent(entityId, 'Sprite')).toBeUndefined()
  })

  it('propagates size, offset, anchor, frame, tiling and sampling prop changes to the component', async () => {
    let view!: ReturnType<typeof renderSprite>
    await act(async () => {
      view = renderSprite({ width: 10, height: 20 })
    })
    const tree = (props: Record<string, unknown>) => (
      <EngineContext.Provider value={engine}>
        <EntityContext.Provider value={entityId}>
          <Sprite width={10} height={20} {...props} />
        </EntityContext.Provider>
      </EngineContext.Provider>
    )
    await act(async () => {
      view.rerender(
        tree({
          width: 1152,
          height: 896,
          offsetX: 3,
          offsetY: 4,
          anchorX: 0,
          anchorY: 1,
          frameWidth: 16,
          frameHeight: 24,
          frameColumns: 4,
          tileX: true,
          tileY: true,
          tileSizeX: 8,
          tileSizeY: 9,
          sampling: 'linear',
        }),
      )
    })
    const s = getSprite<Record<string, unknown>>()
    expect(s).toMatchObject({
      width: 1152,
      height: 896,
      offsetX: 3,
      offsetY: 4,
      anchorX: 0,
      anchorY: 1,
      frameWidth: 16,
      frameHeight: 24,
      frameColumns: 4,
      tileX: true,
      tileY: true,
      tileSizeX: 8,
      tileSizeY: 9,
      sampling: 'linear',
    })
  })
})
