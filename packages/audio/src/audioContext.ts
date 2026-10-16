// ─── Shared audio state ─────────────────────────────────────────────────────
//
// All mutable audio state (the AudioContext, the gain graph, volume + mute
// preferences, the current music track) lives on ONE object stored on
// `globalThis`, not in module variables. That makes it:
//   - independent of <Game>: mounting/unmounting a Game never touches it,
//   - HMR-safe: a re-evaluated module finds the live context instead of
//     leaking a second one,
//   - shared by duplicate copies of the package in one page.
// The only things that tear it down are `getAudioManager().dispose()` or the
// browser closing the context.

/** @internal Currently playing (or fading) music track. */
export interface MusicTrack {
  src: string
  source: AudioBufferSourceNode
  gain: GainNode
  unregister: () => void
  /** Identity of the hook/manager call that started the track. */
  owner: object | null
  /** Pending teardown timer while the track fades out. */
  timer: ReturnType<typeof setTimeout> | null
}

/** @internal */
export interface AudioState {
  ctx: AudioContext | null
  unwatch: (() => void) | null
  groupGainNodes: Map<string, GainNode>
  groupVolumes: Map<string, number>
  groupMuted: Map<string, boolean>
  groupSources: Map<string, Set<() => void>>
  effects: Map<string, { entry: AudioNode; exit: AudioNode }>
  music: MusicTrack | null
  /** Tracks that are fading out and will be torn down by a timer. */
  fading: Set<MusicTrack>
}

const STATE_KEY = Symbol.for('xip.audio.state')

/** @internal */
export function getAudioState(): AudioState {
  const g = globalThis as unknown as Record<symbol, AudioState | undefined>
  let s = g[STATE_KEY]
  if (!s) {
    s = {
      ctx: null,
      unwatch: null,
      groupGainNodes: new Map(),
      groupVolumes: new Map(),
      groupMuted: new Map(),
      groupSources: new Map(),
      effects: new Map(),
      music: null,
      fading: new Set(),
    }
    g[STATE_KEY] = s
  }
  return s
}

const S = getAudioState

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const

/**
 * Autoplay policy: a context created before a user gesture starts suspended,
 * and browsers (iOS Safari: "interrupted") can suspend it again later. While
 * the context is not running, the first gesture resumes it. Returns a cleanup
 * that removes every listener this installed.
 */
function watchContext(ctx: AudioContext): () => void {
  let armed = false
  const needsUnlock = () => ctx.state !== 'running' && ctx.state !== 'closed'
  const arm = () => {
    if (armed || typeof window === 'undefined') return
    armed = true
    for (const e of UNLOCK_EVENTS) window.addEventListener(e, unlock, true)
  }
  const disarm = () => {
    if (!armed) return
    armed = false
    for (const e of UNLOCK_EVENTS) window.removeEventListener(e, unlock, true)
  }
  const unlock = () => {
    if (!needsUnlock()) return disarm()
    Promise.resolve(ctx.resume()).then(disarm, () => {})
  }
  const onState = () => (needsUnlock() ? arm() : disarm())
  ctx.addEventListener?.('statechange', onState)
  onState()
  return () => {
    disarm()
    ctx.removeEventListener?.('statechange', onState)
  }
}

/** Drop every node/listener tied to the current context (volume + mute prefs are kept). */
function resetGraph(s: AudioState): void {
  s.unwatch?.()
  s.unwatch = null
  s.groupGainNodes.clear()
  s.groupSources.clear()
  s.effects.clear()
  for (const t of s.fading) if (t.timer) clearTimeout(t.timer)
  s.fading.clear()
  s.music = null
  s.ctx = null
}

/**
 * The one shared AudioContext. Created lazily on first use (once per page),
 * resumed on the first user gesture, recreated only if the browser closed it.
 */
export function getAudioCtx(): AudioContext {
  const s = S()
  if (s.ctx && s.ctx.state === 'closed') resetGraph(s)
  if (!s.ctx) {
    s.ctx = new AudioContext()
    s.unwatch = watchContext(s.ctx)
  }
  return s.ctx
}

/**
 * Close the shared context and drop the audio graph. Volume and mute settings
 * survive. Only `getAudioManager().dispose()` calls this — never <Game>.
 * @internal
 */
export function disposeAudioContext(): void {
  const s = S()
  for (const set of s.groupSources.values()) for (const stop of [...set]) stop()
  for (const t of [...s.fading]) {
    if (t.timer) clearTimeout(t.timer)
    try {
      t.source.stop()
    } catch {
      /* already stopped */
    }
    t.gain.disconnect()
    t.unregister()
  }
  const ctx = s.ctx
  resetGraph(s)
  try {
    void ctx?.close()
  } catch {
    /* already closed */
  }
}

// ─── Volume groups ──────────────────────────────────────────────────────────
// Graph: each sound → group gain → master gain → destination

/**
 * Audio group name. Built-in groups are `'sfx'` and `'music'`, but any
 * string can be used to create custom groups (e.g. `'ambient'`, `'ui'`, `'voice'`).
 */
export type AudioGroup = string

/**
 * Register a stop function for a source playing in a group.
 * Returns an unregister function to call when the source ends naturally.
 * @internal
 */
export function registerGroupSource(group: AudioGroup | 'master', stopFn: () => void): () => void {
  const sources = S().groupSources
  let set = sources.get(group)
  if (!set) {
    set = new Set()
    sources.set(group, set)
  }
  set.add(stopFn)
  return () => set!.delete(stopFn)
}

export function getGroupGainNode(group: AudioGroup | 'master'): GainNode {
  const ctx = getAudioCtx()
  const s = S()
  const existing = s.groupGainNodes.get(group)
  if (existing) return existing

  const gain = ctx.createGain()
  gain.gain.value = s.groupMuted.get(group) ? 0 : (s.groupVolumes.get(group) ?? 1)

  if (group === 'master') {
    gain.connect(ctx.destination)
  } else {
    gain.connect(getGroupGainNode('master'))
  }

  s.groupGainNodes.set(group, gain)
  return gain
}

/**
 * Set the volume for a named group ('sfx', 'music', or any custom name). Range 0–1.
 *
 * @example
 * setGroupVolume('music', 0.4)
 * setGroupVolume('sfx',   0.8)
 */
export function setGroupVolume(group: AudioGroup, volume: number): void {
  const clamped = Math.max(0, Math.min(1, volume))
  S().groupVolumes.set(group, clamped)
  if (S().groupMuted.get(group)) return // don't change the gain node while muted
  const node = S().groupGainNodes.get(group)
  if (node) node.gain.value = clamped
  else getGroupGainNode(group).gain.value = clamped
}

/**
 * Set the master volume (affects all groups). Range 0–1.
 *
 * @example
 * setMasterVolume(0)   // mute all
 * setMasterVolume(1)   // full volume
 */
export function setMasterVolume(volume: number): void {
  const clamped = Math.max(0, Math.min(1, volume))
  S().groupVolumes.set('master', clamped)
  if (S().groupMuted.get('master')) return
  getGroupGainNode('master').gain.value = clamped
}

/** Read the current volume for a group or master (ignores mute state). */
export function getGroupVolume(group: AudioGroup | 'master'): number {
  return S().groupVolumes.get(group) ?? 1
}

/** Read the current master volume. */
export function getMasterVolume(): number {
  return getGroupVolume('master')
}

/**
 * Mute or unmute an audio group. Preserves the group's volume so unmuting
 * restores the exact level that was set before muting.
 *
 * @example
 * setGroupMute('music', true)  // mute music
 * setGroupMute('music', false) // restore to previous volume
 */
export function setGroupMute(group: AudioGroup, muted: boolean): void {
  S().groupMuted.set(group, muted)
  const node = getGroupGainNode(group)
  node.gain.value = muted ? 0 : (S().groupVolumes.get(group) ?? 1)
}

/** Whether a group (or `'master'`) is currently muted. */
export function isGroupMuted(group: AudioGroup | 'master'): boolean {
  return S().groupMuted.get(group) === true
}

/**
 * Stop all currently playing sounds in a group immediately.
 * New sounds played in the group afterward will play normally.
 */
export function stopGroup(group: AudioGroup): void {
  const sources = S().groupSources.get(group)
  if (sources) {
    for (const stop of [...sources]) stop()
    sources.clear()
  }
}

/**
 * Smoothly transition a group's volume to `volume` over `duration` seconds.
 *
 * @example
 * setGroupVolumeFaded('music', 0, 2) // fade music out over 2s
 * setGroupVolumeFaded('sfx', 1, 0.5) // restore sfx over 0.5s
 */
export function setGroupVolumeFaded(group: AudioGroup | 'master', volume: number, duration: number): void {
  const clamped = Math.max(0, Math.min(1, volume))
  S().groupVolumes.set(group, clamped)
  if (S().groupMuted.get(group)) return // stays silent; unmuting restores this volume
  const node = getGroupGainNode(group)
  const ctx = getAudioCtx()
  const now = ctx.currentTime
  node.gain.cancelScheduledValues(now)
  node.gain.setValueAtTime(node.gain.value, now)
  node.gain.linearRampToValueAtTime(clamped, now + Math.max(0, duration))
}

// ─── Settings persistence ────────────────────────────────────────────────────

const AUDIO_STORAGE_KEY = 'xip:audio'

/**
 * Persist the current master volume and all group volumes to `localStorage`.
 * Call this whenever the player changes a volume setting so preferences survive
 * page reloads.
 *
 * @example
 * setMasterVolume(0.7)
 * saveAudioSettings()
 */
export function saveAudioSettings(): void {
  try {
    const data: Record<string, number> = {}
    for (const [group, volume] of S().groupVolumes) {
      data[group] = volume
    }
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* localStorage unavailable (SSR, private browsing, quota exceeded) */
  }
}

/**
 * Restore master and group volumes previously saved with `saveAudioSettings`.
 * Call once on game startup before audio starts playing.
 *
 * @example
 * // In your game initialisation
 * loadAudioSettings()
 */
export function loadAudioSettings(): void {
  try {
    const raw = localStorage.getItem(AUDIO_STORAGE_KEY)
    if (!raw) return
    const data = JSON.parse(raw) as Record<string, number>
    for (const [group, volume] of Object.entries(data)) {
      if (typeof volume !== 'number') continue
      if (group === 'master') setMasterVolume(volume)
      else setGroupVolume(group, volume)
    }
  } catch {
    /* corrupt data or localStorage unavailable */
  }
}

/**
 * Temporarily lower a group's volume to `amount` (0–1) for `duration` seconds,
 * then restore it. Useful for ducking music under SFX or dialogue.
 *
 * @example
 * duck('music', 0.3, 2) // lower music to 30% for 2 seconds then restore
 */
export function duck(group: AudioGroup, amount: number, duration: number): void {
  const node = getGroupGainNode(group)
  const ctx = getAudioCtx()
  const now = ctx.currentTime
  const prev = S().groupVolumes.get(group) ?? 1
  // a muted group ducks and restores to silence instead of becoming audible
  const muted = S().groupMuted.get(group) === true
  const low = muted ? 0 : Math.max(0, Math.min(1, amount))
  node.gain.cancelScheduledValues(now)
  node.gain.setValueAtTime(node.gain.value, now)
  node.gain.linearRampToValueAtTime(low, now + 0.05)
  node.gain.setValueAtTime(low, now + duration)
  node.gain.linearRampToValueAtTime(muted ? 0 : prev, now + duration + 0.2)
}
