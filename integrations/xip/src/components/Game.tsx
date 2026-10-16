import React, { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ECSWorld,
  GameLoop,
  EventBus,
  AssetManager,
  ScriptSystem,
  createEngineStats,
  getPhysicsFactory,
  type GameLoopMode,
  type Plugin,
  type System,
} from '@xip/core'
import { InputManager, type TouchPreventDefault } from '@xip/input'
import {
  RenderSystem,
  createPostProcessStack,
  type DynamicCanvasOptions,
  type ManagedDynamicCanvas,
  type PostProcessStack,
  type Sampling,
} from '@xip/renderer'
import type { RenderStats } from '@xip/core'
import type { PhysicsSystem } from '@xip/physics'
import { EngineContext, type EngineState } from '../context'
import type { CaptureFrame } from '@xip/context'
import type { DevToolsHandle } from '@xip/devtools'

/** Wraps a System to record execution time into a shared timings map. */
function timedSystem(name: string, system: System, timings: Map<string, number>): System {
  return {
    update(world, dt) {
      const t0 = performance.now()
      system.update(world, dt)
      timings.set(name, performance.now() - t0)
    },
  }
}

/**
 * Optional subsystems injected by the full `xipjs` entry. `xipjs/render`
 * omits them so physics and devtools stay out of its import graph.
 */
export interface GameFeatures {
  createDebugSystem?: (overlay: HTMLCanvasElement) => System
  DevToolsOverlay?: React.ComponentType<{
    handle: DevToolsHandle
    loop: GameLoop
    ecs: ECSWorld
    engine: EngineState
  }>
  maxDevtoolsFrames?: number
}

/** What <Game> needs from a render system; the WebGL2 and Canvas2D ones both fit. */
type GameRenderSystem = System & {
  readonly stats: RenderStats
  setDefaultSampling(sampling: Sampling): void
  createDynamicCanvas(options: DynamicCanvasOptions): ManagedDynamicCanvas
  /** Turn the GPU timer on or off; resolves to whether it is running (Canvas2D never is). */
  setGpuTiming(enabled: boolean): Promise<boolean>
  readonly postProcessStack?: PostProcessStack
  dispose(): void
}
type Canvas2DFactory = (
  canvas: HTMLCanvasElement,
  entityIds: Map<string, number>,
  fellBack: boolean,
) => GameRenderSystem

/** Rendering backend: WebGL2, Canvas2D, or WebGL2 with an automatic Canvas2D fallback. */
export type RendererBackend = 'auto' | 'webgl' | 'canvas2d'

export interface GameControls {
  pause(): void
  resume(): void
  reset(): void
}

export interface GameProps {
  width?: number
  height?: number
  /** Pixels per second squared downward (default 980) */
  gravity?: number
  /**
   * Upper bound on the canvas backing store's pixels per CSS pixel (default: none, it follows
   * `devicePixelRatio`). A phone at DPR 3 draws 9 backing pixels per CSS pixel; `maxDpr={2}`
   * draws 4 and lets the browser scale the canvas up. Coordinates stay in CSS pixels.
   * `undefined`, `0`, negative and `NaN` all mean no cap; a value below 1 is a deliberate downscale.
   */
  maxDpr?: number
  /** Enable debug overlay: collider wireframes, FPS, entity count */
  debug?: boolean
  /**
   * Canvas scaling strategy (default 'none'):
   * - 'none'    — fixed pixel size, no scaling
   * - 'contain' — CSS scale to fit parent while preserving aspect ratio
   * - 'pixel'   — nearest-neighbor pixel-art scaling via CSS
   */
  scale?: 'none' | 'contain' | 'pixel'
  /** Called once the engine is ready — receives pause/resume/reset controls */
  onReady?: (controls: GameControls) => void
  /** Enable time-travel debugging overlay (frame scrubber + entity inspector). */
  devtools?: boolean
  /**
   * Rendering backend (default 'auto'):
   * - 'auto'     — WebGL2, falling back to Canvas2D (with one console warning) when WebGL2 is unavailable
   * - 'webgl'    — WebGL2 only; shows an error panel when it is unavailable
   * - 'canvas2d' — Canvas2D only, no WebGL2 context is created. No post-process effects.
   *
   * The Canvas2D renderer loads on demand, so it adds nothing to the initial bundle.
   * **Captured at mount.**
   */
  renderer?: RendererBackend
  /** Run the simulation in deterministic mode using a seeded RNG. */
  deterministic?: boolean
  /** Seed for the deterministic RNG (default 0). Only used when deterministic=true. */
  seed?: number
  /**
   * When true, the game loop starts immediately and sprites swap from color → image as
   * they load in the background. When false (default) the loop is held until every
   * sprite that is part of the initial scene has finished loading, so the first frame
   * shown is fully rendered with real assets.
   */
  asyncAssets?: boolean
  /**
   * Default texture sampling for all sprites (default 'nearest').
   * Individual sprites can override via their own `sampling` prop.
   * Use `TextureFilter.NEAREST` for pixel art or `TextureFilter.LINEAR` for smooth scaling.
   */
  sampling?: Sampling
  /**
   * Measure GPU frame time (`stats.gpuMs`) from mount, without a stats hook. Off by
   * default. Captured at mount. Needs EXT_disjoint_timer_query_webgl2; `gpuMs` stays
   * null where it is unavailable.
   */
  gpuTiming?: boolean
  /** Custom plugins to register after core systems. Each plugin's systems run after Render. */
  plugins?: Plugin[]
  /**
   * Loop mode (default 'realtime'):
   * - 'realtime' — continuous 60fps tick. Use for action games, anything with
   *   continuous motion or physics.
   * - 'onDemand' — sleeps until input arrives or a component calls markDirty().
   *   Use for puzzle games, turn-based games, visual novels, level editors, or any
   *   scene where nothing changes unless the user acts. Saves battery and CPU.
   *
   * **Captured at mount.** This prop is read once when the Game mounts and
   * baked into the loop. Changing it later has no effect — to switch modes,
   * unmount and remount the Game (e.g. via a `key` change).
   */
  mode?: GameLoopMode
  /**
   * Which touch events the engine cancels with `preventDefault()` (default `true`: start, move
   * and end). `true` also suppresses the mouse events and `click` a tap would produce, so use
   * `'move'` (blocks scrolling only) or `false` when the game listens for `click` or pointer
   * events on the canvas. Can change at any time.
   */
  touchPreventDefault?: TouchPreventDefault
  /**
   * CSS `touch-action` of the canvas (default: not set). Use `'none'` together with
   * `touchPreventDefault={false}` to stop page scrolling and pinch zoom without cancelling taps.
   * An explicit `style.touchAction` wins.
   */
  touchAction?: CSSProperties['touchAction']
  style?: CSSProperties
  className?: string
  children?: React.ReactNode
  /** @internal */
  features?: GameFeatures
}

export function Game({
  width = 800,
  height = 600,
  gravity = 980,
  maxDpr,
  debug = false,
  devtools = false,
  scale = 'none',
  deterministic = false,
  seed = 0,
  asyncAssets = false,
  sampling,
  gpuTiming = false,
  renderer = 'auto',
  onReady,
  plugins,
  mode = 'realtime',
  touchPreventDefault = true,
  touchAction,
  style,
  className,
  children,
  features = {},
}: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const touchPreventDefaultRef = useRef(touchPreventDefault)
  touchPreventDefaultRef.current = touchPreventDefault
  const debugCanvasRef = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<EngineState | null>(null)
  const [assetsReady, setAssetsReady] = useState(asyncAssets)
  const [webglError, setWebglError] = useState<string | null>(null)
  // Set once the lazy Canvas2D renderer has loaded; re-runs the engine effect with it.
  const [canvas2d, setCanvas2d] = useState<Canvas2DFactory | null>(null)
  // Bumped to remount the canvas when a failed WebGL attempt left it unusable for 2D.
  const [canvasGen, setCanvasGen] = useState(0)
  const devtoolsHandle = useRef<DevToolsHandle>({ buffer: [] })
  const [dpr, setDpr] = useState(() => (typeof window !== 'undefined' && window.devicePixelRatio) || 1)

  useEffect(() => {
    const canvas = canvasRef.current!
    const entityIds = new Map<string, number>()

    let renderSystem!: GameRenderSystem
    let wantCanvas2d = renderer === 'canvas2d' || canvas2d !== null
    if (!wantCanvas2d) {
      try {
        renderSystem = new RenderSystem(canvas, entityIds)
      } catch {
        if (renderer === 'webgl') {
          setWebglError(
            'WebGL2 is required to run this game. Please use a modern browser such as Chrome, Firefox, Edge, or Safari 15+.',
          )
          return
        }
        wantCanvas2d = true
      }
    }
    if (wantCanvas2d) {
      if (!canvas2d) {
        let cancelled = false
        import('./canvas2dBackend').then(
          (m) => cancelled || setCanvas2d(() => m.createCanvas2D),
          () => cancelled || setWebglError('Canvas2D renderer failed to load.'),
        )
        return () => {
          cancelled = true
        }
      }
      try {
        renderSystem = canvas2d(canvas, entityIds, renderer === 'auto')
      } catch {
        // A failed WebGL attempt can leave the canvas locked to its GL mode: retry on a fresh one.
        if (renderer === 'auto' && !canvasGen) setCanvasGen(1)
        else setWebglError('Neither WebGL2 nor Canvas 2D is available.')
        return
      }
    }
    const ecs = new ECSWorld()
    if (deterministic) ecs.setDeterministicSeed(seed)
    const input = new InputManager()
    const events = new EventBus()
    const assets = new AssetManager()
    // Apply Vite base URL so assets resolve correctly when deployed to a subdirectory
    const viteEnv = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
    assets.baseURL = (viteEnv?.BASE_URL ?? '/').replace(/\/$/, '')
    ecs.assets = assets

    if (sampling) renderSystem.setDefaultSampling(sampling)
    const activeRenderSystem: System = renderSystem

    // Debug system: always uses a separate overlay canvas (Canvas2D for wireframes)
    let debugSystem: System | null = null
    if (debug && debugCanvasRef.current) {
      debugSystem = features.createDebugSystem?.(debugCanvasRef.current) ?? null
    }
    if ((debug && !features.createDebugSystem) || (devtools && !features.DevToolsOverlay)) {
      console.warn('[Xip] debug/devtools need <Game> from "xipjs", not "xipjs/render".')
    }

    const systemTimings = new Map<string, number>()

    // System order: scripts → physics → render → (debug) → plugins
    ecs.addSystem(timedSystem('ScriptSystem', new ScriptSystem(input), systemTimings))
    const timedRender = timedSystem('RenderSystem', renderSystem, systemTimings)
    ecs.addSystem(timedRender)
    // Physics attaches on the first frame after any physics component exists.
    const attachPhysics = (): void => {
      const create = getPhysicsFactory()
      if (!create) return
      const physics = create(state.gravity ?? gravity, events) as PhysicsSystem
      state.physics = physics
      ecs.addSystem(timedSystem('PhysicsSystem', physics, systemTimings), timedRender)
    }
    if (debugSystem) ecs.addSystem(timedSystem('DebugSystem', debugSystem, systemTimings))

    input.touch.preventDefault = touchPreventDefaultRef.current
    input.attach(canvas)
    canvas.setAttribute('tabindex', '0')

    // Validate dimensions
    if (width <= 0 || height <= 0) {
      console.warn(`[Xip] Invalid Game dimensions: ${width}x${height}. Width and height must be positive.`)
    }

    const stats = createEngineStats(renderSystem.stats)
    let gpuUsers = 0
    let lastFrameStart = 0
    const loop = new GameLoop(
      (dt) => {
        const t0 = performance.now()
        if (lastFrameStart > 0) stats.frameIntervalMs = t0 - lastFrameStart
        lastFrameStart = t0
        if (state.physics === undefined) attachPhysics()
        ecs.update(dt)
        stats.updateMs = performance.now() - t0
        stats.renderMs = systemTimings.get('RenderSystem') ?? 0
        stats.scriptMs = systemTimings.get('ScriptSystem') ?? 0
        stats.physicsMs = systemTimings.get('PhysicsSystem') ?? 0
        stats.systemsMs = stats.updateMs - stats.renderMs
        stats.entityCount = ecs.entityCount
        stats.frame++
        stats.gpuMs = stats.render.gpuMs
        stats.gpuMsAvg = stats.render.gpuMsAvg
        input.flush()
        if (devtools) {
          const handle = devtoolsHandle.current
          handle.buffer.push(ecs.getSnapshot())
          if (handle.buffer.length > (features.maxDevtoolsFrames ?? 600)) handle.buffer.shift()
          handle.onFrame?.()
        }
      },
      {
        ...(deterministic ? { fixedDt: 1 / 60 } : {}),
        // In onDemand mode, default to a 1/60 step so animations advance predictably.
        ...(mode === 'onDemand' && !deterministic ? { fixedDt: 1 / 60 } : {}),
        mode,
        // During hit-pause, re-render the last frame so the screen isn't blank
        onRender: () => renderSystem.update(ecs, 0),
        // Forward tab visibility changes onto the game's event bus so
        // scripts/plugins can suspend audio, netcode, timers, etc.
        onVisibilityChange: (visible) => {
          events.emit(visible ? 'resume' : 'pause', { reason: 'visibility' })
        },
      },
    )

    // In onDemand mode, wake the loop on input events so the user sees their actions
    // take effect. Without this the scene would be frozen until a component manually
    // called engine.loop.markDirty().
    const dirtyHandler = (): void => loop.markDirty()
    if (mode === 'onDemand') {
      canvas.addEventListener('pointerdown', dirtyHandler)
      canvas.addEventListener('pointerup', dirtyHandler)
      canvas.addEventListener('pointermove', dirtyHandler)
      canvas.addEventListener('wheel', dirtyHandler, { passive: true })
      window.addEventListener('keydown', dirtyHandler)
      window.addEventListener('keyup', dirtyHandler)
      window.addEventListener('resize', dirtyHandler)
    }

    // The render system owns the stack so effects run on its (WebGL) frame.
    const postProcessStack = renderSystem.postProcessStack ?? createPostProcessStack()

    const state: EngineState = {
      ecs,
      input,
      activeRenderSystem,
      renderBackend: wantCanvas2d ? 'canvas2d' : 'webgl',
      physics: undefined,
      gravity,
      events,
      assets,
      loop,
      canvas,
      entityIds,
      systemTimings,
      postProcessStack,
      stats,
      getStats: () => stats,
      createDynamicCanvas: (opts) =>
        renderSystem.createDynamicCanvas({
          ...opts,
          onChange: () => {
            opts.onChange?.()
            loop.markDirty()
          },
        }),
      // Loaded on first use so the encoder glue stays out of the main bundle.
      captureFrame: (async (opts) => {
        const { captureFrame } = await import('../utils/capture')
        return captureFrame({ canvas, render: () => renderSystem.update(ecs, 0) }, opts)
      }) as CaptureFrame,
      requestGpuTiming: () => {
        if (gpuUsers++ === 0) void renderSystem.setGpuTiming(true)
        let released = false
        return () => {
          if (released) return
          released = true
          if (--gpuUsers === 0) void renderSystem.setGpuTiming(false)
        }
      },
    }
    if (gpuTiming) state.requestGpuTiming!()
    setEngine(state)

    // Register plugin systems and call their onInit hooks
    if (plugins) {
      // Sort by priority descending (higher priority registered first)
      const pluginNames = new Set(plugins.map((p) => p.name))
      const sorted = [...plugins].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      for (const plugin of sorted) {
        // Validate dependencies
        if (plugin.requires) {
          for (const dep of plugin.requires) {
            if (!pluginNames.has(dep)) {
              console.warn(`[Xip] Plugin "${plugin.name}" requires "${dep}" but it is not registered.`)
            }
          }
        }
        for (const system of plugin.systems) {
          ecs.addSystem(timedSystem(`${plugin.name}`, system, systemTimings))
        }
        plugin.onInit?.(state)
      }
    }

    // Loop is started by the assets-ready effect below once images are loaded.
    // When asyncAssets=true that effect starts it immediately.

    // Expose controls via onReady callback
    onReady?.({
      pause: () => loop.pause(),
      resume: () => loop.resume(),
      reset: () => {
        ecs.clear()
        loop.stop()
        loop.start()
      },
    })

    // Handle contain scaling
    let resizeObserver: ResizeObserver | null = null
    if (scale === 'contain' && wrapperRef.current) {
      const wrapper = wrapperRef.current
      const updateScale = () => {
        const parentW = wrapper.parentElement?.clientWidth ?? width
        const parentH = wrapper.parentElement?.clientHeight ?? height
        const scaleX = parentW / width
        const scaleY = parentH / height
        const s = Math.min(scaleX, scaleY)
        canvas.style.transform = `scale(${s})`
        canvas.style.transformOrigin = 'top left'
        // Apply the same scale to the debug overlay canvas
        const debugEl = debugCanvasRef.current
        if (debugEl) {
          debugEl.style.transform = `scale(${s})`
          debugEl.style.transformOrigin = 'top left'
        }
      }
      updateScale()
      resizeObserver = new ResizeObserver(updateScale)
      if (wrapper.parentElement) resizeObserver.observe(wrapper.parentElement)
    }

    return () => {
      loop.stop()
      input.detach()
      ecs.clear()
      renderSystem.dispose()
      // Release the AudioContext + asset caches (leaks a live AudioContext
      // per remount otherwise).
      assets.dispose()
      resizeObserver?.disconnect()
      if (mode === 'onDemand') {
        canvas.removeEventListener('pointerdown', dirtyHandler)
        canvas.removeEventListener('pointerup', dirtyHandler)
        canvas.removeEventListener('pointermove', dirtyHandler)
        canvas.removeEventListener('wheel', dirtyHandler)
        window.removeEventListener('keydown', dirtyHandler)
        window.removeEventListener('keyup', dirtyHandler)
        window.removeEventListener('resize', dirtyHandler)
      }
      // Call onDestroy on all plugins
      if (plugins) {
        for (const plugin of plugins) {
          plugin.onDestroy?.(state)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas2d, canvasGen])

  // Start loop once initial scene sprites are loaded.
  // Because React runs child effects before parent effects, all Sprite useEffects
  // (which call engine.assets.loadImage) have already fired before this runs —
  // so waitForImages() covers every sprite in the initial scene.
  useEffect(() => {
    if (!engine) return
    let cancelled = false

    if (asyncAssets) {
      engine.loop.start()
      setAssetsReady(true)
      return
    }

    engine.assets.waitForImages().then(() => {
      if (!cancelled) {
        engine.loop.start()
        setAssetsReady(true)
      }
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  // Sync canvas dimensions when width/height props change (HiDPI-aware)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`)
    const onChange = () => setDpr(window.devicePixelRatio || 1)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [dpr])

  const backingRatio = maxDpr && maxDpr > 0 ? Math.min(dpr, maxDpr) : dpr
  useEffect(() => {
    if (!engine) return
    const physW = Math.max(1, Math.round(width * backingRatio))
    const physH = Math.max(1, Math.round(height * backingRatio))
    const canvas = engine.canvas
    if (canvas.width !== physW) canvas.width = physW
    if (canvas.height !== physH) canvas.height = physH
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    // Resizing the backing store clears the drawing buffer; an onDemand loop must repaint it.
    engine.loop.markDirty()
  }, [width, height, engine, backingRatio])

  // Sync gravity changes
  useEffect(() => {
    if (!engine) return
    engine.gravity = gravity
    engine.physics?.setGravity(gravity)
  }, [gravity, engine])

  // Sync touch default-action handling
  useEffect(() => {
    if (engine) engine.input.touch.preventDefault = touchPreventDefault
  }, [touchPreventDefault, engine])

  const canvasStyle: CSSProperties = {
    display: 'block',
    outline: 'none',
    imageRendering: scale === 'pixel' ? 'pixelated' : undefined,
    ...(touchAction !== undefined ? { touchAction } : {}),
    ...style,
  }

  const wrapperStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    ...(scale === 'contain' ? { width, height, overflow: 'visible' } : {}),
  }

  if (webglError) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0f',
          color: '#ef5350',
          fontFamily: 'monospace',
          fontSize: 13,
          padding: 24,
          boxSizing: 'border-box',
          textAlign: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 24 }}>⚠</span>
        <strong>Rendering Not Available</strong>
        <span style={{ color: '#78909c', fontSize: 11, maxWidth: 380 }}>{webglError}</span>
      </div>
    )
  }

  return (
    <EngineContext.Provider value={engine}>
      <div ref={wrapperRef} style={wrapperStyle}>
        <canvas
          key={canvasGen}
          ref={canvasRef}
          width={width}
          height={height}
          style={canvasStyle}
          className={className}
        />
        {debug && (
          <canvas
            ref={debugCanvasRef}
            width={width}
            height={height}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
          />
        )}
        {!assetsReady && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#0a0a0f',
              pointerEvents: 'none',
            }}
          >
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#4fc3f7',
                    animation: 'xip-loading-dot 1.2s ease-in-out infinite',
                    animationDelay: `${i * 0.2}s`,
                  }}
                />
              ))}
            </div>
            <span
              style={{
                fontFamily: 'monospace',
                fontSize: 11,
                letterSpacing: 3,
                color: '#37474f',
              }}
            >
              LOADING
            </span>
            <style>{`
              @keyframes xip-loading-dot {
                0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
                40%           { transform: scale(1);   opacity: 1;   }
              }
            `}</style>
          </div>
        )}
      </div>
      {engine && children}
      {engine && devtools && features.DevToolsOverlay && (
        <features.DevToolsOverlay handle={devtoolsHandle.current} loop={engine.loop} ecs={engine.ecs} engine={engine} />
      )}
    </EngineContext.Provider>
  )
}
