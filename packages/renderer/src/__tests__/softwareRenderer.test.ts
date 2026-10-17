import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRecordingCanvas, installHeadlessCanvasDOM } from '../testing/recordingGL'
import { RenderSystem } from '../webglRenderSystem'

let uninstall: () => void
beforeAll(() => {
  uninstall = installHeadlessCanvasDOM()
})
afterAll(() => uninstall())

const UNMASKED_RENDERER_WEBGL = 0x9246

/** A context whose WEBGL_debug_renderer_info reports `renderer` (or hides the extension when `undefined`). */
function renderSystemOn(renderer: string | null | undefined) {
  const canvas = createRecordingCanvas(64, 64)
  vi.spyOn(canvas.gl, 'getExtension').mockImplementation((name: string) =>
    renderer !== undefined && name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL } : null,
  )
  vi.spyOn(canvas.gl, 'getParameter').mockImplementation((p?: number) =>
    p === UNMASKED_RENDERER_WEBGL ? (renderer as string) : 4096,
  )
  return new RenderSystem(canvas, new Map())
}

describe('software renderer detection', () => {
  it('flags a SwiftShader context (WebGL on the CPU)', () => {
    const rs = renderSystemOn('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')
    expect(rs.stats.softwareRenderer).toBe(true)
  })

  it('flags a Mesa llvmpipe context', () => {
    expect(renderSystemOn('llvmpipe (LLVM 15.0.7, 256 bits)').stats.softwareRenderer).toBe(true)
  })

  it('flags Windows WARP (Microsoft Basic Render Driver)', () => {
    expect(renderSystemOn('ANGLE (Microsoft, Microsoft Basic Render Driver (Vulkan), Unspecified Version)').stats.softwareRenderer).toBe(true)
  })

  it('does not flag a hardware GPU', () => {
    const rs = renderSystemOn('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)')
    expect(rs.stats.softwareRenderer).toBe(false)
  })

  it('reports null when the browser hides the renderer', () => {
    expect(renderSystemOn(undefined).stats.softwareRenderer).toBeNull()
  })

  it('reports null when the renderer string is empty or missing (lost context)', () => {
    expect(renderSystemOn('').stats.softwareRenderer).toBeNull()
    expect(renderSystemOn(null).stats.softwareRenderer).toBeNull()
  })
})
