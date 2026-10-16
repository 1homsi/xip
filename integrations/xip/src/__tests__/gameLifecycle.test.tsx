// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode, useContext } from 'react'
import { render, act } from '@testing-library/react'

vi.mock('@xip/renderer', async (orig) => {
  const actual = await orig<typeof import('@xip/renderer')>()
  class RenderSystem {
    static created = 0
    static disposed = 0
    constructor() {
      RenderSystem.created++
    }
    update() {}
    setDefaultSampling() {}
    dispose() {
      RenderSystem.disposed++
    }
  }
  return { ...actual, RenderSystem }
})

import { Game } from '../components/Game'
import { EngineContext, type EngineState } from '../context'
import { useCoordinates } from '../hooks/useCoordinates'

function countListeners(target: EventTarget) {
  const live = new Map<string, number>()
  const add = target.addEventListener.bind(target)
  const remove = target.removeEventListener.bind(target)
  const key = (t: string, _l: unknown) => t
  const seen = new Set<unknown>()
  vi.spyOn(target, 'addEventListener').mockImplementation((t: string, l: unknown, o?: unknown) => {
    if (!seen.has(l)) {
      seen.add(l)
      live.set(key(t, l), (live.get(key(t, l)) ?? 0) + 1)
    }
    add(t, l as EventListener, o as AddEventListenerOptions)
  })
  vi.spyOn(target, 'removeEventListener').mockImplementation((t: string, l: unknown, o?: unknown) => {
    if (seen.delete(l)) live.set(key(t, l), (live.get(key(t, l)) ?? 0) - 1)
    remove(t, l as EventListener, o as EventListenerOptions)
  })
  // React DOM's one-time global selectionchange listener is not ours
  return () => [...live].filter(([t]) => t !== 'selectionchange').reduce((a, [, v]) => a + v, 0)
}

describe('<Game> lifecycle', () => {
  let rafLive: Set<number>
  beforeEach(() => {
    rafLive = new Set()
    let next = 1
    vi.stubGlobal('requestAnimationFrame', () => {
      const id = next++
      rafLive.add(id)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => rafLive.delete(id))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('StrictMode double mount leaves one engine, and unmount releases rAF and listeners', async () => {
    const windowListeners = countListeners(window)
    const documentListeners = countListeners(document)
    const engines: EngineState[] = []
    function Probe() {
      const e = useContext(EngineContext)
      if (e && !engines.includes(e)) engines.push(e)
      return null
    }
    const disposeSpy = vi.fn()
    const plugin = { name: 'p', systems: [], onInit: vi.fn(), onDestroy: disposeSpy }
    let r!: ReturnType<typeof render>
    await act(async () => {
      r = render(
        <StrictMode>
          <Game asyncAssets plugins={[plugin]}>
            <Probe />
          </Game>
        </StrictMode>,
      )
    })
    expect(engines.length).toBe(1)
    expect(engines[0].loop.isRunning).toBe(true)
    expect(rafLive.size).toBe(1)
    expect(plugin.onInit).toHaveBeenCalledTimes(2)
    expect(disposeSpy).toHaveBeenCalledTimes(1)

    act(() => r.unmount())
    expect(engines[0].loop.isRunning).toBe(false)
    expect(rafLive.size).toBe(0)
    expect(engines[0].ecs.entityCount).toBe(0)
    expect(disposeSpy).toHaveBeenCalledTimes(2)
    const RS = (await import('@xip/renderer')).RenderSystem as unknown as { created: number; disposed: number }
    expect(RS.disposed).toBe(RS.created)
    expect(windowListeners()).toBe(0)
    expect(documentListeners()).toBe(0)
  })

  it('re-applies the backing store size when devicePixelRatio changes', async () => {
    let dpr = 1
    vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => dpr)
    const queries: { media: string; fire: () => void; live: boolean }[] = []
    vi.stubGlobal('matchMedia', (media: string) => {
      const q = { media, live: false, fire: () => {} }
      queries.push(q)
      return {
        media,
        addEventListener: (_: string, cb: () => void) => {
          q.live = true
          q.fire = cb
        },
        removeEventListener: () => {
          q.live = false
        },
      }
    })
    let engine: EngineState | null = null
    function Probe() {
      engine = useContext(EngineContext)
      return null
    }
    await act(async () => {
      render(
        <Game width={200} height={100} asyncAssets>
          <Probe />
        </Game>,
      )
    })
    expect(engine!.canvas.width).toBe(200)
    dpr = 2
    act(() => queries.find((q) => q.live)!.fire())
    expect(engine!.canvas.width).toBe(400)
    expect(engine!.canvas.height).toBe(200)
    expect(engine!.canvas.style.width).toBe('200px')
    expect(queries.filter((q) => q.live).map((q) => q.media)).toEqual(['(resolution: 2dppx)'])
  })

  it('caps the backing store at maxDpr and follows it when the prop changes', async () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3)
    let engine: EngineState | null = null
    function Probe() {
      engine = useContext(EngineContext)
      return null
    }
    let rerender!: (ui: React.ReactElement) => void
    await act(async () => {
      ;({ rerender } = render(
        <Game width={200} height={100} maxDpr={2} asyncAssets>
          <Probe />
        </Game>,
      ))
    })
    expect(engine!.canvas.width).toBe(400)
    expect(engine!.canvas.height).toBe(200)
    expect(engine!.canvas.style.width).toBe('200px')
    await act(async () => {
      rerender(
        <Game width={200} height={100} maxDpr={5} asyncAssets>
          <Probe />
        </Game>,
      )
    })
    expect(engine!.canvas.width).toBe(600)
    // The CSS size stays fixed while the backing store changes.
    expect(engine!.canvas.style.width).toBe('200px')
    expect(engine!.canvas.style.height).toBe('100px')
  })

  it('keeps a non-zero backing store for a very small maxDpr', async () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3)
    let engine: EngineState | null = null
    function Probe() {
      engine = useContext(EngineContext)
      return null
    }
    await act(async () => {
      render(
        <Game width={200} height={100} maxDpr={0.001} asyncAssets>
          <Probe />
        </Game>,
      )
    })
    expect(engine!.canvas.width).toBe(1)
    expect(engine!.canvas.height).toBe(1)
  })

  it('useCoordinates works in CSS pixels at DPR 2', async () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
    let coords!: ReturnType<typeof useCoordinates>
    let engine: EngineState | null = null
    function Probe() {
      engine = useContext(EngineContext)
      coords = useCoordinates()
      return null
    }
    function Gate() {
      return useContext(EngineContext) ? <Probe /> : null
    }
    await act(async () => {
      render(
        <Game width={200} height={100} asyncAssets>
          <Gate />
        </Game>,
      )
    })
    const canvas = engine!.canvas
    expect(canvas.width).toBe(400)
    Object.defineProperty(canvas, 'clientWidth', { value: 200 })
    Object.defineProperty(canvas, 'clientHeight', { value: 100 })
    const cam = engine!.ecs.createEntity()
    engine!.ecs.addComponent(cam, { type: 'Camera2D', x: 50, y: 20, zoom: 2 } as never)
    expect(coords.worldToScreen(50, 20)).toEqual({ x: 100, y: 50 })
    expect(coords.screenToWorld(0, 0)).toEqual({ x: 0, y: -5 })
    expect(coords.screenToWorld(coords.worldToScreen(13, 7).x, coords.worldToScreen(13, 7).y)).toEqual({ x: 13, y: 7 })
  })
})
