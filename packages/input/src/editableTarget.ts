/**
 * True when a key event comes from a text field (input, textarea or contenteditable). Game key
 * handling should leave those keys to the field.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as {
    tagName?: string
    isContentEditable?: boolean
    closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null
  }
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return true
  // The nearest ancestor that sets contenteditable decides. "inherit" or an invalid value defers to
  // its parent, so only the values that name a state are matched.
  const editableRoot = element.closest?.(
    '[contenteditable="false" i], [contenteditable=""], [contenteditable="true" i], [contenteditable="plaintext-only" i]',
  )
  return (
    element.isContentEditable === true ||
    (editableRoot !== null &&
      editableRoot !== undefined &&
      editableRoot.getAttribute('contenteditable')?.toLowerCase() !== 'false')
  )
}
