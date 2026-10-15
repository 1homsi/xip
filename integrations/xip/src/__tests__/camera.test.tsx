// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { ECSWorld, EventBus, AssetManager, createEngineStats } from '@xip/core'
import { EngineContext } from '../context'
import type { EngineState } from '../context'
import { Camera2D } from '../components/Camera2D'
import type { Camera2DComponent } from '@xip/renderer'

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

function Wrapper({ engine, children }: { engine: EngineState; children: React.ReactNode }) {
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>
}

function getCameraComponent(engine: EngineState): Camera2DComponent | undefined {
  const entities = engine.ecs.query('Camera2D')
  if (entities.length === 0) return undefined
  return engine.ecs.getComponent<Camera2DComponent>(entities[0], 'Camera2D')
}

describe('Camera2D component', () => {
  let engine: EngineState

  beforeEach(() => {
    engine = makeEngine()
  })

  it('creates a Camera2D entity on mount', () => {
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D />
        </Wrapper>,
      )
    })
    const entities = engine.ecs.query('Camera2D')
    expect(entities.length).toBe(1)
  })

  it('sets followEntityId from followEntity prop', () => {
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D followEntity="player" />
        </Wrapper>,
      )
    })
    const cam = getCameraComponent(engine)
    expect(cam?.followEntityId).toBe('player')
  })

  it('sets zoom prop', () => {
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D zoom={2} />
        </Wrapper>,
      )
    })
    const cam = getCameraComponent(engine)
    expect(cam?.zoom).toBe(2)
  })

  it('sets smoothing prop', () => {
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D smoothing={0.87} />
        </Wrapper>,
      )
    })
    const cam = getCameraComponent(engine)
    expect(cam?.smoothing).toBe(0.87)
  })

  it('sets background prop', () => {
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D background="#000000" />
        </Wrapper>,
      )
    })
    const cam = getCameraComponent(engine)
    expect(cam?.background).toBe('#000000')
  })

  it('sets bounds prop', () => {
    const bounds = { x: 0, y: 0, width: 2000, height: 1000 }
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D bounds={bounds} />
        </Wrapper>,
      )
    })
    const cam = getCameraComponent(engine)
    expect(cam?.bounds).toEqual(bounds)
  })

  it('sets initial position', () => {
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D x={100} y={200} />
        </Wrapper>,
      )
    })
    const cam = getCameraComponent(engine)
    expect(cam?.x).toBe(100)
    expect(cam?.y).toBe(200)
  })

  it('destroys camera entity on unmount', () => {
    let unmount: () => void
    act(() => {
      const result = render(
        <Wrapper engine={engine}>
          <Camera2D />
        </Wrapper>,
      )
      unmount = result.unmount
    })
    expect(engine.ecs.query('Camera2D').length).toBe(1)
    act(() => {
      unmount()
    })
    expect(engine.ecs.query('Camera2D').length).toBe(0)
  })

  it('sets followOffset props', () => {
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D followOffsetX={50} followOffsetY={-30} />
        </Wrapper>,
      )
    })
    const cam = getCameraComponent(engine)
    expect(cam?.followOffsetX).toBe(50)
    expect(cam?.followOffsetY).toBe(-30)
  })

  it('uses default values when no props given', () => {
    act(() => {
      render(
        <Wrapper engine={engine}>
          <Camera2D />
        </Wrapper>,
      )
    })
    const cam = getCameraComponent(engine)
    expect(cam?.x).toBe(0)
    expect(cam?.y).toBe(0)
    expect(cam?.zoom).toBe(1)
    expect(cam?.smoothing).toBe(0)
    expect(cam?.background).toBe('#1a1a2e')
  })
})

describe('useCamera().zoomAt', () => {
  it('keeps the world point under the cursor fixed', async () => {
    const { useCamera } = await import('../hooks/useCamera')
    const engine = makeEngine()
    ;(engine.loop as unknown as { markDirty: () => void }).markDirty = vi.fn()
    engine.canvas.width = 800
    engine.canvas.height = 600
    let cam!: ReturnType<typeof useCamera>
    function Probe() {
      cam = useCamera()
      return null
    }
    render(
      <Wrapper engine={engine}>
        <Camera2D x={100} y={50} zoom={1} />
        <Probe />
      </Wrapper>,
    )
    const c = getCameraComponent(engine)!
    const worldAt = (sx: number, sy: number) => ({ x: c.x + (sx - 400) / c.zoom, y: c.y + (sy - 300) / c.zoom })
    const before = worldAt(600, 100)
    act(() => cam.zoomAt(600, 100, 2.5))
    const after = worldAt(600, 100)
    expect(c.zoom).toBe(2.5)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })
})

describe('Camera2D followPoint / followSprite', () => {
  const layerStub = (id = 7) =>
    ({
      x: new Float32Array([5]),
      y: new Float32Array([6]),
      ids: new Int32Array([id]),
      flags: new Uint8Array(1),
      count: 1,
    }) as never

  it('passes followPoint and followSprite to the camera component', () => {
    const engine = makeEngine()
    const followPoint = () => ({ x: 1, y: 2 })
    const layer = layerStub()
    render(
      <Wrapper engine={engine}>
        <Camera2D followPoint={followPoint} followSprite={{ layer, id: 7 }} />
      </Wrapper>,
    )
    const cam = getCameraComponent(engine)!
    expect(cam.followPoint).toBe(followPoint)
    expect(cam.followSprite).toEqual({ layer, index: undefined, id: 7 })
    expect(cam.followEntityId).toBeUndefined()
  })

  it('updates the follow targets on rerender without resetting the camera position', () => {
    const engine = makeEngine()
    const layer = layerStub()
    const { rerender } = render(
      <Wrapper engine={engine}>
        <Camera2D followPoint={() => ({ x: 1, y: 1 })} />
      </Wrapper>,
    )
    const cam = getCameraComponent(engine)!
    cam.x = 123
    const next = () => ({ x: 2, y: 2 })
    rerender(
      <Wrapper engine={engine}>
        <Camera2D followPoint={next} followSprite={{ layer, index: 0 }} />
      </Wrapper>,
    )
    expect(cam.followPoint).toBe(next)
    expect(cam.followSprite?.index).toBe(0)
    rerender(
      <Wrapper engine={engine}>
        <Camera2D />
      </Wrapper>,
    )
    expect(cam.followPoint).toBeUndefined()
    expect(cam.followSprite).toBeUndefined()
  })

  it('keeps a panned camera when a new but equal bounds object is passed on re-render', () => {
    const engine = makeEngine()
    const view = render(
      <Wrapper engine={engine}>
        <Camera2D x={100} y={100} bounds={{ x: 0, y: 0, width: 5000, height: 5000 }} />
      </Wrapper>,
    )
    const cam = getCameraComponent(engine)!
    cam.x = 3000
    cam.y = 2500
    view.rerender(
      <Wrapper engine={engine}>
        <Camera2D x={100} y={100} bounds={{ x: 0, y: 0, width: 5000, height: 5000 }} />
      </Wrapper>,
    )
    expect([cam.x, cam.y]).toEqual([3000, 2500])
    // A real change of the bounds is still applied, without moving the camera.
    view.rerender(
      <Wrapper engine={engine}>
        <Camera2D x={100} y={100} bounds={{ x: 0, y: 0, width: 4000, height: 4000 }} />
      </Wrapper>,
    )
    expect(cam.bounds).toEqual({ x: 0, y: 0, width: 4000, height: 4000 })
    expect([cam.x, cam.y]).toEqual([3000, 2500])
    // Changing x / y props does move it.
    view.rerender(
      <Wrapper engine={engine}>
        <Camera2D x={200} y={100} bounds={{ x: 0, y: 0, width: 4000, height: 4000 }} />
      </Wrapper>,
    )
    expect(cam.x).toBe(200)
  })
})
