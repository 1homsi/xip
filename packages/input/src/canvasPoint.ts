/**
 * Maps a viewport (client) point to CSS pixels inside `el`'s layout box.
 *
 * getBoundingClientRect() reports the box after CSS transforms, so an element scaled with
 * `transform: scale(s)` (as `<Game scale="contain">` does) gives points in scaled pixels. The layout
 * size (offsetWidth / offsetHeight) ignores transforms, so the ratio of the two is the scale to undo.
 */
export function canvasPoint(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect()
  const sx = rect.width > 0 && el.offsetWidth > 0 ? el.offsetWidth / rect.width : 1
  const sy = rect.height > 0 && el.offsetHeight > 0 ? el.offsetHeight / rect.height : 1
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy }
}
