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
  const editableRoot = element.closest?.('[contenteditable]')
  const contentEditable =
    element.isContentEditable === true ||
    (editableRoot !== null &&
      editableRoot !== undefined &&
      editableRoot.getAttribute('contenteditable')?.toLowerCase() !== 'false')
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || contentEditable
}
