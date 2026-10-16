import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { WorldSnapshot } from '@xip/core'
import { isEditableTarget } from '@xip/input'
import { EngineContext } from '../context'

export interface HistoryOptions {
  /** Maximum number of snapshots to keep. Oldest entries are evicted. Default 50. */
  capacity?: number
  /**
   * When true, `Ctrl/Cmd+Z` triggers undo and `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y`) triggers
   * redo. Listens on `window`. Default false — users are expected to wire their own
   * UI and shortcuts.
   */
  bindKeyboardShortcuts?: boolean
}

export interface HistoryControls {
  /** Capture the current world state and push it onto the history stack. */
  push(): void
  /** Revert to the previous snapshot. No-op if there's nothing to undo. */
  undo(): void
  /** Re-apply a snapshot that was undone. No-op if there's nothing to redo. */
  redo(): void
  /** Clear the entire history stack. */
  clear(): void
  /** True if `undo()` would do anything. */
  canUndo: boolean
  /** True if `redo()` would do anything. */
  canRedo: boolean
  /** Number of snapshots currently stored. */
  length: number
}

/**
 * Undo/redo for the entire ECS world, backed by the snapshot system.
 *
 * The typical pattern is "commit then push" — after the user completes a logical
 * action (move a piece, paint a tile, rotate a shape), call `push()` to capture
 * the new state. `undo()` rewinds to the previous push, `redo()` replays forward.
 *
 * In onDemand loop mode, undo/redo automatically re-render by calling
 * `engine.loop.markDirty()`.
 *
 * @example
 * ```tsx
 * function PuzzleBoard() {
 *   const history = useHistory({ capacity: 100, bindKeyboardShortcuts: true })
 *
 *   const onMove = (from, to) => {
 *     applyMove(from, to)
 *     history.push() // commit the move so it can be undone
 *   }
 *
 *   return (
 *     <>
 *       <Board onMove={onMove} />
 *       <button disabled={!history.canUndo} onClick={history.undo}>Undo</button>
 *       <button disabled={!history.canRedo} onClick={history.redo}>Redo</button>
 *     </>
 *   )
 * }
 * ```
 */
export function useHistory(options?: HistoryOptions): HistoryControls {
  const engine = useContext(EngineContext)!
  const capacity = options?.capacity ?? 50
  const bindKeys = options?.bindKeyboardShortcuts ?? false

  const stackRef = useRef<WorldSnapshot[]>([])
  const indexRef = useRef<number>(-1)
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  const push = useCallback(() => {
    const snap = engine.ecs.getSnapshot()
    const stack = stackRef.current
    // Discard any redo future — new branches replace it.
    if (indexRef.current < stack.length - 1) {
      stack.length = indexRef.current + 1
    }
    stack.push(snap)
    // Evict oldest entries if we're over capacity.
    while (stack.length > capacity) stack.shift()
    indexRef.current = stack.length - 1
    bump()
  }, [engine, capacity, bump])

  const undo = useCallback(() => {
    if (indexRef.current <= 0) return
    indexRef.current -= 1
    engine.ecs.restoreSnapshot(stackRef.current[indexRef.current])
    engine.loop.markDirty()
    bump()
  }, [engine, bump])

  const redo = useCallback(() => {
    const stack = stackRef.current
    if (indexRef.current >= stack.length - 1) return
    indexRef.current += 1
    engine.ecs.restoreSnapshot(stack[indexRef.current])
    engine.loop.markDirty()
    bump()
  }, [engine, bump])

  const clear = useCallback(() => {
    stackRef.current = []
    indexRef.current = -1
    bump()
  }, [bump])

  useEffect(() => {
    if (!bindKeys) return
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Z inside a text field is the field's own undo
      if (isEditableTarget(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bindKeys, undo, redo])

  // Read from refs but re-compute on every bump so canUndo/canRedo stay reactive.
  void version
  const length = stackRef.current.length
  const canUndo = indexRef.current > 0
  const canRedo = indexRef.current < stackRef.current.length - 1

  return { push, undo, redo, clear, canUndo, canRedo, length }
}
