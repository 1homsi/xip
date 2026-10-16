import { useState, useRef, useCallback, useEffect, type RefObject } from 'react'

export type TransitionType = 'fade' | 'instant'

export interface TransitionOptions {
  duration?: number
  type?: TransitionType
}

export interface LevelTransitionControls {
  readonly currentLevel: string
  readonly isTransitioning: boolean
  transitionTo(level: string, opts?: TransitionOptions): void
  overlayRef: RefObject<HTMLDivElement | null>
}

export function useLevelTransition(initial: string): LevelTransitionControls {
  const [currentLevel, setCurrentLevel] = useState(initial)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
  }, [])

  useEffect(() => () => clearTimers(), [clearTimers])

  const transitionTo = useCallback(
    (level: string, opts: TransitionOptions = {}) => {
      const { duration = 0.4, type = 'fade' } = opts

      // Cancel any in-flight fade so a newer transition is never overwritten
      // by a stale timer.
      clearTimers()

      if (type === 'instant') {
        setCurrentLevel(level)
        setIsTransitioning(false)
        const el = overlayRef.current
        if (el) {
          el.style.transition = 'none'
          el.style.opacity = '0'
          el.style.pointerEvents = 'none'
        }
        return
      }

      setIsTransitioning(true)
      const el = overlayRef.current
      const durationMs = duration * 1000
      const halfDurationMs = durationMs / 2

      if (el) {
        el.style.position = 'absolute'
        el.style.inset = '0'
        el.style.backgroundColor = '#000'
        el.style.zIndex = '9998'
        el.style.pointerEvents = 'none'
        el.style.transition = 'none'
        el.style.opacity = '0'
        void el.offsetHeight
        el.style.transition = `opacity ${halfDurationMs}ms linear`
        el.style.opacity = '1'

        const t1 = setTimeout(() => {
          setCurrentLevel(level)
          if (!overlayRef.current) return
          overlayRef.current.style.transition = `opacity ${halfDurationMs}ms linear`
          overlayRef.current.style.opacity = '0'
          const t2 = setTimeout(() => setIsTransitioning(false), halfDurationMs)
          timersRef.current.push(t2)
        }, halfDurationMs)
        timersRef.current.push(t1)
      } else {
        setCurrentLevel(level)
        setIsTransitioning(false)
      }
    },
    [clearTimers],
  )

  return { currentLevel, isTransitioning, transitionTo, overlayRef }
}
