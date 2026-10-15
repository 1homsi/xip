// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode, useContext } from 'react'
import { render, act, cleanup, waitFor } from '@testing-library/react'

// The WebGL system is controllable: `mode` decides whether its constructor works.
vi.mock('@xip/renderer', async (orig) => {
  const actual = await orig<typeof import('@xip/renderer')>()
  class RenderSystem {
    static mode: 'ok' | 'fail' = 'ok'
    static created = 0
    static disposed = 0
    readonly stats = {}
    constructor() {
      if (RenderSystem.mode === 'fail') throw new Error('[WebGLRenderer] WebGL2 is not supported in this browser')
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

import { Canvas2DRenderSystem } from '@xip/renderer/canvas2d'
import { RenderSystem } from '@xip/renderer'
import { Game } from '../components/Game'
import { World } from '../components/World'
import { Entity } from '../components/Entity'
import { Transform } from '../components/Transform'
import { Sprite } from '../components/Sprite'
import { Camera2D } from '../components/Camera2D'
import { useScreenTint } from '../hooks/useScreenTint'
import { EngineContext, type EngineState } from '../context'

const GL = RenderSystem as unknown as { mode: 'ok' | 'fail'; created: number; disposed: number }

interface FakeCtx {
  fills: { style: unknown; args: number[]; comp: string }[]
}

// happy-dom ships no canvas getContext, so install one on the prototype (and remove it afterwards).
const proto = HTMLCanvasElement.prototype as unknown as { getContext?: unknown }
const originalGetContext = proto.getContext
function setGetContext(fn: (this: HTMLCanvasElement, type: string) => unknown) {
  Object.defineProperty(proto, 'getContext', { value: fn, configurable: true, writable: true })
}

function installCanvas(opts: { lock2d?: (el: HTMLCanvasElement) => boolean } = {}) {
  const requests: string[] = []
  const rec: FakeCtx = { fills: [] }
  const ctx = new Proxy({ fillStyle: '', globalCompositeOperation: 'source-over' } as Record<string, unknown>, {
    get(t, p: string) {
      if (p === 'fillRect') {
        return (...args: number[]) =>
          rec.fills.push({ style: t.fillStyle, args, comp: t.globalCompositeOperation as string })
      }
      if (p in t) return t[p]
      return () => ({ addColorStop: () => {}, setTransform: () => {} })
    },
    set: (t, p: string, v) => ((t[p] = v), true),
  })
  setGetContext(function (this: HTMLCanvasElement, type: string) {
    requests.push(type)
    if (type === '2d') return opts.lock2d?.(this) ? null : ctx
    return null
  })
  return { requests, rec }
}

let engineRef: EngineState | null
function Probe() {
  engineRef = useContext(EngineContext)
  return null
}

async function mount(ui: React.ReactElement) {
  let r!: ReturnType<typeof render>
  engineRef = null
  await act(async () => {
    r = render(ui)
  })
  // The lazy Canvas2D renderer arrives on a later tick, and a loaded machine makes that arbitrarily late:
  // wait until an engine is running (or the error panel is up) instead of sleeping a fixed time.
  await waitFor(
    () => {
      const ready = engineRef?.activeRenderSystem || r.container.textContent?.includes('Rendering Not Available')
      expect(ready).toBeTruthy()
    },
    { timeout: 5000 },
  )
  return r
}

describe('<Game renderer>', () => {
  beforeEach(() => {
    engineRef = null
    GL.mode = 'ok'
    GL.created = 0
    GL.disposed = 0
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Object.defineProperty(proto, 'getContext', { value: originalGetContext, configurable: true, writable: true })
  })

  it("'auto' keeps WebGL2 when it works: no fallback, no warning, no 2D context", async () => {
    const { requests } = installCanvas()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mount(
      <Game asyncAssets>
        <Probe />
      </Game>,
    )
    expect(GL.created).toBe(1)
    expect(engineRef!.renderBackend).toBe('webgl')
    expect(engineRef!.activeRenderSystem).toBeInstanceOf(RenderSystem)
    expect(requests).not.toContain('2d')
    expect(warn).not.toHaveBeenCalled()
  })

  it("'auto' falls back to Canvas2D when WebGL2 fails, warning once across mounts", async () => {
    GL.mode = 'fail'
    installCanvas()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await mount(
      <StrictMode>
        <Game asyncAssets>
          <Probe />
        </Game>
      </StrictMode>,
    )
    expect(engineRef!.renderBackend).toBe('canvas2d')
    expect(engineRef!.activeRenderSystem).toBeInstanceOf(Canvas2DRenderSystem)
    r.unmount()
    await mount(
      <Game asyncAssets>
        <Probe />
      </Game>,
    )
    expect(engineRef!.renderBackend).toBe('canvas2d')
    const fallbackWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('Canvas2D renderer'))
    expect(fallbackWarnings).toHaveLength(1)
    expect(String(fallbackWarnings[0][0])).toMatch(/WebGL2 is unavailable/)
  })

  it("'canvas2d' never creates a WebGL context and does not warn", async () => {
    const { requests } = installCanvas()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mount(
      <Game asyncAssets renderer="canvas2d">
        <Probe />
      </Game>,
    )
    expect(GL.created).toBe(0)
    expect(requests.every((t) => t === '2d')).toBe(true)
    expect(engineRef!.renderBackend).toBe('canvas2d')
    expect(warn).not.toHaveBeenCalled()
  })

  it("'webgl' keeps the error panel when WebGL2 fails, and never loads Canvas2D", async () => {
    GL.mode = 'fail'
    const { requests } = installCanvas()
    const r = await mount(
      <Game asyncAssets renderer="webgl">
        <Probe />
      </Game>,
    )
    expect(r.container.textContent).toContain('Rendering Not Available')
    expect(r.container.textContent).toContain('WebGL2 is required')
    expect(engineRef).toBeNull()
    expect(requests).not.toContain('2d')
  })

  it('shows an error panel when neither backend is available', async () => {
    GL.mode = 'fail'
    setGetContext(() => null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await mount(<Game asyncAssets renderer="canvas2d" />)
    expect(r.container.textContent).toContain('Neither WebGL2 nor Canvas 2D')
  })

  it("'auto' remounts the canvas when a failed WebGL attempt left it locked", async () => {
    GL.mode = 'fail'
    const locked = new WeakSet<HTMLCanvasElement>()
    installCanvas({
      lock2d: (el) => {
        // the first canvas element refuses a 2D context, as if a GL context had claimed it
        if (locked.has(el)) return true
        if (!seen) {
          seen = el
          locked.add(el)
          return true
        }
        return false
      },
    })
    let seen: HTMLCanvasElement | null = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mount(
      <Game asyncAssets>
        <Probe />
      </Game>,
    )
    expect(engineRef!.renderBackend).toBe('canvas2d')
    expect(engineRef!.canvas).not.toBe(seen)
  })

  it('does not start an engine when unmounted before the lazy renderer loads', async () => {
    installCanvas()
    const plugin = { name: 'p', systems: [], onInit: vi.fn(), onDestroy: vi.fn() }
    let r!: ReturnType<typeof render>
    await act(async () => {
      r = render(<Game asyncAssets renderer="canvas2d" plugins={[plugin]} />)
      r.unmount()
    })
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20))
    })
    expect(plugin.onInit).not.toHaveBeenCalled()
  })

  it('draws a sprite, a tint and a sprite layer through the Canvas2D renderer', async () => {
    const { rec } = installCanvas()
    let tint!: ReturnType<typeof useScreenTint>
    function Tinter() {
      tint = useScreenTint()
      return null
    }
    await mount(
      <Game asyncAssets renderer="canvas2d" width={100} height={50}>
        <World>
          <Camera2D x={50} y={25} background="#000000" />
          <Entity>
            <Transform x={50} y={25} />
            <Sprite width={10} height={10} color="#00ff00" />
          </Entity>
          <Tinter />
        </World>
        <Probe />
      </Game>,
    )
    tint.set(0.5, 0.5, 0.5, 1, 'multiply')
    rec.fills.length = 0
    engineRef!.activeRenderSystem!.update(engineRef!.ecs, 1 / 60)
    const styles = rec.fills.map((f) => `${f.comp}:${f.style}`)
    expect(styles).toContain('source-over:rgb(0,255,0)')
    expect(styles.at(-1)).toBe('multiply:rgb(128,128,128)')
  })

  it('disposes the Canvas2D system on unmount', async () => {
    installCanvas()
    const r = await mount(
      <Game asyncAssets renderer="canvas2d">
        <Probe />
      </Game>,
    )
    const rs = engineRef!.activeRenderSystem as Canvas2DRenderSystem
    const dispose = vi.spyOn(rs, 'dispose')
    r.unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
