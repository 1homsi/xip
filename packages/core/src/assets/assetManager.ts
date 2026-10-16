export interface AssetProgress {
  loaded: number
  total: number
  percent: number
}

export interface AssetLoadError {
  src: string
  kind: 'image' | 'audio'
  error: unknown
}

export class AssetManager {
  private images = new Map<string, HTMLImageElement>()
  private imagePromises = new Map<string, Promise<HTMLImageElement>>()
  private audio = new Map<string, AudioBuffer>()
  private audioPromises = new Map<string, Promise<AudioBuffer>>()
  private audioCtx: AudioContext | null = null
  private releaseUnlock: () => void = () => {}
  private activeSources = new Map<string, Set<AudioBufferSourceNode>>()
  private _loaded = 0
  private _total = 0
  private _progressListeners = new Set<(p: AssetProgress) => void>()
  private _errors: AssetLoadError[] = []

  /** Base URL prefix applied to all asset paths starting with '/'. Set by Game component. */
  baseURL = ''

  private resolve(src: string): string {
    return this.baseURL && src.startsWith('/') ? this.baseURL + src : src
  }

  private getAudioContext(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
      this.releaseUnlock = resumeOnGesture(this.audioCtx)
    }
    return this.audioCtx
  }

  private emitProgress(): void {
    const p: AssetProgress = {
      loaded: this._loaded,
      total: this._total,
      percent: this._total > 0 ? this._loaded / this._total : 1,
    }
    for (const cb of this._progressListeners) cb(p)
  }

  /** Get current loading progress. */
  getProgress(): AssetProgress {
    return {
      loaded: this._loaded,
      total: this._total,
      percent: this._total > 0 ? this._loaded / this._total : 1,
    }
  }

  /** Subscribe to progress updates. Returns unsubscribe fn. */
  onProgress(cb: (p: AssetProgress) => void): () => void {
    this._progressListeners.add(cb)
    return () => this._progressListeners.delete(cb)
  }

  /**
   * Assets that failed to load so far (deduped by src+kind). Loading errors
   * also reject the individual load promise — this list is for surfacing
   * problems after a preload completes (e.g. on a loading screen).
   */
  getErrors(): readonly AssetLoadError[] {
    return this._errors
  }

  async loadImage(src: string): Promise<HTMLImageElement> {
    const resolved = this.resolve(src)
    if (this.imagePromises.has(resolved)) return this.imagePromises.get(resolved)!
    this._total++
    this.emitProgress()
    const promise = (async () => {
      const img = new Image()
      img.src = resolved
      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
        })
      } catch (err) {
        console.warn(`[Xip] Failed to load image: ${resolved}`)
        this._errors.push({ src: resolved, kind: 'image', error: err })
        throw err
      } finally {
        this._loaded++
        this.emitProgress()
      }
      this.images.set(resolved, img)
      return img
    })()
    this.imagePromises.set(resolved, promise)
    return promise
  }

  /** Resolves once every image that has been requested via loadImage() is settled. */
  async waitForImages(): Promise<void> {
    await Promise.allSettled([...this.imagePromises.values()])
  }

  getImage(src: string): HTMLImageElement | undefined {
    return this.images.get(this.resolve(src))
  }

  /** Returns a read-only snapshot of all loaded images keyed by src. */
  getLoadedImages(): ReadonlyMap<string, HTMLImageElement> {
    return this.images
  }

  async loadAudio(src: string): Promise<AudioBuffer> {
    const resolved = this.resolve(src)
    if (this.audio.has(resolved)) return this.audio.get(resolved)!
    if (this.audioPromises.has(resolved)) return this.audioPromises.get(resolved)!
    this._total++
    this.emitProgress()
    const ctx = this.getAudioContext()
    const promise = (async () => {
      try {
        const response = await fetch(resolved)
        if (response.ok === false) throw new Error(`HTTP ${response.status} for ${resolved}`)
        const arrayBuffer = await response.arrayBuffer()
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
        this.audio.set(resolved, audioBuffer)
        return audioBuffer
      } catch (err) {
        console.warn(`[Xip] Failed to load audio: ${resolved}`)
        this._errors.push({ src: resolved, kind: 'audio', error: err })
        throw err
      } finally {
        this._loaded++
        this.emitProgress()
      }
    })()
    // Keep settled promises around only while in flight so failures can be
    // retried; successful buffers are served from the audio cache above.
    void promise.catch(() => {})
    this.audioPromises.set(resolved, promise)
    // Forget it once settled. Attached after set(): a synchronous throw from fetch settles
    // the promise before this line, and a delete inside the body would run before the set.
    const forget = () => this.audioPromises.delete(resolved)
    promise.then(forget, forget)
    return promise
  }

  private trackSource(src: string, source: AudioBufferSourceNode): void {
    let set = this.activeSources.get(src)
    if (!set) {
      set = new Set()
      this.activeSources.set(src, set)
    }
    set.add(source)
    source.onended = () => {
      set!.delete(source)
      if (set!.size === 0) this.activeSources.delete(src)
    }
  }

  playAudio(src: string, volume = 1): void {
    const resolved = this.resolve(src)
    const buffer = this.audio.get(resolved)
    if (!buffer) return
    const ctx = this.getAudioContext()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gainNode = ctx.createGain()
    gainNode.gain.value = volume
    source.connect(gainNode)
    gainNode.connect(ctx.destination)
    this.trackSource(resolved, source)
    source.start()
  }

  playLoopAudio(src: string, volume = 1): AudioBufferSourceNode | null {
    const resolved = this.resolve(src)
    const buffer = this.audio.get(resolved)
    if (!buffer) return null
    const ctx = this.getAudioContext()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    const gainNode = ctx.createGain()
    gainNode.gain.value = volume
    source.connect(gainNode)
    gainNode.connect(ctx.destination)
    this.trackSource(resolved, source)
    source.start()
    return source
  }

  stopAudio(src: string): void {
    const resolved = this.resolve(src)
    const set = this.activeSources.get(resolved)
    if (!set) return
    for (const source of set) {
      try {
        source.stop()
      } catch {
        /* already stopped */
      }
    }
    set.clear()
    this.activeSources.delete(resolved)
  }

  stopAll(): void {
    for (const [src] of this.activeSources) {
      this.stopAudio(src)
    }
    this.activeSources.clear()
  }

  /**
   * Release everything: stops playback, closes the AudioContext, clears all
   * caches and listeners. The manager must not be used afterwards.
   */
  dispose(): void {
    this.stopAll()
    this.releaseUnlock()
    try {
      this.audioCtx?.close()
    } catch {
      /* context already closed */
    }
    this.audioCtx = null
    this.images.clear()
    this.imagePromises.clear()
    this.audio.clear()
    this.audioPromises.clear()
    this._progressListeners.clear()
    this._errors.length = 0
    this._loaded = 0
    this._total = 0
  }

  preloadImages(srcs: string[]): Promise<HTMLImageElement[]> {
    return Promise.all(srcs.map((src) => this.loadImage(src)))
  }

  preloadAudio(srcs: string[]): Promise<AudioBuffer[]> {
    return Promise.all(srcs.map((src) => this.loadAudio(src)))
  }
}

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const

// Autoplay policy: a context created before a user gesture starts suspended.
function resumeOnGesture(ctx: AudioContext): () => void {
  if (ctx.state !== 'suspended' || typeof window === 'undefined') return () => {}
  const off = () => {
    for (const e of UNLOCK_EVENTS) window.removeEventListener(e, unlock, true)
  }
  const unlock = () => {
    if (ctx.state !== 'suspended') return off()
    Promise.resolve(ctx.resume()).then(off, () => {})
  }
  for (const e of UNLOCK_EVENTS) window.addEventListener(e, unlock, true)
  return off
}
