import { tween, Ease } from './tween'
import { isReducedMotionPreferred } from './reducedMotion'

export interface TimelineEntry {
  from: number
  to: number
  duration: number
  ease?: (t: number) => number
  onUpdate: (value: number) => void
  onComplete?: () => void
}

export interface TimelineAddOptions {
  /** Delay in seconds before this entry starts (relative to its start time). */
  delay?: number
  /** Start at a named label position instead of sequentially. */
  at?: string
}

export interface TimelineOptions {
  /** Loop the entire timeline when it completes. Default false. */
  loop?: boolean
  /** Number of additional repeats after the first play. Use Infinity for infinite. Default 0. */
  repeat?: number
  /** Called when the timeline finishes all repeats. */
  onComplete?: () => void
  /**
   * When true, this timeline plays at full length even if the user has the
   * `prefers-reduced-motion: reduce` system setting on. Default: false, meaning
   * reduced-motion users see all segments snap to their end values.
   */
  ignoreReducedMotion?: boolean
}

interface Segment {
  startTime: number
  delay: number
  entry: TimelineEntry
  handle?: ReturnType<typeof tween>
  started: boolean
  complete: boolean
}

export interface TweenTimeline {
  /** Append a tween to play after the previous one ends. */
  add(entry: TimelineEntry, opts?: TimelineAddOptions): TweenTimeline
  /** Add a named time marker at the current cursor position. */
  addLabel(name: string): TweenTimeline
  /** Add multiple tweens that all start at the same time (the current cursor). */
  addParallel(entries: TimelineEntry[], opts?: TimelineAddOptions): TweenTimeline
  /** Advance the timeline by dt seconds. Call this from a Script or game loop. */
  update(dt: number): void
  /** Start or restart the timeline from the beginning. */
  start(): void
  /** Stop the timeline and reset to the beginning. */
  stop(): void
  /** Seek to a specific time in seconds. */
  seek(time: number): void
  readonly isRunning: boolean
  readonly isComplete: boolean
  /** Total duration in seconds (computed from all segments). */
  readonly totalDuration: number
}

export function createTimeline(opts?: TimelineOptions): TweenTimeline {
  const segments: Segment[] = []
  const labels = new Map<string, number>()
  let cursor = 0
  let elapsed = 0
  let running = false
  let complete = false
  const maxRepeats = opts?.repeat ?? (opts?.loop ? Infinity : 0)
  let repeatsDone = 0

  function resolveStartTime(addOpts?: TimelineAddOptions): number {
    if (addOpts?.at) {
      const labelTime = labels.get(addOpts.at)
      return labelTime ?? cursor
    }
    return cursor
  }

  function resetSegments() {
    for (const seg of segments) {
      seg.handle?.stop()
      seg.handle = undefined
      seg.started = false
      seg.complete = false
    }
  }

  function computeTotalDuration(): number {
    let max = 0
    for (const seg of segments) {
      const end = seg.startTime + seg.delay + seg.entry.duration
      if (end > max) max = end
    }
    return max
  }

  const timeline: TweenTimeline = {
    add(entry: TimelineEntry, addOpts?: TimelineAddOptions): TweenTimeline {
      const start = resolveStartTime(addOpts)
      const delay = addOpts?.delay ?? 0
      segments.push({ startTime: start, delay, entry, started: false, complete: false })
      cursor = start + delay + entry.duration
      return timeline
    },

    addLabel(name: string): TweenTimeline {
      labels.set(name, cursor)
      return timeline
    },

    addParallel(entries: TimelineEntry[], addOpts?: TimelineAddOptions): TweenTimeline {
      const start = resolveStartTime(addOpts)
      const delay = addOpts?.delay ?? 0
      let maxEnd = cursor
      for (const entry of entries) {
        segments.push({ startTime: start, delay, entry, started: false, complete: false })
        const end = start + delay + entry.duration
        if (end > maxEnd) maxEnd = end
      }
      cursor = maxEnd
      return timeline
    },

    update(dt: number): void {
      if (!running || complete) return
      elapsed += dt

      let allDone = true
      for (const seg of segments) {
        if (seg.complete) continue
        const effectiveStart = seg.startTime + seg.delay
        if (elapsed < effectiveStart) {
          allDone = false
          continue
        }
        if (!seg.started) {
          seg.started = true
          const reducedMotion = !opts?.ignoreReducedMotion && isReducedMotionPreferred()
          seg.handle = tween(
            seg.entry.from,
            seg.entry.to,
            reducedMotion ? 0 : seg.entry.duration,
            seg.entry.ease ?? Ease.linear,
            seg.entry.onUpdate,
            () => {
              seg.complete = true
              seg.entry.onComplete?.()
            },
            { ignoreReducedMotion: true }, // timeline already collapsed duration
          )
          // Apply time already elapsed past the start
          const overflow = elapsed - effectiveStart
          if (overflow > 0) seg.handle.update(overflow)
        } else if (seg.handle) {
          seg.handle.update(dt)
        }
        if (!seg.complete) allDone = false
      }

      if (allDone && segments.length > 0) {
        if (repeatsDone < maxRepeats) {
          repeatsDone++
          // Carry the overshoot past the end into the next cycle, so a loop keeps its real period
          elapsed -= computeTotalDuration()
          resetSegments()
        } else {
          complete = true
          running = false
          opts?.onComplete?.()
        }
      }
    },

    start(): void {
      elapsed = 0
      repeatsDone = 0
      resetSegments()
      if (segments.length === 0) {
        // Nothing to play
        running = false
        complete = true
        opts?.onComplete?.()
        return
      }
      running = true
      complete = false
    },

    stop(): void {
      running = false
      complete = false
      elapsed = 0
      repeatsDone = 0
      resetSegments()
    },

    seek(time: number): void {
      elapsed = 0
      resetSegments()
      // Fast-forward to the target time
      const step = 1 / 60
      while (elapsed < time) {
        const d = Math.min(step, time - elapsed)
        elapsed += d
        for (const seg of segments) {
          if (seg.complete) continue
          const effectiveStart = seg.startTime + seg.delay
          if (elapsed < effectiveStart) continue
          if (!seg.started) {
            seg.started = true
            const reducedMotion = !opts?.ignoreReducedMotion && isReducedMotionPreferred()
            seg.handle = tween(
              seg.entry.from,
              seg.entry.to,
              reducedMotion ? 0 : seg.entry.duration,
              seg.entry.ease ?? Ease.linear,
              seg.entry.onUpdate,
              () => {
                seg.complete = true
              },
              { ignoreReducedMotion: true },
            )
            const overflow = elapsed - effectiveStart
            if (overflow > 0) seg.handle.update(overflow)
          } else if (seg.handle) {
            seg.handle.update(d)
          }
        }
      }
    },

    get isRunning() {
      return running
    },
    get isComplete() {
      return complete
    },
    get totalDuration() {
      return computeTotalDuration()
    },
  }

  return timeline
}
