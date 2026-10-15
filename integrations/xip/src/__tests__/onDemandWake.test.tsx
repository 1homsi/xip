// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useContext } from 'react'
import { render, act, cleanup } from '@testing-library/react'

vi.mock('@xip/renderer', async (orig) => {
  const actual = await orig<typeof import('@xip/renderer')>()
  class RenderSystem {
    update() {}
    setDefaultSampling() {}
    dispose() {}
  }
  return { ...actual, RenderSystem }
})

import { Game } from '../components/Game'
import { Entity } from '../components/Entity'
import { Transform } from '../components/Transform'
import { Sprite } from '../components/Sprite'
import { Camera2D } from '../components/Camera2D'
import { EngineContext, type EngineState } from '../context'

describe('onDemand loop wake from React prop sync', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function scene(p: { w: number; x: number; sw: number; zoom: number }, probe: () => null) {
    const Probe = probe
    return (
      <Game width={p.w} height={100} mode="onDemand" asyncAssets>
        <Probe />
        <Camera2D zoom={p.zoom} />
        <Entity>
          <Transform x={p.x} y={0} />
          <Sprite width={p.sw} height={10} color="#f00" />
        </Entity>
      </Game>
    )
  }

  it('wakes on Transform / Sprite / Camera2D prop changes and on canvas resize', async () => {
    let engine: EngineState | null = null
    const probe = () => {
      engine = useContext(EngineContext)
      return null
    }
    const props = { w: 200, x: 0, sw: 10, zoom: 1 }
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(scene(props, probe))
    })
    const markDirty = vi.spyOn(engine!.loop, 'markDirty')
    const update = async (next: Partial<typeof props>) => {
      markDirty.mockClear()
      await act(async () => {
        view.rerender(scene({ ...props, ...next }, probe))
      })
      Object.assign(props, next)
      return markDirty.mock.calls.length
    }
    expect(await update({ x: 50 })).toBeGreaterThan(0)
    expect(await update({ sw: 20 })).toBeGreaterThan(0)
    expect(await update({ zoom: 2 })).toBeGreaterThan(0)
    expect(await update({ w: 300 })).toBeGreaterThan(0)
    expect(engine!.canvas.width).toBe(300)
  })
})
