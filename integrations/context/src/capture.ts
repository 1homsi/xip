/** What {@link EngineState.captureFrame} resolves to, chosen by `type`. */
export type CaptureType = 'blob' | 'bitmap' | 'canvas'

export interface CaptureFrameOptions {
  /** Result kind. Default `'blob'`. */
  type?: CaptureType
  /** Encoding for `type: 'blob'`. Default `'image/png'`. */
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp'
  /** Encoder quality (0-1) for jpeg and webp. Default 0.92. */
  quality?: number
  /**
   * Output size in pixels. Omit both for the canvas' own pixel size (the backing
   * store size: CSS size times the canvas' pixels per CSS pixel, which is
   * `devicePixelRatio` unless the backing store is capped). Giving one keeps the
   * aspect ratio; giving both stretches to that size.
   */
  width?: number
  height?: number
  /**
   * With a size: render again at that resolution instead of scaling the
   * on-screen frame, so upscales stay sharp (needs a laid-out canvas, else it
   * scales). The view is the same; only the pixel density changes.
   */
  renderAtSize?: boolean
  /** Smooth the scaling (default: smooth when shrinking, nearest when growing). */
  smoothing?: boolean
  /**
   * Render a fresh frame first (default true). Pass `false` only when called
   * right after a render in the same task; a WebGL canvas that is not
   * preserving its drawing buffer reads back black otherwise.
   */
  render?: boolean
}

export type CaptureResult<T extends CaptureType = 'blob'> = T extends 'bitmap'
  ? ImageBitmap
  : T extends 'canvas'
    ? HTMLCanvasElement
    : Blob

/** Overloaded so the result type follows `opts.type`. */
export interface CaptureFrame {
  (opts?: CaptureFrameOptions & { type?: 'blob' }): Promise<Blob>
  (opts: CaptureFrameOptions & { type: 'bitmap' }): Promise<ImageBitmap>
  (opts: CaptureFrameOptions & { type: 'canvas' }): Promise<HTMLCanvasElement>
  (opts?: CaptureFrameOptions): Promise<Blob | ImageBitmap | HTMLCanvasElement>
}
