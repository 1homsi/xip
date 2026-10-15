import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TextLayer } from '@xip/renderer'
import { EngineContext, type EngineState } from '../context'
import { useTextLayer } from '../hooks/useTextLayer'

afterEach(cleanup)

describe('useTextLayer', () => {
  it('wakes an onDemand loop on layer mutations, and stops after unmount', () => {
    const markDirty = vi.fn()
    const engine = {
      loop: { markDirty },
      activeRenderSystem: { addTextLayer: vi.fn(), removeTextLayer: vi.fn() },
    } as unknown as EngineState
    let layer: TextLayer | undefined
    function Names() {
      layer = useTextLayer({ zIndex: 5 })
      return null
    }
    const view = render(
      <EngineContext.Provider value={engine}>
        <Names />
      </EngineContext.Provider>,
    )
    markDirty.mockClear()
    layer!.touch()
    expect(markDirty).toHaveBeenCalledTimes(1)
    const i = layer!.add('Ada', 10, 10)
    layer!.setText(i, 'Grace')
    layer!.set(i, 20, 20)
    expect(markDirty).toHaveBeenCalledTimes(4)
    layer!.setText(i, 'Grace') // unchanged text: no wake
    expect(markDirty).toHaveBeenCalledTimes(4)
    layer!.removeAt(i)
    layer!.clear()
    expect(markDirty).toHaveBeenCalledTimes(6)
    view.unmount()
    layer!.touch()
    expect(markDirty).toHaveBeenCalledTimes(6)
  })
})
