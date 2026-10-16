import { useEffect, useRef } from 'react'
import { getAudioCtx, getGroupGainNode, registerGroupSource } from './audioContext'
import type { AudioGroup } from './audioContext'

// Re-export everything from audioContext for backwards compatibility
export {
  getAudioCtx,
  getGroupGainNode,
  setGroupVolume,
  setMasterVolume,
  getGroupVolume,
  getMasterVolume,
  setGroupMute,
  isGroupMuted,
  stopGroup,
  duck,
  setGroupVolumeFaded,
} from './audioContext'
export type { AudioGroup } from './audioContext'

// ─── Buffer cache with reference counting ────────────────────────────────────

const bufferCache = new Map<string, AudioBuffer>()
const bufferRefCount = new Map<string, number>()

/** @internal Exposed for testing. */
export function _getBufferCache(): Map<string, AudioBuffer> {
  return bufferCache
}
/** @internal Exposed for testing. */
export function _getBufferRefCount(): Map<string, number> {
  return bufferRefCount
}

const bufferLoads = new Map<string, Promise<AudioBuffer>>()

async function loadBuffer(src: string): Promise<AudioBuffer> {
  // Increment ref count
  bufferRefCount.set(src, (bufferRefCount.get(src) ?? 0) + 1)

  const cached = bufferCache.get(src)
  if (cached) return cached

  // Share one request between concurrent callers (StrictMode double effects).
  let load = bufferLoads.get(src)
  if (!load) {
    load = (async () => {
      const res = await fetch(src)
      const data = await res.arrayBuffer()
      const buf = await getAudioCtx().decodeAudioData(data)
      // Only cache while someone still holds a reference; otherwise a hook
      // that unmounted mid-load would leave an entry nothing can release.
      if (bufferRefCount.has(src)) bufferCache.set(src, buf)
      return buf
    })()
    bufferLoads.set(src, load)
    const done = () => bufferLoads.delete(src)
    load.then(done, done)
  }
  return load
}

function releaseBuffer(src: string): void {
  const count = bufferRefCount.get(src) ?? 0
  if (count <= 1) {
    bufferRefCount.delete(src)
    bufferCache.delete(src)
  } else {
    bufferRefCount.set(src, count - 1)
  }
}

// ─── Source pool ─────────────────────────────────────────────────────────────

interface PoolEntry {
  source: AudioBufferSourceNode
  gain: GainNode
  unregister?: () => void
}

function createPoolEntry(
  ctx: AudioContext,
  buffer: AudioBuffer,
  loop: boolean,
  volume: number,
  destination: GainNode,
): PoolEntry {
  const gain = ctx.createGain()
  gain.gain.value = volume
  gain.connect(destination)

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = loop
  source.connect(gain)

  return { source, gain }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface SoundControls {
  /**
   * Start playing. If already playing and loop=false, restarts from the beginning.
   * @param opts.delay — optional delay in seconds before playback begins
   *   (uses AudioContext.currentTime scheduling for sample-accurate timing)
   */
  play(opts?: { delay?: number }): void
  /** Stop the current playback. */
  stop(): void
  /** Change this sound's volume (0–1). Does not affect the group or master volume. */
  setVolume(v: number): void
  /**
   * Change the playback rate (and pitch). 1.0 = normal, 2.0 = double speed / octave up,
   * 0.5 = half speed / octave down. Applies to all active instances.
   */
  setPlaybackRate(rate: number): void
  /**
   * Fade in: ramp gain from 0 to the current volume over `duration` seconds.
   * Starts playback if not already playing.
   */
  fadeIn(duration: number): void
  /**
   * Fade out: ramp gain to 0 over `duration` seconds, then stop.
   */
  fadeOut(duration: number): void
  /**
   * Cross-fade to a different sound source over `duration` seconds.
   * Fades out the current sound while fading in the new one.
   */
  crossfadeTo(src: string, duration: number): void
  /** Whether at least one instance of this sound is currently playing. */
  readonly isPlaying: boolean
}

export interface SoundOptions {
  volume?: number
  loop?: boolean
  group?: AudioGroup
  /**
   * Maximum number of concurrent instances of this sound.
   * When exceeded, the oldest instance is stopped to make room.
   * @default 4
   */
  maxInstances?: number
  /**
   * Initial playback rate. 1.0 = normal speed, 2.0 = double speed.
   * @default 1
   */
  playbackRate?: number
  /**
   * Called when a sound instance ends naturally (not when stopped manually).
   */
  onEnded?: () => void
  /**
   * Keep playing when the component using this hook unmounts (the sound is
   * stopped only by `stop()`, `stopGroup()` or by ending). Use it for an
   * app-level soundtrack started from a component that may remount. The
   * `onEnded` callback is not invoked after unmount.
   * @default false
   */
  persistent?: boolean
}

/**
 * Loads and plays an audio file via the Web Audio API.
 *
 * The AudioContext is created lazily — the first call to `play()` resumes it
 * if the browser suspended it before a user gesture.
 *
 * Assign a `group` to route through the shared volume mixer:
 * - `'sfx'`   — sound effects (use `setGroupVolume('sfx', v)`)
 * - `'music'` — background music (use `setGroupVolume('music', v)`)
 * - `undefined` — connects directly to the master gain node
 *
 * @example
 * const { play, fadeIn, fadeOut } = useSound('/music.ogg', { group: 'music', loop: true })
 */
export function useSound(src: string, opts: SoundOptions = {}): SoundControls {
  const bufferRef = useRef<AudioBuffer | null>(null)
  const activeInstances = useRef<PoolEntry[]>([])
  const volRef = useRef(opts.volume ?? 1)
  const loopRef = useRef(opts.loop ?? false)
  const groupRef = useRef(opts.group)
  const rateRef = useRef(opts.playbackRate ?? 1)
  const onEndedRef = useRef(opts.onEnded)
  const persistentRef = useRef(opts.persistent ?? false)
  const unmountedRef = useRef(false)
  const acquiredSrcRef = useRef<string | null>(null)
  const maxInstances = Math.max(1, opts.maxInstances ?? 4)

  // Keep onEnded ref current without re-running the effect
  onEndedRef.current = opts.onEnded
  persistentRef.current = opts.persistent ?? false

  useEffect(() => {
    let cancelled = false
    unmountedRef.current = false
    loadBuffer(src)
      .then((buf) => {
        if (!cancelled) {
          bufferRef.current = buf
          acquiredSrcRef.current = src
        }
      })
      .catch(console.error)

    return () => {
      cancelled = true
      unmountedRef.current = true
      if (persistentRef.current && acquiredSrcRef.current === src) {
        // Leave the instances playing; they clean themselves up when they end.
        activeInstances.current = []
        bufferRef.current = null
        acquiredSrcRef.current = null
        releaseBuffer(src)
        return
      }
      for (const entry of activeInstances.current) {
        entry.source.onended = null
        try {
          entry.source.stop()
        } catch {
          /* already stopped */
        }
        entry.gain.disconnect()
        entry.unregister?.()
      }
      activeInstances.current = []
      bufferRef.current = null
      if (acquiredSrcRef.current) {
        releaseBuffer(acquiredSrcRef.current)
        acquiredSrcRef.current = null
      } else {
        releaseBuffer(src)
      }
    }
  }, [src])

  const getDestination = (): GainNode =>
    groupRef.current ? getGroupGainNode(groupRef.current) : getGroupGainNode('master')

  const removeInstance = (entry: PoolEntry): void => {
    entry.unregister?.()
    const idx = activeInstances.current.indexOf(entry)
    if (idx !== -1) activeInstances.current.splice(idx, 1)
  }

  const stopOldestIfNeeded = (): void => {
    while (activeInstances.current.length >= maxInstances) {
      const oldest = activeInstances.current.shift()
      if (oldest) {
        oldest.source.onended = null
        try {
          oldest.source.stop()
        } catch {
          /* already stopped */
        }
        oldest.gain.disconnect()
        oldest.unregister?.()
      }
    }
  }

  const spawnEntry = (buf: AudioBuffer, startGain: number): PoolEntry => {
    const ctx = getAudioCtx()
    const dest = getDestination()
    const entry = createPoolEntry(ctx, buf, loopRef.current, startGain, dest)
    entry.source.playbackRate.value = rateRef.current

    const group = groupRef.current ?? 'master'
    entry.unregister = registerGroupSource(group, () => {
      try {
        entry.source.stop()
      } catch {
        /* already stopped */
      }
      removeInstance(entry)
      entry.gain.disconnect()
    })

    entry.source.onended = () => {
      removeInstance(entry)
      entry.gain.disconnect()
      if (!unmountedRef.current) onEndedRef.current?.()
    }

    return entry
  }

  const play = (playOpts?: { delay?: number }): void => {
    if (!bufferRef.current) return
    const ctx = getAudioCtx()
    if (ctx.state === 'suspended') void ctx.resume()

    stopOldestIfNeeded()

    const entry = spawnEntry(bufferRef.current, volRef.current)
    const delay = playOpts?.delay
    entry.source.start(delay && delay > 0 ? ctx.currentTime + delay : undefined)
    activeInstances.current.push(entry)
  }

  const stop = (): void => {
    for (const entry of [...activeInstances.current]) {
      // Clear onended before stopping so the user's onEnded callback only fires
      // on natural completion, not on manual stop() calls.
      entry.source.onended = null
      try {
        entry.source.stop()
      } catch {
        /* already stopped */
      }
      entry.gain.disconnect()
      entry.unregister?.()
    }
    activeInstances.current = []
  }

  const setVolume = (v: number): void => {
    volRef.current = v
    for (const entry of activeInstances.current) {
      entry.gain.gain.value = v
    }
  }

  const setPlaybackRate = (rate: number): void => {
    rateRef.current = rate
    for (const entry of activeInstances.current) {
      entry.source.playbackRate.value = rate
    }
  }

  const fadeIn = (duration: number): void => {
    if (!bufferRef.current) return
    const ctx = getAudioCtx()
    if (ctx.state === 'suspended') void ctx.resume()

    stop()

    const entry = spawnEntry(bufferRef.current, 0)
    entry.gain.gain.setValueAtTime(0, ctx.currentTime)
    entry.gain.gain.linearRampToValueAtTime(volRef.current, ctx.currentTime + duration)
    entry.source.start()
    activeInstances.current.push(entry)
  }

  const fadeOut = (duration: number): void => {
    if (activeInstances.current.length === 0) return
    const ctx = getAudioCtx()
    const now = ctx.currentTime

    for (const entry of [...activeInstances.current]) {
      entry.gain.gain.cancelScheduledValues(now)
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now)
      entry.gain.gain.linearRampToValueAtTime(0, now + duration)
      setTimeout(
        () => {
          try {
            entry.source.stop()
          } catch {
            /* already stopped */
          }
          removeInstance(entry)
          entry.gain.disconnect()
        },
        duration * 1000 + 50,
      )
    }
  }

  const crossfadeTo = (newSrc: string, duration: number): void => {
    fadeOut(duration)
    loadBuffer(newSrc)
      .then((buf) => {
        if (!buf) return
        // Unmounted while loading: nothing could stop a source started now, so drop it.
        if (unmountedRef.current && !persistentRef.current) {
          releaseBuffer(newSrc)
          return
        }
        const previousSrc = acquiredSrcRef.current
        const ctx = getAudioCtx()
        if (ctx.state === 'suspended') void ctx.resume()

        const entry = spawnEntry(buf, 0)
        entry.gain.gain.setValueAtTime(0, ctx.currentTime)
        entry.gain.gain.linearRampToValueAtTime(volRef.current, ctx.currentTime + duration)
        entry.source.start()
        activeInstances.current.push(entry)
        bufferRef.current = buf
        acquiredSrcRef.current = newSrc
        if (previousSrc) releaseBuffer(previousSrc)
      })
      .catch((err: unknown) => {
        releaseBuffer(newSrc)
        console.error(err)
      })
  }

  return {
    play,
    stop,
    setVolume,
    setPlaybackRate,
    fadeIn,
    fadeOut,
    crossfadeTo,
    get isPlaying() {
      return activeInstances.current.length > 0
    },
  }
}
