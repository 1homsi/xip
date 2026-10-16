import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Camera2D,
  Entity,
  Game,
  Sprite,
  Transform,
  useCamera,
  useCaptureFrame,
  useSpriteLayer,
  useTextLayer,
} from 'xipjs/render'
// SDF shape components live on the full entry, not `xipjs/render`; importing them by name
// resolves to the same dist and the same ../context.js, so they share the engine context.
import { Circle } from 'xip-shapes/Circle'
import { Line } from 'xip-shapes/Line'
import { Polygon } from 'xip-shapes/Polygon'

declare global {
  interface Window {
    __parityCapture?: () => Promise<string>
  }
}

/** Entity-batch quads (`<Sprite>` on an entity): flat colour, rotated and flipped. */
function EntitySprites({ count }: { count: number }) {
  const out: React.ReactNode[] = []
  for (let n = 0; n < count; n++) {
    const x = ((n * 61) % 1500) - 750
    const y = ((n * 89) % 900) - 450
    out.push(
      <Entity key={n}>
        <Transform x={x} y={y} rotation={(n % 7) * 0.12} />
        <Sprite
          width={20 + (n % 3) * 4}
          height={24 + (n % 4) * 4}
          flipX={n % 2 === 1}
          flipY={n % 6 === 0}
          zIndex={2}
          color={['#ff8844', '#44cc88', '#4488ff', '#dddddd'][n % 4]}
        />
      </Entity>,
    )
  }
  return <>{out}</>
}

/** SDF shape quads: circles, lines and polygons, with rotation and scale. */
function Shapes({ count }: { count: number }) {
  const out: React.ReactNode[] = []
  for (let n = 0; n < count; n++) {
    const x = ((n * 137) % 1400) - 700
    const y = ((n * 71) % 800) - 400
    out.push(
      <Entity key={n}>
        <Transform x={x} y={y} rotation={(n % 5) * 0.3} scaleX={1 + (n % 3) * 0.2} />
        {n % 3 === 0 ? (
          <Circle radius={8 + (n % 5) * 2} color="#ffdd44" strokeColor="#442200" strokeWidth={1.5} zIndex={3} />
        ) : n % 3 === 1 ? (
          <Line endX={20 + (n % 4) * 5} endY={10} color="#44ddff" lineWidth={2 + (n % 3)} zIndex={3} />
        ) : (
          <Polygon
            points={[
              { x: 0, y: -12 },
              { x: 10, y: 8 },
              { x: -10, y: 8 },
            ]}
            color="#dd44ff"
            strokeColor="#220044"
            strokeWidth={1}
            zIndex={3}
          />
        )}
      </Entity>,
    )
  }
  return <>{out}</>
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
      sprites.rotation[i] = ((n % 9) - 4) * 0.15
    }
    const labelCount = scene === 'text-heavy' ? 1200 : scene === 'overview' ? 180 : 100
    for (let n = 0; n < labelCount; n++) {
      const x = ((n * 97) % 1500) - 750
      const y = ((n * 53) % 900) - 450
      labels.add(`Name ${String(n).padStart(4, '0')}`, x, y, { color: 0xffffffff, anchorX: 0 })
    }
    camera.setPosition(0, 0)
    camera.setZoom(scene === 'overview' ? 0.45 : 1)
    const blobToDataUrl = async (blob: Blob): Promise<string> => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return `data:${blob.type};base64,${btoa(binary)}`
    }
    // Render a fixed number of frames before capturing: the sprite layer has a frame-count
    // dependent packing path, so pinning the count makes the capture deterministic. The warm-ups
    // also let every entity/shape mount effect flush.
    const ready = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await document.fonts?.ready
      for (let i = 0; i < 8; i++) await capture({ type: 'blob' })
      return blobToDataUrl(await capture({ type: 'blob' }))
    }
    window.__parityCapture = ready
  }, [camera, capture, labels, scene, sprites])

  return (
    <>
      <EntitySprites count={scene === 'text-heavy' ? 60 : 200} />
      <Shapes count={scene === 'text-heavy' ? 20 : 80} />
      <Camera2D x={0} y={0} zoom={scene === 'overview' ? 0.45 : 1} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <Game width={1280} height={720} mode="onDemand" renderer="webgl" asyncAssets>
    <Layers />
  </Game>,
)
