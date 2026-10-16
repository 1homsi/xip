/**
 * Snapshot utilities that capture the current canvas to an image. Useful for:
 * - "Save your creation" / "Share" features in puzzle games and editors
 * - Thumbnails of user-created levels
 * - Automated test fixtures
 * - Social media share cards
 *
 * All helpers work with both WebGL2 and Canvas 2D contexts (the underlying
 * `canvas.toBlob` / `canvas.toDataURL` APIs are context-agnostic).
 *
 * **Important**: For WebGL contexts, you must call these helpers *immediately*
 * after the render tick, while the framebuffer still contains the rendered
 * frame. Between frames the browser may clear the WebGL drawing buffer.
 */

export interface ExportOptions {
  /** Image MIME type. Default 'image/png'. */
  type?: 'image/png' | 'image/jpeg' | 'image/webp'
  /** Quality (0–1) for jpeg/webp. Ignored for png. Default 0.92. */
  quality?: number
  /**
   * Optional region to crop, in CSS pixels relative to the canvas top-left.
   * If omitted, the whole canvas is exported.
   */
  region?: { x: number; y: number; width: number; height: number }
  /**
   * Scale multiplier. 1 = source resolution. 2 = double (useful for HiDPI exports).
   * Default 1.
   */
  scale?: number
}

/**
 * Capture the current canvas content to a Blob. Resolves to `null` if the browser
 * refuses the encode (very rare — usually only on dead contexts).
 *
 * Must be called immediately after a render tick for WebGL canvases. In onDemand
 * loop mode, call `engine.loop.markDirty()` and then export from within the next
 * `requestAnimationFrame` to guarantee a fresh frame.
 *
 * @example
 * ```ts
 * const blob = await exportToBlob(engine.canvas, { type: 'image/png' })
 * if (blob) {
 *   const url = URL.createObjectURL(blob)
 *   window.open(url)
 * }
 * ```
 */
export function exportToBlob(canvas: HTMLCanvasElement, options?: ExportOptions): Promise<Blob | null> {
  const type = options?.type ?? 'image/png'
  const quality = options?.quality ?? 0.92
  const region = options?.region
  const scale = options?.scale ?? 1

  return new Promise((resolve) => {
    const source = region || scale !== 1 ? copyRegion(canvas, region, scale) : canvas
    source.toBlob(resolve, type, quality)
  })
}

/**
 * Capture the current canvas content to a base64 data URL. Synchronous.
 *
 * @example
 * ```ts
 * const dataUrl = exportToDataURL(engine.canvas, { type: 'image/jpeg', quality: 0.8 })
 * const img = new Image()
 * img.src = dataUrl
 * ```
 */
export function exportToDataURL(canvas: HTMLCanvasElement, options?: ExportOptions): string {
  const type = options?.type ?? 'image/png'
  const quality = options?.quality ?? 0.92
  const region = options?.region
  const scale = options?.scale ?? 1
  const source = region || scale !== 1 ? copyRegion(canvas, region, scale) : canvas
  return source.toDataURL(type, quality)
}

/**
 * Capture the canvas and trigger a browser download. Convenience wrapper around
 * {@link exportToBlob} + an anchor click.
 *
 * @example
 * ```ts
 * await downloadCanvas(engine.canvas, 'my-puzzle.png')
 * ```
 */
export async function downloadCanvas(
  canvas: HTMLCanvasElement,
  filename: string,
  options?: ExportOptions,
): Promise<void> {
  const blob = await exportToBlob(canvas, options)
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Source pixels per CSS pixel for a canvas. The backing store can be capped below
 * `devicePixelRatio` (see the `maxDpr` prop on `<Game>`), so the ratio is derived from the canvas
 * itself rather than the window; a canvas with no CSS size falls back to the device ratio.
 */
export function sourcePixelRatio(source: HTMLCanvasElement): number {
  if (source.clientWidth > 0) return source.width / source.clientWidth
  return window.devicePixelRatio || 1
}

/**
 * Copy a region of the source canvas (optionally rescaled) into a new offscreen
 * canvas via Canvas 2D. Works even when the source is WebGL — drawImage reads
 * from the current framebuffer.
 */
function copyRegion(source: HTMLCanvasElement, region: ExportOptions['region'], scale: number): HTMLCanvasElement {
  const ratio = sourcePixelRatio(source)
  // Convert CSS-pixel region to physical source pixels
  const sx = region ? region.x * ratio : 0
  const sy = region ? region.y * ratio : 0
  const sw = region ? region.width * ratio : source.width
  const sh = region ? region.height * ratio : source.height
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)
  const out = document.createElement('canvas')
  out.width = dw
  out.height = dh
  const ctx = out.getContext('2d')
  if (!ctx) return out
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh)
  return out
}
