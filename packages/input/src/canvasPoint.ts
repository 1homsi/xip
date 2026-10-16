/**
 * Maps a viewport (client) point to CSS pixels inside `el`'s layout box.
 *
 * getBoundingClientRect() reports the box after CSS transforms, so an element scaled with
 * `transform: scale(s)` (as `<Game scale="contain">` does) gives points in scaled pixels. The layout
 * size (offsetWidth / offsetHeight) ignores transforms, so the ratio of the two is the scale to undo.
 */
export function canvasPoint(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect()
  const sx = layoutScale(rect.width, el.offsetWidth)
  const sy = layoutScale(rect.height, el.offsetHeight)
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy }
}

function layoutScale(boxSize: number, layoutSize: number): number {
  // offsetWidth is rounded to a whole pixel, so a fractional, unscaled layout reads up to 1px off.
  // Treat a box that close to its layout size as unscaled; a real contain scale is far larger.
  // `!(x > 0)` also catches a missing layoutSize (undefined in hand-made mocks)
  if (!(boxSize > 0 && layoutSize > 0) || Math.abs(boxSize - layoutSize) < 1) return 1
  return layoutSize / boxSize
}
