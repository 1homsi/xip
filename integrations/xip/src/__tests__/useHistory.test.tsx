// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { ECSWorld, EventBus, AssetManager, createEngineStats } from '@xip/core'
import { EngineContext } from '../context'
import type { EngineState } from '../context'
import { useHistory } from '../hooks/useHistory'

function makeEngine(): EngineState {
  const ecs = new ECSWorld()
  const events = new EventBus()
  const loop = {
    markDirty: vi.fn(),
    isRunning: false,
    isPaused: false,
    isOnDemand: false,
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    hitPause: vi.fn(),
  }
  const stats = createEngineStats()
  return {
    ecs,
    events,
    assets: new AssetManager(),
    input: {} as never,
    physics: { setGravity: vi.fn() } as never,
    loop: loop as never,
    canvas: document.createElement('canvas'),
    entityIds: new Map(),
    systemTimings: new Map(),
    postProcessStack: { add: vi.fn(), remove: vi.fn(), apply: vi.fn(), clear: vi.fn() },
    stats,
    getStats: () => stats,
  }
}

function wrapper(engine: EngineState) {
  return ({ children }: { children: React.ReactNode }) => (
    <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>
  )
}

describe('useHistory', () => {
  let engine: EngineState

  beforeEach(() => {
    engine = makeEngine()
  })

  it('starts with canUndo=false and canRedo=false', () => {
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(engine) })
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    expect(result.current.length).toBe(0)
  })

  it('push() adds a snapshot and length increases', () => {
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(engine) })
    act(() => result.current.push())
    expect(result.current.length).toBe(1)
    act(() => result.current.push())
    expect(result.current.length).toBe(2)
  })

  it('canUndo becomes true after two pushes', () => {
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(engine) })
    act(() => result.current.push())
    expect(result.current.canUndo).toBe(false) // only one snapshot — nothing to undo to
    act(() => result.current.push())
    expect(result.current.canUndo).toBe(true)
  })

  it('undo() restores a previous snapshot and marks dirty', () => {
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(engine) })
    const eid1 = engine.ecs.createEntity()
    act(() => result.current.push())
    const eid2 = engine.ecs.createEntity()
    act(() => result.current.push())

    expect(engine.ecs.entityCount).toBe(2)
    act(() => result.current.undo())
    // After undo, we should be back to the state with one entity
    expect(engine.ecs.entityCount).toBe(1)
    expect(engine.loop.markDirty).toHaveBeenCalled()
    void eid1
    void eid2
  })

  it('redo() re-applies an undone snapshot', () => {
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(engine) })
    engine.ecs.createEntity()
    act(() => result.current.push())
    engine.ecs.createEntity()
    act(() => result.current.push())

    act(() => result.current.undo())
    expect(engine.ecs.entityCount).toBe(1)
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.redo())
    expect(engine.ecs.entityCount).toBe(2)
    expect(result.current.canRedo).toBe(false)
  })

  it('push() after undo truncates the redo future', () => {
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(engine) })
    act(() => result.current.push())
    act(() => result.current.push())
    act(() => result.current.push())
    expect(result.current.length).toBe(3)

    act(() => result.current.undo())
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.push())
    // The redo future is now gone
    expect(result.current.canRedo).toBe(false)
  })

  it('evicts oldest entries when over capacity', () => {
    const { result } = renderHook(() => useHistory({ capacity: 3 }), { wrapper: wrapper(engine) })
    act(() => result.current.push())
    act(() => result.current.push())
    act(() => result.current.push())
    act(() => result.current.push())
    expect(result.current.length).toBe(3)
  })

  it('clear() empties the stack', () => {
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(engine) })
    act(() => result.current.push())
    act(() => result.current.push())
    act(() => result.current.clear())
    expect(result.current.length).toBe(0)
    expect(result.current.canUndo).toBe(false)
  })

  it('undo/redo are no-ops at the boundaries', () => {
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(engine) })
    expect(() => act(() => result.current.undo())).not.toThrow()
    expect(() => act(() => result.current.redo())).not.toThrow()
    act(() => result.current.push())
    expect(() => act(() => result.current.undo())).not.toThrow()
  })

  it.each(['input', 'textarea', 'contenteditable'] as const)(
    'leaves Ctrl+Z available to the browser when focus is in %s',
    (kind) => {
      const { result } = renderHook(() => useHistory({ bindKeyboardShortcuts: true }), { wrapper: wrapper(engine) })
      act(() => {
        result.current.push()
        result.current.push()
      })

      const target =
        kind === 'input'
          ? document.createElement('input')
          : document.createElement(kind === 'textarea' ? 'textarea' : 'div')
      if (kind === 'contenteditable') target.setAttribute('contenteditable', 'true')
      document.body.append(target)
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
      target.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(false)
      expect(result.current.canUndo).toBe(true)
      target.remove()
    },
  )

  it('still handles Ctrl+Z when focus is outside an editable element', () => {
    const { result } = renderHook(() => useHistory({ bindKeyboardShortcuts: true }), { wrapper: wrapper(engine) })
    act(() => {
      result.current.push()
      result.current.push()
    })
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true })

    act(() => window.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(true)
    expect(result.current.canUndo).toBe(false)
  })
})
