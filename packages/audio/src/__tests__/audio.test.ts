import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Web Audio API mocks ────────────────────────────────────────────────────

function createMockGainNode() {
  return {
    gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

function createMockSourceNode() {
  const node: any = {
    buffer: null,
    loop: false,
    playbackRate: { value: 1 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  }
  // Simulate ending after stop()
  node.stop.mockImplementation(() => {
    if (node.onended) node.onended()
  })
  return node
}

function createMockPannerNode() {
  return {
    panningModel: 'HRTF',
    distanceModel: 'linear',
    maxDistance: 10000,
    refDistance: 1,
    rolloffFactor: 1,
    positionX: { value: 0, setValueAtTime: vi.fn() },
    positionY: { value: 0, setValueAtTime: vi.fn() },
    positionZ: { value: 0, setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

let mockCtx: any
let createdSources: any[]
let createdGains: any[]
let createdPanners: any[]

function setupAudioMocks() {
  createdSources = []
  createdGains = []
  createdPanners = []

  mockCtx = {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: vi.fn(),
    createGain: vi.fn(() => {
      const g = createMockGainNode()
      createdGains.push(g)
      return g
    }),
    createBufferSource: vi.fn(() => {
      const s = createMockSourceNode()
      createdSources.push(s)
      return s
    }),
    createPanner: vi.fn(() => {
      const p = createMockPannerNode()
      createdPanners.push(p)
      return p
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 1, length: 44100 })),
    listener: {
      positionX: { value: 0, setValueAtTime: vi.fn() },
      positionY: { value: 0, setValueAtTime: vi.fn() },
      positionZ: { value: 0, setValueAtTime: vi.fn() },
    },
  }
  ;(globalThis as any).AudioContext = vi.fn(() => mockCtx)

  // Mock fetch for loadBuffer
  ;(globalThis as any).fetch = vi.fn(async () => ({
    arrayBuffer: async () => new ArrayBuffer(8),
  }))
}

// ─── Minimal React ref/effect mock ──────────────────────────────────────────

let cleanupFns: (() => void)[]
let effectCallbacks: (() => (() => void) | void)[]

vi.mock('react', () => ({
  useRef: (init: any) => ({ current: init }),
  useEffect: (cb: () => (() => void) | void, _deps?: any[]) => {
    effectCallbacks.push(cb)
  },
}))

function flushEffects() {
  for (const cb of effectCallbacks) {
    const cleanup = cb()
    if (cleanup) cleanupFns.push(cleanup)
  }
  effectCallbacks = []
}

function runCleanups() {
  for (const fn of cleanupFns) fn()
  cleanupFns = []
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Audio system', () => {
  beforeEach(() => {
    cleanupFns = []
    effectCallbacks = []
    setupAudioMocks()
  })

  afterEach(() => {
    runCleanups()
    vi.restoreAllMocks()

    // Reset the module-level singletons by clearing the module cache
    vi.resetModules()
  })

  describe('Buffer ref counting', () => {
    it('removes buffer from cache when last consumer unmounts', async () => {
      const { useSound, _getBufferCache, _getBufferRefCount } = await import('../useSound')

      // First consumer
      useSound('/boom.wav')
      flushEffects()
      await vi.waitFor(() => expect(_getBufferCache().has('/boom.wav')).toBe(true))

      expect(_getBufferRefCount().get('/boom.wav')).toBe(1)

      // Unmount → cleanup decrements to 0 → cache entry removed
      runCleanups()
      expect(_getBufferCache().has('/boom.wav')).toBe(false)
      expect(_getBufferRefCount().has('/boom.wav')).toBe(false)
    })

    it('keeps buffer in cache when other consumers remain', async () => {
      const { useSound, _getBufferCache, _getBufferRefCount } = await import('../useSound')

      // Two consumers of the same src
      useSound('/boom.wav')
      flushEffects()
      await vi.waitFor(() => expect(_getBufferCache().has('/boom.wav')).toBe(true))

      useSound('/boom.wav')
      flushEffects()
      await vi.waitFor(() => expect(_getBufferRefCount().get('/boom.wav')).toBe(2))

      // First unmount — refcount drops to 1, buffer stays
      const first = cleanupFns.shift()!
      first()
      expect(_getBufferRefCount().get('/boom.wav')).toBe(1)
      expect(_getBufferCache().has('/boom.wav')).toBe(true)

      // Second unmount — refcount drops to 0, buffer removed
      runCleanups()
      expect(_getBufferCache().has('/boom.wav')).toBe(false)
    })

    it('releases the previous buffer after crossfade and the final buffer on unmount', async () => {
      const { useSound, _getBufferCache, _getBufferRefCount } = await import('../useSound')

      const controls = useSound('/intro.wav')
      flushEffects()
      await vi.waitFor(() => expect(_getBufferCache().has('/intro.wav')).toBe(true))

      controls.crossfadeTo('/loop.wav', 0.25)
      await vi.waitFor(() => expect(_getBufferCache().has('/loop.wav')).toBe(true))

      expect(_getBufferCache().has('/intro.wav')).toBe(false)
      expect(_getBufferRefCount().has('/intro.wav')).toBe(false)
      expect(_getBufferRefCount().get('/loop.wav')).toBe(1)

      runCleanups()
      expect(_getBufferCache().has('/loop.wav')).toBe(false)
      expect(_getBufferRefCount().has('/loop.wav')).toBe(false)
    })

    it('a crossfade that finishes loading after unmount starts nothing and releases its buffer', async () => {
      const { useSound, _getBufferCache, _getBufferRefCount } = await import('../useSound')

      const controls = useSound('/intro.wav')
      flushEffects()
      await vi.waitFor(() => expect(_getBufferCache().has('/intro.wav')).toBe(true))

      controls.crossfadeTo('/loop.wav', 0.25)
      runCleanups() // unmount while /loop.wav is still loading
      await new Promise((r) => setTimeout(r, 10))

      expect(createdSources.every((s) => s.start.mock.calls.length === 0)).toBe(true)
      expect(controls.isPlaying).toBe(false)
      expect(_getBufferRefCount().has('/loop.wav')).toBe(false)
    })
  })

  describe('maxInstances limits concurrent source nodes', () => {
    it('stops oldest instance when maxInstances exceeded', async () => {
      const { useSound } = await import('../useSound')

      const controls = useSound('/pew.wav', { maxInstances: 2 })
      flushEffects()

      // Give loadBuffer time to resolve
      await new Promise((r) => setTimeout(r, 10))

      controls.play()
      controls.play()

      // 2 sources created, both active
      // Note: createGain is called for group/master chains too; count sources
      const sourcesBeforeOverflow = createdSources.length
      expect(sourcesBeforeOverflow).toBe(2)

      // Third play should evict the oldest
      controls.play()
      expect(createdSources.length).toBe(3)
      // The first source's stop() should have been called
      expect(createdSources[0].stop).toHaveBeenCalled()
    })
  })

  describe('Spatial sound', () => {
    it('setPosition updates panner positionX/Y', async () => {
      const { useSpatialSound } = await import('../useSpatialSound')

      const controls = useSpatialSound('/explosion.wav', { maxDistance: 500 })
      flushEffects()

      await new Promise((r) => setTimeout(r, 10))

      // setPosition creates the panner lazily
      controls.setPosition(200, 300)

      expect(createdPanners.length).toBe(1)
      const panner = createdPanners[0]
      expect(panner.positionX.setValueAtTime).toHaveBeenCalledWith(200, mockCtx.currentTime)
      expect(panner.positionY.setValueAtTime).toHaveBeenCalledWith(300, mockCtx.currentTime)
    })

    it('play routes source through panner', async () => {
      const { useSpatialSound } = await import('../useSpatialSound')

      const controls = useSpatialSound('/explosion.wav')
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))

      controls.play()

      // Source should be connected to panner
      expect(createdSources.length).toBe(1)
      expect(createdSources[0].connect).toHaveBeenCalled()
      expect(createdPanners.length).toBe(1)
      // Panner connected to gain
      expect(createdPanners[0].connect).toHaveBeenCalled()
    })
  })

  describe('setListenerPosition', () => {
    it('sets AudioContext listener position', async () => {
      const { setListenerPosition } = await import('../listener')

      setListenerPosition(100, 200)

      expect(mockCtx.listener.positionX.setValueAtTime).toHaveBeenCalledWith(100, mockCtx.currentTime)
      expect(mockCtx.listener.positionY.setValueAtTime).toHaveBeenCalledWith(200, mockCtx.currentTime)
    })
  })

  describe('isPlaying', () => {
    it('is false before play() is called', async () => {
      const { useSound } = await import('../useSound')
      const controls = useSound('/sfx.wav')
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      expect(controls.isPlaying).toBe(false)
    })

    it('is true after play() is called', async () => {
      const { useSound } = await import('../useSound')
      const controls = useSound('/sfx.wav')
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      controls.play()
      expect(controls.isPlaying).toBe(true)
    })

    it('is false after stop() is called', async () => {
      const { useSound } = await import('../useSound')
      const controls = useSound('/sfx.wav')
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      controls.play()
      controls.stop()
      expect(controls.isPlaying).toBe(false)
    })

    it('is false after source ends naturally', async () => {
      const { useSound } = await import('../useSound')
      const controls = useSound('/sfx.wav')
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      controls.play()
      // Simulate natural end
      createdSources[0].onended?.()
      expect(controls.isPlaying).toBe(false)
    })
  })

  describe('onEnded callback', () => {
    it('fires when a source ends naturally', async () => {
      const { useSound } = await import('../useSound')
      let fired = false
      const controls = useSound('/sfx.wav', {
        onEnded: () => {
          fired = true
        },
      })
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      controls.play()
      createdSources[0].onended?.()
      expect(fired).toBe(true)
    })

    it('does not fire when stop() is called manually', async () => {
      const { useSound } = await import('../useSound')
      let fired = false
      const controls = useSound('/sfx.wav', {
        onEnded: () => {
          fired = true
        },
      })
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      controls.play()
      controls.stop() // manual stop — onEnded should NOT fire
      expect(fired).toBe(false)
    })
  })

  describe('setPlaybackRate', () => {
    it('sets playbackRate on new sources at the time of play', async () => {
      const { useSound } = await import('../useSound')
      const controls = useSound('/sfx.wav', { playbackRate: 2 })
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      controls.play()
      expect(createdSources[0].playbackRate.value).toBe(2)
    })

    it('updates all active sources immediately', async () => {
      const { useSound } = await import('../useSound')
      const controls = useSound('/sfx.wav', { maxInstances: 3 })
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      controls.play()
      controls.play()
      controls.setPlaybackRate(0.5)
      expect(createdSources[0].playbackRate.value).toBe(0.5)
      expect(createdSources[1].playbackRate.value).toBe(0.5)
    })
  })

  describe('audioContext helpers', () => {
    it('getMasterVolume returns 1 by default', async () => {
      const { getMasterVolume } = await import('../useSound')
      expect(getMasterVolume()).toBe(1)
    })

    it('getMasterVolume reflects setMasterVolume', async () => {
      const { getMasterVolume, setMasterVolume } = await import('../useSound')
      setMasterVolume(0.4)
      expect(getMasterVolume()).toBeCloseTo(0.4)
    })

    it('setGroupMute(false) restores the volume set before muting', async () => {
      const { setGroupVolume, setGroupMute, getGroupVolume } = await import('../useSound')
      const { getGroupGainNode } = await import('../audioContext')

      setGroupVolume('sfx', 0.6)
      setGroupMute('sfx', true)
      setGroupMute('sfx', false)

      // Gain node should be at 0.6, not 1
      const node = getGroupGainNode('sfx')
      expect(node.gain.value).toBeCloseTo(0.6)
      expect(getGroupVolume('sfx')).toBeCloseTo(0.6)
    })

    it('setGroupVolume has no effect on gain node while group is muted', async () => {
      const { setGroupVolume, setGroupMute } = await import('../useSound')
      const { getGroupGainNode } = await import('../audioContext')

      setGroupMute('music', true)
      setGroupVolume('music', 0.7)

      const node = getGroupGainNode('music')
      expect(node.gain.value).toBe(0) // still muted
    })

    it('setGroupVolumeFaded calls linearRamp on group gain node', async () => {
      const { setGroupVolumeFaded } = await import('../useSound')
      const { getGroupGainNode } = await import('../audioContext')

      const node = getGroupGainNode('sfx')
      setGroupVolumeFaded('sfx', 0.3, 2)

      expect(node.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.3, expect.any(Number))
    })

    it('duck and setGroupVolumeFaded keep a muted group silent', async () => {
      const { setGroupMute, duck, setGroupVolumeFaded, getGroupVolume } = await import('../useSound')
      const { getGroupGainNode } = await import('../audioContext')

      setGroupMute('ambience', true)
      const node = getGroupGainNode('ambience') as unknown as ReturnType<typeof createMockGainNode>
      node.gain.setValueAtTime.mockClear()
      node.gain.linearRampToValueAtTime.mockClear()

      duck('ambience', 0.3, 2)
      setGroupVolumeFaded('ambience', 1, 1)

      const scheduled = [
        ...node.gain.setValueAtTime.mock.calls.map((c) => c[0]),
        ...node.gain.linearRampToValueAtTime.mock.calls.map((c) => c[0]),
      ]
      expect(scheduled.length).toBeGreaterThan(0)
      expect(scheduled.every((v) => v === 0)).toBe(true)
      // the faded target is still remembered, so unmuting restores it
      expect(getGroupVolume('ambience')).toBe(1)
    })

    it('muting or unmuting drops automation that was already scheduled on the group', async () => {
      const { setGroupVolume, setGroupMute, duck } = await import('../useSound')
      const { getGroupGainNode } = await import('../audioContext')

      setGroupVolume('music', 0.8)
      const node = getGroupGainNode('music') as unknown as ReturnType<typeof createMockGainNode>
      duck('music', 0.3, 2) // scheduled while unmuted
      node.gain.cancelScheduledValues.mockClear()

      setGroupMute('music', false) // already unmuted: the duck keeps running
      expect(node.gain.cancelScheduledValues).not.toHaveBeenCalled()

      setGroupMute('music', true)
      expect(node.gain.cancelScheduledValues).toHaveBeenCalledTimes(1)
      expect(node.gain.value).toBe(0)

      duck('music', 0.3, 2) // scheduled while muted
      node.gain.cancelScheduledValues.mockClear()
      setGroupMute('music', false)
      expect(node.gain.cancelScheduledValues).toHaveBeenCalledTimes(1)
      expect(node.gain.value).toBeCloseTo(0.8)
    })

    it('stopGroup calls stop on all registered sources', async () => {
      const { useSound, stopGroup } = await import('../useSound')

      const controls = useSound('/sfx.wav', { group: 'sfx', maxInstances: 5 })
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))

      controls.play()
      controls.play()
      expect(createdSources.length).toBe(2)

      stopGroup('sfx')

      expect(createdSources[0].stop).toHaveBeenCalled()
      expect(createdSources[1].stop).toHaveBeenCalled()
    })
  })

  describe('robustness', () => {
    it('keeps voices bounded under a burst of plays and releases them all on unmount', async () => {
      const { useSound } = await import('../useSound')
      const onEnded = vi.fn()
      const controls = useSound('/burst.wav', { maxInstances: 8, onEnded })
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      for (let i = 0; i < 500; i++) controls.play()
      const live = createdSources.filter((s) => !s.stop.mock.calls.length)
      expect(live.length).toBe(8)
      expect(onEnded).not.toHaveBeenCalled()
      runCleanups()
      expect(createdSources.every((s) => s.stop.mock.calls.length > 0)).toBe(true)
      expect(onEnded).not.toHaveBeenCalled()
    })

    it('maxInstances 0 does not hang', async () => {
      const { useSound } = await import('../useSound')
      const controls = useSound('/x.wav', { maxInstances: 0 })
      flushEffects()
      await new Promise((r) => setTimeout(r, 10))
      controls.play()
      controls.play()
      expect(createdSources.length).toBe(2)
    })

    it('resumes a suspended context on the first user gesture, then stops listening', async () => {
      mockCtx.state = 'suspended'
      mockCtx.resume = vi.fn(async () => {
        mockCtx.state = 'running'
      })
      const add = vi.spyOn(window, 'addEventListener')
      const remove = vi.spyOn(window, 'removeEventListener')
      const { getAudioCtx } = await import('../audioContext')
      getAudioCtx()
      const types = add.mock.calls.map((c) => c[0])
      expect(types).toEqual(expect.arrayContaining(['pointerdown', 'keydown', 'touchend']))
      window.dispatchEvent(new Event('keydown'))
      await Promise.resolve()
      await Promise.resolve()
      expect(mockCtx.resume).toHaveBeenCalledTimes(1)
      expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(['keydown', 'pointerdown', 'touchend'])
      window.dispatchEvent(new Event('keydown'))
      expect(mockCtx.resume).toHaveBeenCalledTimes(1)
    })
  })
})
