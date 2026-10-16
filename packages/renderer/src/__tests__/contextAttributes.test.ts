import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRecordingCanvas, installHeadlessCanvasDOM } from '../testing/recordingGL'
import { RenderSystem } from '../webglRenderSystem'

let uninstall: () => void
beforeAll(() => {
  uninstall = installHeadlessCanvasDOM()
})
afterAll(() => uninstall())

describe('WebGL2 context attributes', () => {
  it('requests no depth or stencil buffer, since the renderer draws with neither', () => {
    const canvas = createRecordingCanvas(64, 64)
    const getContext = vi.spyOn(canvas, 'getContext')
    new RenderSystem(canvas, new Map())
    expect(getContext).toHaveBeenCalledWith('webgl2', expect.objectContaining({ depth: false, stencil: false }))
  })
})
