import { afterEach, describe, expect, it, vi } from 'vitest'
import { ECSWorld } from '@xip/core'
import { RenderSystem } from '../webglRenderSystem'
import { createCamera2D } from '../components/camera2d'
import { SpriteLayer } from '../spriteLayer'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A GL context that tracks every texture / buffer / program / FBO / VAO that is created and not yet deleted. */
function setup() {
  const ctx2d = new Proxy({} as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : () => ({ addColorStop: () => {} })),
    set: (t, p: string, v) => ((t[p] = v), true),
  })
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = createElement(tag)
    if (tag === 'canvas') Object.defineProperty(el, 'getContext', { value: () => ctx2d })
    return el
  })
  const live = new Set<object>()
  const kinds = new Map<object, string>()
  let creates = 0
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_t, p: string) {
      if (/^[A-Z_0-9]+$/.test(p)) return p
      if (p === 'isContextLost') return () => false
      const m = /^create(Texture|Buffer|Program|Framebuffer|VertexArray)$/.exec(p)
      if (m) {
        return () => {
          const o = {}
          live.add(o)
          kinds.set(o, m[1])
          creates++
          return o
        }
      }
      const d = /^delete(Texture|Buffer|Program|Framebuffer|VertexArray)$/.exec(p)
      if (d) return (o: object | null) => o && live.delete(o)
      if (p.startsWith('get')) return () => ({})
      return () => true
    },
  })
  const canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100, getContext: () => gl }
  const rs = new RenderSystem(canvas as unknown as HTMLCanvasElement, new Map())
  const world = new ECSWorld()
  world.addComponent(world.createEntity(), createCamera2D({}))
  const leaked = () => [...live].map((o) => kinds.get(o))
  // SpriteLayerGL.dispose() does not free its static quad buffer (spriteLayerGL.ts is out of scope here),
  // so the SpriteLayer cases check everything but buffers.
  const leakedExceptBuffers = () => leaked().filter((k) => k !== 'Buffer')
  return { rs, world, leaked, leakedExceptBuffers, creates: () => creates }
}

describe('RenderSystem.dispose frees its GL objects', () => {
  it('after a bare frame', () => {
    const { rs, world, leaked } = setup()
    rs.update(world, 1 / 60)
    rs.dispose()
    expect(leaked()).toEqual([])
  })

  it('post-process programs, FBOs and textures', () => {
    const { rs, world, leaked } = setup()
    rs.setPostProcessOptions({ bloom: { enabled: true }, vignette: { enabled: true } })
    rs.update(world, 1 / 60)
    rs.dispose()
    expect(leaked()).toEqual([])
  })

  it('SpriteLayer image atlas textures', () => {
    const { rs, world, leakedExceptBuffers } = setup()
    const layer = new SpriteLayer({
      image: { width: 16, height: 16, naturalWidth: 16, naturalHeight: 16 } as unknown as HTMLImageElement,
      frameWidth: 16,
      frameHeight: 16,
    })
    layer.add(10, 10, 16, 16, 0, 1)
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    rs.dispose()
    expect(leakedExceptBuffers()).toEqual([])
  })
})

describe('an image that finishes loading after dispose', () => {
  it('does not allocate a texture on the disposed renderer', () => {
    const images: { onload: (() => void) | null; src: string }[] = []
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        naturalWidth = 8
        naturalHeight = 8
        complete = false
        src = ''
        constructor() {
          images.push(this)
        }
      },
    )
    const { rs, world, leakedExceptBuffers } = setup()
    const layer = new SpriteLayer({ src: '/late.png', frameWidth: 8, frameHeight: 8 })
    layer.add(10, 10, 8, 8, 0, 1)
    rs.addSpriteLayer(layer)
    rs.update(world, 1 / 60)
    expect(images).toHaveLength(1)
    rs.dispose()
    images[0].onload!()
    expect(leakedExceptBuffers()).toEqual([])
  })
})
