import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Camera2D, Game, useCamera, useCaptureFrame, useSpriteLayer, useTextLayer } from 'xipjs/render'

declare global {
  interface Window {
    __parityCapture?: () => Promise<string>
  }
}

function Layers() {
  const scene = new URLSearchParams(location.search).get('scene') ?? 'crowd'
  const sprites = useSpriteLayer({ zIndex: 0, sortByKey: true })
  const labels = useTextLayer({
    fontFamily: 'monospace',
    fontSize: 12,
    outlineColor: '#080808',
    outlineWidth: 2,
    zIndex: 5,
  })
  const camera = useCamera()
  const capture = useCaptureFrame()

  useEffect(() => {
    const spriteCount = scene === 'overview' ? 24000 : scene === 'text-heavy' ? 2400 : 3000
    for (let n = 0; n < spriteCount; n++) {
      const x = ((n * 73) % 1600) - 800
      const y = ((n * 131) % 1000) - 500
      const i = sprites.add(x, y, 10 + (n % 4) * 2, 12 + (n % 5) * 3)
      sprites.color[i] = [0xffcc88ff, 0x99dd99ff, 0x88bbffff, 0xff9999ff][n % 4]
      sprites.sortKey[i] = y + (n % 7) * 0.01
    }
    const labelCount = scene === 'text-heavy' ? 1200 : scene === 'overview' ? 180 : 100
    for (let n = 0; n < labelCount; n++) {
      const x = ((n * 97) % 1500) - 750
      const y = ((n * 53) % 900) - 450
      labels.add(`Name ${String(n).padStart(4, '0')}`, x, y, { color: 0xffffffff, anchorX: 0 })
    }
    camera.setPosition(0, 0)
    camera.setZoom(scene === 'overview' ? 0.45 : 1)
    const ready = async () => {
      const blob = await capture({ type: 'blob' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return `data:${blob.type};base64,${btoa(binary)}`
    }
    window.__parityCapture = ready
  }, [camera, capture, labels, scene, sprites])

  return <Camera2D x={0} y={0} zoom={scene === 'overview' ? 0.45 : 1} />
}

createRoot(document.getElementById('root')!).render(
  <Game width={1280} height={720} mode="onDemand" renderer="webgl" asyncAssets>
    <Layers />
  </Game>,
)
